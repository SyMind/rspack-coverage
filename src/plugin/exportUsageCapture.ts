import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

interface RsdoctorModuleRecord {
  ukey: number;
  identifier: string;
  layer?: string;
}

interface RsdoctorModuleGraphPayload {
  modules?: RsdoctorModuleRecord[];
  exportUsageEdges?: unknown[];
}

export interface CapturedExportUsageRecord {
  originIdentifier: string;
  originLayer: string | null;
  originExport: string[] | null;
  targetIdentifier: string;
  targetLayer: string | null;
  targetExport: string[] | null;
  dependencyId: string;
  location: string | null;
}

function exportPath(value: unknown): string[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  return value;
}

function decodePath(value: unknown): string[] | null {
  if (value === null) return null;
  const parsed: unknown = JSON.parse(String(value));
  return exportPath(parsed) ?? null;
}

/**
 * Rsdoctor has to materialize its callback payload once, but the coverage plugin
 * immediately projects it into a narrow SQLite ledger. The build snapshot never
 * retains the full module/dependency graph in JavaScript memory.
 */
export class NativeExportUsageCapture {
  readonly directory = mkdtempSync(join(tmpdir(), "rspack-coverage-export-usage-"));
  readonly #database = new DatabaseSync(join(this.directory, "capture.sqlite"));
  readonly #insert;
  readonly #entries;
  readonly #count;
  #available = false;
  #discarded = 0;
  #disposed = false;

  constructor() {
    this.#database.exec(`
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;
      PRAGMA temp_store = FILE;
      PRAGMA cache_size = -8192;
      PRAGMA mmap_size = 0;
      CREATE TABLE export_usage_raw (
        sequence INTEGER PRIMARY KEY,
        origin_identifier TEXT NOT NULL,
        origin_layer TEXT,
        origin_export TEXT,
        target_identifier TEXT NOT NULL,
        target_layer TEXT,
        target_export TEXT,
        dependency_id TEXT NOT NULL,
        location TEXT
      );
    `);
    this.#insert = this.#database.prepare(`
      INSERT INTO export_usage_raw (
        sequence,
        origin_identifier,
        origin_layer,
        origin_export,
        target_identifier,
        target_layer,
        target_export,
        dependency_id,
        location
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.#entries = this.#database.prepare(`
      SELECT
        origin_identifier,
        origin_layer,
        origin_export,
        target_identifier,
        target_layer,
        target_export,
        dependency_id,
        location
      FROM export_usage_raw
      ORDER BY origin_identifier, origin_layer, sequence
    `);
    this.#count = this.#database.prepare("SELECT count(*) AS count FROM export_usage_raw");
  }

  get available(): boolean {
    return this.#available;
  }

  get discarded(): number {
    return this.#discarded;
  }

  get size(): number {
    return Number(this.#count.get()?.count ?? 0);
  }

  capture(payload: RsdoctorModuleGraphPayload): void {
    if (!Array.isArray(payload.exportUsageEdges)) return;
    // Multiple RsdoctorPlugin instances share the same compilation hook. Keep
    // the richest callback instead of letting a later empty payload erase it.
    if (this.#available && payload.exportUsageEdges.length <= this.size) return;
    const modules = new Map<number, RsdoctorModuleRecord>();
    for (const module of payload.modules ?? []) {
      if (
        module &&
        Number.isSafeInteger(module.ukey) &&
        typeof module.identifier === "string" &&
        module.identifier
      ) {
        modules.set(module.ukey, module);
      }
    }

    this.#database.exec("BEGIN IMMEDIATE; DELETE FROM export_usage_raw;");
    let sequence = 0;
    let discarded = 0;
    try {
      for (const value of payload.exportUsageEdges ?? []) {
        if (!Array.isArray(value) || value.length < 6) {
          discarded += 1;
          continue;
        }
        const origin = modules.get(Number(value[0]));
        const originExport = exportPath(value[1]);
        const target = modules.get(Number(value[2]));
        const targetExport = exportPath(value[3]);
        const dependencyId = value[4];
        const location = value[5];
        if (
          !origin ||
          originExport === undefined ||
          !target ||
          targetExport === undefined ||
          typeof dependencyId !== "string" ||
          (location !== null && typeof location !== "string")
        ) {
          discarded += 1;
          continue;
        }
        this.#insert.run(
          sequence,
          origin.identifier,
          origin.layer ?? null,
          originExport === null ? null : JSON.stringify(originExport),
          target.identifier,
          target.layer ?? null,
          targetExport === null ? null : JSON.stringify(targetExport),
          dependencyId,
          location,
        );
        sequence += 1;
      }
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
    this.#available = true;
    this.#discarded = discarded;
  }

  *entries(): IterableIterator<CapturedExportUsageRecord> {
    for (const row of this.#entries.iterate()) {
      yield {
        originIdentifier: String(row.origin_identifier),
        originLayer: row.origin_layer === null ? null : String(row.origin_layer),
        originExport: decodePath(row.origin_export),
        targetIdentifier: String(row.target_identifier),
        targetLayer: row.target_layer === null ? null : String(row.target_layer),
        targetExport: decodePath(row.target_export),
        dependencyId: String(row.dependency_id),
        location: row.location === null ? null : String(row.location),
      };
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#database.close();
    rmSync(this.directory, { recursive: true, force: true });
  }
}
