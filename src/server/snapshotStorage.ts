import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertSnapshotRecordSize } from "../shared/snapshotLimits.js";
import type {
  BuildReference,
  BuildReferenceStore,
  BuildSnapshot,
  ExportGraphModule,
  ExportGraphStore,
  ExportReferenceEdge,
  ModuleCodeGeneration,
  RawSourceMapPayload,
  ReferenceDirection,
} from "../shared/types.js";
import type { StagedCoverageSnapshot } from "./coverageAnalysisRunner.js";

export const SNAPSHOT_FORMAT_VERSION = 2 as const;
export const DEFAULT_DATA_DIRECTORY = join("node_modules", ".cache", "rspack-coverage");
const SQLITE_CACHE_KIB = 32 * 1024;
const PAYLOAD_DATABASE_FILE = "snapshot.sqlite";

export interface StoredFile {
  file: string;
  bytes: number;
  sha256: string;
}

export interface StoredMapEntry {
  key: string;
  value: StoredFile;
}

export interface PersistedSnapshotMetadata {
  version: 2;
  snapshotId: string;
  manifest: BuildSnapshot["manifest"];
  outputPath: string;
  indexAsset: string | null;
  assets: StoredMapEntry[];
  maps: StoredMapEntry[];
  database: StoredFile;
  coverageSnapshot: StoredFile;
  memory: {
    sqliteCacheKiB: number;
    payloadsLoadedOnDemand: true;
  };
}

interface LatestSnapshotPointer {
  version: 2;
  snapshotId: string;
  buildHash: string;
  updatedAt: number;
}

type SnapshotDigest = ReturnType<typeof createHash>;
type PayloadTable = "sources" | "code_generation";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function updateDigest(digest: SnapshotDigest, kind: string, key: string, content: Buffer): void {
  digest.update(`${kind.length}:${kind}${key.length}:${key}${content.byteLength}:`);
  digest.update(content);
}

function checksum(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function checksumFile(file: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

function storedPath(directory: string, value: string): string {
  if (!value || isAbsolute(value)) throw new Error(`Invalid absolute snapshot path: ${value}`);
  const file = resolve(directory, value);
  const relativeFile = relative(directory, file);
  if (
    !relativeFile ||
    relativeFile === ".." ||
    relativeFile.startsWith(`..${sep}`) ||
    isAbsolute(relativeFile)
  ) {
    throw new Error(`Snapshot path escapes its directory: ${value}`);
  }
  return file;
}

function validateStoredFile(directory: string, value: StoredFile): string {
  if (
    !value ||
    typeof value.file !== "string" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  ) {
    throw new Error("Snapshot contains an invalid file record.");
  }
  const file = storedPath(directory, value.file);
  const stats = statSync(file);
  if (!stats.isFile() || stats.size !== value.bytes) {
    throw new Error(`Snapshot file has an unexpected size: ${value.file}`);
  }
  return file;
}

function readStoredFile(directory: string, value: StoredFile): Buffer {
  const file = validateStoredFile(directory, value);
  const content = readFileSync(file);
  if (checksum(content) !== value.sha256) {
    throw new Error(`Snapshot file failed its checksum: ${value.file}`);
  }
  return content;
}

async function writeStoredFile(
  directory: string,
  relativeFile: string,
  content: Buffer,
  digest?: { value: SnapshotDigest; kind: string; key: string },
): Promise<StoredFile> {
  const file = storedPath(directory, relativeFile);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, { flag: "wx" });
  if (digest) updateDigest(digest.value, digest.kind, digest.key, content);
  return { file: relativeFile, bytes: content.byteLength, sha256: checksum(content) };
}

async function recordStoredFile(directory: string, relativeFile: string): Promise<StoredFile> {
  const file = storedPath(directory, relativeFile);
  const stats = await stat(file);
  if (!stats.isFile()) throw new Error(`Snapshot payload is not a file: ${relativeFile}`);
  return {
    file: relativeFile,
    bytes: stats.size,
    sha256: await checksumFile(file),
  };
}

function parseJson<T>(content: Buffer, label: string): T {
  try {
    return JSON.parse(content.toString("utf8")) as T;
  } catch (error) {
    throw new Error(`Could not parse ${label}: ${errorMessage(error)}`);
  }
}

function jsonPayload(family: string, key: string, value: unknown): Buffer {
  const content = Buffer.from(JSON.stringify(value));
  assertSnapshotRecordSize(family, key, content.byteLength);
  return content;
}

function estimateSourceMapBytes(map: RawSourceMapPayload): number {
  let bytes = Buffer.byteLength(map.mappings);
  for (const source of map.sources) bytes += Buffer.byteLength(source);
  for (const name of map.names) bytes += Buffer.byteLength(name);
  for (const content of map.sourcesContent ?? []) {
    if (content !== null) bytes += Buffer.byteLength(content);
  }
  return bytes;
}

function bufferValue(value: unknown, label: string): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array)
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === "string") return Buffer.from(value);
  throw new Error(`Snapshot database contains an invalid ${label} payload.`);
}

function cacheSet<T>(cache: Map<string, T>, key: string, value: T, limit: number): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

class LazyStoredMap<T> implements ReadonlyMap<string, T> {
  readonly #records: Map<string, StoredFile>;
  readonly #cache = new Map<string, T>();

  constructor(
    private readonly directory: string,
    entries: StoredMapEntry[],
    private readonly decode: (content: Buffer) => T,
    private readonly cacheLimit = 2,
  ) {
    this.#records = new Map(entries.map((entry) => [entry.key, entry.value]));
    if (this.#records.size !== entries.length) {
      throw new Error("Snapshot contains duplicate stored-map keys.");
    }
  }

  get size(): number {
    return this.#records.size;
  }

  get(key: string): T | undefined {
    const cached = this.#cache.get(key);
    if (cached !== undefined || this.#cache.has(key)) {
      this.#cache.delete(key);
      this.#cache.set(key, cached as T);
      return cached;
    }
    const record = this.#records.get(key);
    if (!record) return undefined;
    const value = this.decode(readStoredFile(this.directory, record));
    cacheSet(this.#cache, key, value, this.cacheLimit);
    return value;
  }

  has(key: string): boolean {
    return this.#records.has(key);
  }

  *entries(): MapIterator<[string, T]> {
    for (const key of this.#records.keys()) {
      const value = this.get(key);
      if (value !== undefined) yield [key, value];
    }
  }

  keys(): MapIterator<string> {
    return this.#records.keys();
  }

  *values(): MapIterator<T> {
    for (const [, value] of this.entries()) yield value;
  }

  forEach(callbackfn: (value: T, key: string, map: ReadonlyMap<string, T>) => void): void {
    for (const [key, value] of this.entries()) callbackfn(value, key, this);
  }

  [Symbol.iterator](): MapIterator<[string, T]> {
    return this.entries();
  }
}

class SqliteStoredMap<T> implements ReadonlyMap<string, T> {
  readonly #cache = new Map<string, T>();
  readonly #get;
  readonly #has;
  readonly #count;
  readonly #keys;
  readonly #entries;

  constructor(
    database: DatabaseSync,
    table: PayloadTable,
    private readonly decode: (content: Buffer) => T,
    private readonly cacheLimit = 1,
  ) {
    this.#get = database.prepare(`SELECT payload FROM ${table} WHERE key = ?`);
    this.#has = database.prepare(`SELECT 1 AS present FROM ${table} WHERE key = ?`);
    this.#count = database.prepare(`SELECT count(*) AS count FROM ${table}`);
    this.#keys = database.prepare(`SELECT key FROM ${table} ORDER BY key`);
    this.#entries = database.prepare(`SELECT key, payload FROM ${table} ORDER BY key`);
  }

  get size(): number {
    return Number(this.#count.get()?.count ?? 0);
  }

  get(key: string): T | undefined {
    const cached = this.#cache.get(key);
    if (cached !== undefined || this.#cache.has(key)) {
      this.#cache.delete(key);
      this.#cache.set(key, cached as T);
      return cached;
    }
    const row = this.#get.get(key);
    if (!row) return undefined;
    const value = this.decode(bufferValue(row.payload, "stored map"));
    cacheSet(this.#cache, key, value, this.cacheLimit);
    return value;
  }

  has(key: string): boolean {
    return this.#cache.has(key) || Boolean(this.#has.get(key));
  }

  *entries(): MapIterator<[string, T]> {
    for (const row of this.#entries.iterate()) {
      const key = String(row.key);
      const value = this.decode(bufferValue(row.payload, "stored map"));
      cacheSet(this.#cache, key, value, this.cacheLimit);
      yield [key, value];
    }
  }

  *keys(): MapIterator<string> {
    for (const row of this.#keys.iterate()) yield String(row.key);
  }

  *values(): MapIterator<T> {
    for (const [, value] of this.entries()) yield value;
  }

  forEach(callbackfn: (value: T, key: string, map: ReadonlyMap<string, T>) => void): void {
    for (const [key, value] of this.entries()) callbackfn(value, key, this);
  }

  [Symbol.iterator](): MapIterator<[string, T]> {
    return this.entries();
  }
}

function decodeReference(row: Record<string, unknown>): BuildReference {
  return parseJson<BuildReference>(bufferValue(row.payload, "reference"), "reference");
}

class SqliteReferenceStore implements BuildReferenceStore {
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
  readonly #cache = new Map<string, BuildReference>();

  constructor(database: DatabaseSync) {
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
      "SELECT payload FROM refs WHERE target_id = ? ORDER BY sequence LIMIT ? OFFSET ?",
    );
    this.#outgoingPage = database.prepare(
      "SELECT payload FROM refs WHERE origin_id = ? ORDER BY sequence LIMIT ? OFFSET ?",
    );
    this.#bothPage = database.prepare(
      "SELECT payload FROM refs WHERE target_id = ? OR origin_id = ? ORDER BY sequence LIMIT ? OFFSET ?",
    );
    this.#incomingOrigins = database.prepare(
      "SELECT DISTINCT origin_id FROM refs WHERE target_id = ? ORDER BY origin_id",
    );
    this.#forTarget = database.prepare(
      "SELECT payload FROM refs WHERE target_id = ? ORDER BY sequence",
    );
    this.#all = database.prepare("SELECT payload FROM refs ORDER BY sequence");
    this.#count = database.prepare("SELECT count(*) AS count FROM refs");
  }

  get size(): number {
    return Number(this.#count.get()?.count ?? 0);
  }

  get(id: string): BuildReference | undefined {
    const cached = this.#cache.get(id);
    if (cached) {
      this.#cache.delete(id);
      this.#cache.set(id, cached);
      return cached;
    }
    const row = this.#byId.get(id);
    if (!row) return undefined;
    const reference = decodeReference(row);
    cacheSet(this.#cache, id, reference, 128);
    return reference;
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
    return rows.map((row) => {
      const reference = decodeReference(row);
      cacheSet(this.#cache, reference.id, reference, 128);
      return reference;
    });
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

class SqliteExportGraphStore implements ExportGraphStore {
  readonly #module;
  readonly #source;
  readonly #edges;
  readonly #moduleCache = new Map<string, ExportGraphModule>();

  constructor(database: DatabaseSync) {
    this.#module = database.prepare("SELECT payload FROM export_modules WHERE id = ?");
    this.#source = database.prepare("SELECT module_ids FROM export_sources WHERE source = ?");
    this.#edges = database.prepare(
      "SELECT payload FROM export_edges WHERE target_id = ? ORDER BY sequence",
    );
  }

  getModule(moduleId: string): ExportGraphModule | undefined {
    const cached = this.#moduleCache.get(moduleId);
    if (cached) {
      this.#moduleCache.delete(moduleId);
      this.#moduleCache.set(moduleId, cached);
      return cached;
    }
    const row = this.#module.get(moduleId);
    if (!row) return undefined;
    const module = parseJson<ExportGraphModule>(
      bufferValue(row.payload, "export module"),
      "export graph module",
    );
    cacheSet(this.#moduleCache, moduleId, module, 32);
    return module;
  }

  moduleIdsForSource(source: string): string[] {
    const row = this.#source.get(source);
    return row
      ? parseJson<string[]>(
          bufferValue(row.module_ids, "export source index"),
          "export source index",
        )
      : [];
  }

  edgesForTargets(targetModuleIds: ReadonlySet<string>): ExportReferenceEdge[] {
    const output: ExportReferenceEdge[] = [];
    for (const moduleId of targetModuleIds) {
      for (const row of this.#edges.iterate(moduleId)) {
        output.push(
          parseJson<ExportReferenceEdge>(
            bufferValue(row.payload, "export edge"),
            "export graph edge",
          ),
        );
      }
    }
    return output;
  }
}

function configureReader(database: DatabaseSync): void {
  database.exec(`
    PRAGMA query_only = ON;
    PRAGMA temp_store = FILE;
    PRAGMA cache_size = -${SQLITE_CACHE_KIB};
    PRAGMA mmap_size = 0;
  `);
}

function createPayloadDatabase(file: string): DatabaseSync {
  const database = new DatabaseSync(file);
  database.exec(`
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    PRAGMA temp_store = FILE;
    PRAGMA cache_size = -${SQLITE_CACHE_KIB};
    PRAGMA mmap_size = 0;
    CREATE TABLE sources (
      key TEXT PRIMARY KEY,
      payload BLOB NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE code_generation (
      key TEXT PRIMARY KEY,
      payload BLOB NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE export_modules (
      id TEXT PRIMARY KEY,
      payload BLOB NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE export_sources (
      source TEXT PRIMARY KEY,
      module_ids BLOB NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE export_edges (
      sequence INTEGER PRIMARY KEY,
      origin_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      payload BLOB NOT NULL
    );
    CREATE TABLE refs (
      sequence INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      origin_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      payload BLOB NOT NULL
    );
  `);
  return database;
}

function codeGenerationEntries(
  snapshot: BuildSnapshot,
): Iterable<readonly [string, ModuleCodeGeneration[]]> {
  const ids = new Set<string>([
    ...snapshot.manifest.modules.map((module) => module.id),
    ...snapshot.codeGeneration.keys(),
  ]);
  return {
    *[Symbol.iterator]() {
      for (const id of ids) {
        const records = snapshot.codeGeneration.get(id) ?? snapshot.loadCodeGeneration?.(id) ?? [];
        try {
          if (records.length > 0) yield [id, records] as const;
        } finally {
          snapshot.releaseCodeGeneration?.(id);
        }
      }
    },
  };
}

function writePayloads(
  database: DatabaseSync,
  snapshot: BuildSnapshot,
  digest: SnapshotDigest,
): number {
  const insertSource = database.prepare("INSERT INTO sources (key, payload) VALUES (?, ?)");
  const insertCodeGeneration = database.prepare(
    "INSERT INTO code_generation (key, payload) VALUES (?, ?)",
  );
  const insertExportModule = database.prepare(
    "INSERT INTO export_modules (id, payload) VALUES (?, ?)",
  );
  const insertExportSource = database.prepare(
    "INSERT INTO export_sources (source, module_ids) VALUES (?, ?)",
  );
  const insertExportEdge = database.prepare(
    "INSERT INTO export_edges (sequence, origin_id, target_id, payload) VALUES (?, ?, ?, ?)",
  );
  const insertReference = database.prepare(
    "INSERT INTO refs (sequence, id, origin_id, target_id, payload) VALUES (?, ?, ?, ?, ?)",
  );

  let codeGenerationSources = 0;
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const [key, content] of snapshot.originalSources) {
      assertSnapshotRecordSize("original source", key, Buffer.byteLength(content));
      const payload = Buffer.from(content);
      insertSource.run(key, payload);
      updateDigest(digest, "source", key, payload);
    }
    for (const [key, records] of codeGenerationEntries(snapshot)) {
      for (const record of records) {
        assertSnapshotRecordSize(
          "module code generation",
          key,
          Buffer.byteLength(record.content) + (record.map ? estimateSourceMapBytes(record.map) : 0),
        );
      }
      const payload = jsonPayload("module code generation", key, records);
      insertCodeGeneration.run(key, payload);
      updateDigest(digest, "code-generation", key, payload);
      codeGenerationSources += 1;
    }
    for (const module of snapshot.exportGraph.modules) {
      const payload = jsonPayload("export graph module", module.id, module);
      insertExportModule.run(module.id, payload);
      updateDigest(digest, "export-module", module.id, payload);
    }
    for (const [source, moduleIds] of Object.entries(snapshot.exportGraph.sourceToModuleIds)) {
      const payload = jsonPayload("export source index", source, moduleIds);
      insertExportSource.run(source, payload);
      updateDigest(digest, "export-source", source, payload);
    }
    for (let index = 0; index < snapshot.exportGraph.edges.length; index += 1) {
      const edge = snapshot.exportGraph.edges[index];
      if (!edge) continue;
      const payload = jsonPayload("export graph edge", String(index), edge);
      insertExportEdge.run(index, edge.originModuleId, edge.targetModuleId, payload);
      updateDigest(digest, "export-edge", String(index), payload);
    }
    let referenceIndex = 0;
    const references = snapshot.referenceStore?.entries() ?? snapshot.references.values();
    for (const reference of references) {
      const payload = jsonPayload("reference", reference.id, reference);
      insertReference.run(
        referenceIndex,
        reference.id,
        reference.originId,
        reference.targetId,
        payload,
      );
      updateDigest(digest, "reference", String(referenceIndex), payload);
      referenceIndex += 1;
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  database.exec(`
    CREATE INDEX export_edges_target ON export_edges (target_id, sequence);
    CREATE INDEX refs_origin ON refs (origin_id, sequence);
    CREATE INDEX refs_target ON refs (target_id, sequence);
    PRAGMA optimize;
  `);
  return codeGenerationSources;
}

function assertSnapshotId(value: string): void {
  if (!/^v2-[a-f0-9]{32}$/.test(value)) {
    throw new Error(`Invalid snapshot id: ${value}`);
  }
}

export async function readBuildSnapshotMetadata(
  directory: string,
  expectedId?: string,
): Promise<PersistedSnapshotMetadata> {
  const metadataFile = join(directory, "metadata.json");
  const metadataStats = await stat(metadataFile);
  assertSnapshotRecordSize("snapshot metadata", "metadata.json", metadataStats.size);
  const metadata = parseJson<PersistedSnapshotMetadata>(
    await readFile(metadataFile),
    "snapshot metadata",
  );
  if (metadata.version !== SNAPSHOT_FORMAT_VERSION) {
    throw new Error(
      `Unsupported Rspack Coverage snapshot version ${String(metadata.version)}; expected ${SNAPSHOT_FORMAT_VERSION}.`,
    );
  }
  assertSnapshotId(metadata.snapshotId);
  if (expectedId && metadata.snapshotId !== expectedId) {
    throw new Error("The latest pointer does not match the stored snapshot.");
  }
  if (
    !metadata.manifest ||
    typeof metadata.manifest.hash !== "string" ||
    metadata.manifest.hash.length === 0 ||
    !Array.isArray(metadata.assets) ||
    !Array.isArray(metadata.maps) ||
    typeof metadata.outputPath !== "string" ||
    metadata.memory?.payloadsLoadedOnDemand !== true
  ) {
    throw new Error("Snapshot build manifest is missing.");
  }
  return metadata;
}

function openPayloadDatabase(directory: string, stored: StoredFile): DatabaseSync {
  const file = validateStoredFile(directory, stored);
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    configureReader(database);
    const result = database.prepare("PRAGMA quick_check(1)").get();
    if (result?.quick_check !== "ok") throw new Error("Snapshot database failed quick_check.");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function createStoredSnapshot(
  directory: string,
  metadata: PersistedSnapshotMetadata,
): BuildSnapshot {
  const assets = new LazyStoredMap(directory, metadata.assets, (content) => content, 2);
  const maps = new LazyStoredMap(
    directory,
    metadata.maps,
    (content) => parseJson<RawSourceMapPayload>(content, "source map"),
    1,
  );
  const mapPayloads = new LazyStoredMap(directory, metadata.maps, (content) => content, 1);
  const database = openPayloadDatabase(directory, metadata.database);
  const originalSources = new SqliteStoredMap(
    database,
    "sources",
    (content) => content.toString("utf8"),
    1,
  );
  const codeGeneration = new SqliteStoredMap(
    database,
    "code_generation",
    (content) => parseJson<ModuleCodeGeneration[]>(content, "module code generation"),
    2,
  );
  return {
    manifest: metadata.manifest,
    assets,
    maps,
    mapPayloads,
    originalSources,
    exportGraph: { modules: [], edges: [], sourceToModuleIds: {} },
    exportGraphStore: new SqliteExportGraphStore(database),
    references: [],
    referenceStore: new SqliteReferenceStore(database),
    codeGeneration,
    outputPath: metadata.outputPath,
    indexAsset: metadata.indexAsset,
    storage: {
      version: SNAPSHOT_FORMAT_VERSION,
      snapshotId: metadata.snapshotId,
      directory,
    },
    dispose: () => database.close(),
  };
}

async function writeLatestPointer(
  dataDirectory: string,
  pointer: LatestSnapshotPointer,
): Promise<void> {
  const temporary = join(dataDirectory, `.latest-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(pointer), { flag: "wx" });
  try {
    await rename(temporary, join(dataDirectory, "latest.json"));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function pruneOldSnapshots(
  snapshotsDirectory: string,
  currentId: string,
  previousId?: string | null,
): Promise<void> {
  const candidates = await Promise.all(
    (await readdir(snapshotsDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^v\d+-[a-f0-9]{32}$/.test(entry.name))
      .map(async (entry) => ({
        id: entry.name,
        modifiedAt: (await stat(join(snapshotsDirectory, entry.name))).mtimeMs,
      })),
  );
  const retained = new Set(
    [
      currentId,
      previousId && previousId !== currentId ? previousId : null,
      ...candidates
        .filter((candidate) => candidate.id !== currentId && candidate.id !== previousId)
        .sort((left, right) => right.modifiedAt - left.modifiedAt)
        .slice(0, previousId && previousId !== currentId ? 0 : 1)
        .map((candidate) => candidate.id),
    ].filter(Boolean),
  );
  await Promise.all(
    candidates
      .filter((candidate) => !retained.has(candidate.id))
      .map((candidate) =>
        rm(join(snapshotsDirectory, candidate.id), { recursive: true, force: true }),
      ),
  );
}

const OPTIONAL_SNAPSHOT_FILES = [
  "coverage.json",
  "report.json",
  "report.sources",
  "report.sources.index.json",
] as const;

function metadataIdentity(metadata: PersistedSnapshotMetadata): string {
  return JSON.stringify({
    version: metadata.version,
    snapshotId: metadata.snapshotId,
    manifest: { ...metadata.manifest, builtAt: 0 },
    outputPath: metadata.outputPath,
    indexAsset: metadata.indexAsset,
    assets: metadata.assets,
    maps: metadata.maps,
    database: metadata.database,
    coverageSnapshot: metadata.coverageSnapshot,
  });
}

async function replaceImportedOptionalFiles(
  temporaryDirectory: string,
  finalDirectory: string,
): Promise<void> {
  const transaction = randomUUID();
  const names = OPTIONAL_SNAPSHOT_FILES.filter((name) =>
    existsSync(join(temporaryDirectory, name)),
  );
  const staged = new Map<string, string>();
  const backups = new Map<string, string>();
  const installed = new Set<string>();
  try {
    for (const name of names) {
      const file = join(finalDirectory, `.${name}-${transaction}.staged`);
      await rename(join(temporaryDirectory, name), file);
      staged.set(name, file);
    }
    for (const name of names) {
      const target = join(finalDirectory, name);
      if (!existsSync(target)) continue;
      const backup = join(finalDirectory, `.${name}-${transaction}.backup`);
      await rename(target, backup);
      backups.set(name, backup);
    }
    for (const name of names) {
      const source = staged.get(name);
      if (!source) continue;
      await rename(source, join(finalDirectory, name));
      installed.add(name);
    }
  } catch (error) {
    await Promise.all(
      [...installed].map((name) => rm(join(finalDirectory, name), { force: true })),
    );
    await Promise.all(
      [...backups].map(([name, backup]) =>
        rename(backup, join(finalDirectory, name)).catch(() => undefined),
      ),
    );
    await Promise.all([...staged.values()].map((file) => rm(file, { force: true })));
    throw error;
  }
  await Promise.all([...backups.values()].map((file) => rm(file, { force: true })));
}

/**
 * Atomically activates a fully extracted snapshot directory. The caller must
 * validate the portable container before calling this function.
 */
export async function installImportedBuildSnapshot(
  temporaryDirectory: string,
  dataDirectory: string,
  previousSnapshotId?: string | null,
): Promise<BuildSnapshot> {
  const metadata = await readBuildSnapshotMetadata(temporaryDirectory);
  const validatedSnapshot = createStoredSnapshot(temporaryDirectory, metadata);
  validatedSnapshot.dispose?.();

  const snapshotsDirectory = join(dataDirectory, "snapshots");
  const finalDirectory = join(snapshotsDirectory, metadata.snapshotId);
  await mkdir(snapshotsDirectory, { recursive: true });

  if (existsSync(finalDirectory)) {
    const existing = await readBuildSnapshotMetadata(finalDirectory, metadata.snapshotId);
    if (metadataIdentity(existing) !== metadataIdentity(metadata)) {
      throw new Error(
        `Snapshot ${metadata.snapshotId} conflicts with different data already stored locally.`,
      );
    }
    await replaceImportedOptionalFiles(temporaryDirectory, finalDirectory);
    await rm(temporaryDirectory, { recursive: true, force: true });
  } else {
    await rename(temporaryDirectory, finalDirectory);
  }

  await writeLatestPointer(dataDirectory, {
    version: SNAPSHOT_FORMAT_VERSION,
    snapshotId: metadata.snapshotId,
    buildHash: metadata.manifest.hash,
    updatedAt: Date.now(),
  });
  await pruneOldSnapshots(snapshotsDirectory, metadata.snapshotId, previousSnapshotId).catch(
    () => undefined,
  );
  return createStoredSnapshot(
    finalDirectory,
    await readBuildSnapshotMetadata(finalDirectory, metadata.snapshotId),
  );
}

export function resolveCoverageDataDirectory(
  context: string,
  configured: string | false | undefined,
): string | null {
  if (configured === false) return null;
  const value = configured ?? DEFAULT_DATA_DIRECTORY;
  return isAbsolute(value) ? resolve(value) : resolve(context, value);
}

export async function persistBuildSnapshot(
  snapshot: BuildSnapshot,
  dataDirectory: string,
): Promise<BuildSnapshot> {
  const snapshotsDirectory = join(dataDirectory, "snapshots");
  const temporaryDirectory = join(snapshotsDirectory, `.tmp-${randomUUID()}`);
  const digest = createHash("sha256");
  await mkdir(temporaryDirectory, { recursive: true });

  try {
    const assets: StoredMapEntry[] = [];
    let assetIndex = 0;
    for (const key of snapshot.assets.keys()) {
      const content = snapshot.assets.get(key);
      if (!content) continue;
      assertSnapshotRecordSize("asset", key, content.byteLength);
      const value = await writeStoredFile(temporaryDirectory, `assets/${assetIndex}.bin`, content, {
        value: digest,
        kind: "asset",
        key,
      });
      assets.push({ key, value });
      assetIndex += 1;
    }

    const maps: StoredMapEntry[] = [];
    let mapIndex = 0;
    const mapKeys = new Set([...snapshot.maps.keys(), ...(snapshot.mapPayloads?.keys() ?? [])]);
    for (const key of mapKeys) {
      const rawPayload = snapshot.mapPayloads?.get(key);
      const sourceMap = rawPayload ? undefined : snapshot.maps.get(key);
      if (!rawPayload && !sourceMap) continue;
      if (rawPayload) {
        assertSnapshotRecordSize("source map", key, rawPayload.byteLength);
      } else if (sourceMap) {
        assertSnapshotRecordSize("source map", key, estimateSourceMapBytes(sourceMap));
      }
      const value = await writeStoredFile(
        temporaryDirectory,
        `maps/${mapIndex}.json`,
        rawPayload ?? jsonPayload("source map", key, sourceMap),
        { value: digest, kind: "map", key },
      );
      maps.push({ key, value });
      mapIndex += 1;
    }

    const databaseFile = storedPath(temporaryDirectory, PAYLOAD_DATABASE_FILE);
    const database = createPayloadDatabase(databaseFile);
    let codeGenerationSources: number;
    try {
      codeGenerationSources = writePayloads(database, snapshot, digest);
    } finally {
      database.close();
    }
    const databaseRecord = await recordStoredFile(temporaryDirectory, PAYLOAD_DATABASE_FILE);
    const manifest: BuildSnapshot["manifest"] = {
      ...snapshot.manifest,
      counts: {
        ...snapshot.manifest.counts,
        references: snapshot.referenceStore?.size ?? snapshot.references.length,
        codeGenerationSources,
      },
    };
    updateDigest(
      digest,
      "manifest",
      "build",
      Buffer.from(JSON.stringify({ ...manifest, builtAt: 0 })),
    );
    updateDigest(digest, "path", "output", Buffer.from(snapshot.outputPath));
    updateDigest(digest, "path", "index", Buffer.from(snapshot.indexAsset ?? ""));

    const stagedAssets: StagedCoverageSnapshot["assets"] = {};
    const assetFiles = new Map(assets.map((entry) => [entry.key, entry.value.file]));
    const mapFiles = new Map(maps.map((entry) => [entry.key, entry.value.file]));
    for (const asset of manifest.assets) {
      const contentFile = assetFiles.get(asset.id);
      if (!contentFile) continue;
      stagedAssets[asset.id] = {
        contentFile,
        mapFile: mapFiles.get(asset.id) ?? null,
      };
    }
    const staged: StagedCoverageSnapshot = {
      build: manifest,
      assets: stagedAssets,
      sources: [],
      sourceDatabaseFile: PAYLOAD_DATABASE_FILE,
    };
    const coverageSnapshot = await writeStoredFile(
      temporaryDirectory,
      "snapshot.json",
      Buffer.from(JSON.stringify(staged)),
    );

    const snapshotId = `v2-${digest.digest("hex").slice(0, 32)}`;
    const metadata: PersistedSnapshotMetadata = {
      version: SNAPSHOT_FORMAT_VERSION,
      snapshotId,
      manifest,
      outputPath: snapshot.outputPath,
      indexAsset: snapshot.indexAsset,
      assets,
      maps,
      database: databaseRecord,
      coverageSnapshot,
      memory: {
        sqliteCacheKiB: SQLITE_CACHE_KIB,
        payloadsLoadedOnDemand: true,
      },
    };
    await writeFile(join(temporaryDirectory, "metadata.json"), JSON.stringify(metadata), {
      flag: "wx",
    });

    const finalDirectory = join(snapshotsDirectory, snapshotId);
    if (existsSync(finalDirectory)) {
      await readBuildSnapshotMetadata(finalDirectory, snapshotId);
      await rm(temporaryDirectory, { recursive: true, force: true });
    } else {
      await rename(temporaryDirectory, finalDirectory);
    }
    await mkdir(dataDirectory, { recursive: true });
    await writeLatestPointer(dataDirectory, {
      version: SNAPSHOT_FORMAT_VERSION,
      snapshotId,
      buildHash: manifest.hash,
      updatedAt: Date.now(),
    });
    await pruneOldSnapshots(snapshotsDirectory, snapshotId).catch(() => undefined);
    const storedMetadata = await readBuildSnapshotMetadata(finalDirectory, snapshotId);
    const storedSnapshot = createStoredSnapshot(finalDirectory, storedMetadata);
    snapshot.dispose?.();
    return storedSnapshot;
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function loadLatestBuildSnapshot(dataDirectory: string): Promise<BuildSnapshot> {
  let pointer: LatestSnapshotPointer;
  try {
    pointer = parseJson<LatestSnapshotPointer>(
      await readFile(join(dataDirectory, "latest.json")),
      "latest snapshot pointer",
    );
  } catch (error) {
    throw new Error(
      `No reusable Rspack Coverage snapshot was found in ${dataDirectory}: ${errorMessage(error)}`,
    );
  }
  if (pointer.version !== SNAPSHOT_FORMAT_VERSION) {
    throw new Error(
      `Unsupported latest snapshot version ${String(pointer.version)}; expected ${SNAPSHOT_FORMAT_VERSION}.`,
    );
  }
  assertSnapshotId(pointer.snapshotId);
  const directory = join(dataDirectory, "snapshots", pointer.snapshotId);
  const metadata = await readBuildSnapshotMetadata(directory, pointer.snapshotId);
  if (metadata.manifest.hash !== pointer.buildHash) {
    throw new Error("The latest snapshot pointer contains a different build hash.");
  }
  return createStoredSnapshot(directory, metadata);
}
