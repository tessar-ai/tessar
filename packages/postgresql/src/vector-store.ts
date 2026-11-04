import { openDatabase, type Database } from "./database.js";
import { transaction } from "./transaction.js";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { canonicalJson, immutable, TessarError, type ModelRef } from "@tessar/core";
import {
  TessarRagError, type EmbeddingModel, type Content, type Chunk, type VectorStore,
  type VectorCollectionInfo, type VectorRecord, type VectorListOptions, type VectorDelete,
  type VectorSearchOptions, type VectorSearchResult, type TextSearchOptions, type TextSearchResult,
} from "@tessar/rag";
import { contentsInput, vectorsInput, invalid, keys, nonempty, object, predicate } from "./vector-validation.js";

export interface PostgresqlVectorStoreOptions {
  pool: Pool;
  embedding: EmbeddingModel;
  schema?: string;
  collection?: string;
}

export interface NativeSearchResult {
  id: string;
  createdAt: string;
  content: Content | Chunk;
  /** PostgreSQL ts_rank relevance; larger is better, not BM25 or cosine similarity. */
  score: number;
}

export class PostgresqlVectorStore implements VectorStore {
  readonly #db: Database;
  readonly #collection: string;
  readonly #embedding: EmbeddingModel;
  readonly #model: Readonly<ModelRef>;
  readonly #table: string;
  readonly #name: string;
  readonly #collections: string;
  #vectorSchema = "";
  #initializing?: Promise<void>;
  #bm25Initializing?: Promise<void>;
  #bm25OperatorSchema = "";
  #closed = false;

  constructor(options: PostgresqlVectorStoreOptions) {
    try {
      object(options, "vector store options");
      keys(options, ["pool", "embedding", "schema", "collection"]);
      this.#db = openDatabase(options);
      nonempty(options.collection === undefined ? "default" : options.collection, "collection");
      if (!options.embedding || typeof options.embedding.embedDocuments !== "function" || typeof options.embedding.embedQuery !== "function")
        invalid("embedding must implement embedDocuments and embedQuery");
      object(options.embedding.ref, "embedding model ref");
      keys(options.embedding.ref, ["providerId", "modelId", "connectionId"]);
      nonempty(options.embedding.ref.providerId, "embedding providerId");
      nonempty(options.embedding.ref.modelId, "embedding modelId");
      if (options.embedding.ref.connectionId !== undefined) nonempty(options.embedding.ref.connectionId, "embedding connectionId");
      this.#model = immutable(identity(options.embedding.ref));
    } catch (error) {
      if (TessarError.isInstance(error)) throw new TessarRagError("InvalidConfiguration", error.message, { cause: error });
      throw error;
    }
    this.#embedding = options.embedding;
    this.#collection = options.collection ?? "default";
    this.#name = "tessar_v_" + createHash("sha256").update(this.#collection).digest("hex").slice(0, 40);
    this.#table = this.#db.table(this.#name.slice("tessar_".length));
    this.#collections = this.#db.table("vector_collections");
  }

  async info(): Promise<VectorCollectionInfo> {
    this.#assertOpen();
    await this.#init();
    const dimensions = await this.#transaction(client => this.#dimensions(client));
    return { collection: this.#collection, model: this.#model, dimensions };
  }

  async insert(input: readonly (Content | Chunk)[]): Promise<string[]> {
    this.#assertOpen();
    const contents = contentsInput(input);
    if (!contents.length) return [];
    this.#assertModel();
    await this.#init();
    const vectors = vectorsInput(await this.#embedding.embedDocuments(contents), contents.length);
    this.#assertOpen();
    this.#assertModel();
    const rows = contents.map((content, index) => ({
      id: randomUUID(), created_at: new Date().toISOString(), content, vector: vectors[index],
    }));
    await this.#transaction(async client => {
      const dimensions = await this.#dimensions(client);
      const width = vectors[0]!.length;
      if (dimensions !== null && dimensions !== width) invalid("Embedding dimensions do not match the collection");
      if (dimensions === null) {
        await client.query(`ALTER TABLE ${this.#table} ALTER COLUMN embedding TYPE ${this.#vectorSchema}.vector(${width})`);
        await client.query(`CREATE INDEX ${quote(this.#name + "_cos")} ON ${this.#table} USING hnsw (embedding ${this.#vectorSchema}.vector_cosine_ops)`);
        await client.query(`UPDATE ${this.#collections} SET dimensions=$1 WHERE name=$2`, [width, this.#collection]);
      }
      await client.query(`INSERT INTO ${this.#table}(id,created_at,content,vector,embedding)
        SELECT id,created_at,content,vector,vector::text::${this.#vectorSchema}.vector
        FROM ROWS FROM (jsonb_to_recordset($1::jsonb) AS (id text,created_at text,content jsonb,vector jsonb)) WITH ORDINALITY AS r
        ORDER BY ordinality`, [JSON.stringify(rows)]);
    }, true);
    return rows.map(row => row.id);
  }

  async get(id: string): Promise<VectorRecord | null> {
    this.#assertOpen();
    nonempty(id, "record id");
    await this.#init();
    return this.#transaction(async client => {
      const result = await client.query(`SELECT id,created_at,content,vector FROM ${this.#table} WHERE id=$1`, [id]);
      return result.rows[0] ? record(result.rows[0]) : null;
    });
  }

  async list(options: VectorListOptions = {}): Promise<VectorRecord[]> {
    this.#assertOpen();
    object(options, "list options");
    keys(options, ["filter", "limit", "offset"]);
    const limit = options.limit === undefined ? 100 : options.limit, offset = options.offset === undefined ? 0 : options.offset;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000
      || typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)
      invalid("Require integer limit 1..1000 and nonnegative safe integer offset");
    const where = options.filter === undefined ? { sql: "true", values: [] } : predicate(options.filter);
    await this.#init();
    return this.#transaction(async client => (await client.query(`SELECT id,created_at,content,vector FROM ${this.#table}
      WHERE ${where.sql} ORDER BY sequence LIMIT $${where.values.length + 1} OFFSET $${where.values.length + 2}`,
      [...where.values, limit, offset])).rows.map(record));
  }

  async search(query: string, options: VectorSearchOptions = {}): Promise<VectorSearchResult[]> {
    this.#assertOpen();
    nonempty(query, "search query");
    object(options, "search options");
    keys(options, ["topK", "score_threshold", "filter"]);
    const topK = top(options.topK), threshold = options.score_threshold;
    if (threshold !== undefined && (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < -1 || threshold > 1))
      invalid("score_threshold must be a finite number between -1 and 1");
    const where = options.filter === undefined ? undefined : predicate(options.filter, 2);
    await this.#init();
    const dimensions = await this.#transaction(async client => {
      const dimensions = await this.#dimensions(client);
      if (dimensions === null) return null;
      return (await client.query(`SELECT 1 AS present FROM ${this.#table} LIMIT 1`)).rows.length ? dimensions : null;
    });
    if (dimensions === null) return [];
    this.#assertModel();
    const [vector] = vectorsInput([await this.#embedding.embedQuery(query)], 1);
    this.#assertOpen();
    this.#assertModel();
    if (vector!.length !== dimensions) invalid("Query embedding has different dimensions from the collection");
    return this.#transaction(async client => {
      const distance = `embedding OPERATOR(${this.#vectorSchema}.<=>) $1::${this.#vectorSchema}.vector`;
      // Materialization forces exact ranking of the filtered subset before topK.
      const prefix = where ? `WITH matched AS MATERIALIZED (SELECT * FROM ${this.#table} WHERE ${where.sql})` : "";
      const limit = `$${(where?.values.length ?? 0) + 2}`;
      const sql = where
        ? `${prefix} SELECT id,created_at,content,1-(${distance}) AS score FROM matched ORDER BY ${distance},sequence LIMIT ${limit}`
        : `SELECT id,created_at,content,1-distance AS score FROM (
            SELECT id,created_at,content,sequence,${distance} AS distance FROM ${this.#table}
            ORDER BY ${distance} LIMIT ${limit}
          ) AS nearest ORDER BY distance,sequence`;
      const result = await client.query(sql,
        [JSON.stringify(vector), ...(where?.values ?? []), topK]);
      return result.rows.map(row => {
        if (typeof row.score !== "number" || !Number.isFinite(row.score)) invalid("Vector search returned a nonfinite similarity score");
        return { ...scored(row), score: Math.max(-1, Math.min(1, row.score)) };
      }).filter(row => threshold === undefined || row.score >= threshold);
    });
  }

  async searchBM25(query: string, options: TextSearchOptions = {}): Promise<TextSearchResult[]> {
    this.#assertOpen();
    const { topK, where } = textOptions(query, options);
    await this.#init();
    if (!this.#bm25Initializing) this.#bm25Initializing = this.#transaction(async client => {
      const extension = await client.query("SELECT 1 FROM pg_extension WHERE extname='pg_search'");
      if (!extension.rows.length) invalid("searchBM25 requires the pg_search extension", "InvalidConfiguration");
      const operator = await client.query(`SELECT n.nspname AS schema FROM pg_operator o
        JOIN pg_namespace n ON n.oid=o.oprnamespace
        JOIN pg_depend d ON d.classid='pg_operator'::regclass AND d.objid=o.oid AND d.deptype='e'
        JOIN pg_extension e ON e.oid=d.refobjid
        WHERE e.extname='pg_search' AND o.oprname='|||' LIMIT 1`);
      if (!operator.rows.length) invalid("pg_search must provide its text match disjunction operator", "InvalidConfiguration");
      this.#bm25OperatorSchema = quote(operator.rows[0].schema);
      await client.query(`CREATE INDEX IF NOT EXISTS ${quote(this.#name + "_bm25")} ON ${this.#table}
        USING bm25 (sequence,search_text) WITH (key_field='sequence')`);
    }, true).catch(error => { this.#bm25Initializing = undefined; throw error; });
    await this.#bm25Initializing;
    return this.#transaction(async client => (await client.query(`SELECT id,created_at,content,pdb.score(sequence) AS score
      FROM ${this.#table} WHERE search_text OPERATOR(${this.#bm25OperatorSchema}.|||) $1::text AND ${where.sql}
      ORDER BY score DESC,sequence LIMIT $${where.values.length + 2}`, [query, ...where.values, topK])).rows.map(scored));
  }

  async searchNative(query: string, options: TextSearchOptions = {}): Promise<NativeSearchResult[]> {
    this.#assertOpen();
    const { topK, where } = textOptions(query, options);
    await this.#init();
    return this.#transaction(async client => (await client.query(`WITH terms AS (
      SELECT to_tsquery('simple'::regconfig,string_agg(quote_literal(lexeme),' | ')) AS query
      FROM unnest(tsvector_to_array(to_tsvector('simple'::regconfig,$1))) AS t(lexeme)
    ) SELECT id,created_at,content,ts_rank(to_tsvector('simple'::regconfig,search_text),terms.query) AS score
      FROM ${this.#table} CROSS JOIN terms
      WHERE to_tsvector('simple'::regconfig,search_text) @@ terms.query AND ${where.sql}
      ORDER BY score DESC,sequence LIMIT $${where.values.length + 2}`, [query, ...where.values, topK])).rows.map(scored));
  }

  async delete(selector: VectorDelete): Promise<number> {
    this.#assertOpen();
    object(selector, "delete selector");
    keys(selector, ["ids", "filter"]);
    if (Object.hasOwn(selector, "ids") === Object.hasOwn(selector, "filter")) invalid("Delete requires exactly one of ids or filter");
    let where;
    if (Object.hasOwn(selector, "ids")) {
      if (!Array.isArray(selector.ids) || !selector.ids.length) invalid("Delete IDs must be a nonempty array");
      const ids = Array.from(selector.ids);
      for (const id of ids) nonempty(id, "record id");
      where = { sql: "id=ANY($1::text[])", values: [ids] };
    } else where = predicate(selector.filter);
    await this.#init();
    return this.#transaction(async client => (await client.query(`DELETE FROM ${this.#table} WHERE ${where.sql}`, where.values)).rowCount ?? 0, true);
  }

  async close(): Promise<void> { this.#closed = true; }

  #assertOpen(): void { if (this.#closed) invalid("Vector store is closed", "InvalidState"); }

  #assertModel(): void {
    if (canonicalJson(identity(this.#embedding.ref)) !== canonicalJson(this.#model))
      invalid("Embedding model identity changed after opening the collection", "InvalidConfiguration");
  }

  async #dimensions(client: PoolClient): Promise<number | null> {
    const result = await client.query(`SELECT dimensions FROM ${this.#collections} WHERE name=$1`, [this.#collection]);
    return result.rows[0]?.dimensions ?? null;
  }

  async #init(): Promise<void> {
    this.#assertOpen();
    if (!this.#initializing) {
      this.#initializing = this.#transaction(async client => {
        const extension = await client.query("SELECT n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector'");
        if (!extension.rows.length) invalid("PostgreSQL vector store requires the vector extension", "InvalidConfiguration");
        this.#vectorSchema = quote(extension.rows[0].schema);
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${quote(this.#db.schema)}`);
        await client.query(`CREATE TABLE IF NOT EXISTS ${this.#collections} (name text PRIMARY KEY,model jsonb NOT NULL,dimensions integer CHECK(dimensions>0))`);
        await client.query(`INSERT INTO ${this.#collections}(name,model) VALUES($1,$2::jsonb) ON CONFLICT(name) DO NOTHING`, [this.#collection, canonicalJson(this.#model)]);
        const saved = await client.query(`SELECT model,dimensions FROM ${this.#collections} WHERE name=$1`, [this.#collection]);
        if (canonicalJson(saved.rows[0]?.model) !== canonicalJson(this.#model)) invalid("Existing collection has a different embedding model", "InvalidConfiguration");
        await client.query(`CREATE TABLE IF NOT EXISTS ${this.#table} (
          sequence bigserial PRIMARY KEY,id text NOT NULL UNIQUE,created_at text NOT NULL,
          content jsonb NOT NULL,vector jsonb NOT NULL,embedding ${this.#vectorSchema}.vector NOT NULL,
          search_text text GENERATED ALWAYS AS (content->>'text') STORED)`);
        await client.query(`CREATE INDEX IF NOT EXISTS ${quote(this.#name + "_native")} ON ${this.#table}
          USING gin (to_tsvector('simple'::regconfig,search_text))`);
      }, true, true).catch(error => { this.#initializing = undefined; throw error; });
    }
    await this.#initializing;
    this.#assertOpen();
  }

  async #transaction<T>(action: (client: PoolClient) => Promise<T>, lock = false, initialize = false): Promise<T> {
    this.#assertOpen();
    // Schema creation is shared across collections; writes lock only their collection.
    return transaction(this.#db, client => {
      this.#assertOpen();
      return action(client);
    }, lock || initialize ? [
      ...(initialize ? ["vector-schema"] : []),
      ...(lock ? ["vector:" + this.#collection] : []),
    ] : undefined);
  }
}

function quote(value: string): string { return '"' + value.replaceAll('"', '""') + '"'; }
function identity(ref: Readonly<ModelRef>): ModelRef {
  return { providerId: ref.providerId, modelId: ref.modelId, ...(ref.connectionId === undefined ? {} : { connectionId: ref.connectionId }) };
}
function record(row: Record<string, unknown>): VectorRecord {
  return { id: row.id as string, createdAt: row.created_at as string, content: row.content as Content | Chunk, vector: row.vector as number[] };
}
function scored(row: Record<string, unknown>): NativeSearchResult {
  return { id: row.id as string, createdAt: row.created_at as string, content: row.content as Content | Chunk, score: row.score as number };
}
function top(value: unknown): number {
  const topK = value === undefined ? 5 : value;
  if (typeof topK !== "number" || !Number.isSafeInteger(topK) || topK <= 0) invalid("topK must be a positive safe integer");
  return topK;
}
function textOptions(query: string, options: TextSearchOptions) {
  nonempty(query, "text query");
  if (query.includes("\u0000")) invalid("Text query must not contain NUL");
  object(options, "text search options");
  keys(options, ["topK", "filter"]);
  return { topK: top(options.topK), where: options.filter === undefined ? { sql: "true", values: [] } : predicate(options.filter, 2) };
}
