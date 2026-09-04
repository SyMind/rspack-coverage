import { describe, expect, it } from "vitest";
import {
  assertSnapshotRecordSize,
  MAX_SNAPSHOT_RECORD_BYTES,
} from "../../src/shared/snapshotLimits.js";

describe("snapshot memory guards", () => {
  it("accepts the boundary and rejects a larger single payload", () => {
    expect(() =>
      assertSnapshotRecordSize("source", "at-limit", MAX_SNAPSHOT_RECORD_BYTES),
    ).not.toThrow();
    expect(() =>
      assertSnapshotRecordSize("source", "too-large", MAX_SNAPSHOT_RECORD_BYTES + 1),
    ).toThrow(/256 MiB per-record memory guard/);
  });
});
