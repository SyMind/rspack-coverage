export const MAX_SNAPSHOT_RECORD_BYTES = 256 * 1024 * 1024;
export const MAX_COVERAGE_ANALYSIS_BYTES = 128 * 1024 * 1024;
/**
 * Portable snapshots are streamed to disk, so this is a disk/abuse guard rather
 * than a JavaScript heap limit. It intentionally leaves ample room above the
 * multi-gigabyte captures this tool is designed to inspect.
 */
export const MAX_PORTABLE_SNAPSHOT_BYTES = 32 * 1024 * 1024 * 1024;

export function assertSnapshotRecordSize(family: string, key: string, bytes: number): void {
  if (bytes <= MAX_SNAPSHOT_RECORD_BYTES) return;
  throw new Error(
    `Rspack Coverage refused to materialize ${family} ${JSON.stringify(key)}: ${bytes} bytes exceeds the 256 MiB per-record memory guard. Split the source/chunk or exclude it from this analysis build.`,
  );
}
