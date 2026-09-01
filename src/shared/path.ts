const SCHEME_RE = /^(?:webpack|rspack|file):\/\//;
const RESOURCE_REQUEST_RE = /^(?:[a-z][a-z\d+.-]*:\/\/|\/|\.\.?\/|[a-z]:[\\/])/i;

function stripLoaderPrefix(value: string): string {
  const separator = value.lastIndexOf("!");
  if (separator === -1) return value;

  const resource = value.slice(separator + 1);
  return RESOURCE_REQUEST_RE.test(resource) ? resource : value;
}

export function stripQueryAndFragment(value: string): string {
  const query = value.indexOf("?");
  const fragment = value.indexOf("#");
  const cut = Math.min(
    query === -1 ? value.length : query,
    fragment === -1 ? value.length : fragment,
  );
  return value.slice(0, cut);
}

export function normalizeUrlPath(value: string): string {
  try {
    const url = new URL(value, "http://rspack-coverage.local");
    return decodeURIComponent(url.pathname).replace(/\\/g, "/");
  } catch {
    return stripQueryAndFragment(value).replace(/\\/g, "/");
  }
}

export function normalizeSourcePath(value: string): string {
  // Rspack/webpack may expose a source as a full loader request:
  //   /loader.js??options!/absolute/path/to/source.js
  // The loader query must be removed before looking for `?`, otherwise every
  // resource handled by the loader collapses into the loader's own path.
  let normalized = stripQueryAndFragment(stripLoaderPrefix(value)).replace(/\\/g, "/");
  normalized = normalized.replace(/^webpack:\/\/[^/]*\//, "");
  normalized = normalized.replace(/^rspack:\/\/[^/]*\//, "");
  normalized = normalized.replace(SCHEME_RE, "");
  normalized = normalized.replace(/^\/+/, "").replace(/^\.\//, "");
  while (normalized.includes("../")) {
    normalized = normalized.replace(/(^|\/)\.(?:\.\/)+/g, "$1");
  }
  return normalized || "[unknown source]";
}

export function sourceCategory(path: string): "first-party" | "node_modules" | "runtime" {
  if (path.startsWith("[rspack runtime") || path.includes("webpack/runtime")) return "runtime";
  if (path.includes("node_modules/")) return "node_modules";
  return "first-party";
}

export function assetUrlPath(publicPath: string, assetName: string): string {
  if (!publicPath || publicPath === "auto") return `/${assetName.replace(/^\/+/, "")}`;
  if (/^https?:\/\//i.test(publicPath) || publicPath.startsWith("//")) return assetName;
  const base = publicPath.endsWith("/") ? publicPath : `${publicPath}/`;
  return `/${`${base}${assetName}`.replace(/^\/+/, "")}`;
}
