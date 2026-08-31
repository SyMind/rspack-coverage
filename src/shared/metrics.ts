import type { UsageMetrics } from "./types.js";

export const emptyMetrics = (): UsageMetrics => ({
  emittedBytes: 0,
  loadedBytes: 0,
  executedBytes: 0,
  unusedBytes: 0,
  notLoadedBytes: 0,
  mappedBytes: 0,
  unmappedBytes: 0,
  usageRatio: null,
});

export function finalizeMetrics(metrics: UsageMetrics): UsageMetrics {
  metrics.unusedBytes = Math.max(0, metrics.loadedBytes - metrics.executedBytes);
  metrics.notLoadedBytes = Math.max(0, metrics.emittedBytes - metrics.loadedBytes);
  metrics.usageRatio = metrics.loadedBytes > 0 ? metrics.executedBytes / metrics.loadedBytes : null;
  return metrics;
}

export function addMetrics(target: UsageMetrics, source: UsageMetrics): UsageMetrics {
  target.emittedBytes += source.emittedBytes;
  target.loadedBytes += source.loadedBytes;
  target.executedBytes += source.executedBytes;
  target.mappedBytes += source.mappedBytes;
  target.unmappedBytes += source.unmappedBytes;
  return finalizeMetrics(target);
}

export function metricsFromBytes(input: {
  emittedBytes: number;
  loaded: boolean;
  executedBytes: number;
  mapped: boolean;
}): UsageMetrics {
  return finalizeMetrics({
    emittedBytes: input.emittedBytes,
    loadedBytes: input.loaded ? input.emittedBytes : 0,
    executedBytes: input.loaded ? input.executedBytes : 0,
    unusedBytes: 0,
    notLoadedBytes: 0,
    mappedBytes: input.mapped ? input.emittedBytes : 0,
    unmappedBytes: input.mapped ? 0 : input.emittedBytes,
    usageRatio: null,
  });
}
