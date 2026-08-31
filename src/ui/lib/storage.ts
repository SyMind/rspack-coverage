import type {
  ChromeCoverageEntry,
  CoverageImportSummary,
  CoverageReport,
} from "../../shared/types.js";

const DATABASE = "rspack-coverage";
const VERSION = 1;

type Recording = {
  buildHash: string;
  coverage: ChromeCoverageEntry[];
  precision: CoverageImportSummary["precision"];
  savedAt: number;
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("recordings"))
        database.createObjectStore("recordings");
      if (!database.objectStoreNames.contains("reports")) database.createObjectStore("reports");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getValue<T>(storeName: string, key: string): Promise<T | null> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).get(key);
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
  });
}

async function putValue(storeName: string, key: string, value: unknown): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(value, key);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

export function loadRecording(buildHash: string): Promise<Recording | null> {
  return getValue("recordings", buildHash);
}

export function saveRecording(recording: Recording): Promise<void> {
  return putValue("recordings", recording.buildHash, recording);
}

export function loadReport(buildHash: string): Promise<CoverageReport | null> {
  return getValue("reports", buildHash);
}

export function saveReport(report: CoverageReport): Promise<void> {
  return putValue("reports", report.buildHash, report);
}
