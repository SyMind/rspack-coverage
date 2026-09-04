import type {
  CodeCoverageSpan,
  CodeCoverageState,
  SourceFileReport,
  SourceLineState,
} from "./types.js";

export function sourceLineCoverageStatus(line: SourceLineState): CodeCoverageState {
  if (line.buildState === "not-emitted") return "not-emitted";
  if (line.buildState === "unknown") return "unknown";
  if (line.runtimeState === "not-loaded") return "unloaded";
  if (line.runtimeState === "not-executed") return "unexecuted";
  if (line.runtimeState === "executed") return "executed";
  return "unknown";
}

/**
 * Source maps attribute generated ranges to original lines much more reliably than
 * to exact original character intervals. Paint the complete original line from
 * that evidence: executed is green, loaded-but-unexecuted is red, and evidence
 * gaps retain their own non-binary states.
 */
export function sourceFileCoverageSpans(file: SourceFileReport): CodeCoverageSpan[] {
  if (!file.content) return [];
  return sourceLinesCoverageSpans(file.content, file.lines);
}

export function sourceLinesCoverageSpans(
  content: string,
  lines: readonly SourceLineState[],
): CodeCoverageSpan[] {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return lines.flatMap((line) => {
    const start = starts[line.line - 1] ?? 0;
    const next = starts[line.line] ?? content.length;
    const end = Math.max(start, next - (content.charCodeAt(next - 1) === 10 ? 1 : 0));
    return end > start ? [{ start, end, status: sourceLineCoverageStatus(line) }] : [];
  });
}
