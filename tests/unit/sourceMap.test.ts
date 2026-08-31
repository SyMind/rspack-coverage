import { describe, expect, it } from "vitest";
import { buildGeneratedSpans } from "../../src/analyzer/sourceMap.js";

describe("source map spans", () => {
  it("keeps mapped, unmapped, and CRLF intervals explicit", () => {
    const generated = "aaaaabbbbb\r\ncc";
    const spans = buildGeneratedSpans(generated, {
      version: 3,
      sources: ["webpack:///./src/index.js"],
      sourcesContent: ["used();\ncold();\nlast();"],
      names: [],
      mappings: "AAAA,KACA;AACA",
    });
    expect(spans.map((span) => [span.start, span.end, span.originalLine])).toEqual([
      [0, 5, 0],
      [5, 10, 1],
      [10, 12, null],
      [12, 14, 2],
    ]);
  });
});
