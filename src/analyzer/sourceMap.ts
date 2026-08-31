import { decodedMappings, TraceMap } from "@jridgewell/trace-mapping";
import type { RawSourceMapPayload } from "../shared/types.js";
import { buildLineStarts } from "./utf.js";

export interface GeneratedSpan {
  start: number;
  end: number;
  source: string | null;
  sourceContent: string | null;
  originalLine: number | null;
  originalColumn: number | null;
  originalEndColumn: number | null;
}

function sourceName(map: RawSourceMapPayload, index: number): string {
  const source = map.sources[index] ?? `[unknown source ${index}]`;
  if (!map.sourceRoot || /^(?:webpack|rspack|file):\/\//.test(source)) return source;
  return `${map.sourceRoot.replace(/\/$/, "")}/${source.replace(/^\//, "")}`;
}

export function buildGeneratedSpans(
  generated: string,
  rawMap: RawSourceMapPayload,
): GeneratedSpan[] {
  const traceMap = new TraceMap(rawMap as any);
  const decoded = decodedMappings(traceMap);
  const lineStarts = buildLineStarts(generated);
  const spans: GeneratedSpan[] = [];

  for (let line = 0; line < lineStarts.length; line += 1) {
    const lineStart = lineStarts[line] ?? 0;
    const nextLineStart = lineStarts[line + 1] ?? generated.length;
    let contentEnd = nextLineStart;
    if (contentEnd > lineStart && generated.charCodeAt(contentEnd - 1) === 10) contentEnd -= 1;
    if (contentEnd > lineStart && generated.charCodeAt(contentEnd - 1) === 13) contentEnd -= 1;
    const segments = decoded[line] ?? [];
    let cursor = lineStart;

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index] as number[];
      const segmentStart = Math.min(contentEnd, lineStart + (segment[0] ?? 0));
      if (segmentStart > cursor) {
        spans.push(unmapped(cursor, segmentStart));
      }
      const nextSegment = segments[index + 1] as number[] | undefined;
      const segmentEnd = Math.max(
        segmentStart,
        Math.min(contentEnd, nextSegment ? lineStart + (nextSegment[0] ?? 0) : contentEnd),
      );
      if (segmentEnd > segmentStart) {
        if (segment.length >= 4 && segment[1] !== undefined && segment[2] !== undefined) {
          const sourceIndex = segment[1];
          const nextOriginalColumn =
            nextSegment &&
            nextSegment.length >= 4 &&
            nextSegment[1] === sourceIndex &&
            nextSegment[2] === segment[2]
              ? (nextSegment[3] ?? null)
              : null;
          spans.push({
            start: segmentStart,
            end: segmentEnd,
            source: sourceName(rawMap, sourceIndex),
            sourceContent: rawMap.sourcesContent?.[sourceIndex] ?? null,
            originalLine: segment[2] ?? null,
            originalColumn: segment[3] ?? 0,
            originalEndColumn: nextOriginalColumn,
          });
        } else {
          spans.push(unmapped(segmentStart, segmentEnd));
        }
      }
      cursor = Math.max(cursor, segmentEnd);
    }

    if (cursor < contentEnd) spans.push(unmapped(cursor, contentEnd));
    if (contentEnd < nextLineStart) spans.push(unmapped(contentEnd, nextLineStart));
  }

  if (spans.length === 0 && generated.length > 0) return [unmapped(0, generated.length)];
  return spans;
}

function unmapped(start: number, end: number): GeneratedSpan {
  return {
    start,
    end,
    source: null,
    sourceContent: null,
    originalLine: null,
    originalColumn: null,
    originalEndColumn: null,
  };
}
