import { type ReactNode, useEffect, useRef } from "react";
import type { CodeCoverageSpan, CodeViewResponse } from "../../shared/types.js";

const TOKEN_RE =
  /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:\\.|[^`])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:const|let|var|function|class|return|if|else|for|while|switch|case|break|continue|new|import|export|from|default|async|await|try|catch|throw|extends|typeof|instanceof|in|of|true|false|null|undefined)\b|\b\d+(?:\.\d+)?\b)/g;

function syntaxNodes(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let index = 0;
  for (const match of text.matchAll(TOKEN_RE)) {
    const start = match.index ?? 0;
    if (start > cursor) nodes.push(text.slice(cursor, start));
    const token = match[0];
    const className =
      token.startsWith("//") || token.startsWith("/*")
        ? "syntax-comment"
        : token.startsWith('"') || token.startsWith("'") || token.startsWith("`")
          ? "syntax-string"
          : /^\d/.test(token)
            ? "syntax-number"
            : "syntax-keyword";
    nodes.push(
      <span className={className} key={`${keyPrefix}:${index++}`}>
        {token}
      </span>,
    );
    cursor = start + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

export function SyntaxText(props: { text: string; keyPrefix: string }) {
  return <>{syntaxNodes(props.text, props.keyPrefix)}</>;
}

function segmentsForLine(
  spans: CodeCoverageSpan[],
  lineStart: number,
  lineEnd: number,
): Array<{ start: number; end: number; status: CodeCoverageSpan["status"] }> {
  const result: Array<{ start: number; end: number; status: CodeCoverageSpan["status"] }> = [];
  let cursor = lineStart;
  for (const span of spans) {
    if (span.end <= lineStart) continue;
    if (span.start >= lineEnd) break;
    const start = Math.max(lineStart, span.start);
    const end = Math.min(lineEnd, span.end);
    if (start > cursor) result.push({ start: cursor, end: start, status: "neutral" });
    if (end > start) result.push({ start, end, status: span.status });
    cursor = Math.max(cursor, end);
  }
  if (cursor < lineEnd) result.push({ start: cursor, end: lineEnd, status: "neutral" });
  if (result.length === 0) result.push({ start: lineStart, end: lineEnd, status: "neutral" });
  return result;
}

export function CoverageCode(props: {
  code: CodeViewResponse;
  highlight?: { start: number; end: number; flashKey: number } | null;
}) {
  const rootRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!props.highlight) return;
    rootRef.current
      ?.querySelector<HTMLElement>("[data-usage-highlight]")
      ?.scrollIntoView?.({ behavior: "smooth", block: "center", inline: "nearest" });
  }, [props.highlight]);
  const starts = [0];
  for (let index = 0; index < props.code.content.length; index += 1) {
    if (props.code.content.charCodeAt(index) === 10) starts.push(index + 1);
  }
  const spans = [...props.code.spans].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  return (
    <section
      className="coverage-code"
      aria-label={`${props.code.view} code coverage`}
      ref={rootRef}
    >
      {starts.map((start, index) => {
        const next = starts[index + 1] ?? props.code.content.length;
        const end =
          next > start && props.code.content.charCodeAt(next - 1) === 10 ? next - 1 : next;
        const segments = segmentsForLine(spans, start, end);
        return (
          <div className="coverage-code-line" key={start || `line:${index}`}>
            <span className="coverage-line-number">{props.code.startLine + index}</span>
            <code>
              {segments.map((segment) => {
                const highlightStart = props.highlight
                  ? Math.max(segment.start, props.highlight.start)
                  : segment.end;
                const highlightEnd = props.highlight
                  ? Math.min(segment.end, props.highlight.end)
                  : segment.start;
                const hasHighlight = highlightEnd > highlightStart;
                return (
                  <span
                    className={`coverage-segment coverage-${segment.status}`}
                    key={`${start}:${segment.start}:${segment.end}:${segment.status}`}
                  >
                    {hasHighlight ? (
                      <>
                        <SyntaxText
                          text={props.code.content.slice(segment.start, highlightStart)}
                          keyPrefix={`${start}:${segment.start}:before`}
                        />
                        <mark
                          className="usage-highlight"
                          data-usage-highlight
                          key={`${highlightStart}:${highlightEnd}:${props.highlight?.flashKey}`}
                        >
                          <SyntaxText
                            text={props.code.content.slice(highlightStart, highlightEnd) || " "}
                            keyPrefix={`${start}:${highlightStart}:highlight`}
                          />
                        </mark>
                        <SyntaxText
                          text={props.code.content.slice(highlightEnd, segment.end)}
                          keyPrefix={`${start}:${highlightEnd}:after`}
                        />
                      </>
                    ) : (
                      <SyntaxText
                        text={props.code.content.slice(segment.start, segment.end) || " "}
                        keyPrefix={`${start}:${segment.start}`}
                      />
                    )}
                  </span>
                );
              })}
            </code>
          </div>
        );
      })}
    </section>
  );
}
