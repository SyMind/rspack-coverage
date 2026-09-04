import { useEffect, useRef, useState } from "react";
import { FULL_PATH_COPY_EVENT, type FullPathCopyResult } from "../lib/copyFullPath.js";

export function PathCopyToast() {
  const [result, setResult] = useState<FullPathCopyResult | null>(null);
  const dismissTimer = useRef<number | null>(null);

  useEffect(() => {
    const onCopy = (event: Event) => {
      const detail = (event as CustomEvent<FullPathCopyResult>).detail;
      setResult(detail);
      if (dismissTimer.current !== null) window.clearTimeout(dismissTimer.current);
      dismissTimer.current = window.setTimeout(() => setResult(null), 2200);
    };
    window.addEventListener(FULL_PATH_COPY_EVENT, onCopy);
    return () => {
      window.removeEventListener(FULL_PATH_COPY_EVENT, onCopy);
      if (dismissTimer.current !== null) window.clearTimeout(dismissTimer.current);
    };
  }, []);

  if (!result) return null;
  return (
    <div
      className={`path-copy-toast${result.copied ? "" : " path-copy-toast--error"}`}
      role={result.copied ? "status" : "alert"}
      title={result.path}
    >
      <strong>{result.copied ? "Full path copied" : "Could not copy full path"}</strong>
      <code>{result.path}</code>
    </div>
  );
}
