# Context Preparation and Provider Requests

Status: implemented in this checkout; see the accompanying plan and verification ledger.

## Intent and approved scope

Keep two meaningful extension points: context.prepare transforms Tessar context;
provider.request transforms the provider-native body after adapter encoding and
before invoking the provider SDK. Plugins installed after a host is packaged can
inspect or modify that body without replacing the host's adapter.

Remove model.request rather than preserve another normalized-request transform.
Keep context.prepare on an Agent's primary loop and native request interception
on both primary and auxiliary calls. Keep standalone Agent execution independent of
Controller or Session; without plugins, preparation passes through unchanged.

Node.js >=24.22.1, pnpm 11.5.3, TypeScript ESM. No new dependency, storage table,
HTTP server, broker, or provider-specific implementation in core.

## Approaches

| Approach | Consequence | Decision |
| --- | --- | --- |
| Keep only context.prepare | Plugins cannot inspect the adapter-encoded body | Rejected |
| Keep model.request as another normalized transform | Duplicates context.prepare and does not expose native payload | Rejected |
| Separate context.prepare and provider.request | Distinct, useful boundaries; requires adapter participation | Selected |

Do not introduce headers, HTTP-response or raw-stream hooks in this change.
Headers, credentials, endpoint and SDK transport configuration remain separate.
Do not combine this change with streaming part lifecycles, effort settings,
tool selection cleanup, operation gates, or Session idle semantics.

## Concrete interfaces

The following type shapes implement the approved scope.
Use lowercase map provider.request and identical event string "provider.request".

```ts
type ModelPurpose = "primary" | "auxiliary";

interface ProviderRequest {
  model: ModelRef;
  protocol: string;
  attemptId: string;
  purpose: ModelPurpose;
  body: JsonObject;
}

// EventMap: HookSpec<ProviderRequest, ProviderRequest, ExecutionHookContext>
// Event kind: transformation.

interface ModelCallContext {
  signal: AbortSignal;
  prepareRequest?(
    protocol: string,
    body: JsonObject,
  ): Promise<JsonObject>;
}
```

Core supplies prepareRequest bound to the current execution and model attempt.
The adapter supplies protocol and its encoded body, awaits the callback when
present, validates runtime-owned invariants, and sends the resulting body.
Use "responses" and "chat-completions" for the existing OpenAI protocols.
Other adapters supply their protocol identifier; core does not switch on vendors.

No callback is required for direct adapter callers. Adapter authors must invoke
the callback at the documented boundary to support provider.request; do not
pretend core can inspect a private SDK client or automatically wrap arbitrary
third-party transports.

## Context and auxiliary calls

Retain ModelRequest as the context.prepare payload and transformation result.
Primary preparation starts with the context built from the execution. Auxiliary
calls keep the caller-supplied ModelRequest and do not gain context.prepare.
Remove their old model.request dispatch directly. The caller already owns the
normalized auxiliary request; provider.request can transform its encoded body.

A subagent implemented as a separate Agent has its own loop and context.prepare
when a Controller with that plugin is attached. Hooks from the parent do not
automatically transfer to another Agent or process. Do not introduce subagent
APIs, context inheritance, or context.purpose for this change.

## Execution and transformation semantics

1. Select/bind the adapter and prepare the normalized request.
2. On the primary loop, await context.prepare; validate normalized request and
   model identity on both primary and auxiliary paths.
3. Create the existing attempt record and emit model.start with normalized input.
4. Inside adapter.stream, encode the SDK request body.
5. Await provider.request with the bound attempt, model, purpose and protocol.
6. Validate the transformed body and invoke the SDK with the existing abort signal.
7. Continue existing model response, usage, error and attempt persistence paths.

Handlers run sequentially in the existing captured registration order. Each sees
the preceding result; undefined preserves it. A returned ProviderRequest replaces
the envelope, but model, protocol, attemptId and purpose must remain unchanged.
Use existing immutable JSON snapshots; mutation without returning a replacement
does not change the request. Reject invalid envelope/body shapes before send.

The adapter owns validation that native model and streaming fields still match
the selected execution. A hook may change content and provider options, but may
not bypass model selection, change connection, turn off streaming, or activate
provider-managed conversation/background behavior unsupported by the loop.
Preserve current single-choice and protocol-continuation requirements. Do not
attempt to reproduce the provider's entire parameter schema in core.

Run once per adapter invocation, including Tessar recovery attempts. SDK-internal
HTTP retries reuse the prepared body; this hook is not a per-HTTP-attempt event.
Do not add retry defaults or extra provider parameters when they were not set.
Cancellation after a handler finishes must prevent sending the request.

Thrown plugin errors fail the attempt; do not send the original body as fallback.
Invalid transformation results fail before SDK invocation. Preserve plugin versus
provider error attribution and existing cancellation/error lifecycle behavior.

## Trace and persistence boundaries

model.start.request remains normalized ModelRequest, explicitly labelled as such.
provider.request exposes the body at that handler's position in the transform
chain. A logger/trace plugin must not claim this is the final outgoing body when
later handlers may still change it. SDK-added defaults and HTTP headers are not
part of the observed body. No additional final-payload event is introduced here.

Changing a request does not rewrite stored history or Session model settings.
Do not persist native bodies, credentials, callback functions, or another copy
of the request in checkpoints. Plugins choose what to log under their existing
configuration. The database schema is unchanged.

## Direct API update and verification

No external plugins have been released. Update core, built-in plugins and repo
examples directly. Do not add compatibility shims, deprecated event aliases,
dual dispatch, legacy adapter fallbacks, or a consumer migration phase.

- Remove model.request from map, event types and dispatch sites, without an alias.
- Update primary normalized transformations to context.prepare and keep auxiliary
  request preparation with its caller. Native transformations use provider.request.
- Update core/public exports, both OpenAI adapters, test providers, logger/trace
  assumptions, public type tests, API reference and developer examples together.
- Test sequential replacement, undefined, immutable input, invalid result,
  protected identity, hook failure, cancellation and concurrent auxiliary attempts.
- Exercise both protocols, standalone and Controller-backed execution, primary
  and auxiliary calls, and SDK retry versus a new Tessar attempt.
- Assert zero SDK calls on invalid/failed hooks, no extra fields without hooks,
  and unchanged canonical history/checkpoint data after native transformation.
- Verify typecheck, build, package tests, integration tests and check:boundaries.

The broader streaming and Plugin API design remains tracked in architecture-notes.md;
this document does not silently approve unrelated audit removals.
