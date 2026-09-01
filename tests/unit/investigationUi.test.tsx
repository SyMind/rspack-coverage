// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CoverageCode } from "../../src/ui/components/CoverageCode.js";

afterEach(cleanup);

describe("coverage investigation UI", () => {
  it("renders executed code green and loaded-but-unexecuted code red", () => {
    render(
      <CoverageCode
        code={{
          view: "source",
          sourceId: "source",
          filename: "source.js",
          language: "javascript",
          content: "used();\nunused();",
          spans: [
            { start: 0, end: 7, status: "executed" },
            { start: 8, end: 17, status: "unexecuted" },
          ],
          offset: 0,
          endOffset: 17,
          startLine: 1,
          totalCharacters: 17,
          hasPrevious: false,
          hasNext: false,
          provenance: "test",
          gap: null,
        }}
      />,
    );

    expect(document.querySelector(".coverage-executed")).toHaveTextContent("used();");
    expect(document.querySelector(".coverage-unexecuted")).toHaveTextContent("unused();");
  });
});
