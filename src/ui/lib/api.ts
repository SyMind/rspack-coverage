import type {
  BuildManifest,
  CoverageAnalysisStatus,
  CoverageImportSummary,
  ModuleReferencesResponse,
  ReferenceSnippetResponse,
  SourceExportAnalysisStatus,
  SourceFileDetail,
} from "../../shared/types.js";

const PREFIX = "/__rspack_coverage__/api";

function token(): string {
  return (
    document.querySelector<HTMLMetaElement>('meta[name="rspack-coverage-token"]')?.content ?? ""
  );
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
    throw new Error(`Coverage API ${response.status}: ${body}`);
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
): Promise<SourceFileDetail> {
  return (await request(
    `/coverage-analysis/source?buildHash=${encodeURIComponent(buildHash)}&fileId=${encodeURIComponent(fileId)}&attempt=${attempt}`,
    signal ? { signal } : {},
  ).then((response) => response.json())) as SourceFileDetail;
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

export async function loadReferenceSnippet(referenceId: string): Promise<ReferenceSnippetResponse> {
  return (await request(`/references/${encodeURIComponent(referenceId)}/snippet`).then((response) =>
    response.json(),
  )) as ReferenceSnippetResponse;
}
