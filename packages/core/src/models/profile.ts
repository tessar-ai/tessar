import type { JsonValue } from "../helpers/json.js";
import type { ModelRef } from "./contract.js";
export interface ModelPricing {
  currency: string;
  basis: "million-tokens";
  type: "flat" | "tiered";
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  tiers?: readonly { condition: JsonValue; rates: JsonValue }[];
}
export interface ProfileMetadata {
  completeness: "complete" | "partial" | "unavailable";
  freshness: "fresh" | "stale" | "unknown";
  fetchedAt: string | null;
  sourceRevision: string | null;
  provenance: Readonly<Record<string, string>>;
}
export interface ModelProfile extends ModelRef {
  name: string | null;
  contextWindow: number | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  capabilities: {
    tools: boolean | null;
    reasoning: boolean | null;
    structuredOutput: boolean | null;
    imageInput: boolean | null;
    audioInput: boolean | null;
    audioOutput: boolean | null;
  };
  pricing: ModelPricing | null;
  metadata: ProfileMetadata;
}
export interface Model {
  readonly ref: Readonly<ModelRef>;
  profile(): Readonly<ModelProfile>;
  refreshProfile(options?: { signal?: AbortSignal }): Promise<ModelProfile>;
}
export type ProfilePatch = Partial<
  Omit<ModelProfile, "capabilities" | "metadata">
> & {
  capabilities?: Partial<ModelProfile["capabilities"]>;
  metadata?: Partial<ProfileMetadata>;
};
export interface MetadataResolver {
  resolve(
    ref: ModelRef,
    options: { signal?: AbortSignal },
  ): Promise<ProfilePatch>;
}
