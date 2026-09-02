import { describe, expect, it } from "vitest";
import {
  normalizeSourcePath,
  normalizeSourcePathForContext,
  normalizeUrlPath,
  sourceCategory,
} from "../../src/shared/path.js";

describe("path normalization", () => {
  it("normalizes webpack URLs, loader queries, and URL fragments", () => {
    expect(normalizeSourcePath("webpack:///./src/page.tsx?loader!=x#fragment")).toBe(
      "src/page.tsx",
    );
    expect(normalizeUrlPath("https://127.0.0.1/assets/main.js?v=1#x")).toBe("/assets/main.js");
  });

  it("keeps the resource path from a full Rspack loader request", () => {
    expect(
      normalizeSourcePath(
        "/project/node_modules/@code-inspector/webpack/dist/loader.js??ruleSet[1].rules[25].use[0]!/project/src/page.tsx?compiled=true",
      ),
    ).toBe("project/src/page.tsx");
    expect(normalizeSourcePath("/loader.js?value!=x#fragment")).toBe("loader.js");
  });

  it("resolves webpack parent paths against the compilation context", () => {
    const context = "/repo/packages/L4-Entry/app-flow-chat";
    expect(
      normalizeSourcePathForContext(
        "webpack://app-flow-chat/../../../node_modules/pkg/form/field.js",
        context,
      ),
    ).toBe(normalizeSourcePathForContext("/repo/node_modules/pkg/form/field.js", context));
    expect(normalizeSourcePathForContext("webpack:///./src/page.tsx", context)).toBe(
      "src/page.tsx",
    );
  });

  it("classifies dependency and runtime sources", () => {
    expect(sourceCategory("node_modules/react/index.js")).toBe("node_modules");
    expect(sourceCategory("[rspack runtime / unmapped]/main.js")).toBe("runtime");
    expect(sourceCategory("src/index.ts")).toBe("first-party");
  });
});
