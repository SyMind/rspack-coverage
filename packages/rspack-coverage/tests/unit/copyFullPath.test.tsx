// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PathCopyToast } from "../../src/ui/components/PathCopyToast.js";
import { copyablePathProps } from "../../src/ui/lib/copyFullPath.js";

afterEach(() => {
  cleanup();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
});

describe("copyable full paths", () => {
  it("reveals and copies the original path instead of the shortened label", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const path = "/project/a/very/long/source/path/value.ts";
    render(
      <>
        <span {...copyablePathProps(path)}>value.ts</span>
        <PathCopyToast />
      </>,
    );

    const label = screen.getByText("value.ts");
    expect(label).toHaveAttribute("title", path);
    expect(label).toHaveAttribute("data-full-path", path);

    const event = createEvent.contextMenu(label);
    fireEvent(label, event);
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(path));
    expect(screen.getByRole("status")).toHaveTextContent("Full path copied");
    expect(screen.getByRole("status")).toHaveTextContent(path);
  });
});
