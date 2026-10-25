# Tools and messages

[All guides](README.md) · Next: [Plugins](plugins.md)

Use `createTool()` to give an Agent application functions. You supply the tool's
`name`, description, Zod `schema` and implementation. Tessar exposes the schema
to the model, validates model-supplied arguments and correlates tool results.

## A complete tool example

Save as `tools.ts` after the [setup](README.md).

```ts
import { Agent, ToolMessage } from "@tessar/core";
import { createTool } from "@tessar/core/tool";
import { OpenAIProvider } from "@tessar/openai";
import { z } from "zod";

const add = createTool({
  name: "add",
  description: "Add two numbers and return their sum.",
  schema: z.object({ a: z.number(), b: z.number() }),
  execute: ({ a, b }, context) => {
    context.signal.throwIfAborted();
    context.emit({ stage: "calculating" });
    return { sum: a + b };
  },
});

const explain = createTool({
  name: "explain_addition",
  description: "Describe how addition works.",
  schema: z.object({}),
  execute: () => new ToolMessage("Addition combines two quantities.", {
    metadata: { source: "application" },
  }),
});

const agent = new Agent({
  id: "calculator",
  model: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: process.env.OPENAI_MODEL!,
  }),
  instructions: "Use the provided tools for arithmetic and explanations.",
  tools: { add, explain },
});

const result = await agent.generate("Use add to calculate 27 + 15.");
console.log(result.output);
```

```sh
node --env-file=.env tools.ts
```

The target model must support function tools. Object keys are registered names:
`tools: { explain }` exposes `explain`; `tools: { explain_addition: explain }`
exposes `explain_addition`. Aliases apply to provider descriptions, dispatch and
history without mutating the original Tool. The same Tool can have distinct aliases.

Plugin-registered tools use the Tool's own name. Both registration paths retain
the Tool's schema identity for safe resume; changing a pending tool's schema can
reject continuation with `ResumeIncompatible`, including older plugin manifests
that did not retain that identity.

## Results and execution context

| Return value | Result |
| --- | --- |
| String | A `ToolMessage` containing text |
| JSON value | A `ToolMessage` containing a `data` part |
| `new ToolMessage(...)` | Explicit content parts and message options |

Returning `undefined` is an error. You do not need to provide a tool call ID:
the runtime binds the returned message to the call it is executing. Each provider
adapter translates Tessar messages to its wire format. Message metadata is
application data; it is not automatically appended to the model-visible text.

`execute(input, context)` receives parsed input and the current `signal`,
`threadId`, `streamId`, `turnId` and `toolExecutionId`. Use the signal with
cancelable I/O and `emit()` for progress events. These IDs describe the active
execution; they do not replace application authentication or credentials.

Tool calls can execute concurrently when the model requests several. The default
has no concurrency limit; `tools: { concurrency: 4, add, explain }` sets one.
Retries and availability rules belong in your tool implementation or plugins.
For external side effects, design idempotency and recovery explicitly; a saved
checkpoint alone does not guarantee an external action runs exactly once.

See [Agent](agent.md) for `HumanMessage` and `SystemMessage`. Use `ToolMessage`
when constructing a tool result, rather than fabricating provider-specific JSON.

## Suspend a tool to ask the user

Tools can return `context.suspend(payload)` instead of a result. Core persists
the waiting request and emits `stream.suspended`. The current stream attachment
then closes; the execution remains available for a later response. `execute()`
does not run again when that response arrives.

This example lets the model supply the question, selection mode and options.
`resumeSchema` validates the UI's response and is not sent as part of the tool's
input schema. The optional `resume(response, input, context)` callback can use the
original tool input to check selection rules or perform the next action.

```ts
const askUser = createTool({
  name: "ask_user",
  description: "Ask the user to select one or more of the provided options.",
  schema: z.object({
    question: z.string(),
    mode: z.enum(["single", "multiple"]),
    options: z.array(z.object({ id: z.string(), label: z.string() })).min(1),
  }),
  resumeSchema: z.object({ selected: z.array(z.string()).min(1) }),
  execute: (input, context) => context.suspend(input),
  resume: (answer, input, context) => {
    const allowed = new Set(input.options.map(option => option.id));
    if ((input.mode === "single" && answer.selected.length !== 1) ||
        answer.selected.some(id => !allowed.has(id))) {
      return context.suspend({ ...input, error: "Select from the provided options." });
    }
    return answer;
  },
});

const questioner = new Agent({
  id: "questioner",
  model: agent.getModel(),
  tools: { askUser },
});
```

Invalid `resumeSchema` input leaves the original request pending. A callback may
return another suspension to ask again; that creates a new interrupt ID for the
same tool call. Without a `resume` callback, the parsed response becomes the tool
result directly. If `resumeSchema` is omitted, responses must still be JSON.

## Connect suspension to your UI

The host application owns rendering. Map the payload's mode to radio buttons,
checkboxes or any interface you choose. An event consumer can retain requests
and pass form submissions back to Agent:

```ts
import { stream as streamEvents, message as messageEvents, errorFromInfo, type Stream, type JsonValue } from "@tessar/core";

const pending = new Map<string, { threadId: string; payload: JsonValue }>();

async function consumeExecution(execution: Stream): Promise<void> {
  for await (const event of execution) {
    if (event.type === streamEvents.suspended) {
      const request = event.payload.interrupt;
      pending.set(request.id, { threadId: execution.threadId, payload: request.payload });
      // Render request.payload with your application's UI.
      console.log("Question:", request.id, request.payload);
    }
    if (event.type === messageEvents.delta && event.payload.partKind === "text") {
      process.stdout.write(event.payload.delta);
    }
    if (event.type === streamEvents.error) throw errorFromInfo(event.payload.error);
  }
}

async function submitAnswer(interruptId: string, selected: string[]): Promise<void> {
  const request = pending.get(interruptId);
  if (!request) throw Error("Question is no longer available");
  await consumeExecution(questioner.resume({
    threadId: request.threadId,
    interruptId,
    value: { selected },
  }));
  pending.delete(interruptId);
}

await consumeExecution(questioner.stream("Ask which database I want to use."));
// In your running application's form-submit callback:
// await submitAnswer(questionId, selectedOptionIds);
```

Keep the application host alive while waiting for UI input. The response comes
from the user's interaction; Tessar does not display a prompt or pick a value.
For a Session, listen through `session.subscribe()` and call
`session.resume({ interruptId, value })`; further events arrive through the
existing subscription. A Session manages one foreground execution. Separate
Sessions can run concurrently through the same Controller.

## Conditional approval inside a tool

Use the same API when the tool itself owns its approval policy. This application
factory accepts your publishing service and approval rule:

```ts
function createPublishTool(
  publishReport: (id: string, signal: AbortSignal) => Promise<string>,
  needsApproval: (id: string) => boolean,
) {
  return createTool({
    name: "publish_report",
    description: "Publish a report, requesting approval when required.",
    schema: z.object({ reportId: z.string() }),
    resumeSchema: z.boolean(),
    execute: (input, context) => {
      if (needsApproval(input.reportId)) {
        return context.suspend({ question: "Publish this report?", reportId: input.reportId });
      }
      return publishReport(input.reportId, context.signal);
    },
    resume: (approved, input, context) => approved
      ? publishReport(input.reportId, context.signal)
      : "User declined publication.",
  });
}
```

Use `tool.before` instead when a plugin should enforce approval across existing
tools without changing their implementations. The same checkpoint machinery
handles both kinds of waiting: approval hooks resolve a decision; a tool's
resume callback produces its result or another waiting request.

For callbacks performing external side effects, use the tool's recovery contract
or tracked effects where needed. A response is consumed durably before dispatch;
an uncertain callback outcome after a crash still needs reconciliation.

Standalone Agent retains pending execution state in memory and releases it on
completion, cancellation or `agent.shutdown()`. Resume keeps the original
effective model and options. Durable process restart requires a configured
storage backend; [Thread/Session restoration](storage.md) can continue the same
request. No Session is required for `agent.stream()` and `agent.resume()`.
