import type {
  BuildManifest,
  CodeViewResponse,
  CoverageAnalysisStatus,
  CoverageImportSummary,
  ExportImporterChainResponse,
  ModuleReferencesResponse,
  ReferenceSnippetResponse,
  SourceExportAnalysisStatus,
  SourceFileDetail,
} from "../../shared/types.js";

const PREFIX = "/__rspack_coverage__/api";

export interface SnapshotImportResponse {
  snapshotId: string;
  bytes: number;
  build: BuildManifest;
}

function token(): string {
  return (
    document.querySelector<HTMLMetaElement>('meta[name="rspack-coverage-token"]')?.content ?? ""
  );
}

export function snapshotDownloadUrl(): string {
  const search = new URLSearchParams({ token: token() });
  return `${PREFIX}/snapshot?${search}`;
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("X-Rspack-Coverage-Token", token());
  const requestInit: RequestInit = {
    ...init,
    headers,
    cache: "no-store",
  };
  const response = await fetch(`${PREFIX}${path}`, requestInit);
  if (!response.ok) {
    const body = await response.text();
    let message = body;
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed.error === "string") message = parsed.error;
    } catch {
      // Preserve a non-JSON server response as-is.
    }
    throw new Error(message || `Coverage API request failed with status ${response.status}.`);
  }
  return response;
}

export async function loadSourceExportStatus(
  buildHash: string,
  source: string,
  signal?: AbortSignal,
  attempt = 0,
): Promise<SourceExportAnalysisStatus> {
  return (await request(
    `/source-exports?buildHash=${encodeURIComponent(buildHash)}&source=${encodeURIComponent(source)}&attempt=${attempt}`,
    signal ? { signal } : {},
  ).then((response) => response.json())) as SourceExportAnalysisStatus;
}

export async function loadBuild(): Promise<BuildManifest> {
  return (await request("/build")).json() as Promise<BuildManifest>;
}

export async function uploadSnapshot(file: File): Promise<SnapshotImportResponse> {
  return (await request("/snapshot", { method: "POST", body: file }).then((response) =>
    response.json(),
  )) as SnapshotImportResponse;
}

export async function loadCoverageAnalysisStatus(
  buildHash: string,
): Promise<CoverageAnalysisStatus> {
  return (await request(`/coverage-analysis?buildHash=${encodeURIComponent(buildHash)}`).then(
    (response) => response.json(),
  )) as CoverageAnalysisStatus;
}

export async function loadCoverageSource(
  buildHash: string,
  fileId: string,
  signal?: AbortSignal,
  attempt = 0,
  moduleId?: string | null,
): Promise<SourceFileDetail> {
  const search = new URLSearchParams({ buildHash, fileId, attempt: String(attempt) });
  if (moduleId) search.set("moduleId", moduleId);
  return (await request(`/coverage-analysis/source?${search}`, signal ? { signal } : {}).then(
    (response) => response.json(),
  )) as SourceFileDetail;
}

export async function loadGeneratedSource(
  buildHash: string,
  fileId: string,
  offset = 0,
  limit = 240_000,
  signal?: AbortSignal,
  attempt = 0,
): Promise<CodeViewResponse> {
  const search = new URLSearchParams({
    buildHash,
    fileId,
    offset: String(offset),
    limit: String(limit),
    attempt: String(attempt),
  });
  return (await request(
    `/coverage-analysis/generated-source?${search}`,
    signal ? { signal } : {},
  ).then((response) => response.json())) as CodeViewResponse;
}

export async function startCoverageAnalysis(
  buildHash: string,
  precision: CoverageImportSummary["precision"],
  file: File,
): Promise<CoverageAnalysisStatus> {
  return (await request(
    `/coverage-analysis?buildHash=${encodeURIComponent(buildHash)}&precision=${encodeURIComponent(precision)}`,
    { method: "POST", body: file },
  ).then((response) => response.json())) as CoverageAnalysisStatus;
}

export async function reuseCoverageAnalysis(
  buildHash: string,
  precision: CoverageImportSummary["precision"],
): Promise<CoverageAnalysisStatus> {
  return (await request(
    `/coverage-analysis/reuse?buildHash=${encodeURIComponent(buildHash)}&precision=${encodeURIComponent(precision)}`,
    { method: "POST" },
  ).then((response) => response.json())) as CoverageAnalysisStatus;
}

export async function loadReferences(
  moduleId: string,
  direction: "in" | "out" | "both",
  cursor = 0,
  limit = 80,
): Promise<ModuleReferencesResponse> {
  const search = new URLSearchParams({ direction, cursor: String(cursor), limit: String(limit) });
  return (await request(`/modules/${encodeURIComponent(moduleId)}/references?${search}`).then(
    (response) => response.json(),
  )) as ModuleReferencesResponse;
}

export async function loadExportImporterChain(
  moduleId: string,
  exportedName: string,
): Promise<ExportImporterChainResponse> {
  const search = new URLSearchParams({ export: exportedName });
  return (await request(`/modules/${encodeURIComponent(moduleId)}/export-chain?${search}`).then(
    (response) => response.json(),
  )) as ExportImporterChainResponse;
}

export async function loadReferenceSnippet(referenceId: string): Promise<ReferenceSnippetResponse> {
  return (await request(`/references/${encodeURIComponent(referenceId)}/snippet`).then((response) =>
    response.json(),
  )) as ReferenceSnippetResponse;
}

export async function loadExportDeclaration(
  moduleId: string,
  exportedName: string,
): Promise<ReferenceSnippetResponse> {
  const search = new URLSearchParams({ export: exportedName });
  return (await request(
    `/modules/${encodeURIComponent(moduleId)}/export-declaration?${search}`,
  ).then((response) => response.json())) as ReferenceSnippetResponse;
}

export async function openInEditor(input: {
  moduleId: string;
  sourceId: string | null;
  line?: number;
  column?: number;
}): Promise<{ opened: boolean; method: string | null; url: string }> {
  return (await request("/open-in-editor", {
    method: "POST",
    body: JSON.stringify(input),
  }).then((response) => response.json())) as {
    opened: boolean;
    method: string | null;
    url: string;
  };
}
