import { canonicalJson } from "../state/commit.js";
import type { ExecutionPosition } from "../state/schema.js";
import { errorInfo, fail } from "../errors.js";
import { normalizeInstruction } from "../instructions/instruction.js";
import type { RegistryLease } from "../plugins/registry.js";
import type {
  ModelAdapter,
  ModelCallContext,
  ModelRef,
  ModelRequest,
  ModelProviderRegistration,
  ModelPartChunk,
} from "./contract.js";
import { PartLifecycle } from "./parts.js";
import { immutable } from "../json.js";

export function isModelAdapter(value: unknown): value is ModelAdapter {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as ModelAdapter).stream === "function" &&
    typeof (value as ModelAdapter).validate === "function"
  );
}

export function matchingAdapter(
  adapter: ModelAdapter,
  ref: ModelRef,
): ModelAdapter {
  if (
    adapter.ref.providerId !== ref.providerId ||
    adapter.ref.modelId !== ref.modelId ||
    (ref.connectionId !== undefined &&
      adapter.ref.connectionId !== ref.connectionId)
  )
    fail(
      "ModelContextIncompatible",
      "The selected connection is no longer available",
    );
  return adapter;
}

export function selectAdapter(
  registry: RegistryLease,
  ref: ModelRef,
  direct?: ModelAdapter,
): ModelAdapter {
  if (
    direct &&
    direct.ref.providerId === ref.providerId &&
    direct.ref.connectionId === ref.connectionId
  ) {
    if (direct.ref.modelId === ref.modelId) return direct;
    if (direct.withModel)
      return matchingAdapter(
        providerCall(ref, () => direct.withModel!(ref.modelId)),
        ref,
      );
  }
  const provider = registry.find<ModelProviderRegistration>(
    "provider",
    ref.providerId,
  );
  if (!provider) fail("MissingProvider", "Model provider is not registered");
  return matchingAdapter(
    providerCall(ref, () => provider.create(ref.modelId)),
    ref,
  );
}

/** Bind before continuation effects, including when no assistant history exists yet. */
export function bindExecutionModel(
  registry: RegistryLease,
  position: ExecutionPosition,
  direct?: ModelAdapter,
  override?: ModelRef,
): ModelAdapter {
  const ref = override ?? position.modelRef;
  const changed =
    ref.providerId !== position.modelRef.providerId ||
    ref.connectionId !== position.modelRef.connectionId;
  const adapter = selectAdapter(registry, ref, direct);
  if (
    !changed &&
    position.modelConnection &&
    canonicalJson(position.modelConnection) !==
      canonicalJson(adapter.connection ?? null)
  )
    fail("ModelContextIncompatible", "Execution model connection changed");
  if (changed) delete position.modelOptions;
  position.modelRef = {
    ...ref,
    ...(adapter.ref.connectionId
      ? { connectionId: adapter.ref.connectionId }
      : {}),
  };
  if (adapter.connection) position.modelConnection = adapter.connection;
  else delete position.modelConnection;
  return adapter;
}

function record(error: unknown, ref: ModelRef): void {
  errorInfo(error, {
    source: "provider",
    providerId: ref.providerId,
    modelId: ref.modelId,
  });
}
export function providerCall<T>(ref: ModelRef, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    record(error, ref);
    throw error;
  }
}
export async function* streamModel(
  adapter: ModelAdapter,
  request: ModelRequest,
  context: ModelCallContext,
  observe?: (chunk: ModelPartChunk) => void | Promise<void>,
) {
  request = {
    ...request,
    instructions: normalizeInstruction(request.instructions),
  };
  const parts = new PartLifecycle(context.now);
  let responded = false;
  try {
    for await (const chunk of adapter.stream(request, context)) {
      context.signal.throwIfAborted();
      parts.accept(chunk);
      if (chunk.type === "response") responded = true;
      if (chunk.type !== "usage" && chunk.type !== "response")
        await observe?.(immutable(chunk));
      yield chunk;
    }
    if (!responded) context.signal.throwIfAborted();
  } catch (error) {
    record(error, request.model);
    throw error;
  } finally {
    for (const end of parts.interrupted()) await observe?.(end);
  }
}
