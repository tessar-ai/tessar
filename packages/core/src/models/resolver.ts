import { immutable, type Clock, systemClock } from "../helpers/json.js";
import type { ModelProfile, ProfilePatch } from "./profile.js";
import type { ModelRef, ModelProviderRegistration } from "./contract.js";
import { bundledCatalog, type CatalogSnapshot } from "./catalog.js";
export function emptyProfile(ref: ModelRef): ModelProfile {
  return immutable({
    ...ref,
    name: null,
    contextWindow: null,
    maxInputTokens: null,
    maxOutputTokens: null,
    capabilities: {
      tools: null,
      reasoning: null,
      structuredOutput: null,
      imageInput: null,
      audioInput: null,
      audioOutput: null,
    },
    pricing: null,
    metadata: {
      completeness: "unavailable",
      freshness: "unknown",
      fetchedAt: null,
      sourceRevision: null,
      provenance: {},
    },
  });
}
export function applyPatch(
  base: ModelProfile,
  patch: ProfilePatch,
  source: string,
  now: string,
): ModelProfile {
  const next = structuredClone(base),
    provenance = { ...next.metadata.provenance };
  for (const key of [
    "name",
    "contextWindow",
    "maxInputTokens",
    "maxOutputTokens",
    "pricing",
  ] as const)
    if (patch[key] !== undefined && patch[key] !== null) {
      (next as any)[key] = patch[key];
      provenance[key] = source;
    }
  for (const key of Object.keys(
    next.capabilities,
  ) as (keyof ModelProfile["capabilities"])[])
    if (
      patch.capabilities?.[key] !== undefined &&
      patch.capabilities[key] !== null
    ) {
      next.capabilities[key] = patch.capabilities[key]!;
      provenance["capabilities." + key] = source;
    }
  const known = Object.keys(provenance).length;
  const retainedOldFields =
    base.metadata.freshness === "stale" &&
    Object.keys(base.metadata.provenance).some(
      (key) => provenance[key] === base.metadata.provenance[key],
    );
  next.metadata = {
    completeness:
      known === 0
        ? "unavailable"
        : next.name !== null &&
          next.contextWindow !== null &&
          next.maxInputTokens !== null &&
          next.maxOutputTokens !== null &&
          next.pricing !== null &&
          Object.values(next.capabilities).every((v) => v !== null)
          ? "complete"
          : "partial",
    freshness: known ? (retainedOldFields ? "stale" : "fresh") : "unknown",
    fetchedAt: known
      ? retainedOldFields
        ? base.metadata.fetchedAt
        : now
      : null,
    sourceRevision:
      patch.metadata?.sourceRevision ?? base.metadata.sourceRevision,
    provenance,
  };
  return immutable(next);
}
const PROFILE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_METADATA_PARTITION = "registration";

export class ProfileResolver {
  /** @internal */ catalog: CatalogSnapshot;
  /** @internal */ readonly cache = new Map<
  string,
  { profile: ModelProfile; fetchedAt: number }
>();
  private readonly pending = new Map<string, Promise<ModelProfile>>();
  private readonly detached = new WeakSet<ModelProviderRegistration>();
  private generation = 0;
  constructor(
    private readonly options: { catalog?: CatalogSnapshot; clock?: Clock } = {},
  ) {
    this.catalog = options.catalog ?? bundledCatalog;
  }
  private now() {
    return (this.options.clock ?? systemClock).now();
  }
  private key(provider: ModelProviderRegistration, ref: ModelRef) {
    return JSON.stringify([
      ref.providerId,
      ref.modelId,
      ref.connectionId ?? null,
      provider.endpoint ?? "",
      provider.metadataPartition ?? DEFAULT_METADATA_PARTITION,
    ]);
  }
  needsRefresh(ref: ModelRef, provider: ModelProviderRegistration): boolean {
    const cached = this.cache.get(this.key(provider, ref));
    return (
      !cached || Date.parse(this.now()) - cached.fetchedAt >= PROFILE_TTL_MS
    );
  }
  current(ref: ModelRef, provider: ModelProviderRegistration): ModelProfile {
    const cached = this.cache.get(this.key(provider, ref));
    if (cached) {
      return Date.parse(this.now()) - cached.fetchedAt >= PROFILE_TTL_MS
        ? immutable({
          ...cached.profile,
          metadata: { ...cached.profile.metadata, freshness: "stale" },
        })
        : cached.profile;
    }
    let profile = emptyProfile(ref);
    const catalogRef = provider.catalogModelRef
      ? provider.catalogModelRef(ref)
      : ref;
    const patch = catalogRef
      ? this.catalog.entries[catalogRef.providerId]?.[catalogRef.modelId]
      : undefined;
    if (patch) {
      profile = applyPatch(
        profile,
        { ...patch, metadata: { sourceRevision: this.catalog.revision } },
        "catalog:" + this.catalog.revision,
        this.catalog.fetchedAt,
      );
      if (
        Date.parse(this.now()) - Date.parse(this.catalog.fetchedAt) >=
        PROFILE_TTL_MS
      )
        profile = immutable({
          ...profile,
          metadata: { ...profile.metadata, freshness: "stale" },
        });
    }
    return profile;
  }
  resolve(
    ref: ModelRef,
    provider: ModelProviderRegistration,
    signal?: AbortSignal,
  ): Promise<ModelProfile> {
    const key = this.key(provider, ref),
      active = this.pending.get(key);
    if (active) return active;
    const generation = this.generation;
    const promise = (async () => {
      let profile = this.current(ref, provider);
      if (provider.metadata) {
        try {
          const patch = await provider.metadata.resolve(ref, { signal });
          profile = applyPatch(
            profile,
            patch,
            "provider:" + provider.id,
            this.now(),
          );
        } catch {
          profile = immutable({
            ...profile,
            metadata: {
              ...profile.metadata,
              freshness:
                profile.metadata.completeness === "unavailable"
                  ? "unknown"
                  : "stale",
            },
          });
        }
      }
      if (!this.detached.has(provider) && !signal?.aborted && generation === this.generation)
        this.cache.set(key, { profile, fetchedAt: Date.parse(this.now()) });
      return profile;
    })();
    this.pending.set(key, promise);
    void promise.finally(() => {
      if (this.pending.get(key) === promise) this.pending.delete(key);
    }).catch(() => { });
    return promise;
  }
  remove(provider: ModelProviderRegistration): void {
    this.detached.add(provider);
    for (const map of [this.cache, this.pending]) for (const key of map.keys()) {
      const [id, , , endpoint, partition] = JSON.parse(key) as unknown[];
      if (id === provider.id && endpoint === (provider.endpoint ?? "") && partition === (provider.metadataPartition ?? DEFAULT_METADATA_PARTITION))
        map.delete(key);
    }
  }
  clear() {
    this.generation++;
    this.cache.clear();
    this.pending.clear();
  }
}
