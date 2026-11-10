import { createHash, randomUUID } from "node:crypto";
import { MongoServerError, type Db, type Collection, type Document, type ClientSession } from "mongodb";
import { canonicalJson, immutable, TessarError, type ModelRef } from "@tessar/core";
import {
  TessarRagError, type EmbeddingModel, type Content, type Chunk, type VectorStore,
  type VectorCollectionInfo, type VectorRecord, type VectorListOptions, type VectorDelete,
  type VectorSearchOptions, type VectorSearchResult, type TextSearchOptions, type TextSearchResult,
} from "@tessar/rag";
import { openDatabase, type Database } from "./database.js";
import { transaction } from "./transaction.js";
import { contentsInput, vectorsInput, invalid, keys, nonempty, object, predicate, filterTokens, top, textTerms } from "./vector-validation.js";

const INVALID_CONFIGURATION = "InvalidConfiguration";
const VECTOR_INDEX = "tessar_vector";
const BM25_INDEX = "tessar_bm25";
const BM25_TEXT_MAPPING = {
  type: "string", similarity: { type: "bm25" },
  indexOptions: "offsets", store: true, norms: "include",
} as const;

export interface MongoDBVectorStoreOptions {
  database: Db;
  embedding: EmbeddingModel;
  namespace?: string;
  collection?: string;
}

export interface NativeSearchResult {
  id: string;
  createdAt: string;
  content: Content | Chunk;
  /** MongoDB textScore relevance; larger is better, not BM25 or cosine similarity. */
  score: number;
}

interface Metadata {
  _id: string;
  model: string;
  dimensions: number | null;
  sequence: number;
}
interface Row {
  _id: string;
  createdAt: string;
  content: string;
  text: string;
  vector: number[];
  filterTokens: string[];
  sequence: number;
}
interface SearchIndex {
  name: string;
  type?: string;
  latestDefinition?: Document;
  queryable?: boolean;
  status?: string;
  latestDefinitionVersion?: { version?: number };
  statusDetail?: { status?: string; queryable?: boolean; mainIndex?: { status?: string; queryable?: boolean; definitionVersion?: { version?: number } } }[];
}

export class MongoDBVectorStore implements VectorStore {
  readonly #database: Database;
  readonly #embedding: EmbeddingModel;
  readonly #model: Readonly<ModelRef>;
  readonly #collection: string;
  readonly #data: Collection<Row>;
  readonly #metadata: Collection<Metadata>;
  #initializing?: Promise<void>;
  #nativeInitializing?: Promise<unknown>;
  #closed = false;

  constructor(options: MongoDBVectorStoreOptions) {
    try {
      object(options, "vector store options");
      keys(options, ["database", "embedding", "namespace", "collection"]);
      nonempty(options.collection === undefined ? "default" : options.collection, "collection");
      this.#database = openDatabase(options);
      if (!options.embedding || typeof options.embedding.embedDocuments !== "function" || typeof options.embedding.embedQuery !== "function")
        invalid("embedding must implement embedDocuments and embedQuery");
      object(options.embedding.ref, "embedding model ref");
      keys(options.embedding.ref, ["providerId", "modelId", "connectionId"]);
      nonempty(options.embedding.ref.providerId, "embedding providerId");
      nonempty(options.embedding.ref.modelId, "embedding modelId");
      if (options.embedding.ref.connectionId !== undefined) nonempty(options.embedding.ref.connectionId, "embedding connectionId");
      this.#model = immutable(identity(options.embedding.ref));
    } catch (error) {
      if (TessarError.isInstance(error)) throw new TessarRagError(INVALID_CONFIGURATION, error.message, { cause: error });
      throw error;
    }
    this.#embedding = options.embedding;
    this.#collection = options.collection ?? "default";
    const prefix = this.#database.prefix;
    this.#metadata = options.database.collection<Metadata>(prefix + "tessar_vector_collections");
    this.#data = options.database.collection<Row>(prefix + "tessar_v_" + createHash("sha256").update(this.#collection).digest("hex").slice(0, 40));
  }

  async info(): Promise<VectorCollectionInfo> {
    await this.#init();
    const metadata = await this.#saved();
    return { collection: this.#collection, model: this.#model, dimensions: metadata.dimensions };
  }

  async insert(input: readonly (Content | Chunk)[]): Promise<string[]> {
    this.#assertOpen();
    const contents = contentsInput(input);
    const tokens = contents.map(filterTokens);
    if (!contents.length) return [];
    this.#assertModel();
    await this.#init();
    this.#assertModel();
    const vectors = vectorsInput(await this.#embedding.embedDocuments(contents), contents.length);
    this.#assertOpen(); this.#assertModel();
    const rows = contents.map((content, index) => ({
      _id: randomUUID(), createdAt: new Date().toISOString(), content: JSON.stringify(content),
      text: content.text, vector: vectors[index]!, filterTokens: tokens[index]!, sequence: 0,
    }));
    await this.#transaction(async session => {
      const metadata = await this.#saved(session);
      const width = vectors[0]!.length;
      if (metadata.dimensions !== null && metadata.dimensions !== width) invalid("Embedding dimensions do not match the collection");
      if (!Number.isSafeInteger(metadata.sequence + rows.length)) invalid("Collection sequence exhausted", "InvalidState");
      // Updating the shared metadata serializes concurrent first inserts and sequence allocation.
      await this.#metadata.updateOne({ _id: this.#collection }, { $set: { dimensions: width }, $inc: { sequence: rows.length } }, { session });
      rows.forEach((row, index) => { row.sequence = metadata.sequence + index + 1; });
      await this.#data.insertMany(rows, { session, ordered: true });
    });
    return rows.map(row => row._id);
  }

  async get(id: string): Promise<VectorRecord | null> {
    this.#assertOpen(); nonempty(id, "record id");
    await this.#init();
    const row = await this.#data.findOne({ _id: id });
    return row ? record(row) : null;
  }

  async list(options: VectorListOptions = {}): Promise<VectorRecord[]> {
    this.#assertOpen(); object(options, "list options"); keys(options, ["filter", "limit", "offset"]);
    const limit = options.limit === undefined ? 100 : options.limit, offset = options.offset === undefined ? 0 : options.offset;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000
      || typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)
      invalid("Require integer limit 1..1000 and nonnegative safe integer offset");
    const filter = options.filter === undefined ? {} : { filterTokens: { $all: predicate(options.filter) } };
    await this.#init();
    return (await this.#data.find(filter).sort({ sequence: 1 }).skip(offset).limit(limit).toArray()).map(record);
  }

  async delete(selector: VectorDelete): Promise<number> {
    this.#assertOpen(); object(selector, "delete selector"); keys(selector, ["ids", "filter"]);
    if (Object.hasOwn(selector, "ids") === Object.hasOwn(selector, "filter")) invalid("Delete requires exactly one of ids or filter");
    let filter;
    if (Object.hasOwn(selector, "ids")) {
      if (!Array.isArray(selector.ids) || !selector.ids.length) invalid("Delete IDs must be a nonempty array");
      const ids = Array.from(selector.ids); for (const id of ids) nonempty(id, "record id");
      filter = { _id: { $in: ids } };
    } else filter = { filterTokens: { $all: predicate(selector.filter) } };
    await this.#init();
    return (await this.#data.deleteMany(filter)).deletedCount;
  }

  async search(query: string, options: VectorSearchOptions = {}): Promise<VectorSearchResult[]> {
    this.#assertOpen(); nonempty(query, "search query"); object(options, "search options"); keys(options, ["topK", "score_threshold", "filter"]);
    const topK = top(options.topK), threshold = options.score_threshold;
    if (threshold !== undefined && (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < -1 || threshold > 1))
      invalid("score_threshold must be a finite number between -1 and 1");
    const tokens = options.filter === undefined ? [] : predicate(options.filter);
    await this.#init();
    const { dimensions } = await this.#saved();
    if (dimensions === null || !await this.#data.findOne({})) return [];
    await this.#searchIndex(VECTOR_INDEX, "vectorSearch", {
      fields: [
        { type: "vector", path: "vector", numDimensions: dimensions, similarity: "cosine" },
        { type: "filter", path: "filterTokens" },
      ]
    });
    this.#assertModel();
    const [vector] = vectorsInput([await this.#embedding.embedQuery(query)], 1);
    this.#assertOpen(); this.#assertModel();
    if (vector!.length !== dimensions) invalid("Query embedding has different dimensions from the collection");
    const results = await this.#scored([
      {
        $vectorSearch: {
          index: VECTOR_INDEX, path: "vector", queryVector: vector, exact: true, limit: topK,
          ...(tokens.length ? { filter: { $and: tokens.map(value => ({ filterTokens: { $eq: value } })) } } : {})
        }
      },
      { $project: { _id: 1, score: { $meta: "vectorSearchScore" } } },
    ]);
    return results.map(row => ({ ...row, score: Math.max(-1, Math.min(1, 2 * row.score - 1)) }))
      .filter(row => threshold === undefined || row.score >= threshold);
  }

  async searchBM25(query: string, options: TextSearchOptions = {}): Promise<TextSearchResult[]> {
    this.#assertOpen(); const { terms, topK, tokens } = textOptions(query, options);
    await this.#init();
    await this.#searchIndex(BM25_INDEX, "search", {
      mappings: {
        dynamic: false, fields: {
          text: BM25_TEXT_MAPPING, filterTokens: { type: "token", normalizer: "none" },
        }
      }
    });
    if (!terms.length) return [];
    return this.#scored([
      {
        $search: {
          index: BM25_INDEX, compound: {
            should: terms.map(term => ({ text: { path: "text", query: term } })), minimumShouldMatch: 1,
            ...(tokens.length ? { filter: tokens.map(value => ({ equals: { path: "filterTokens", value } })) } : {}),
          }
        }
      },
      { $limit: topK }, { $project: { _id: 1, score: { $meta: "searchScore" } } },
    ]);
  }

  async searchNative(query: string, options: TextSearchOptions = {}): Promise<NativeSearchResult[]> {
    this.#assertOpen(); const { terms, topK, tokens } = textOptions(query, options);
    await this.#init();
    if (!this.#nativeInitializing) this.#nativeInitializing = this.#data.createIndex({ text: "text" }, { name: "tessar_native", default_language: "none" })
      .catch(error => { this.#nativeInitializing = undefined; throw error; });
    await this.#nativeInitializing;
    if (!terms.length) return [];
    return this.#scored([
      { $match: { $text: { $search: terms.join(" "), $language: "none" }, ...(tokens.length ? { filterTokens: { $all: tokens } } : {}) } },
      { $project: { _id: 1, score: { $meta: "textScore" } } },
      { $sort: { score: -1, _id: 1 } }, { $limit: topK },
    ]);
  }

  async close(): Promise<void> { this.#closed = true; }

  #assertOpen(): void { if (this.#closed) invalid("Vector store is closed", "InvalidState"); }
  #assertModel(): void {
    if (canonicalJson(identity(this.#embedding.ref)) !== canonicalJson(this.#model))
      invalid("Embedding model identity changed after opening the collection", INVALID_CONFIGURATION);
  }

  async #saved(session?: ClientSession): Promise<Metadata> {
    const metadata = await this.#metadata.findOne({ _id: this.#collection }, { session });
    if (!metadata || metadata.model !== canonicalJson(this.#model)) invalid("Existing collection has a different embedding model", INVALID_CONFIGURATION);
    return metadata;
  }

  async #init(): Promise<void> {
    this.#assertOpen();
    if (!this.#initializing) this.#initializing = (async () => {
      for (const collection of [this.#metadata, this.#data]) {
        try { await this.#database.database.createCollection(collection.collectionName); }
        catch (error) { if (!(error instanceof MongoServerError && error.code === 48)) throw error; }
      }
      await this.#data.createIndex({ sequence: 1 }, { name: "tessar_sequence", unique: true });
      await this.#metadata.updateOne({ _id: this.#collection }, {
        $setOnInsert: {
          model: canonicalJson(this.#model), dimensions: null, sequence: 0,
        }
      }, { upsert: true });
      await this.#saved();
    })().catch(error => { this.#initializing = undefined; throw error; });
    await this.#initializing;
    this.#assertOpen();
  }

  async #transaction<T>(action: (session: ClientSession) => Promise<T>): Promise<T> {
    this.#assertOpen();
    return transaction(this.#database, async session => {
      this.#assertOpen();
      return action(session);
    });
  }
  async #searchIndex(name: string, type: "search" | "vectorSearch", definition: Document): Promise<void> {
    this.#assertOpen();
    const list = async () => (await this.#data.listSearchIndexes(name).toArray() as SearchIndex[]).find(index => index.name === name);
    let existing = await list();
    if (!existing) {
      try { await this.#data.createSearchIndex({ name, type, definition }); }
      catch (error) { if (!(error instanceof MongoServerError && error.code === 68)) throw error; }
      existing = await list();
    }
    const actualType = existing?.type ?? (Array.isArray(existing?.latestDefinition?.fields) ? "vectorSearch" : "search");
    if (existing && (actualType !== type || !existing.latestDefinition || canonicalJson(existing.latestDefinition) !== canonicalJson(definition)))
      invalid("Existing MongoDB Search index has an incompatible definition", INVALID_CONFIGURATION);
    if (!existing || existing.queryable !== true || existing.status !== "READY" || existing.statusDetail?.some(detail =>
      detail.status !== "READY" || detail.queryable !== true || !detail.mainIndex || detail.mainIndex.status !== "READY" || detail.mainIndex.queryable !== true
      || (existing.latestDefinitionVersion?.version !== undefined && detail.mainIndex.definitionVersion?.version !== existing.latestDefinitionVersion.version)))
      invalid("MongoDB Search index is not yet ready; retry explicitly after it finishes building", "InvalidState");
  }

  async #scored(pipeline: Document[]): Promise<NativeSearchResult[]> {
    this.#assertOpen();
    const hits = await this.#data.aggregate<{ _id: string; score: number }>(pipeline).toArray();
    if (!hits.length) return [];
    // Search indexes are asynchronous: retrieve original data only from current records.
    const rows = await this.#data.find({ _id: { $in: hits.map(hit => hit._id) } }).toArray();
    const current = new Map(rows.map(row => [row._id, row]));
    return hits.flatMap(hit => {
      const row = current.get(hit._id); if (!row) return [];
      if (typeof hit.score !== "number" || !Number.isFinite(hit.score)) invalid("Search returned a nonfinite score");
      return [{ id: row._id, createdAt: row.createdAt, content: JSON.parse(row.content) as Content | Chunk, score: hit.score }];
    });
  }
}

function identity(ref: Readonly<ModelRef>): ModelRef {
  return { providerId: ref.providerId, modelId: ref.modelId, ...(ref.connectionId === undefined ? {} : { connectionId: ref.connectionId }) };
}
function record(row: Row): VectorRecord {
  return { id: row._id, createdAt: row.createdAt, content: JSON.parse(row.content) as Content | Chunk, vector: row.vector };
}
function textOptions(query: string, options: TextSearchOptions) {
  const terms = textTerms(query); object(options, "text search options"); keys(options, ["topK", "filter"]);
  return { terms, topK: top(options.topK), tokens: options.filter === undefined ? [] : predicate(options.filter) };
}
