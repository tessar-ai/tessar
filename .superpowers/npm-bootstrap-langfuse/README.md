# @tessar/langfuse

Optional Langfuse tracing for Tessar, using the official Langfuse SDK and
OpenTelemetry. Requires Node 24.14 or newer. Langfuse Cloud and self-hosted
Langfuse use the same configuration; choose the appropriate `baseUrl`.

```sh
npm install @tessar/core @tessar/langfuse
```

```ts
import { LangfusePlugin } from "@tessar/langfuse";

const tracing = new LangfusePlugin({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.LANGFUSE_SECRET_KEY,
  baseUrl: process.env.LANGFUSE_BASE_URL,
  tags: ["my-app"],
  // traceName: "Customer support", // Optional display name shared by all nodes.
  // prompt: { name: "support-system", version: 3 }, // Existing Langfuse prompt.
});
// new Controller({ id, agent, plugins: [tracing] })
// await controller.initialize();
// Execute agent.stream()/generate() or work through a Session.
// await controller.dispose(); // Closes observations and flushes buffered exports.
```

All options are optional and otherwise use the official SDK's environment/default
settings. `baseUrl` selects a Cloud region or your deployment. This integration
uses Langfuse JS SDK v6, which requires self-hosted Langfuse v4.59.0 or newer;
see [Langfuse compatibility](https://langfuse.com/docs/observability/sdk/overview).

Session executions append to one trace per Thread. The trace ID is the first 32
hex characters of SHA-256 of `thread.id`; switching Threads selects another
trace, and returning appends to the original. Direct Agent calls retain one
trace per Stream. The root uses `Agent.id`; Turn numbers continue within the
Thread across follow-ups and restoration. Turn input is the latest effective primary request; Turn output is
the assistant/tool messages committed in that segment. Auxiliary model calls
retain their own input/output rather than replacing the enclosing Turn's data.
Generation observations include the effective model request, final response,
reported usage and errors. Requests include instructions, history, tool schemas
and configured model options. Auxiliary model calls made through the plugin API
are also captured and nested under their originating tool when applicable.

Observations retain Tessar's controller, agent, Session, Thread and Stream IDs,
along with scope metadata. When present, Tessar's Session ID is also the Langfuse
session ID. No user-ID field is inferred from application-defined scope keys.
Retries produce separate generations. Concurrent executions use explicit parents
and an instance-local tracer; the global application tracer is not replaced.

The plugin checkpoints its root/Turn creation flags and counter using existing
Thread plugin state, with reset-on-fork semantics. After restart, new operations
refer to the existing Agent/Turn parents without re-exporting old observations.
An exported root's input, output, timing and status remain its original segment's
snapshot; inspect each new generation for current history and response. Suspended
observations retain partial output and are not rewritten after resume.
Durable runtime restart still requires a Tessar storage backend. Telemetry export
is buffered and best-effort; it is not a durable event journal.

Token details use exclusive buckets for ordinary input/output, cache reads,
cache writes and reasoning, avoiding double-counting inclusive provider totals.
Unknown counts are omitted rather than emitted as zero. The complete original
usage, including provenance and provider details, is retained in metadata.
Provider/model pricing is managed by Langfuse; Tessar does not invent costs.
Trace names and optional `tags` propagate to tools and generations. The optional
`prompt` reference links primary generations to an existing Langfuse prompt;
it does not upload instructions or label auxiliary prompts. Scores come from
application evaluations or feedback through Langfuse's scoring SDK/API.

No network request is awaited by an execution hook. The official span processor
batches exports in the background; Controller cleanup awaits its shutdown/flush.
Use the [developer guide](../../examples/guide/langfuse.md) for a complete example.
