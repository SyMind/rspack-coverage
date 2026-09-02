// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BuildManifest,
  CoverageAnalysisStatus,
  CoverageReport,
} from "../../src/shared/types.js";
import { App } from "../../src/ui/App.js";

const api = vi.hoisted(() => ({
  loadBuild: vi.fn(),
  loadCoverageAnalysisStatus: vi.fn(),
  snapshotDownloadUrl: vi.fn(() => "/api/snapshot?token=test"),
  uploadSnapshot: vi.fn(),
  reuseCoverageAnalysis: vi.fn(),
  startCoverageAnalysis: vi.fn(),
}));

vi.mock("../../src/ui/lib/api.js", () => api);

function build(hash: string): BuildManifest {
  return {
    hash,
    mode: "production",
    context: "/project",
    publicPath: "/",
    builtAt: 1,
    assets: [],
    chunks: [],
    modules: [],
    entrypoints: [],
    diagnostics: [],
    capabilities: {
      usedExports: "enabled",
      sourceMap: "full",
      originalLocations: "exact",
    },
    counts: {
      assets: 0,
      javascriptAssets: 0,
      chunks: 0,
      modules: 0,
      sourceMaps: 0,
    },
    previewAvailable: true,
    publicPathSupported: true,
  };
}

const idle: CoverageAnalysisStatus = { status: "idle", recentAvailable: false };

function report(): CoverageReport {
  const metrics = {
    emittedBytes: 10,
    loadedBytes: 10,
    executedBytes: 10,
    unusedBytes: 0,
    notLoadedBytes: 0,
    mappedBytes: 10,
    unmappedBytes: 0,
    usageRatio: 1,
  };
  return {
    version: 2,
    buildHash: "current-build-hash",
    createdAt: 1,
    metrics,
    moduleMetrics: metrics,
    importSummary: {
      importedEntries: 1,
      matchedAssets: 1,
      ignoredEntries: [],
      precision: "per-block",
    },
    tree: {
      id: "root",
      name: "Sources",
      path: "",
      kind: "root",
      category: "all",
      metrics,
      chunks: [],
      duplicated: false,
      children: [],
    },
    files: [],
    chunks: [],
    opportunities: [],
  };
}

describe("snapshot upload UI", () => {
  beforeEach(() => {
    api.loadBuild.mockResolvedValue(build("current-build-hash"));
    api.loadCoverageAnalysisStatus.mockResolvedValue(idle);
    api.uploadSnapshot.mockResolvedValue({
      snapshotId: "v2-0123456789abcdef0123456789abcdef",
      bytes: 128,
      build: build("imported-build-hash"),
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("imports a snapshot selected from the top-right button", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Upload snapshot" });
    const file = new File(["portable snapshot"], "build.rspack-coverage");

    fireEvent.change(screen.getByLabelText("Snapshot file"), {
      target: { files: [file] },
    });

    await waitFor(() => expect(api.uploadSnapshot).toHaveBeenCalledWith(file));
    expect(await screen.findByText("imported-bui", { selector: "code" })).toBeInTheDocument();
  });

  it("keeps only report actions in the top bar and starts the report with metrics", async () => {
    api.loadCoverageAnalysisStatus.mockResolvedValueOnce({ status: "complete", report: report() });
    render(<App />);

    await screen.findByRole("navigation", { name: "Coverage report sections" });
    expect(document.querySelector(".topbar .brand")).toBeNull();
    expect(document.querySelector(".topbar .brand-mark")).toBeNull();
    expect(document.querySelector(".topbar .build-status")).toBeNull();
    expect(document.querySelector(".report-heading")).toBeNull();
    expect(screen.queryByText("What loaded, what ran, what remained")).toBeNull();
    expect(document.querySelector(".report-shell > .metric-grid")).toBeInTheDocument();
  });

  it("shows the coverage green status dot only while a snapshot is uploading", async () => {
    let finishUpload = () => {};
    api.uploadSnapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishUpload = () =>
            resolve({
              snapshotId: "v2-0123456789abcdef0123456789abcdef",
              bytes: 128,
              build: build("imported-build-hash"),
            });
        }),
    );
    render(<App />);
    const initialButton = await screen.findByRole("button", { name: "Upload snapshot" });
    expect(initialButton.querySelector(".snapshot-upload-status")).toBeNull();

    fireEvent.change(screen.getByLabelText("Snapshot file"), {
      target: { files: [new File(["portable snapshot"], "build.rspack-coverage")] },
    });

    const busyButton = await screen.findByRole("button", { name: "Importing snapshot…" });
    expect(busyButton).toHaveAttribute("aria-busy", "true");
    expect(busyButton.querySelector(".snapshot-upload-status")).toBeInTheDocument();

    finishUpload();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Upload snapshot" })).toBeEnabled(),
    );
  });

  it("accepts a snapshot dropped anywhere on the workbench", async () => {
    render(<App />);
    const workbench = await screen.findByRole("region", {
      name: "Rspack Coverage workbench",
    });
    const file = new File(["portable snapshot"], "dropped.rspack-coverage");
    const dataTransfer = { types: ["Files"], files: [file] };

    fireEvent.dragEnter(workbench, { dataTransfer });
    expect(screen.getByText("Drop snapshot to open it")).toBeInTheDocument();
    fireEvent.drop(workbench, { dataTransfer });

    await waitFor(() => expect(api.uploadSnapshot).toHaveBeenCalledWith(file));
    await waitFor(() => expect(screen.queryByText("Drop snapshot to open it")).toBeNull());
  });

  it("keeps snapshot upload available when no saved build exists", async () => {
    api.loadBuild.mockRejectedValueOnce(new Error("Build data is not ready"));
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Open a saved snapshot" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Upload snapshot" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Choose snapshot file" })).toBeEnabled();
  });
});
