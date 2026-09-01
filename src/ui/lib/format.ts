export function formatBytes(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

export function formatPercent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

export function usageColor(ratio: number | null, loadedBytes: number): string {
  if (loadedBytes === 0) return "var(--not-loaded)";
  const safe = Math.max(0, Math.min(1, ratio ?? 0));
  if (safe === 0) return "#ef4444";
  if (safe === 1) return "#34d399";
  return `linear-gradient(90deg, #34d399 0 ${safe * 100}%, #ef4444 ${safe * 100}% 100%)`;
}
