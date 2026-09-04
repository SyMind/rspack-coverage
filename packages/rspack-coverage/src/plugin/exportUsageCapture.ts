import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ReferenceLocation } from "../shared/types.js";

interface RsdoctorModuleRecord {
  ukey: number;
  identifier: string;
  layer?: string;
}

interface RsdoctorModuleGraphPayload {
  modules?: RsdoctorModuleRecord[];
  exportUsageEdges?: unknown[];
}

export interface CapturedModuleReferenceRecord {
  originIdentifier: string;
  originLayer: string | null;
  targetIdentifier: string;
  targetLayer: string | null;
  dependencyId: string;
  dependencyType: string | null;
  request: string | null;
  exports: string[] | null;
  active: boolean | null;
  location: ReferenceLocation | null;
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

function readProperty<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function moduleIdentifier(module: any): string | null {
  const value = readProperty(() => module?.identifier?.(), null);
  return value ? String(value) : null;
}

function moduleLayer(module: any): string | null {
  const value = readProperty(() => module?.layer, null);
  return value === null || value === undefined || value === "" ? null : String(value);
}

function referenceLocation(value: any): ReferenceLocation | null {
  if (!value?.start || !Number.isFinite(Number(value.start.line))) return null;
  const rawStartColumn = Number(value.start.column ?? 1);
  const start = {
    line: Math.max(1, Number(value.start.line)),
    column: Math.max(0, rawStartColumn - 1),
  };
  const endValue = value.end?.line ? value.end : value.start;
  const rawEndColumn = Number(endValue.column ?? rawStartColumn + 1);
  return {
    start,
    end: {
      line: Math.max(start.line, Number(endValue.line ?? start.line)),
      column: Math.max(start.column + 1, rawEndColumn - 1),
    },
  };
}

function decodeReferencePath(value: unknown): string[] | null {
  if (value === null) return null;
  const parsed: unknown = JSON.parse(String(value));
  return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : null;
}

function decodeReferenceLocation(value: unknown): ReferenceLocation | null {
  if (value === null) return null;
  return JSON.parse(String(value)) as ReferenceLocation;
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
  readonly #referenceInsert;
  readonly #referenceEntries;
  readonly #referenceCount;
  #available = false;
  #referencesAvailable = false;
  #discarded = 0;
  #discardedReferences = 0;
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
      CREATE TABLE module_references_raw (
        sequence INTEGER PRIMARY KEY,
        origin_identifier TEXT NOT NULL,
        origin_layer TEXT,
        target_identifier TEXT NOT NULL,
        target_layer TEXT,
        dependency_id TEXT NOT NULL,
        dependency_type TEXT,
        request TEXT,
        exports TEXT,
        active INTEGER,
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
    this.#referenceInsert = this.#database.prepare(`
      INSERT INTO module_references_raw (
        sequence,
        origin_identifier,
        origin_layer,
        target_identifier,
        target_layer,
        dependency_id,
        dependency_type,
        request,
        exports,
        active,
        location
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.#referenceEntries = this.#database.prepare(`
      SELECT
        origin_identifier,
        origin_layer,
        target_identifier,
        target_layer,
        dependency_id,
        dependency_type,
        request,
        exports,
        active,
        location
      FROM module_references_raw
      ORDER BY origin_identifier, origin_layer, sequence
    `);
    this.#referenceCount = this.#database.prepare(
      "SELECT count(*) AS count FROM module_references_raw",
    );
  }

  get available(): boolean {
    return this.#available;
  }

  get discarded(): number {
    return this.#discarded;
  }

  get referencesAvailable(): boolean {
    return this.#referencesAvailable;
  }

  get discardedReferences(): number {
    return this.#discardedReferences;
  }

  get referenceSize(): number {
    return Number(this.#referenceCount.get()?.count ?? 0);
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

  captureReferences(compilation: any, modules: Iterable<any>): void {
    this.#database.exec("BEGIN IMMEDIATE; DELETE FROM module_references_raw;");
    let sequence = 0;
    let discarded = 0;
    try {
      const moduleGraph = compilation.moduleGraph as any;
      for (const containingOrigin of modules) {
        const connections = readProperty<Iterable<any>>(
          () => moduleGraph.getOutgoingConnections(containingOrigin) ?? [],
          [],
        );
        for (const connection of connections) {
          const dependency = connection.dependency ?? null;
          const dependencyOrigin = dependency
            ? readProperty(
                () =>
                  moduleGraph.getParentModule(dependency) ??
                  dependency._parentModule ??
                  connection.originModule ??
                  containingOrigin,
                containingOrigin,
              )
            : (connection.originModule ?? containingOrigin);
          const target = connection.resolvedModule ?? connection.module;
          if (!dependencyOrigin || !target || dependencyOrigin === target) continue;
          const originIdentifier = moduleIdentifier(dependencyOrigin);
          const targetIdentifier = moduleIdentifier(target);
          if (!originIdentifier || !targetIdentifier) {
            discarded += 1;
            continue;
          }
          const activeState = readProperty(() => connection.getActiveState(undefined), null);
          const exports = Array.isArray(dependency?.ids) ? dependency.ids.map(String) : null;
          const location = referenceLocation(dependency?.loc);
          this.#referenceInsert.run(
            sequence,
            originIdentifier,
            moduleLayer(dependencyOrigin),
            targetIdentifier,
            moduleLayer(target),
            String(dependency?.id ?? sequence),
            dependency?.type ? String(dependency.type) : null,
            dependency?.request ? String(dependency.request) : null,
            exports ? JSON.stringify(exports) : null,
            typeof activeState === "boolean" ? Number(activeState) : null,
            location ? JSON.stringify(location) : null,
          );
          sequence += 1;
        }
      }
      this.#database.exec("COMMIT;");
      this.#referencesAvailable = true;
      this.#discardedReferences = discarded;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      this.#referencesAvailable = false;
      throw error;
    }
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

  *referenceEntries(): IterableIterator<CapturedModuleReferenceRecord> {
    for (const row of this.#referenceEntries.iterate()) {
      yield {
        originIdentifier: String(row.origin_identifier),
        originLayer: row.origin_layer === null ? null : String(row.origin_layer),
        targetIdentifier: String(row.target_identifier),
        targetLayer: row.target_layer === null ? null : String(row.target_layer),
        dependencyId: String(row.dependency_id),
        dependencyType: row.dependency_type === null ? null : String(row.dependency_type),
        request: row.request === null ? null : String(row.request),
        exports: decodeReferencePath(row.exports),
        active: row.active === null ? null : Boolean(row.active),
        location: decodeReferenceLocation(row.location),
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
