import type { ChromeCoverageRange } from "../shared/types.js";

export function mergeRanges(
  ranges: ChromeCoverageRange[],
  sourceLength: number,
): ChromeCoverageRange[] {
  const normalized = ranges
    .map((range) => ({
      start: Math.max(0, Math.min(sourceLength, Math.trunc(range.start))),
      end: Math.max(0, Math.min(sourceLength, Math.trunc(range.end))),
    }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: ChromeCoverageRange[] = [];
  for (const range of normalized) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function intersectRanges(
  ranges: ChromeCoverageRange[],
  start: number,
  end: number,
): ChromeCoverageRange[] {
  const intersections: ChromeCoverageRange[] = [];
  for (const range of ranges) {
    if (range.end <= start) continue;
    if (range.start >= end) break;
    intersections.push({ start: Math.max(start, range.start), end: Math.min(end, range.end) });
  }
  return intersections;
}
