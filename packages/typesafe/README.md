# @tessar/typesafe

Call TypeSafe with typed questions and native answers, using one client for
guardrails, routing, classification, scoring or other application decisions.
Optional Tessar records persist calls for later inspection. No Agent, Controller,
Session or loop is required. Uses native `fetch`; no TypeSafe SDK dependency.

## Install

Node.js >=24.22.1:

```sh
npm install @tessar/typesafe
```

## Generate

```ts
import { TypeSafe } from "@tessar/typesafe";

const typesafe = new TypeSafe({
  apiKey: process.env.TYPESAFE_API_KEY!,
  model: "jev-latest",
});

const router = await typesafe.generate({
  state: { userMessage: "I was charged twice. Please refund me." },
  questions: {
    destination: {
      type: "choice",
      instructions: "Choose the team responsible for this request.",
      criteria: { billing: "Payments and refunds", engineering: "Technical errors" },
    },
  },
});
console.log(router.answers.destination.choice); // typed: "billing" | "engineering"

// Same client, another purpose and context. No task state is retained by it.
const guardrail = await typesafe.generate({
  state: { bash: "rm config.json", policy: "Do not delete configuration files." },
  questions: {
    allowed: { type: "noul", instructions: "Does the command comply with the policy?" },
  },
});
console.log(guardrail.answers.allowed.noul); // probability of true, 0–1
```

`state` and `questions` are required on every `generate()` call. State accepts
text, JSON objects or arrays. Pass actual JavaScript values; Tessar does not
interpret `"{message.user}"` as a variable. Instructions belong to individual
questions. Constructor state/questions defaults and `generate("text")` are not
supported. Set the model in the constructor or in the request; request overrides
do not change the client default. The client never chooses a model implicitly.

The result preserves native `model`, `answers` and `usage` (`input_tokens`,
`output_tokens`), plus additional provider fields. The returned model can be a
resolved name rather than the requested alias. Answers are keyed by question
name. A noul is a probability, not a boolean permission: thresholds and policies
belong to the application.

## Parameters

| Constructor option | Behavior |
| --- | --- |
| `apiKey?: string` | Explicit value, then `TYPESAFE_API_KEY`; required after resolution |
| `baseURL?: string` | Explicit value, then `TYPESAFE_BASE_URL`, then `https://api.typesafe.ai` |
| `model?: string` | Default model; each request may override it |
| `timeout?: number` | Default 30000 ms per HTTP attempt, including reading the body |
| `maxRetries?: number` | Default 3 additional attempts; 0 disables retry |
| `records?: RecordStore` | `backend.records` or a ready plugin's `tessar.storage.records` |
| `headers?: Readonly<Record<string,string>>` | Additional provider headers; API key and JSON content type remain authoritative |

Base URL is the service root (optionally a proxy path prefix); the client appends
`/v1/systemone`. For example, `https://proxy.example/typesafe` becomes
`https://proxy.example/typesafe/v1/systemone`. Do not include `/v1/systemone` in it.

`generate(request, options?)`:

| Argument | Fields |
| --- | --- |
| `request` | `state`, nonempty `questions`, optional `model`, optional `assets` |
| `options` | Optional `id`, `scope`, JSON-object `metadata`, `signal: AbortSignal` |

Payload and response follow [TypeSafe's OpenAPI](https://api.typesafe.ai/openapi.json).
No local id, scope, metadata, timeout or retry option is added to its JSON body.
The client has no `initialize()`/`dispose()`, and never closes a provided backend.

## Questions

| Type | Question | Native answer |
| --- | --- | --- |
| `noul` | Optional instructions and true/false criteria | `type`, `noul` |
| `choice` | 1–255 criteria labels; optional instructions | `type`, `choice`, `confidence`, `probabilities` |
| `score` | 1–10 ordered criterion descriptions | `type`, `score`, `confidence`, `legend`, `probabilities` |
| `box` | Optional instructions; image-enabled model/header | `type`, `box: {top,bottom,left,right}`, nullable `confidence` |

Instructions and descriptions can be text, JSON objects or arrays; noul/choice
descriptions and instructions can also be null. Score can be fractional. Mixed
question types share the same state in one request; answers are not sequential
steps. There is no root/global instructions field.

Inline images use `assets: { photo: { type: "image", format: "png", data_base64:
"..." } }`, and require an explicit constructor header
`{ "TypeSafe-Danger-Zone-Images": "true" }`. A reference such as `"photo"` in state
is interpreted by the provider's asset protocol. File upload/multipart helpers
and image encoding are not implemented in this package. Long context can use
the provider's explicit `TypeSafe-Danger-Zone-Long-Context` header.

## Persist and inspect calls

```ts
import { TypeSafe } from "@tessar/typesafe";
import { createSqliteBackend } from "@tessar/sqlite";

const backend = await createSqliteBackend({ filename: "./state.db" });
const typesafe = new TypeSafe({ model: "jev-latest", records: backend.records });
try {
  const scope = { userId: "user-1" };
  const id = crypto.randomUUID(); // optional: omit it to let Tessar generate one
  await typesafe.generate({
    state: { userMessage: "I was charged twice." },
    questions: { billing: { type: "noul", instructions: "Is this about billing?" } },
  }, { id, scope, metadata: { channel: "support", policyVersion: "v2" } });

  console.log(await backend.records.get("typesafe.calls", id, { scope }));
  console.log(await backend.records.list({ namespace: "typesafe.calls", scope, limit: 20 }));
} finally {
  await backend.close();
}
```

Each logical call writes one record under `typesafe.calls` containing request,
response or serialized error, status (`completed`, `failed`, `cancelled`),
startedAt/endedAt, attemptCount and optional metadata. Retries share the call ID.
Scope and metadata are local; metadata can hold arbitrary tool/thread/session/
stream IDs without creating runtime dependencies. API keys and outgoing headers
are not recorded. Each id must be unique in the namespace; duplicate record IDs
reject rather than overwrite. Locally invalid input is rejected before HTTP and
is not recorded. Raw answers contain probabilities, not an invented explanation.

Record writes are awaited after provider handling. A failed write never retries
the provider. If the provider succeeded, the original storage error is thrown;
if both failed, an `AggregateError` retains both original errors. A successful
provider call may therefore have occurred even when persistence rejects. There
is no execution-replay or exactly-once guarantee. The client does not add record
IDs to the native response; supply an ID when you need to look it up directly,
or use the paginated namespace/scope history. Without `records`, no calls are
automatically persisted or sent to Logger/OpenTelemetry.

Serialized failures use the shared `ErrorInfo` shape. Read HTTP status, response
body and request ID from `record.data.error.details.status`, `.body` and
`.requestId`. These fields are not duplicated directly under `error`.

## Retry, cancellation and errors

Retries apply to HTTP 408/429/5xx, connection errors and timeouts. Valid
`retry-after-ms`/`Retry-After` delays up to 60 seconds are honored; otherwise
backoff starts at 500 ms and caps at 5 seconds. The total call may exceed timeout
because that limit applies to each attempt. Caller cancellation also stops
backoff. Other 4xx, malformed successful responses, validation and storage errors
are not retried.

`TypeSafeAPIError` exposes `status`, parsed/raw `body` and nullable `requestId`.
`TypeSafeResponseError` preserves the raw invalid response body. Network/timeout,
caller abort reasons and storage errors retain their original exceptions;
configuration errors use `TessarError`. Unknown provider behavior is not converted
to a fabricated answer. Inspect native responses and errors rather than assuming
every call yields a usable decision.

Both TypeSafe error classes extend `TessarError` with source `provider` and inherit
`.isInstance(value: unknown)`. `TypeSafeAPIError.isInstance(error)` narrows to its
HTTP fields; `TessarError.isInstance(error)` recognizes either subclass. Checking
the shared base does not imply a core-origin failure. No errorId or name-based
matching is involved. See the [error guide](../../examples/guide/errors.md).
