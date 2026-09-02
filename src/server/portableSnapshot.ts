import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { lstat, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { TextDecoder } from "node:util";
import {
  MAX_PORTABLE_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_RECORD_BYTES,
} from "../shared/snapshotLimits.js";
import type { BuildSnapshot } from "../shared/types.js";
import {
  installImportedBuildSnapshot,
  type PersistedSnapshotMetadata,
  readBuildSnapshotMetadata,
  type StoredFile,
} from "./snapshotStorage.js";

const PORTABLE_SNAPSHOT_MAGIC = Buffer.from("RSPACK_COVERAGE_SNAPSHOT_V1\n");
const PORTABLE_SNAPSHOT_DIGEST_BYTES = 32;
const MAX_PORTABLE_PATH_BYTES = 4 * 1024;
const MAX_PORTABLE_FILE_COUNT = 250_000;
const OPTIONAL_COVERAGE_FILE = "coverage.json";
const OPTIONAL_REPORT_FILES = [
  "report.json",
  "report.sources",
  "report.sources.index.json",
] as const;
const RESERVED_OPTIONAL_FILES = new Set<string>([OPTIONAL_COVERAGE_FILE, ...OPTIONAL_REPORT_FILES]);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

interface ArchiveEntry {
  path: string;
  file: string;
  bytes: number;
  expectedSha256?: string;
}

export interface PortableSnapshotArchive {
  filename: string;
  bytes: number;
  content: Readable;
}

export interface ImportedPortableSnapshot {
  snapshot: BuildSnapshot;
  bytes: number;
}

export class PortableSnapshotFormatError extends Error {}
export class PortableSnapshotTooLargeError extends Error {}

function encodeUint32(value: number): Buffer {
  const output = Buffer.allocUnsafe(4);
  output.writeUInt32BE(value);
  return output;
}

function encodeUint64(value: number): Buffer {
  const output = Buffer.allocUnsafe(8);
  output.writeBigUInt64BE(BigInt(value));
  return output;
}

function safeSnapshotPath(directory: string, value: string): string {
  const segments = value.split("/");
  if (
    value.length === 0 ||
    value.includes("\\") ||
    value.includes("\0") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new PortableSnapshotFormatError(`Invalid snapshot file path: ${JSON.stringify(value)}`);
  }
  return join(directory, ...segments);
}

function expectedSnapshotFiles(metadata: PersistedSnapshotMetadata): Map<string, StoredFile> {
  const output = new Map<string, StoredFile>();
  const add = (record: StoredFile) => {
    safeSnapshotPath("/snapshot", record.file);
    if (
      output.has(record.file) ||
      record.file === "metadata.json" ||
      RESERVED_OPTIONAL_FILES.has(record.file)
    ) {
      throw new PortableSnapshotFormatError(
        `Snapshot metadata contains a duplicate file: ${record.file}`,
      );
    }
    output.set(record.file, record);
  };
  add(metadata.coverageSnapshot);
  add(metadata.database);
  for (const entry of metadata.assets) add(entry.value);
  for (const entry of metadata.maps) add(entry.value);
  return output;
}

async function archiveEntries(snapshot: BuildSnapshot): Promise<ArchiveEntry[]> {
  const storage = snapshot.storage;
  if (storage?.version !== 2) {
    throw new PortableSnapshotFormatError(
      "Only persisted v2 snapshots can be exported as a portable file.",
    );
  }
  const directory = storage.directory;
  const metadata = await readBuildSnapshotMetadata(directory, storage.snapshotId);
  const expected = expectedSnapshotFiles(metadata);
  const orderedPaths = [
    "metadata.json",
    metadata.coverageSnapshot.file,
    metadata.database.file,
    ...metadata.assets.map((entry) => entry.value.file),
    ...metadata.maps.map((entry) => entry.value.file),
  ];
  if (existsSync(join(directory, OPTIONAL_COVERAGE_FILE))) {
    orderedPaths.push(OPTIONAL_COVERAGE_FILE);
  }
  if (OPTIONAL_REPORT_FILES.every((name) => existsSync(join(directory, name)))) {
    orderedPaths.push(...OPTIONAL_REPORT_FILES);
  }

  const entries: ArchiveEntry[] = [];
  const seen = new Set<string>();
  for (const path of orderedPaths) {
    if (seen.has(path)) continue;
    seen.add(path);
    const pathBytes = Buffer.byteLength(path);
    if (pathBytes > MAX_PORTABLE_PATH_BYTES) {
      throw new PortableSnapshotFormatError(`Snapshot file path is too long: ${path}`);
    }
    const file = safeSnapshotPath(directory, path);
    const fileStats = await lstat(file);
    if (!fileStats.isFile()) {
      throw new PortableSnapshotFormatError(`Snapshot payload is not a file: ${path}`);
    }
    const record = expected.get(path);
    if (record && record.bytes !== fileStats.size) {
      throw new PortableSnapshotFormatError(`Snapshot file has an unexpected size: ${path}`);
    }
    entries.push({
      path,
      file,
      bytes: fileStats.size,
      ...(record ? { expectedSha256: record.sha256 } : {}),
    });
  }
  return entries;
}

function archiveBytes(entries: ArchiveEntry[]): number {
  let total = PORTABLE_SNAPSHOT_MAGIC.byteLength + 4;
  for (const entry of entries) {
    total += 4 + 8 + Buffer.byteLength(entry.path) + entry.bytes + PORTABLE_SNAPSHOT_DIGEST_BYTES;
  }
  if (!Number.isSafeInteger(total) || total > MAX_PORTABLE_SNAPSHOT_BYTES) {
    throw new PortableSnapshotTooLargeError(
      "Portable snapshot exceeds the 32 GiB streamed upload guard.",
    );
  }
  return total;
}

async function* streamArchive(entries: ArchiveEntry[]): AsyncGenerator<Buffer> {
  yield PORTABLE_SNAPSHOT_MAGIC;
  for (const entry of entries) {
    const path = Buffer.from(entry.path);
    yield encodeUint32(path.byteLength);
    yield encodeUint64(entry.bytes);
    yield path;
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(entry.file)) {
      const payload = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      digest.update(payload);
      yield payload;
    }
    const checksum = digest.digest();
    if (entry.expectedSha256 && checksum.toString("hex") !== entry.expectedSha256) {
      throw new PortableSnapshotFormatError(
        `Snapshot file failed its stored checksum: ${entry.path}`,
      );
    }
    yield checksum;
  }
  yield encodeUint32(0);
}

export async function createPortableSnapshotArchive(
  snapshot: BuildSnapshot,
): Promise<PortableSnapshotArchive> {
  const entries = await archiveEntries(snapshot);
  return {
    filename: `${snapshot.storage?.snapshotId ?? "rspack-coverage"}.rspack-coverage`,
    bytes: archiveBytes(entries),
    content: Readable.from(streamArchive(entries)),
  };
}

export async function writePortableSnapshotFile(
  snapshot: BuildSnapshot,
  destination: string,
): Promise<void> {
  const archive = await createPortableSnapshotArchive(snapshot);
  await mkdir(dirname(destination), { recursive: true });
  try {
    await pipeline(archive.content, createWriteStream(destination, { flags: "wx" }));
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  }
}

class BoundedStreamReader {
  readonly #iterator: AsyncIterator<unknown>;
  #pending: Buffer = Buffer.alloc(0);
  #ended = false;
  bytesRead = 0;

  constructor(source: Readable) {
    this.#iterator = source[Symbol.asyncIterator]();
  }

  async #fill(): Promise<void> {
    if (this.#pending.byteLength > 0 || this.#ended) return;
    const next = await this.#iterator.next();
    if (next.done) {
      this.#ended = true;
      return;
    }
    const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as Uint8Array);
    this.bytesRead += chunk.byteLength;
    if (this.bytesRead > MAX_PORTABLE_SNAPSHOT_BYTES) {
      throw new PortableSnapshotTooLargeError(
        "Portable snapshot exceeds the 32 GiB streamed upload guard.",
      );
    }
    this.#pending = chunk;
  }

  async readAtMost(length: number): Promise<Buffer> {
    await this.#fill();
    if (this.#pending.byteLength === 0) {
      throw new PortableSnapshotFormatError("Portable snapshot ended unexpectedly.");
    }
    const size = Math.min(length, this.#pending.byteLength);
    const output = this.#pending.subarray(0, size);
    this.#pending = this.#pending.subarray(size);
    return output;
  }

  async readExact(length: number): Promise<Buffer> {
    const output = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const chunk = await this.readAtMost(length - offset);
      chunk.copy(output, offset);
      offset += chunk.byteLength;
    }
    return output;
  }

  async assertEnd(): Promise<void> {
    if (this.#pending.byteLength > 0) {
      throw new PortableSnapshotFormatError("Portable snapshot contains trailing bytes.");
    }
    await this.#fill();
    if (this.#pending.byteLength > 0 || !this.#ended) {
      throw new PortableSnapshotFormatError("Portable snapshot contains trailing bytes.");
    }
  }
}

interface RecordHeader {
  path: string;
  bytes: number;
}

async function readRecordHeader(reader: BoundedStreamReader): Promise<RecordHeader | null> {
  const pathLength = (await reader.readExact(4)).readUInt32BE();
  if (pathLength === 0) return null;
  if (pathLength > MAX_PORTABLE_PATH_BYTES) {
    throw new PortableSnapshotFormatError("Portable snapshot contains an oversized file path.");
  }
  const bytesBigInt = (await reader.readExact(8)).readBigUInt64BE();
  if (bytesBigInt > BigInt(MAX_PORTABLE_SNAPSHOT_BYTES)) {
    throw new PortableSnapshotTooLargeError(
      "Portable snapshot contains a file larger than the 32 GiB streamed upload guard.",
    );
  }
  let path: string;
  try {
    path = utf8Decoder.decode(await reader.readExact(pathLength));
  } catch {
    throw new PortableSnapshotFormatError("Portable snapshot contains an invalid UTF-8 path.");
  }
  safeSnapshotPath("/snapshot", path);
  return { path, bytes: Number(bytesBigInt) };
}

async function extractRecord(
  reader: BoundedStreamReader,
  directory: string,
  header: RecordHeader,
  expected?: StoredFile,
): Promise<void> {
  if (expected && expected.bytes !== header.bytes) {
    throw new PortableSnapshotFormatError(`Snapshot file has an unexpected size: ${header.path}`);
  }
  const destination = safeSnapshotPath(directory, header.path);
  await mkdir(dirname(destination), { recursive: true });
  const output = createWriteStream(destination, { flags: "wx" });
  const digest = createHash("sha256");
  try {
    let remaining = header.bytes;
    while (remaining > 0) {
      const chunk = await reader.readAtMost(Math.min(remaining, 1024 * 1024));
      digest.update(chunk);
      remaining -= chunk.byteLength;
      if (!output.write(chunk)) await once(output, "drain");
    }
    output.end();
    await once(output, "finish");
  } catch (error) {
    output.destroy();
    throw error;
  }
  const actual = digest.digest();
  const archived = await reader.readExact(PORTABLE_SNAPSHOT_DIGEST_BYTES);
  if (!actual.equals(archived)) {
    throw new PortableSnapshotFormatError(`Portable snapshot checksum failed for ${header.path}.`);
  }
  if (expected && actual.toString("hex") !== expected.sha256) {
    throw new PortableSnapshotFormatError(
      `Portable snapshot does not match metadata for ${header.path}.`,
    );
  }
}

export async function importPortableSnapshot(
  source: Readable,
  dataDirectory: string,
  previousSnapshotId?: string | null,
): Promise<ImportedPortableSnapshot> {
  const snapshotsDirectory = join(dataDirectory, "snapshots");
  const temporaryDirectory = join(snapshotsDirectory, `.import-${randomUUID()}`);
  await mkdir(temporaryDirectory, { recursive: true });
  const reader = new BoundedStreamReader(source);
  try {
    const magic = await reader.readExact(PORTABLE_SNAPSHOT_MAGIC.byteLength);
    if (!magic.equals(PORTABLE_SNAPSHOT_MAGIC)) {
      throw new PortableSnapshotFormatError(
        "This is not a supported .rspack-coverage snapshot file.",
      );
    }

    const metadataHeader = await readRecordHeader(reader);
    if (metadataHeader?.path !== "metadata.json") {
      throw new PortableSnapshotFormatError("Portable snapshot must begin with metadata.json.");
    }
    if (metadataHeader.bytes > MAX_SNAPSHOT_RECORD_BYTES) {
      throw new PortableSnapshotFormatError(
        "Portable snapshot metadata exceeds the 256 MiB per-record memory guard.",
      );
    }
    await extractRecord(reader, temporaryDirectory, metadataHeader);

    const metadata = await readBuildSnapshotMetadata(temporaryDirectory);
    const expected = expectedSnapshotFiles(metadata);
    const allowedOptional = new Set<string>([OPTIONAL_COVERAGE_FILE, ...OPTIONAL_REPORT_FILES]);
    const seen = new Set<string>(["metadata.json"]);
    let fileCount = 1;

    while (true) {
      const header = await readRecordHeader(reader);
      if (!header) break;
      fileCount += 1;
      if (fileCount > MAX_PORTABLE_FILE_COUNT) {
        throw new PortableSnapshotFormatError(
          `Portable snapshot contains more than ${MAX_PORTABLE_FILE_COUNT.toLocaleString()} files.`,
        );
      }
      if (seen.has(header.path)) {
        throw new PortableSnapshotFormatError(
          `Portable snapshot contains a duplicate file: ${header.path}`,
        );
      }
      const expectedRecord = expected.get(header.path);
      if (!expectedRecord && !allowedOptional.has(header.path)) {
        throw new PortableSnapshotFormatError(
          `Portable snapshot contains an unexpected file: ${header.path}`,
        );
      }
      await extractRecord(reader, temporaryDirectory, header, expectedRecord);
      seen.add(header.path);
    }
    await reader.assertEnd();

    for (const path of expected.keys()) {
      if (!seen.has(path)) {
        throw new PortableSnapshotFormatError(
          `Portable snapshot is missing required file: ${path}`,
        );
      }
    }
    const reportFiles = OPTIONAL_REPORT_FILES.filter((path) => seen.has(path));
    if (reportFiles.length > 0 && reportFiles.length !== OPTIONAL_REPORT_FILES.length) {
      throw new PortableSnapshotFormatError(
        "Portable snapshot contains an incomplete Coverage report sidecar.",
      );
    }

    const snapshot = await installImportedBuildSnapshot(
      temporaryDirectory,
      dataDirectory,
      previousSnapshotId,
    );
    return { snapshot, bytes: reader.bytesRead };
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
