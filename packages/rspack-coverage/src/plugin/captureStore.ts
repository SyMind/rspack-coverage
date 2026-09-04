import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertSnapshotRecordSize } from "../shared/snapshotLimits.js";
import type {
  BuildReference,
  BuildReferenceStore,
  ExportUsageEdge,
  ExportUsageStore,
  ReferenceDirection,
} from "../shared/types.js";

function payload(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error("Capture spill database contains an invalid payload.");
}

export interface MutableCaptureSourceMap extends ReadonlyMap<string, string> {
  set(key: string, value: string): this;
  delete(key: string): boolean;
}

export interface MutableCaptureReferenceStore extends BuildReferenceStore {
  add(reference: BuildReference): boolean;
  finish(): void;
}

export interface MutableCaptureExportUsageStore extends ExportUsageStore {
  add(edge: ExportUsageEdge): boolean;
  finish(): void;
}

class CaptureSourceMap implements MutableCaptureSourceMap {
  readonly #get;
  readonly #has;
  readonly #set;
  readonly #delete;
  readonly #count;
  readonly #keys;
  readonly #entries;
  #cached: { key: string; value: string } | null = null;

  constructor(database: DatabaseSync) {
    this.#get = database.prepare("SELECT payload FROM sources WHERE key = ?");
    this.#has = database.prepare("SELECT 1 AS present FROM sources WHERE key = ?");
    this.#set = database.prepare(
      "INSERT INTO sources (key, payload) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET payload = excluded.payload",
    );
    this.#delete = database.prepare("DELETE FROM sources WHERE key = ?");
    this.#count = database.prepare("SELECT count(*) AS count FROM sources");
    this.#keys = database.prepare("SELECT key FROM sources ORDER BY key");
    this.#entries = database.prepare("SELECT key, payload FROM sources ORDER BY key");
  }

  get size(): number {
    return Number(this.#count.get()?.count ?? 0);
  }

  get(key: string): string | undefined {
    if (this.#cached?.key === key) return this.#cached.value;
    const row = this.#get.get(key);
    if (!row) return undefined;
    const value = payload(row.payload).toString("utf8");
    this.#cached = { key, value };
    return value;
  }

  has(key: string): boolean {
    return this.#cached?.key === key || Boolean(this.#has.get(key));
  }

  set(key: string, value: string): this {
    assertSnapshotRecordSize("original source", key, Buffer.byteLength(value));
    this.#set.run(key, Buffer.from(value));
    this.#cached = null;
    return this;
  }

  delete(key: string): boolean {
    const removed = Number(this.#delete.run(key).changes) > 0;
    if (this.#cached?.key === key) this.#cached = null;
    return removed;
  }

  *entries(): MapIterator<[string, string]> {
    for (const row of this.#entries.iterate()) {
      yield [String(row.key), payload(row.payload).toString("utf8")];
    }
  }

  *keys(): MapIterator<string> {
    for (const row of this.#keys.iterate()) yield String(row.key);
  }

  *values(): MapIterator<string> {
    for (const [, value] of this.entries()) yield value;
  }

  forEach(
    callbackfn: (value: string, key: string, map: ReadonlyMap<string, string>) => void,
  ): void {
    for (const [key, value] of this.entries()) callbackfn(value, key, this);
  }

  [Symbol.iterator](): MapIterator<[string, string]> {
    return this.entries();
  }
}

function decodeReference(row: Record<string, unknown>): BuildReference {
  return JSON.parse(payload(row.payload).toString("utf8")) as BuildReference;
}

class CaptureReferenceStore implements MutableCaptureReferenceStore {
  readonly #insert;
  readonly #byId;
  readonly #incomingCount;
  readonly #outgoingCount;
  readonly #bothCount;
  readonly #incomingPage;
  readonly #outgoingPage;
  readonly #bothPage;
  readonly #incomingOrigins;
  readonly #forTarget;
  readonly #all;
  readonly #count;
  #sequence = 0;
  #finished = false;

  constructor(private readonly database: DatabaseSync) {
    this.#insert = database.prepare(
      "INSERT OR IGNORE INTO refs (sequence, id, origin_id, target_id, payload) VALUES (?, ?, ?, ?, ?)",
    );
    this.#byId = database.prepare("SELECT payload FROM refs WHERE id = ?");
    this.#incomingCount = database.prepare(
      "SELECT count(*) AS count FROM refs WHERE target_id = ?",
    );
    this.#outgoingCount = database.prepare(
      "SELECT count(*) AS count FROM refs WHERE origin_id = ?",
    );
    this.#bothCount = database.prepare(
      "SELECT count(*) AS count FROM refs WHERE target_id = ? OR origin_id = ?",
    );
    this.#incomingPage = database.prepare(
      "SELECT payload FROM refs WHERE target_id = ? ORDER BY origin_id, target_id, id LIMIT ? OFFSET ?",
    );
    this.#outgoingPage = database.prepare(
      "SELECT payload FROM refs WHERE origin_id = ? ORDER BY origin_id, target_id, id LIMIT ? OFFSET ?",
    );
    this.#bothPage = database.prepare(
      "SELECT payload FROM refs WHERE target_id = ? OR origin_id = ? ORDER BY origin_id, target_id, id LIMIT ? OFFSET ?",
    );
    this.#incomingOrigins = database.prepare(
      "SELECT DISTINCT origin_id FROM refs WHERE target_id = ? ORDER BY origin_id",
    );
    this.#forTarget = database.prepare(
      "SELECT payload FROM refs WHERE target_id = ? ORDER BY origin_id, target_id, id",
    );
    this.#all = database.prepare("SELECT payload FROM refs ORDER BY origin_id, target_id, id");
    this.#count = database.prepare("SELECT count(*) AS count FROM refs");
  }

  get size(): number {
    return Number(this.#count.get()?.count ?? 0);
  }

  add(reference: BuildReference): boolean {
    const serialized = Buffer.from(JSON.stringify(reference));
    assertSnapshotRecordSize("reference", reference.id, serialized.byteLength);
    const result = this.#insert.run(
      this.#sequence,
      reference.id,
      reference.originId,
      reference.targetId,
      serialized,
    );
    if (Number(result.changes) === 0) return false;
    this.#sequence += 1;
    return true;
  }

  finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.database.exec(`
      COMMIT;
      CREATE INDEX IF NOT EXISTS capture_refs_origin ON refs (origin_id, target_id, id);
      CREATE INDEX IF NOT EXISTS capture_refs_target ON refs (target_id, origin_id, id);
      PRAGMA optimize;
    `);
  }

  get(id: string): BuildReference | undefined {
    const row = this.#byId.get(id);
    return row ? decodeReference(row) : undefined;
  }

  count(moduleId: string, direction: ReferenceDirection): number {
    const row =
      direction === "in"
        ? this.#incomingCount.get(moduleId)
        : direction === "out"
          ? this.#outgoingCount.get(moduleId)
          : this.#bothCount.get(moduleId, moduleId);
    return Number(row?.count ?? 0);
  }

  page(
    moduleId: string,
    direction: ReferenceDirection,
    cursor: number,
    limit: number,
  ): BuildReference[] {
    const rows =
      direction === "in"
        ? this.#incomingPage.all(moduleId, limit, cursor)
        : direction === "out"
          ? this.#outgoingPage.all(moduleId, limit, cursor)
          : this.#bothPage.all(moduleId, moduleId, limit, cursor);
    return rows.map(decodeReference);
  }

  incomingOrigins(moduleId: string): string[] {
    return [...this.#incomingOrigins.iterate(moduleId)].map((row) => String(row.origin_id));
  }

  countTargets(targetModuleIds: ReadonlySet<string>): number {
    let total = 0;
    for (const moduleId of targetModuleIds) {
      total += Number(this.#incomingCount.get(moduleId)?.count ?? 0);
    }
    return total;
  }

  forTargets(targetModuleIds: ReadonlySet<string>): BuildReference[] {
    const output: BuildReference[] = [];
    for (const moduleId of targetModuleIds) {
      for (const row of this.#forTarget.iterate(moduleId)) output.push(decodeReference(row));
    }
    return output;
  }

  *entries(): IterableIterator<BuildReference> {
    for (const row of this.#all.iterate()) yield decodeReference(row);
  }
}

function decodeExportUsageEdge(row: Record<string, unknown>): ExportUsageEdge {
  return JSON.parse(payload(row.payload).toString("utf8")) as ExportUsageEdge;
}

class CaptureExportUsageStore implements MutableCaptureExportUsageStore {
  readonly #insert;
  readonly #insertTarget;
  readonly #byId;
  readonly #targetCount;
  readonly #targetPage;
  readonly #all;
  readonly #count;
  #sequence = 0;
  #started = false;
  #finished = false;

  constructor(private readonly database: DatabaseSync) {
    this.#insert = database.prepare(
      "INSERT OR IGNORE INTO export_usage_edges (sequence, id, origin_id, target_id, target_export, payload) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.#insertTarget = database.prepare(
      "INSERT OR IGNORE INTO export_usage_targets (sequence, target_id, target_export) VALUES (?, ?, ?)",
    );
    this.#byId = database.prepare("SELECT payload FROM export_usage_edges WHERE id = ?");
    this.#targetCount = database.prepare(
      "SELECT count(*) AS count FROM export_usage_targets WHERE target_id = ? AND target_export = ?",
    );
    this.#targetPage = database.prepare(
      "SELECT edge.payload FROM export_usage_targets AS target JOIN export_usage_edges AS edge USING (sequence) WHERE target.target_id = ? AND target.target_export = ? ORDER BY target.sequence LIMIT ? OFFSET ?",
    );
    this.#all = database.prepare("SELECT payload FROM export_usage_edges ORDER BY sequence");
    this.#count = database.prepare("SELECT count(*) AS count FROM export_usage_edges");
  }

  get size(): number {
    return Number(this.#count.get()?.count ?? 0);
  }

  add(edge: ExportUsageEdge): boolean {
    if (this.#finished) throw new Error("Export usage capture is already finalized.");
    if (!this.#started) {
      this.database.exec("BEGIN IMMEDIATE;");
      this.#started = true;
    }
    const serialized = Buffer.from(JSON.stringify(edge));
    assertSnapshotRecordSize("export usage edge", edge.id, serialized.byteLength);
    const result = this.#insert.run(
      this.#sequence,
      edge.id,
      edge.originModuleId,
      edge.targetModuleId,
      JSON.stringify(edge.targetExport),
      serialized,
    );
    if (Number(result.changes) === 0) return false;
    for (let length = 1; length <= (edge.targetExport?.length ?? 0); length += 1) {
      this.#insertTarget.run(
        this.#sequence,
        edge.targetModuleId,
        JSON.stringify(edge.targetExport?.slice(0, length)),
      );
    }
    this.#sequence += 1;
    return true;
  }

  finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    if (this.#started) this.database.exec("COMMIT;");
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS capture_export_usage_target
        ON export_usage_targets (target_id, target_export, sequence);
      PRAGMA optimize;
    `);
  }

  get(id: string): ExportUsageEdge | undefined {
    const row = this.#byId.get(id);
    return row ? decodeExportUsageEdge(row) : undefined;
  }

  countTarget(moduleId: string, exportPath: readonly string[]): number {
    return Number(this.#targetCount.get(moduleId, JSON.stringify(exportPath))?.count ?? 0);
  }

  pageTarget(
    moduleId: string,
    exportPath: readonly string[],
    cursor: number,
    limit: number,
  ): ExportUsageEdge[] {
    return this.#targetPage
      .all(moduleId, JSON.stringify(exportPath), limit, cursor)
      .map(decodeExportUsageEdge);
  }

  *entries(): IterableIterator<ExportUsageEdge> {
    for (const row of this.#all.iterate()) yield decodeExportUsageEdge(row);
  }
}

export class CapturePayloadStore {
  readonly directory = mkdtempSync(join(tmpdir(), "rspack-coverage-capture-"));
  readonly database = new DatabaseSync(join(this.directory, "capture.sqlite"));
  readonly sources: MutableCaptureSourceMap;
  readonly references: MutableCaptureReferenceStore;
  readonly exportUsage: MutableCaptureExportUsageStore;
  #disposed = false;

  constructor() {
    this.database.exec(`
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;
      PRAGMA temp_store = FILE;
      PRAGMA cache_size = -16384;
      PRAGMA mmap_size = 0;
      CREATE TABLE sources (
        key TEXT PRIMARY KEY,
        payload BLOB NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE refs (
        sequence INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        origin_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        payload BLOB NOT NULL
      );
      CREATE TABLE export_usage_edges (
        sequence INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        origin_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        target_export TEXT NOT NULL,
        payload BLOB NOT NULL
      );
      CREATE TABLE export_usage_targets (
        sequence INTEGER NOT NULL,
        target_id TEXT NOT NULL,
        target_export TEXT NOT NULL,
        PRIMARY KEY (sequence, target_export)
      ) WITHOUT ROWID;
      BEGIN IMMEDIATE;
    `);
    this.sources = new CaptureSourceMap(this.database);
    this.references = new CaptureReferenceStore(this.database);
    this.exportUsage = new CaptureExportUsageStore(this.database);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.database.close();
    rmSync(this.directory, { recursive: true, force: true });
  }
}
