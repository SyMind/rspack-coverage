import { describe, expect, it } from "vitest";
import { ExportAnalysisService } from "../../src/server/ExportAnalysisService.js";
import type { BuildSnapshot } from "../../src/shared/types.js";

describe("ExportAnalysisService memory guard", () => {
  it("fails explicitly instead of truncating an oversized direct-reference ledger", async () => {
    const snapshot: BuildSnapshot = {
      manifest: {
        hash: "build",
        mode: "production",
        context: "/project",
        publicPath: "/",
        builtAt: 1,
        assets: [],
        chunks: [],
        modules: [
          {
            id: "target",
            identifier: "/project/src/target.js",
            name: "./src/target.js",
            resource: "/project/src/target.js",
            sourcePaths: ["src/target.js"],
            moduleType: "javascript/esm",
            chunks: [],
            issuer: null,
            size: 1,
            usedExports: ["value"],
            providedExports: ["value"],
            optimizationBailout: [],
            nested: false,
          },
        ],
        entrypoints: [],
        diagnostics: [],
        capabilities: {
          usedExports: "enabled",
          sourceMap: "full",
          originalLocations: "exact",
        },
        counts: {
          assets: 0,
          javascriptAssets: 0,
          chunks: 0,
          modules: 1,
          sourceMaps: 0,
          references: 25_001,
        },
        previewAvailable: false,
        publicPathSupported: true,
      },
      assets: new Map(),
      maps: new Map(),
      originalSources: new Map([["src/target.js", "export const value = 1;"]]),
      exportGraph: { modules: [], edges: [], sourceToModuleIds: {} },
      references: [],
      referenceStore: {
        size: 25_001,
        get: () => undefined,
        count: () => 0,
        page: () => [],
        incomingOrigins: () => [],
        countTargets: () => 25_001,
        forTargets: () => {
          throw new Error("Oversized references must not be materialized");
        },
        *entries() {},
      },
      codeGeneration: new Map(),
      outputPath: "/project/dist",
      indexAsset: null,
    };
    const service = new ExportAnalysisService();
    try {
      expect(service.request(snapshot, "src/target.js")).toMatchObject({
        status: "error",
        message: expect.stringContaining("25001 direct references"),
      });
    } finally {
      await service.close();
    }
  });
});
