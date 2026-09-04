import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
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

export interface CodeSearchMatch {
  index: number;
  start: number;
  end: number;
}

const MAX_CODE_SEARCH_MATCHES = 20_000;

function findCodeSearchMatches(
  content: string,
  query: string,
): { matches: CodeSearchMatch[]; truncated: boolean } {
  if (!query) return { matches: [], truncated: false };
  const haystack = content.toLowerCase();
  const needle = query.toLowerCase();
  const matches: CodeSearchMatch[] = [];
  let cursor = 0;
  while (cursor <= haystack.length - needle.length) {
    const start = haystack.indexOf(needle, cursor);
    if (start < 0) break;
    matches.push({ index: matches.length, start, end: start + needle.length });
    if (matches.length === MAX_CODE_SEARCH_MATCHES) {
      return { matches, truncated: true };
    }
    cursor = start + needle.length;
  }
  return { matches, truncated: false };
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
  searchMatches?: CodeSearchMatch[];
  activeSearchIndex?: number;
}) {
  const rootRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!props.highlight) return;
    rootRef.current
      ?.querySelector<HTMLElement>("[data-usage-highlight]")
      ?.scrollIntoView?.({ behavior: "smooth", block: "center", inline: "nearest" });
  }, [props.highlight]);
  const activeSearchMatch = props.searchMatches?.find(
    (match) => match.index === props.activeSearchIndex,
  );
  const activeSearchKey = activeSearchMatch
    ? `${activeSearchMatch.start}:${activeSearchMatch.end}`
    : "";
  useEffect(() => {
    if (props.activeSearchIndex === undefined || props.activeSearchIndex < 0 || !activeSearchKey) {
      return;
    }
    rootRef.current
      ?.querySelector<HTMLElement>(`[data-code-search-index="${props.activeSearchIndex}"]`)
      ?.scrollIntoView?.({ behavior: "smooth", block: "center", inline: "nearest" });
  }, [props.activeSearchIndex, activeSearchKey]);
  const starts = [0];
  for (let index = 0; index < props.code.content.length; index += 1) {
    if (props.code.content.charCodeAt(index) === 10) starts.push(index + 1);
  }
  const spans = [...props.code.spans].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const searchMatchesByLine = new Map<number, CodeSearchMatch[]>();
  let searchLine = 0;
  for (const match of props.searchMatches ?? []) {
    let nextLineStart = starts[searchLine + 1];
    while (nextLineStart !== undefined && nextLineStart <= match.start) {
      searchLine += 1;
      nextLineStart = starts[searchLine + 1];
    }
    const matches = searchMatchesByLine.get(searchLine) ?? [];
    matches.push(match);
    searchMatchesByLine.set(searchLine, matches);
  }
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
        const lineSearchMatches = searchMatchesByLine.get(index) ?? [];
        return (
          <div className="coverage-code-line" key={start || `line:${index}`}>
            <span className="coverage-line-number">{props.code.startLine + index}</span>
            <code>
              {segments.map((segment) => {
                const searchMatches = lineSearchMatches.filter(
                  (match) => match.end > segment.start && match.start < segment.end,
                );
                const boundaries = new Set([segment.start, segment.end]);
                if (props.highlight) {
                  boundaries.add(Math.max(segment.start, props.highlight.start));
                  boundaries.add(Math.min(segment.end, props.highlight.end));
                }
                for (const match of searchMatches) {
                  boundaries.add(Math.max(segment.start, match.start));
                  boundaries.add(Math.min(segment.end, match.end));
                }
                const orderedBoundaries = Array.from(boundaries)
                  .filter((boundary) => boundary >= segment.start && boundary <= segment.end)
                  .sort((left, right) => left - right);
                return (
                  <span
                    className={`coverage-segment coverage-${segment.status}`}
                    key={`${start}:${segment.start}:${segment.end}:${segment.status}`}
                  >
                    {orderedBoundaries.length > 1 ? (
                      orderedBoundaries.slice(0, -1).map((sliceStart, sliceIndex) => {
                        const sliceEnd = orderedBoundaries[sliceIndex + 1] ?? sliceStart;
                        if (sliceEnd <= sliceStart) return null;
                        const searchMatch = searchMatches.find(
                          (match) => match.start < sliceEnd && match.end > sliceStart,
                        );
                        const isUsageHighlight = Boolean(
                          props.highlight &&
                            props.highlight.start < sliceEnd &&
                            props.highlight.end > sliceStart,
                        );
                        const syntax = (
                          <SyntaxText
                            key={`syntax:${sliceStart}:${sliceEnd}`}
                            text={props.code.content.slice(sliceStart, sliceEnd) || " "}
                            keyPrefix={`${start}:${sliceStart}:${sliceEnd}`}
                          />
                        );
                        const usage = isUsageHighlight ? (
                          <mark
                            className="usage-highlight"
                            data-usage-highlight
                            key={`usage:${sliceStart}:${sliceEnd}:${props.highlight?.flashKey}`}
                          >
                            {syntax}
                          </mark>
                        ) : (
                          syntax
                        );
                        return searchMatch ? (
                          <mark
                            className={`code-search-match ${searchMatch.index === props.activeSearchIndex ? "is-active" : ""}`}
                            data-code-search-index={searchMatch.index}
                            key={`search:${sliceStart}:${sliceEnd}:${searchMatch.index}`}
                          >
                            {usage}
                          </mark>
                        ) : (
                          <span key={`text:${sliceStart}:${sliceEnd}`}>{usage}</span>
                        );
                      })
                    ) : (
                      <SyntaxText text=" " keyPrefix={`${start}:${segment.start}:empty`} />
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

export function SearchableCoverageCode(props: {
  code: CodeViewResponse;
  highlight?: { start: number; end: number; flashKey: number } | null;
  scrollClassName?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [wrapLines, setWrapLines] = useState(false);
  const search = useMemo(
    () => findCodeSearchMatches(props.code.content, query),
    [props.code.content, query],
  );
  const activeMatchIndex = search.matches.length
    ? Math.min(matchIndex, search.matches.length - 1)
    : -1;
  const moveSearch = (delta: number) => {
    if (search.matches.length === 0) return;
    setMatchIndex((current) => {
      const normalized = Math.min(Math.max(current, 0), search.matches.length - 1);
      return (normalized + delta + search.matches.length) % search.matches.length;
    });
  };
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((!event.metaKey && !event.ctrlKey) || event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);
  return (
    <>
      <search className="code-search-toolbar" aria-label="Search usage source code">
        <input
          ref={inputRef}
          type="search"
          aria-label="Search usage source code"
          placeholder="Search in usage file…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setMatchIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              moveSearch(event.shiftKey ? -1 : 1);
            } else if (event.key === "Escape") {
              setQuery("");
              setMatchIndex(0);
            }
          }}
        />
        <span className="code-search-status" aria-live="polite">
          {query
            ? search.matches.length
              ? `${activeMatchIndex + 1} / ${search.matches.length}${search.truncated ? "+" : ""}`
              : "No matches"
            : "⌘F"}
        </span>
        <button
          type="button"
          aria-label="Previous usage search match"
          disabled={search.matches.length === 0}
          onClick={() => moveSearch(-1)}
        >
          ↑
        </button>
        <button
          type="button"
          aria-label="Next usage search match"
          disabled={search.matches.length === 0}
          onClick={() => moveSearch(1)}
        >
          ↓
        </button>
        <button
          type="button"
          className="code-wrap-toggle"
          aria-pressed={wrapLines}
          onClick={() => setWrapLines((current) => !current)}
        >
          Wrap lines
        </button>
      </search>
      <div
        className={`coverage-code-scroll ${props.scrollClassName ?? ""}${wrapLines ? " is-wrapped" : ""}`}
      >
        <CoverageCode
          code={props.code}
          highlight={props.highlight ?? null}
          searchMatches={search.matches}
          activeSearchIndex={activeMatchIndex}
        />
      </div>
    </>
  );
}
