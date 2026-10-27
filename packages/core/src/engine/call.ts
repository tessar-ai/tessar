import type { Controller } from "../controller.js";
import type {
  Agent,
  AgentStreamOptions,
  AgentInput,
  GenerateOutcome,
  ModelSelection,
} from "../agent.js";
import { HumanMessage } from "../messages/message.js";
import { inputMessages } from "../messages/codec.js";
import { fail, requireId, errorInfo } from "../errors.js";
import { immutable } from "../json.js";
import { isModelAdapter, matchingAdapter } from "../models/stream.js";
import {
  snapshotModelOptions,
  validateModelOptions,
} from "../models/options.js";
import type { ModelAdapter, ModelRef } from "../models/contract.js";
import { ThreadService } from "../state/threads.js";
import { prepareThread } from "../state/thread-operations.js";
import { standaloneRuntime, type ExecutionRuntime } from "./runtime.js";
import type { Stream } from "./delivery.js";
import { retainStandalone } from "./continuation.js";

export function modelRef(model: ModelSelection): ModelRef {
  return "ref" in model ? model.ref : model;
}

function chooseModel(
  agent: Agent<any>,
  selection: ModelSelection | string,
): { ref: ModelRef; adapter?: ModelAdapter } {
  const model = agent.getModel();
  if (typeof selection === "string") {
    requireId(selection, "model id");
    if (isModelAdapter(model)) {
      if (selection === model.ref.modelId)
        return { ref: model.ref, adapter: model };
      if (!model.withModel)
        fail(
          "UnsupportedModelSelection",
          "This adapter does not support changing the model ID",
        );
      const adapter = matchingAdapter(model.withModel(selection), {
        ...model.ref,
        modelId: selection,
      });
      return { ref: adapter.ref, adapter };
    }
    return { ref: { ...modelRef(model), modelId: selection } };
  }
  if (isModelAdapter(selection))
    return { ref: selection.ref, adapter: selection };
  const ref = modelRef(selection);
  if (
    isModelAdapter(model) &&
    model.ref.providerId === ref.providerId &&
    model.ref.connectionId === ref.connectionId
  ) {
    if (model.ref.modelId === ref.modelId) return { ref, adapter: model };
    if (model.withModel)
      return {
        ref,
        adapter: matchingAdapter(model.withModel(ref.modelId), ref),
      };
  }
  return { ref };
}

export function callAgent(
  agent: Agent<any>,
  input: AgentInput,
  options: AgentStreamOptions<any>,
  controller?: Controller,
): Stream {
  const selected = chooseModel(agent, options.model ?? agent.getModel());
  const runtime = controller ?? standaloneRuntime(agent.id, agent.listTool());
  let lifecycle: ReturnType<typeof retainStandalone> | undefined;
  try {
    controller?.requireReady();
    if (!controller && !selected.adapter)
      fail(
        "MissingProvider",
        "Standalone execution requires an executable model instance",
      );
    const ref = immutable(
      selected.adapter
        ? selected.ref
        : controller!.resolveModel(selected.ref).ref,
    );
    requireId(ref.providerId, "provider id");
    requireId(ref.modelId, "model id");
    validateModelOptions(options.modelOptions);
    const overrides = Object.fromEntries(
      Object.entries(options.modelOptions ?? {}).filter(
        ([, value]) => value !== undefined,
      ),
    );
    const modelOptions = snapshotModelOptions({
      ...selected.adapter?.options,
      ...overrides,
    });
    const messages = inputMessages(
      typeof input === "string" ? new HumanMessage(input) : input,
    );
    const threadId = agent.ids.next("thread");
    lifecycle = controller
      ? undefined
      : retainStandalone(agent, threadId, runtime);
    const prepare = controller
      ? () =>
          prepareThread(controller, { scope: options.scope }, threadId).then(
            () => {},
          )
      : () =>
          new ThreadService(runtime.backend, {
            next: (kind) =>
              kind === "thread" ? threadId : agent.ids.next(kind),
          })
            .create({ scope: options.scope })
            .then(() => {});
    const stream = agent.admit(
      {
        kind: "input",
        id: options.id,
        threadId,
        input: messages,
        model: ref,
        adapter: selected.adapter,
        modelOptions,
        context: options.context,
        limits: options.limits,
        signal: options.signal,
      },
      { kind: "iterator" },
      prepare,
      runtime,
      lifecycle?.cleanup,
      lifecycle?.admitted,
    );
    return lifecycle?.bind(stream, options.signal) ?? stream;
  } catch (error) {
    // No async resources are started before admission. Discard the empty host/backend.
    if (lifecycle) {
      void lifecycle
        .cleanup()
        .catch((cause) => runtime.report(errorInfo(cause)));
    } else if (!controller) {
      void runtime.hooks.dispose();
      void runtime.backend.close();
    }
    throw error;
  }
}

export async function readOutcome(
  runtime: ExecutionRuntime,
  stream: Stream,
): Promise<GenerateOutcome> {
  if (!stream.id) fail("AdmissionFailed", "Execution was not admitted");
  const record = await runtime.queries.getRecord(
    "streams",
    stream.threadId,
    stream.id,
  );
  if (!record) fail("StorageUnavailable", "Committed execution missing");
  const cp = await runtime.queries.snapshot(stream.threadId),
    pending = cp.execution?.pendingInterruptId;
  return {
    threadId: stream.threadId,
    streamId: record.id,
    status: record.status,
    output: cp.state.messages.filter((message) =>
      record.outputMessageIds.includes(message.id),
    ),
    usage: record.directUsage,
    interrupt: pending
      ? await runtime.queries.getRecord("interrupts", stream.threadId, pending)
      : null,
    error: record.error,
  };
}
