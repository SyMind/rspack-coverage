import type { BuildManifest, RawSourceMapPayload } from "../../shared/types.js";

const PREFIX = "/__rspack_coverage__/api";

function token(): string {
  return (
    document.querySelector<HTMLMetaElement>('meta[name="rspack-coverage-token"]')?.content ?? ""
  );
}

async function request(path: string): Promise<Response> {
  const response = await fetch(`${PREFIX}${path}`, {
    headers: { "X-Rspack-Coverage-Token": token() },
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Coverage API ${response.status}: ${body}`);
  }
  return response;
}

export async function loadBuild(): Promise<BuildManifest> {
  return (await request("/build")).json() as Promise<BuildManifest>;
}

export async function loadAnalysisPayload(
  build: BuildManifest,
  onProgress: (completed: number, total: number) => void,
): Promise<{
  maps: Record<string, RawSourceMapPayload>;
  generatedAssets: Record<string, string>;
  originalSources: Record<string, string>;
}> {
  const maps: Record<string, RawSourceMapPayload> = {};
  const generatedAssets: Record<string, string> = {};
  const originalSourcesPromise = request("/sources").then(
    (response) => response.json() as Promise<Record<string, string>>,
  );
  let cursor = 0;
  let completed = 0;
  const workers = Math.min(4, build.assets.length);

  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (cursor < build.assets.length) {
        const index = cursor;
        cursor += 1;
        const asset = build.assets[index];
        if (!asset) continue;
        const [assetResponse, mapResponse] = await Promise.all([
          request(`/asset/${encodeURIComponent(asset.id)}`),
          asset.mapAvailable
            ? request(`/map/${encodeURIComponent(asset.id)}`)
            : Promise.resolve(null),
        ]);
        generatedAssets[asset.id] = await assetResponse.text();
        if (mapResponse) maps[asset.id] = (await mapResponse.json()) as RawSourceMapPayload;
        completed += 1;
        onProgress(completed, build.assets.length);
      }
    }),
  );
  return { maps, generatedAssets, originalSources: await originalSourcesPromise };
}
