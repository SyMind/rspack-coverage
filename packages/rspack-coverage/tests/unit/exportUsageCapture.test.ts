import { describe, expect, it } from "vitest";
import { NativeExportUsageCapture } from "../../src/plugin/exportUsageCapture.js";

describe("NativeExportUsageCapture", () => {
  it("retains the logical module graph before concatenation and drops self references", () => {
    const capture = new NativeExportUsageCapture();
    const consumer = {
      layer: "client",
      identifier: () => "/project/consumer.js",
    };
    const provider = {
      identifier: () => "/project/provider.js",
    };
    const dependency = {
      id: "dependency-1",
      type: "esm import specifier",
      request: "./provider.js",
      ids: ["value"],
      loc: {
        start: { line: 4, column: 3 },
        end: { line: 4, column: 8 },
      },
    };
    const selfDependency = {
      id: "dependency-self",
      type: "cjs self exports reference",
      request: "self",
    };
    const connections = new Map<object, any[]>([
      [
        consumer,
        [
          {
            dependency,
            originModule: consumer,
            resolvedModule: provider,
            getActiveState: (): boolean => true,
          },
          {
            dependency: selfDependency,
            originModule: consumer,
            resolvedModule: consumer,
            getActiveState: (): boolean => true,
          },
        ],
      ],
      [provider, []],
    ]);

    try {
      capture.captureReferences(
        {
          moduleGraph: {
            getOutgoingConnections: (module: object) => connections.get(module) ?? [],
            getParentModule: (value: object) => (value === dependency ? consumer : null),
          },
        },
        [consumer, provider],
      );

      expect(capture.referencesAvailable).toBe(true);
      expect(capture.referenceSize).toBe(1);
      expect(capture.discardedReferences).toBe(0);
      expect([...capture.referenceEntries()]).toEqual([
        {
          originIdentifier: "/project/consumer.js",
          originLayer: "client",
          targetIdentifier: "/project/provider.js",
          targetLayer: null,
          dependencyId: "dependency-1",
          dependencyType: "esm import specifier",
          request: "./provider.js",
          exports: ["value"],
          active: true,
          location: {
            start: { line: 4, column: 2 },
            end: { line: 4, column: 7 },
          },
        },
      ]);
    } finally {
      capture.dispose();
    }
  });

  it("projects Rsdoctor tuples to a narrow disk ledger and keeps the richest callback", () => {
    const capture = new NativeExportUsageCapture();
    try {
      capture.capture({
        modules: [
          { ukey: 1, identifier: "/project/consumer.js" },
          { ukey: 2, identifier: "/project/provider.js", layer: "client" },
        ],
        exportUsageEdges: [
          [1, ["forwarded"], 2, ["value", "field"], "dependency-1", "4:2-7"],
          [1, null, 2, ["other"], "dependency-2", null],
          [9, null, 2, ["missing"], "dependency-3", null],
        ],
      });

      expect(capture.available).toBe(true);
      expect(capture.size).toBe(2);
      expect(capture.discarded).toBe(1);
      expect([...capture.entries()]).toEqual([
        {
          originIdentifier: "/project/consumer.js",
          originLayer: null,
          originExport: ["forwarded"],
          targetIdentifier: "/project/provider.js",
          targetLayer: "client",
          targetExport: ["value", "field"],
          dependencyId: "dependency-1",
          location: "4:2-7",
        },
        {
          originIdentifier: "/project/consumer.js",
          originLayer: null,
          originExport: null,
          targetIdentifier: "/project/provider.js",
          targetLayer: "client",
          targetExport: ["other"],
          dependencyId: "dependency-2",
          location: null,
        },
      ]);

      capture.capture({ modules: [], exportUsageEdges: [] });
      expect(capture.size).toBe(2);
    } finally {
      capture.dispose();
    }
  });
});
