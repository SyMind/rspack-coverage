import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeCoverageWithMatches } from "../analyzer/analyze.js";
import type { ResolvedRspackCoveragePluginOptions } from "../plugin/types.js";
import type { BuildSnapshot, ChromeCoverageEntry, CoverageImportSummary } from "../shared/types.js";
import { InvestigationModel } from "./InvestigationModel.js";

const ANALYSIS_PREFIX = "/__rspack_coverage__/";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function contentType(file: string): string {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function requestJson(request: IncomingMessage, maximumBytes = 1024 * 1024 * 1024) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maximumBytes)
      throw new Error("Request body exceeds the 1 GiB local analysis limit");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function vscodeUrl(target: { path: string; line: number; column: number }): string {
  const normalized = target.path.replace(/\\/g, "/");
  const encoded = normalized
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `vscode://file${encoded.startsWith("/") ? encoded : `/${encoded}`}:${target.line}:${target.column}`;
}

function openEditor(target: { path: string; line: number; column: number }) {
  const goto = `${target.path}:${target.line}:${target.column}`;
  const editor = process.env.RSPACK_COVERAGE_EDITOR || "code";
  const result = spawnSync(editor, ["--goto", goto], { stdio: "ignore", timeout: 5_000 });
  if (result.status === 0) return { opened: true, method: editor, url: vscodeUrl(target) };
  if (process.platform === "darwin") {
    const fallback = spawnSync("open", [vscodeUrl(target)], { stdio: "ignore", timeout: 5_000 });
    return { opened: fallback.status === 0, method: "vscode-url", url: vscodeUrl(target) };
  }
  return { opened: false, method: null, url: vscodeUrl(target) };
}

export class AnalysisServer {
  readonly token = randomBytes(24).toString("base64url");
  #snapshot: BuildSnapshot | null = null;
  #investigation: InvestigationModel | null = null;
  #server = createServer((request, response) => {
    void this.#handle(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const message = error instanceof Error ? error.message : "Coverage analysis failed";
      const invalidInput =
        error instanceof SyntaxError ||
        message.startsWith("Chrome Coverage") ||
        message.startsWith("No JavaScript assets") ||
        message.startsWith("Request body exceeds") ||
        message.includes("does not match build");
      sendJson(response, invalidInput ? 400 : 500, { error: message });
    });
  });
  #port: number | null = null;
  #uiDirectory: string;

  constructor(private readonly options: ResolvedRspackCoveragePluginOptions) {
    const moduleDirectory = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(moduleDirectory, "ui"),
      resolve(moduleDirectory, "../../dist/ui"),
      resolve(process.cwd(), "dist/ui"),
    ];
    this.#uiDirectory =
      candidates.find((candidate) => existsSync(join(candidate, "index.html"))) ??
      resolve(moduleDirectory, "ui");
  }

  get port(): number | null {
    return this.#port;
  }

  get origin(): string | null {
    return this.#port ? `http://127.0.0.1:${this.#port}` : null;
  }

  update(snapshot: BuildSnapshot): void {
    this.#snapshot = snapshot;
    this.#investigation = null;
  }

  async start(): Promise<number> {
    if (this.#port) return this.#port;
    for (let port = this.options.port; port < this.options.port + 100; port += 1) {
      try {
        await new Promise<void>((resolvePromise, reject) => {
          const onError = (error: NodeJS.ErrnoException) => {
            this.#server.off("listening", onListening);
            reject(error);
          };
          const onListening = () => {
            this.#server.off("error", onError);
            resolvePromise();
          };
          this.#server.once("error", onError);
          this.#server.once("listening", onListening);
          this.#server.listen(port, "127.0.0.1");
        });
        this.#port = port;
        return port;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      }
    }
    throw new Error(
      `No free port found between ${this.options.port} and ${this.options.port + 99}.`,
    );
  }

  async close(): Promise<void> {
    if (!this.#server.listening) return;
    await new Promise<void>((resolvePromise, reject) => {
      this.#server.close((error) => (error ? reject(error) : resolvePromise()));
    });
    this.#port = null;
  }

  #validHost(request: IncomingMessage): boolean {
    const hostname = request.headers.host?.split(":")[0]?.replace(/^\[|\]$/g, "");
    return hostname === "127.0.0.1" || hostname === "localhost";
  }

  #authorized(request: IncomingMessage, url: URL): boolean {
    return (
      request.headers["x-rspack-coverage-token"] === this.token ||
      url.searchParams.get("token") === this.token
    );
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.#validHost(request)) {
      sendJson(response, 403, { error: "Invalid host" });
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST") {
      response.writeHead(405, { Allow: "GET, HEAD, POST" });
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", this.origin ?? "http://127.0.0.1");
    const pathname = safeDecode(url.pathname);

    if (pathname.startsWith(`${ANALYSIS_PREFIX}api/`)) {
      if (!this.#authorized(request, url)) {
        sendJson(response, 401, { error: "Missing or invalid analysis token" });
        return;
      }
      await this.#serveApi(request, pathname, url, response);
      return;
    }

    if (pathname.startsWith(ANALYSIS_PREFIX)) {
      this.#serveAnalysisUi(pathname, response);
      return;
    }

    this.#serveApplication(pathname, request, response);
  }

  async #serveApi(
    request: IncomingMessage,
    pathname: string,
    url: URL,
    response: ServerResponse,
  ): Promise<void> {
    const snapshot = this.#snapshot;
    if (!snapshot) {
      sendJson(response, 503, { error: "Build data is not ready" });
      return;
    }
    if (pathname === `${ANALYSIS_PREFIX}api/build`) {
      sendJson(response, 200, snapshot.manifest);
      return;
    }
    if (pathname === `${ANALYSIS_PREFIX}api/chunks`) {
      sendJson(response, 200, snapshot.manifest.chunks);
      return;
    }
    if (pathname === `${ANALYSIS_PREFIX}api/sources`) {
      sendJson(
        response,
        200,
        [...snapshot.originalSources].map(([path, content]) => ({
          path,
          characters: content.length,
        })),
      );
      return;
    }
    if (pathname === `${ANALYSIS_PREFIX}api/analyze` && request.method === "POST") {
      const body = (await requestJson(request)) as {
        coverage?: ChromeCoverageEntry[];
        precision?: CoverageImportSummary["precision"];
      };
      if (!Array.isArray(body.coverage)) {
        sendJson(response, 400, { error: "Chrome Coverage JSON must contain an array of entries" });
        return;
      }
      const precision = ["per-block", "per-function", "unknown"].includes(String(body.precision))
        ? (body.precision as CoverageImportSummary["precision"])
        : "unknown";
      const result = await analyzeCoverageWithMatches({
        build: snapshot.manifest,
        coverage: body.coverage,
        maps: snapshot.maps,
        generatedAssets: snapshot.assets,
        originalSources: snapshot.originalSources,
        precision,
      });
      this.#investigation = new InvestigationModel(
        snapshot,
        result.report,
        result.matched,
        result.lineEvidence,
        result.analyzedAssetIds,
      );
      sendJson(response, 200, this.#investigation.summary);
      return;
    }
    if (pathname === `${ANALYSIS_PREFIX}api/report`) {
      if (!this.#investigation) {
        sendJson(response, 404, { error: "No recording has been analyzed by this server" });
        return;
      }
      sendJson(response, 200, this.#investigation.summary);
      return;
    }
    if (pathname === `${ANALYSIS_PREFIX}api/source`) {
      if (!this.#investigation) {
        sendJson(response, 409, { error: "Analyze a recording before loading source details" });
        return;
      }
      const source = this.#investigation.source(url.searchParams.get("id") ?? "");
      sendJson(response, source ? 200 : 404, source ?? { error: "Unknown source" });
      return;
    }
    if (pathname === `${ANALYSIS_PREFIX}api/evidence-gaps`) {
      sendJson(response, 200, this.#investigation?.evidenceGaps() ?? []);
      return;
    }
    const moduleMatch = pathname.match(/\/api\/modules\/([^/]+)(?:\/(code|references|context))?$/);
    if (moduleMatch) {
      if (!this.#investigation) {
        sendJson(response, 409, { error: "Analyze a recording before investigating modules" });
        return;
      }
      const moduleId = moduleMatch[1] ?? "";
      const action = moduleMatch[2] ?? "detail";
      if (action === "detail") {
        const detail = this.#investigation.module(moduleId);
        sendJson(response, detail ? 200 : 404, detail ?? { error: "Unknown module" });
        return;
      }
      if (action === "code") {
        const view = url.searchParams.get("view") === "output" ? "output" : "source";
        const code = this.#investigation.code(
          moduleId,
          view,
          url.searchParams.get("source"),
          Number(url.searchParams.get("offset") ?? 0),
          Number(url.searchParams.get("limit") ?? 240_000),
        );
        sendJson(response, code ? 200 : 404, code ?? { error: "Unknown module" });
        return;
      }
      if (action === "references") {
        const requestedDirection = url.searchParams.get("direction");
        const direction =
          requestedDirection === "in" || requestedDirection === "out" ? requestedDirection : "both";
        const references = this.#investigation.references(
          moduleId,
          direction,
          Number(url.searchParams.get("cursor") ?? 0),
          Number(url.searchParams.get("limit") ?? 80),
        );
        sendJson(response, references ? 200 : 404, references ?? { error: "Unknown module" });
        return;
      }
      const context = this.#investigation.aiContext(moduleId);
      sendJson(response, context ? 200 : 404, context ?? { error: "Unknown module" });
      return;
    }
    const snippetMatch = pathname.match(/\/api\/references\/([^/]+)\/snippet$/);
    if (snippetMatch) {
      if (!this.#investigation) {
        sendJson(response, 409, { error: "Analyze a recording before loading references" });
        return;
      }
      const snippet = this.#investigation.snippet(
        snippetMatch[1] ?? "",
        Number(url.searchParams.get("context") ?? 3),
      );
      sendJson(response, snippet ? 200 : 404, snippet ?? { error: "Unknown reference" });
      return;
    }
    if (pathname === `${ANALYSIS_PREFIX}api/open-in-editor` && request.method === "POST") {
      if (!this.#investigation) {
        sendJson(response, 409, { error: "Analyze a recording before opening source" });
        return;
      }
      const body = (await requestJson(request, 64 * 1024)) as {
        moduleId?: string;
        sourceId?: string | null;
        line?: number;
        column?: number;
      };
      const target = this.#investigation.editorTarget(
        String(body.moduleId ?? ""),
        body.sourceId ?? null,
        Number(body.line ?? 1),
        Number(body.column ?? 1),
      );
      if (!target) {
        sendJson(response, 400, { error: "The selected module has no local absolute source path" });
        return;
      }
      sendJson(response, 200, { target, ...openEditor(target) });
      return;
    }
    const assetMatch = pathname.match(/\/api\/asset\/([^/]+)$/);
    if (assetMatch) {
      const content = snapshot.assets.get(assetMatch[1] ?? "");
      if (!content) return void sendJson(response, 404, { error: "Unknown asset" });
      response.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Content-Length": content.byteLength,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(content);
      return;
    }
    const mapMatch = pathname.match(/\/api\/map\/([^/]+)$/);
    if (mapMatch) {
      const map = snapshot.maps.get(mapMatch[1] ?? "");
      if (!map) return void sendJson(response, 404, { error: "Source map unavailable" });
      sendJson(response, 200, map);
      return;
    }
    sendJson(response, 404, { error: "Unknown API route" });
  }

  #serveAnalysisUi(pathname: string, response: ServerResponse): void {
    const relative = pathname.slice(ANALYSIS_PREFIX.length) || "index.html";
    const requested = relative.endsWith("/") ? `${relative}index.html` : relative;
    const absolute = resolve(this.#uiDirectory, normalize(requested));
    if (!absolute.startsWith(`${this.#uiDirectory}${sep}`) && absolute !== this.#uiDirectory) {
      response.writeHead(403);
      response.end();
      return;
    }
    const file =
      existsSync(absolute) && statSync(absolute).isFile()
        ? absolute
        : join(this.#uiDirectory, "index.html");
    if (!existsSync(file)) {
      response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Rspack Coverage UI is missing. Reinstall the package or run its build.");
      return;
    }
    const headers: Record<string, string> = {
      "Content-Type": contentType(file),
      "Cache-Control": file.endsWith("index.html")
        ? "no-store"
        : "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    };
    if (file.endsWith("index.html")) {
      const html = readFileSync(file, "utf8").replace(
        "</head>",
        `<meta name="rspack-coverage-token" content="${this.token}"></head>`,
      );
      response.writeHead(200, headers);
      response.end(html);
      return;
    }
    response.writeHead(200, headers);
    createReadStream(file).pipe(response);
  }

  #serveApplication(pathname: string, request: IncomingMessage, response: ServerResponse): void {
    const snapshot = this.#snapshot;
    if (!snapshot?.manifest.previewAvailable) {
      response.writeHead(503, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(
        "<!doctype html><title>Preview unavailable</title><h1>Application preview unavailable</h1><p>Open the Coverage report to inspect build diagnostics.</p>",
      );
      return;
    }
    const matchedAsset = snapshot.manifest.assets.find(
      (asset) => asset.urlPath === pathname || `/${asset.name.replace(/^\/+/, "")}` === pathname,
    );
    if (matchedAsset) {
      const content = snapshot.assets.get(matchedAsset.id);
      if (content) {
        response.writeHead(200, {
          "Content-Type": contentType(matchedAsset.name),
          "Content-Length": content.byteLength,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(content);
        return;
      }
    }

    const outputFile = resolve(snapshot.outputPath, `.${pathname}`);
    if (
      outputFile.startsWith(`${snapshot.outputPath}${sep}`) &&
      existsSync(outputFile) &&
      statSync(outputFile).isFile()
    ) {
      response.writeHead(200, {
        "Content-Type": contentType(outputFile),
        "Cache-Control": "no-store",
      });
      createReadStream(outputFile).pipe(response);
      return;
    }

    const acceptsHtml = request.headers.accept?.includes("text/html") ?? false;
    if (
      (pathname === "/" || (this.options.historyApiFallback && acceptsHtml)) &&
      snapshot.indexAsset
    ) {
      const content = snapshot.assets.get(`html:${snapshot.indexAsset}`);
      if (content) {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(content);
        return;
      }
    }
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}
