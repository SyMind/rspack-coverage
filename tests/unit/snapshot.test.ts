import { describe, expect, it } from "vitest";
import { collectCodeGeneratedModuleIdentifiers } from "../../src/plugin/snapshot.js";

describe("snapshot code-generation eligibility", () => {
  it("uses Stats codeGenerated markers recursively", () => {
    const identifiers = collectCodeGeneratedModuleIdentifiers([
      {
        identifier: "concatenated-root",
        codeGenerated: true,
        modules: [
          { identifier: "nested-without-entry", codeGenerated: false },
          { identifier: "nested-generated", codeGenerated: true },
        ],
      },
      { identifier: "standalone-without-entry", codeGenerated: false },
    ]);

    expect(identifiers).toEqual(new Set(["concatenated-root", "nested-generated"]));
  });

  it("keeps the legacy best-effort path when Stats omits the marker", () => {
    expect(
      collectCodeGeneratedModuleIdentifiers([
        { identifier: "legacy", modules: [{ identifier: "legacy-child" }] },
      ]),
    ).toBeNull();
  });
});
