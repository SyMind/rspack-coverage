import type {
  BuildManifest,
  ChromeCoverageEntry,
  CodeViewResponse,
  CoverageImportSummary,
  CoverageReport,
  ModuleInvestigationDetail,
  ModuleReferencesResponse,
  ReferenceSnippetResponse,
  SourceFileReport,
} from "../../shared/types.js";

const PREFIX = "/__rspack_coverage__/api";

function token(): string {
  return (
    document.querySelector<HTMLMetaElement>('meta[name="rspack-coverage-token"]')?.content ?? ""
  );
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${PREFIX}${path}`, {
    ...init,
    headers: {
      "X-Rspack-Coverage-Token": token(),
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.text();
    let message = body;
    try {
      message = (JSON.parse(body) as { error?: string }).error ?? body;
    } catch {
      // Preserve plain-text server errors.
    }
    throw new Error(`Coverage API ${response.status}: ${message}`);
  }
  return response;
}

export async function loadBuild(): Promise<BuildManifest> {
  return (await request("/build")).json() as Promise<BuildManifest>;
}

export async function analyzeOnServer(
  coverage: ChromeCoverageEntry[],
  precision: CoverageImportSummary["precision"],
): Promise<CoverageReport> {
  return (
    await request("/analyze", {
      method: "POST",
      body: JSON.stringify({ coverage, precision }),
    })
  ).json() as Promise<CoverageReport>;
}

export async function loadCurrentReport(): Promise<CoverageReport | null> {
  try {
    return (await request("/report")).json() as Promise<CoverageReport>;
  } catch (error) {
    if (error instanceof Error && error.message.includes("Coverage API 404")) return null;
    throw error;
  }
}

export async function loadSource(fileId: string): Promise<SourceFileReport> {
  return (
    await request(`/source?id=${encodeURIComponent(fileId)}`)
  ).json() as Promise<SourceFileReport>;
}

export async function loadModule(moduleId: string): Promise<ModuleInvestigationDetail> {
  return (
    await request(`/modules/${encodeURIComponent(moduleId)}`)
  ).json() as Promise<ModuleInvestigationDetail>;
}

export async function loadCode(
  moduleId: string,
  input: {
    view: "source" | "output";
    sourceId?: string | null;
    offset?: number;
    limit?: number;
  },
): Promise<CodeViewResponse> {
  const search = new URLSearchParams({
    view: input.view,
    offset: String(input.offset ?? 0),
    limit: String(input.limit ?? 240_000),
  });
  if (input.sourceId) search.set("source", input.sourceId);
  return (
    await request(`/modules/${encodeURIComponent(moduleId)}/code?${search}`)
  ).json() as Promise<CodeViewResponse>;
}

export async function loadReferences(
  moduleId: string,
  direction: "in" | "out" | "both",
  cursor = 0,
  limit = 80,
): Promise<ModuleReferencesResponse> {
  const search = new URLSearchParams({ direction, cursor: String(cursor), limit: String(limit) });
  return (
    await request(`/modules/${encodeURIComponent(moduleId)}/references?${search}`)
  ).json() as Promise<ModuleReferencesResponse>;
}

export async function loadReferenceSnippet(referenceId: string): Promise<ReferenceSnippetResponse> {
  return (
    await request(`/references/${encodeURIComponent(referenceId)}/snippet`)
  ).json() as Promise<ReferenceSnippetResponse>;
}

export async function loadEvidenceGaps(): Promise<Array<{ kind: string; message: string }>> {
  return (await request("/evidence-gaps")).json() as Promise<
    Array<{ kind: string; message: string }>
  >;
}

export async function loadAiContext(moduleId: string): Promise<unknown> {
  return (await request(`/modules/${encodeURIComponent(moduleId)}/context`)).json();
}

export async function openInEditor(input: {
  moduleId: string;
  sourceId: string | null;
  line?: number;
  column?: number;
}): Promise<{ opened: boolean; url: string }> {
  return (
    await request("/open-in-editor", {
      method: "POST",
      body: JSON.stringify(input),
    })
  ).json() as Promise<{ opened: boolean; url: string }>;
}
