import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CapturePayloadStore } from "../../src/plugin/captureStore.js";

describe("capture spill store", () => {
  it("keeps source payloads and reference adjacency on disk", () => {
    const store = new CapturePayloadStore();
    const directory = store.directory;
    try {
      store.sources.set("src/a.js", "a".repeat(1024 * 1024));
      store.sources.set("src/b.js", "b");
      store.references.add({
        id: "edge-a-b",
        originId: "a",
        targetId: "b",
        dependencyType: "esm import",
        request: "./b.js",
        exports: ["value"],
        active: true,
        location: null,
      });
      store.references.finish();

      expect(store.sources.size).toBe(2);
      expect(store.sources.get("src/a.js")?.length).toBe(1024 * 1024);
      expect(store.references.count("b", "in")).toBe(1);
      expect(store.references.page("b", "in", 0, 1)[0]?.id).toBe("edge-a-b");
      expect(store.references.incomingOrigins("b")).toEqual(["a"]);
    } finally {
      store.dispose();
    }
    expect(existsSync(directory)).toBe(false);
  });
});
