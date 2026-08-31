import { describe, expect, it } from "vitest";
import { normalizeSourcePath, normalizeUrlPath, sourceCategory } from "../../src/shared/path.js";

describe("path normalization", () => {
  it("normalizes webpack URLs, loader queries, and URL fragments", () => {
    expect(normalizeSourcePath("webpack:///./src/page.tsx?loader!=x#fragment")).toBe(
      "src/page.tsx",
    );
    expect(normalizeUrlPath("https://127.0.0.1/assets/main.js?v=1#x")).toBe("/assets/main.js");
  });

  it("classifies dependency and runtime sources", () => {
    expect(sourceCategory("node_modules/react/index.js")).toBe("node_modules");
    expect(sourceCategory("[rspack runtime / unmapped]/main.js")).toBe("runtime");
    expect(sourceCategory("src/index.ts")).toBe("first-party");
  });
});
