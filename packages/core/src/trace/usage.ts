import { fail } from "../errors.js";
import { immutable, type JsonValue } from "../helpers/json.js";
export const tokenMetrics = [
  "inputTokens",
  "uncachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "cacheReadInputTokens",
  "cacheWriteInputTokens",
  "totalTokens",
] as const;
export type TokenMetric = (typeof tokenMetrics)[number];
export type UsageSource = "provider" | "derived" | "estimated" | "unavailable";
export type TokenCounts = Record<TokenMetric, number | null>;
export interface ModelUsage extends TokenCounts {
  provenance: Record<TokenMetric, UsageSource>;
  providerDetails?: JsonValue;
}
export interface UsageMetricSummary {
  knownTotal: number | null;
  knownAttempts: number;
  totalAttempts: number;
  coverage: "complete" | "partial" | "unavailable";
}
export interface UsageSummary {
  metrics: Record<TokenMetric, UsageMetricSummary>;
}
export function normalizeUsage(
  input: Partial<TokenCounts>,
  providerDetails?: JsonValue,
): ModelUsage {
  const counts = {} as TokenCounts,
    provenance = {} as ModelUsage["provenance"];
  for (const key of tokenMetrics) {
    const value = input[key] ?? null;
    if (value !== null && (!Number.isSafeInteger(value) || value < 0))
      fail("InvalidUsage", "Token counts must be nonnegative integers");
    counts[key] = value;
    provenance[key] = value === null ? "unavailable" : "provider";
  }
  if (
    counts.totalTokens === null &&
    counts.inputTokens !== null &&
    counts.outputTokens !== null
  ) {
    counts.totalTokens = counts.inputTokens + counts.outputTokens;
    provenance.totalTokens = "derived";
  }
  return immutable({
    ...counts,
    provenance,
    ...(providerDetails !== undefined ? { providerDetails } : {}),
  });
}
export function aggregateUsage(
  attempts: readonly { id: string; usage: ModelUsage }[],
): UsageSummary {
  const unique = [...new Map(attempts.map((a) => [a.id, a])).values()];
  const metrics = {} as UsageSummary["metrics"];
  for (const key of tokenMetrics) {
    const known = unique
      .map((a) => a.usage[key])
      .filter((v): v is number => v !== null);
    metrics[key] = {
      knownTotal:
        known.length || !unique.length
          ? known.reduce((a, b) => a + b, 0)
          : null,
      knownAttempts: known.length,
      totalAttempts: unique.length,
      coverage:
        known.length === unique.length
          ? "complete"
          : known.length
            ? "partial"
            : "unavailable",
    };
  }
  return immutable({ metrics });
}
