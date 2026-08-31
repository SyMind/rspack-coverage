import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedRspackCoveragePluginOptions } from "../plugin/types.js";
import type { BuildSnapshot } from "../shared/types.js";

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

export class AnalysisServer {
  readonly token = randomBytes(24).toString("base64url");
  #snapshot: BuildSnapshot | null = null;
  #server = createServer((request, response) => void this.#handle(request, response));
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
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
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
      this.#serveApi(pathname, response);
      return;
    }

    if (pathname.startsWith(ANALYSIS_PREFIX)) {
      this.#serveAnalysisUi(pathname, response);
      return;
    }

    this.#serveApplication(pathname, request, response);
  }

  #serveApi(pathname: string, response: ServerResponse): void {
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
      sendJson(response, 200, Object.fromEntries(snapshot.originalSources));
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
