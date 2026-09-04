import { describe, expect, it } from "vitest";
import { formatPercent } from "../../src/ui/lib/format.js";

describe("formatPercent", () => {
  it("keeps small positive usage distinguishable from zero", () => {
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(0.004)).toBe("<1%");
    expect(formatPercent(0.006)).toBe("1%");
  });
});
