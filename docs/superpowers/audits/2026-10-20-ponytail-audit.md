delete: Remove the metadata adapter that calls `models.retrieve()` and discards its response; retain catalog profiles and metadata adapters that supply actual fields. [packages/openai/src/metadata.ts:3]

delete: Remove unused imports in controller, frame, interrupt, services, loop and model registry, plus the unused `schedule(key)` argument. The TypeScript unused-symbol check identifies them directly. [packages/core/src/models/registry.ts:43]

stdlib: Replace the manual UTF-8 comparison loop with `Buffer.compare(Buffer.from(a), Buffer.from(b))`, preserving byte ordering. [packages/core/src/state/queries.ts:53]

stdlib: Replace the digest byte-to-hex loop with `Buffer.from(hash).toString("hex")`. [packages/core/src/models/registry.ts:141]

net: -25 lines, -0 deps possible.
