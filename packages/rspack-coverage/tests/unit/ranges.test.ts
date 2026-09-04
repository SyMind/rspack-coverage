import { describe, expect, it } from "vitest";
import { intersectRanges, mergeRanges } from "../../src/analyzer/ranges.js";

describe("coverage ranges", () => {
  it("normalizes, clamps, and merges nested or overlapping ranges", () => {
    expect(
      mergeRanges(
        [
          { start: 8, end: 15 },
          { start: 2, end: 10 },
          { start: 3, end: 4 },
          { start: -4, end: 1 },
          { start: 30, end: 40 },
        ],
        20,
      ),
    ).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 15 },
    ]);
  });

  it("intersects a generated span without changing surrounding ranges", () => {
    expect(
      intersectRanges(
        [
          { start: 0, end: 5 },
          { start: 8, end: 14 },
        ],
        3,
        10,
      ),
    ).toEqual([
      { start: 3, end: 5 },
      { start: 8, end: 10 },
    ]);
  });
});
