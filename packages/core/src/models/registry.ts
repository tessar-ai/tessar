import { fail } from "../errors.js";
import { immutable, type Clock } from "../json.js";
import type { Model } from "./profile.js";
import type {
  ModelAdapter,
  ModelProviderRegistration,
  ModelRef,
} from "./contract.js";
import { ProfileResolver } from "./resolver.js";
import type { CatalogSnapshot } from "./catalog.js";
import { normalizeCatalog } from "./normalize-catalog.js";
import { canonicalJson } from "../state/commit.js";
import { matchingAdapter } from "./stream.js";
export class ModelRegistry {
  private readonly providers = new Map<string, ModelProviderRegistration>();
  private readonly handles = new Map<string, Model>();
  private readonly connections = new Map<string, ModelAdapter>();
  private readonly shutdown = new AbortController();
  readonly resolver: ProfileResolver;
  constructor(options: { catalog?: CatalogSnapshot; clock?: Clock } = {}) {
    this.resolver = new ProfileResolver(options);
  }
  registerProvider(provider: ModelProviderRegistration): () => void {
    if (this.shutdown.signal.aborted) fail("Disposed", "Model registry closed");
    if (this.providers.has(provider.id))
      fail("RegistrationConflict", "Provider already registered");
    if (
      provider.catalogModelRef &&
      (!Number.isInteger(provider.catalogMappingVersion) ||
        provider.catalogMappingVersion! < 1)
    )
      fail("InvalidConfiguration", "Catalog aliases require a mapping version");
    const registration: ModelProviderRegistration = {
      id: provider.id,
      create: provider.create.bind(provider),
      metadata: provider.metadata,
      endpoint: provider.endpoint,
      metadataPartition: provider.metadataPartition ?? crypto.randomUUID(),
      catalogModelRef: provider.catalogModelRef?.bind(provider),
      catalogMappingVersion: provider.catalogMappingVersion,
    };
    this.providers.set(provider.id, registration);
    return () => {
      if (this.providers.get(provider.id) !== registration) return;
      this.providers.delete(provider.id);
      for (const [key, handle] of this.handles)
        if (handle.ref.providerId === provider.id) this.handles.delete(key);
      for (const [key, adapter] of this.connections)
        if (adapter.ref.providerId === provider.id)
          this.connections.delete(key);
    };
  }
  private schedule(model: Model): void {
    queueMicrotask(() => {
      if (this.shutdown.signal.aborted) return;
      const provider = this.providers.get(model.ref.providerId);
      if (!provider || !this.resolver.needsRefresh(model.ref, provider)) return;
      void model.refreshProfile().catch(() => {});
    });
  }
  get(ref: ModelRef): Model {
    return this.obtain(ref, true);
  }
  retain(adapter: ModelAdapter): void {
    if (adapter.ref.connectionId === undefined) return;
    const key = JSON.stringify([
      adapter.ref.providerId,
      adapter.ref.connectionId,
    ]);
    const existing = this.connections.get(key);
    if (
      existing &&
      canonicalJson(existing.connection ?? null) !==
        canonicalJson(adapter.connection ?? null)
    )
      fail(
        "ModelContextIncompatible",
        "Connection ID already identifies a different endpoint or protocol",
      );
    this.connections.set(key, adapter);
  }
  /** Resolve executable code only for execution/selection, never catalog reads. */
  resolve(ref: ModelRef) {
    if (this.shutdown.signal.aborted) fail("Disposed", "Model registry closed");
    const retained = this.connections.get(
      JSON.stringify([ref.providerId, ref.connectionId]),
    );
    const provider = this.providers.get(ref.providerId);
    if (!retained && !provider)
      fail("MissingProvider", "Provider is not registered");
    const adapter = retained
      ? retained.ref.modelId === ref.modelId
        ? retained
        : (retained.withModel?.(ref.modelId) ?? provider?.create(ref.modelId))
      : provider!.create(ref.modelId);
    if (!adapter)
      fail(
        "UnsupportedModelSelection",
        "This adapter cannot select another model ID",
      );
    return matchingAdapter(adapter, ref);
  }
  private obtain(ref: ModelRef, schedule: boolean): Model {
    if (this.shutdown.signal.aborted) fail("Disposed", "Model registry closed");
    const provider = this.providers.get(ref.providerId);
    if (!provider) fail("MissingProvider", "Provider is not registered");
    const key = JSON.stringify([
      ref.providerId,
      ref.modelId,
      ref.connectionId ?? null,
    ]);
    const existing = this.handles.get(key);
    if (existing) {
      if (schedule && this.resolver.needsRefresh(ref, provider))
        this.schedule(existing);
      return existing;
    }
    const identity = immutable(ref);
    const refresh = async (options: { signal?: AbortSignal } = {}) => {
      const signals = [
        this.shutdown.signal,
        AbortSignal.timeout(3000),
        ...(options.signal ? [options.signal] : []),
      ];
      return this.resolver.resolve(
        identity,
        provider,
        AbortSignal.any(signals),
      );
    };
    const resolver = this.resolver;
    const model: Model = Object.freeze({
      ref: identity,
      profile() {
        return resolver.current(identity, provider);
      },
      refreshProfile: refresh,
    });
    this.handles.set(key, model);
    if (schedule) this.schedule(model);
    return model;
  }
  list(): readonly Model[] {
    for (const providerId of this.providers.keys())
      for (const modelId of Object.keys(
        this.resolver.catalog.entries[providerId] ?? {},
      ))
        this.obtain({ providerId, modelId }, false);
    return [...this.handles.values()];
  }
  async refreshCatalog(
    fetcher: typeof fetch = globalThis.fetch,
  ): Promise<void> {
    try {
      const response = await fetcher("https://models.dev/api.json", {
        signal: AbortSignal.any([
          this.shutdown.signal,
          AbortSignal.timeout(3000),
        ]),
      });
      if (!response.ok) return;
      const raw = await response.text();
      if (raw.length > 16 * 1024 * 1024) return;
      const hash = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(raw),
        ),
        revision =
          "sha256:" +
          Array.from(new Uint8Array(hash))
            .map((v) => v.toString(16).padStart(2, "0"))
            .join("");
      if (this.shutdown.signal.aborted) return;
      this.resolver.catalog = normalizeCatalog(JSON.parse(raw), {
        revision,
        fetchedAt: new Date().toISOString(),
      });
      this.resolver.clear();
      for (const model of this.handles.values())
        void model.refreshProfile().catch(() => {});
    } catch {
      /* metadata failure never prevents runtime readiness */
    }
  }
  dispose(): void {
    this.shutdown.abort();
    this.connections.clear();
    this.resolver.clear();
  }
}
