# TypeSafe client

## Agreed API

`@tessar/typesafe` exports class `TypeSafe`; `index.ts` exports API only. Native
fetch sends JSON to POST `/v1/systemone`. No Agent, Controller, Session, loop,
provider registration, initialization or client disposal is required.

Constructor: `{apiKey?,baseURL?,model?,timeout?,maxRetries?,records?,headers?}`.
API key resolves explicit config then TYPESAFE_API_KEY; missing key is an error.
Base URL resolves config then TYPESAFE_BASE_URL then https://api.typesafe.ai.
Timeout defaults 30000 ms per HTTP attempt; maxRetries defaults 3 additional
attempts. Headers support provider experimental image/long-context flags.

`generate({state,questions,model?,assets?}, {id?,scope?,metadata?,signal?}?)`.
State and questions are required on EVERY call. State is a string, JSON object
or array. JavaScript interpolation is the caller's responsibility; there is no
Tessar template syntax. Constructor has no questions/state defaults and no string
shorthand. Model is required in either constructor or request; no silent model
choice. A request model overrides the constructor without changing it.

Native question/response shapes follow the current official OpenAPI: noul,
choice, score, box, native answers/model/usage. Generic response types preserve
question names and choice-label inference. Validate required response structure,
question/answer type matching and numeric ranges. Responses retain extra native
fields. JSON inline image assets are supported with explicit provider headers;
multipart upload helpers and model catalog APIs are outside this scope.

## Persistence

`records?: RecordStore` accepts backend.records or tessar.storage.records. Caller
owns the backend. Store one record per logical generate under typesafe.calls;
all retries share the same ID. IDs can be supplied or generated as plain UUIDs.
Scope and metadata are local JSON data, never sent in the HTTP body. Stored data:
request, response or error, status, startedAt, endedAt, attemptCount, metadata?.
Metadata remains free-form: tool/thread/session/stream IDs are caller data.
Without records the call still works, with no hidden persistence.

Implementation decision: record writes happen after HTTP/retry handling, and do
not trigger provider retries. Successful provider + failed append throws the
original storage error. Provider + append failure throws AggregateError retaining
both original exceptions. Provider failure otherwise preserves the original
exception. No raw API keys/Authorization headers in records.

## Transport and errors

Retry only network TypeError, timeout, HTTP 408/429/5xx; never caller abort,
validation, other 4xx, malformed success or storage failure. Honor valid
retry-after-ms / Retry-After up to 60s; otherwise exponential 500ms to 5s.
Timeout covers fetch AND reading the body per attempt. Cancellation also stops
backoff. HTTP errors expose status, parsed/raw body and request ID using
TypeSafeAPIError; malformed successful responses use TypeSafeResponseError.
Configuration errors use existing TessarError. No catch-all unknown error class.

## Verification

Mocked HTTP tests cover payload isolation, all question types, concurrent purposes,
model override, response validation, retries, timeout/cancellation, and independent
success/failure record persistence. Real local HTTP + SQLite fixture proves built
public imports, native fetch, headers/body, persistence and reopen. No external API
verification is claimed without a real TypeSafe endpoint and credentials.

Sources: https://api.typesafe.ai/openapi.json and
https://github.com/typesafe-ai/typesafe-sdk-js (reviewed 2026-10-27).
