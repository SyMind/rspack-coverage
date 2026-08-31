import { describe, expect, it } from "vitest";
import { buildLineStarts, buildUtf8Prefix, utf8BytesBetween } from "../../src/analyzer/utf.js";

describe("UTF-16 positions and UTF-8 byte accounting", () => {
  it("counts surrogate pairs and Unicode without treating columns as bytes", () => {
    const text = "a😀é";
    const prefix = buildUtf8Prefix(text);
    expect(text.length).toBe(4);
    expect(utf8BytesBetween(prefix, 0, text.length)).toBe(7);
    expect(utf8BytesBetween(prefix, 1, 3)).toBe(4);
    expect(utf8BytesBetween(prefix, 3, 4)).toBe(2);
  });

  it("keeps CRLF in generated offsets while finding line starts", () => {
    expect(buildLineStarts("one\r\ntwo\n三")).toEqual([0, 5, 9]);
  });
});
