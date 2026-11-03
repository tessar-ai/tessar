import { openDatabase, type Database, type LibsqlStorageOptions } from "./database.js";
import { transaction } from "./transaction.js";
import { createHash } from "node:crypto";
import { canonicalJson, immutable, TessarError, type ModelRef } from "@tessar/core";
import {
  TessarRagError,
  type VectorDelete, type VectorCollectionInfo, type VectorListOptions, type VectorRecord, type VectorStore,
  type EmbeddingModel, type Content, type Chunk,
  type VectorSearchOptions, type VectorSearchResult,
  type TextSearchOptions, type TextSearchResult,
} from "@tessar/rag";
import { contentsInput, vectorsInput, invalid, keys, nonempty, object, predicate } from "./vector-validation.js";

export interface LibsqlVectorStoreOptions extends LibsqlStorageOptions {
  collection?: string;
  embedding: EmbeddingModel;
}

export class LibsqlVectorStore implements VectorStore {
  readonly #db: Database;
  readonly #collection: string;
  readonly #embedding: EmbeddingModel;
  readonly #model: Readonly<ModelRef>;
  readonly #indexTable: string;
  readonly #textTable: string;
  #closed = false;

  constructor(options: LibsqlVectorStoreOptions) {
    try {
      object(options, "vector store options");
      keys(options, ["database", "namespace", "collection", "embedding"]);
      this.#db = openDatabase(options);
      nonempty(options.collection === undefined ? "default" : options.collection, "collection");
      if (!options.embedding || typeof options.embedding.embedDocuments !== "function"
        || typeof options.embedding.embedQuery !== "function")
        invalid("embedding must implement embedDocuments and embedQuery");
      object(options.embedding.ref, "embedding model ref");
      keys(options.embedding.ref, ["providerId", "modelId", "connectionId"]);
      nonempty(options.embedding.ref.providerId, "embedding providerId");
      nonempty(options.embedding.ref.modelId, "embedding modelId");
      if (options.embedding.ref.connectionId !== undefined)
        nonempty(options.embedding.ref.connectionId, "embedding connectionId");
      this.#model = immutable(modelIdentity(options.embedding.ref));
    } catch (error) {
      if (TessarError.isInstance(error))
        throw new TessarRagError("InvalidConfiguration", error.message, { cause: error });
      throw error;
    }
    this.#collection = options.collection ?? "default";
    this.#embedding = options.embedding;
    this.#indexTable = `${this.#db.prefix}tessar_vector_data_` + createHash("sha256").update(this.#collection).digest("hex");
    this.#textTable = this.#indexTable + "_fts";
    transaction(this.#db, () => {
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS ${this.#db.prefix}tessar_vector_models (
          name TEXT PRIMARY KEY, model TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ${this.#db.prefix}tessar_vector_collections (
          name TEXT PRIMARY KEY, dimensions INTEGER NOT NULL CHECK(dimensions>0)
        );
        CREATE TABLE IF NOT EXISTS ${this.#db.prefix}tessar_vectors (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          collection TEXT NOT NULL REFERENCES ${this.#db.prefix}tessar_vector_collections(name),
          id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
          content TEXT NOT NULL, vector TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ${this.#db.prefix}tessar_vectors_collection_sequence
          ON ${this.#db.prefix}tessar_vectors(collection,sequence);
      `);
      const saved = this.#db.prepare(`SELECT model FROM ${this.#db.prefix}tessar_vector_models WHERE name=?`).get(this.#collection) as { model: string } | undefined;
      const dimensions = this.#dimensions();
      if (!saved && dimensions !== null)
        invalid("Existing collection has no embedding model identity; automatic adoption is not supported", "InvalidConfiguration");
      if (saved && canonicalJson(JSON.parse(saved.model)) !== canonicalJson(this.#model))
        invalid("Existing collection has a different embedding model", "InvalidConfiguration");
      this.#db.prepare(`INSERT INTO ${this.#db.prefix}tessar_vector_models(name,model) VALUES(?,?) ON CONFLICT(name) DO NOTHING`)
        .run(this.#collection, canonicalJson(this.#model));
      if (dimensions !== null) this.#ensureIndex(dimensions);
      const textIndexed = this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(this.#textTable);
      if (!textIndexed) {
        this.#db.exec(`CREATE VIRTUAL TABLE "${this.#textTable}" USING fts5(text);`);
        this.#db.prepare(`INSERT INTO "${this.#textTable}"(rowid,text)
          SELECT sequence,json_extract(content,'$.text') FROM ${this.#db.prefix}tessar_vectors WHERE collection=?`)
          .run(this.#collection);
      }
    });
  }

  async info(): Promise<VectorCollectionInfo> {
    this.#assertOpen();
    return { collection: this.#collection, model: this.#model, dimensions: this.#dimensions() };
  }

  async insert(input: readonly (Content | Chunk)[]): Promise<string[]> {
    this.#assertOpen();
    const contents = contentsInput(input);
    if (!contents.length) return [];
    this.#assertModel();
    const vectors = vectorsInput(await this.#embedding.embedDocuments(contents), contents.length);
    this.#assertOpen();
    this.#assertModel();
    return transaction(this.#db, () => {
      this.#ensureIndex(vectors[0]!.length);
      const statement = this.#db.prepare(`INSERT INTO ${this.#db.prefix}tessar_vectors(collection,id,created_at,content,vector) VALUES(?,?,?,?,?)`);
      const indexStatement = this.#db.prepare(`INSERT INTO "${this.#indexTable}"(record_sequence,embedding) VALUES(?,vector32(?))`);
      const textStatement = this.#db.prepare(`INSERT INTO "${this.#textTable}"(rowid,text) VALUES(?,?)`);
      return contents.map((content, index) => {
        const id = crypto.randomUUID();
        const vector = JSON.stringify(vectors[index]);
        const saved = statement.run(this.#collection, id, new Date().toISOString(), JSON.stringify(content), vector);
        indexStatement.run(saved.lastInsertRowid, vector);
        textStatement.run(saved.lastInsertRowid, content.text);
        return id;
      });
    });
  }

  async get(id: string): Promise<VectorRecord | null> {
    this.#assertOpen();
    nonempty(id, "record id");
    const row = this.#db.prepare(`SELECT id,created_at,content,vector FROM ${this.#db.prefix}tessar_vectors WHERE collection=? AND id=?`)
      .get(this.#collection, id);
    return row ? record(row as Record<string, unknown>) : null;
  }

  async list(options: VectorListOptions = {}): Promise<VectorRecord[]> {
    this.#assertOpen();
    object(options, "list options");
    keys(options, ["filter", "limit", "offset"]);
    const limit = options.limit === undefined ? 100 : options.limit;
    const offset = options.offset === undefined ? 0 : options.offset;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000
      || typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)
      invalid("Require integer limit 1..1000 and nonnegative safe integer offset");
    const where = options.filter === undefined ? { sql: "1", values: [] } : predicate(options.filter);
    return this.#db.prepare(`SELECT id,created_at,content,vector FROM ${this.#db.prefix}tessar_vectors
      WHERE collection=? AND ${where.sql} ORDER BY sequence LIMIT ? OFFSET ?`)
      .all(this.#collection, ...where.values, limit, offset).map(row => record(row as Record<string, unknown>));
  }

  async search(input: string, options: VectorSearchOptions = {}): Promise<VectorSearchResult[]> {
    this.#assertOpen();
    nonempty(input, "search query");
    object(options, "search options");
    keys(options, ["topK", "score_threshold", "filter"]);
    const topK = options.topK === undefined ? 5 : options.topK;
    if (typeof topK !== "number" || !Number.isSafeInteger(topK) || topK <= 0)
      invalid("topK must be a positive safe integer");
    const threshold = options.score_threshold;
    if (threshold !== undefined && (typeof threshold !== "number"
      || !Number.isFinite(threshold) || threshold < -1 || threshold > 1))
      invalid("score_threshold must be a finite number between -1 and 1");
    const where = options.filter === undefined ? undefined : predicate(options.filter);
    const dimensions = this.#dimensions();
    if (dimensions === null || !this.#db.prepare(`SELECT 1 FROM ${this.#db.prefix}tessar_vectors WHERE collection=? LIMIT 1`).get(this.#collection)) return [];
    this.#assertModel();
    const [vector] = vectorsInput([await this.#embedding.embedQuery(input)], 1);
    this.#assertOpen();
    this.#assertModel();
    if (vector!.length !== dimensions) invalid("Query embedding has different dimensions from the collection");
    const query = JSON.stringify(vector);
    // Filter before topK; the native ANN function cannot prefilter metadata/source.
    const from = where
      ? `FROM "${this.#indexTable}" i`
      : `FROM vector_top_k(?,vector32(?),?) k JOIN "${this.#indexTable}" i ON i.rowid=k.id`;
    return this.#db.prepare(`SELECT r.id,r.created_at,r.content,
      1 - vector_distance_cos(i.embedding,vector32(?)) AS score
      ${from}
      JOIN ${this.#db.prefix}tessar_vectors r ON r.sequence=i.record_sequence
      WHERE r.collection=? ${where ? "AND " + where.sql : ""}
      ORDER BY score DESC,r.sequence ${where ? "LIMIT ?" : ""}`)
      .all(query, ...(where ? [] : [this.#indexTable + "_idx", query, topK]),
        this.#collection, ...(where ? [...where.values, topK] : []))
      .map(value => {
        const row = value as { id: string; created_at: string; content: string; score: number };
        if (typeof row.score !== "number" || !Number.isFinite(row.score))
          invalid("Vector search returned a nonfinite similarity score");
        return { id: row.id, createdAt: row.created_at, content: JSON.parse(row.content), score: Math.max(-1, Math.min(1, row.score)) };
      }).filter(result => threshold === undefined || result.score >= threshold);
  }

  async searchBM25(query: string, options: TextSearchOptions = {}): Promise<TextSearchResult[]> {
    this.#assertOpen();
    nonempty(query, "text query");
    if (query.includes("\u0000")) invalid("Text query must not contain NUL");
    object(options, "text search options");
    keys(options, ["topK", "filter"]);
    const topK = options.topK === undefined ? 5 : options.topK;
    if (typeof topK !== "number" || !Number.isSafeInteger(topK) || topK <= 0)
      invalid("topK must be a positive safe integer");
    const where = options.filter === undefined ? { sql: "1", values: [] } : predicate(options.filter);
    // Quote each segment so plain text cannot become FTS operators or column syntax.
    const match = query.trim().split(/\s+/u).map(term => '"' + term.replaceAll('"', '""') + '"').join(" OR ");
    return this.#db.prepare(`SELECT r.id,r.created_at,r.content,-bm25("${this.#textTable}") AS score
      FROM "${this.#textTable}" JOIN ${this.#db.prefix}tessar_vectors r ON r.sequence="${this.#textTable}".rowid
      WHERE "${this.#textTable}" MATCH ? AND r.collection=? AND ${where.sql}
      ORDER BY score DESC,r.sequence LIMIT ?`)
      .all(match, this.#collection, ...where.values, topK)
      .map(value => {
        const row = value as { id: string; created_at: string; content: string; score: number };
        return { id: row.id, createdAt: row.created_at, content: JSON.parse(row.content), score: row.score };
      });
  }

  async delete(selector: VectorDelete): Promise<number> {
    this.#assertOpen();
    object(selector, "delete selector");
    keys(selector, ["ids", "filter"]);
    if (Object.hasOwn(selector, "ids") === Object.hasOwn(selector, "filter"))
      invalid("Delete requires exactly one of ids or filter");
    if (Object.hasOwn(selector, "ids")) {
      if (!Array.isArray(selector.ids) || !selector.ids.length) invalid("Delete IDs must be a nonempty array");
      const ids = Array.from(selector.ids);
      for (const id of ids) nonempty(id, "record id");
      return transaction(this.#db, () => {
        const statement = this.#db.prepare(`DELETE FROM ${this.#db.prefix}tessar_vectors WHERE collection=? AND id=?`);
        const index = this.#dimensions() === null ? undefined : this.#db.prepare(`DELETE FROM "${this.#indexTable}" WHERE record_sequence IN
          (SELECT sequence FROM ${this.#db.prefix}tessar_vectors WHERE collection=? AND id=?)`);
        const text = this.#db.prepare(`DELETE FROM "${this.#textTable}" WHERE rowid IN
          (SELECT sequence FROM ${this.#db.prefix}tessar_vectors WHERE collection=? AND id=?)`);
        return ids.reduce((count, id) => {
          index?.run(this.#collection, id);
          text.run(this.#collection, id);
          return count + Number(statement.run(this.#collection, id).changes);
        }, 0);
      });
    }
    const where = predicate(selector.filter);
    return transaction(this.#db, () => {
      if (this.#dimensions() !== null) this.#db.prepare(`DELETE FROM "${this.#indexTable}" WHERE record_sequence IN
        (SELECT sequence FROM ${this.#db.prefix}tessar_vectors WHERE collection=? AND ${where.sql})`)
        .run(this.#collection, ...where.values);
      this.#db.prepare(`DELETE FROM "${this.#textTable}" WHERE rowid IN
        (SELECT sequence FROM ${this.#db.prefix}tessar_vectors WHERE collection=? AND ${where.sql})`)
        .run(this.#collection, ...where.values);
      return Number(this.#db.prepare(`DELETE FROM ${this.#db.prefix}tessar_vectors WHERE collection=? AND ${where.sql}`)
        .run(this.#collection, ...where.values).changes);
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) invalid("Vector store is closed", "InvalidState");
  }

  #dimensions(): number | null {
    const row = this.#db.prepare(`SELECT dimensions FROM ${this.#db.prefix}tessar_vector_collections WHERE name=?`).get(this.#collection) as { dimensions: number } | undefined;
    return row?.dimensions ?? null;
  }

  #assertModel(): void {
    if (canonicalJson(modelIdentity(this.#embedding.ref)) !== canonicalJson(this.#model))
      invalid("Embedding model identity changed after opening the collection", "InvalidConfiguration");
  }

  #ensureIndex(dimensions: number): void {
    this.#db.prepare(`INSERT INTO ${this.#db.prefix}tessar_vector_collections(name,dimensions) VALUES(?,?) ON CONFLICT(name) DO NOTHING`)
      .run(this.#collection, dimensions);
    const expected = this.#dimensions();
    if (expected !== dimensions) invalid("Embedding dimensions do not match the collection");
    if (!this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(this.#indexTable)) {
      this.#db.exec(`CREATE TABLE "${this.#indexTable}" (
        record_sequence INTEGER PRIMARY KEY REFERENCES ${this.#db.prefix}tessar_vectors(sequence),
        embedding F32_BLOB(${dimensions}) NOT NULL
      );
      CREATE INDEX "${this.#indexTable}_idx" ON "${this.#indexTable}"(libsql_vector_idx(embedding,'metric=cosine'));`);
      this.#db.prepare(`INSERT INTO "${this.#indexTable}"(record_sequence,embedding)
        SELECT sequence,vector32(vector) FROM ${this.#db.prefix}tessar_vectors WHERE collection=?`).run(this.#collection);
    }
  }

}

function modelIdentity(ref: Readonly<ModelRef>): ModelRef {
  return {
    providerId: ref.providerId, modelId: ref.modelId,
    ...(ref.connectionId === undefined ? {} : { connectionId: ref.connectionId }),
  };
}

function record(row: Record<string, unknown>): VectorRecord {
  return {
    id: String(row.id), createdAt: String(row.created_at),
    content: JSON.parse(String(row.content)), vector: JSON.parse(String(row.vector)),
  };
}
