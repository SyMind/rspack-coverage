import { describe, expect, it } from "vitest";
import { NativeExportUsageCapture } from "../../src/plugin/exportUsageCapture.js";

describe("NativeExportUsageCapture", () => {
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
