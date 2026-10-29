# Trace timing corrections

The approved work fixes three findings from the Langfuse audit: delayed Session
Turn start times, parallel tool spans inflated by result publication, and a
Thread-wide root that currently describes only its first execution.

## Timing behavior

- A Turn span starts at the original `turn.start` timestamp, including model/tool
  selection and context preparation. Keep the existing persisted Turn numbering
  and span IDs; do not create an extra span before model selection is checkpointed.
- `tool.end` remains a notification after the result is published. Add optional
  `endedAt` to its payload using the existing tool execution record's completion
  timestamp. An already-started tool span ends at that timestamp, excluding waits
  for sibling tools. A recovered result without a tool start in this segment
  remains an instantaneous publication observation, without a negative duration.
- Keep tool execution, concurrency, result ordering, checkpointing and suspension
  behavior unchanged. Tracing stays in the optional OpenTelemetry plugin.

## Root direction approved by the user

The user selected option 2 after comparing concrete two-message examples:
each new Agent invocation / Session follow-up gets a separate trace, rooted at
its Agent execution observation. The root owns that invocation's input, output,
timing and Turns. Traces from the same Tessar Thread are grouped by a Langfuse
Session whose session ID is the Thread ID; the Tessar Session ID stays available
as Tessar metadata. This supersedes the earlier one-trace-per-Thread requirement.

Do not add a synthetic Thread root. Core Agent/Controller/Session/Thread/Stream
identities and public invocation APIs stay unchanged. Resume/recovery creates a
new trace segment with a fresh Agent root, retaining the logical Stream ID and
Thread grouping. Its trace ID includes the resumed checkpoint identity so it
cannot overwrite the suspended segment. Continued Turns get fresh observation
IDs under the new root while retaining their logical Turn ID and number.

The plugin retains only Thread Turn counters in its existing checkpoint state;
old root/Turn-created flags are ignored. A new execution never reuses an ended
parent span. Recovery can emit tool results before `stream.resumed`, so initialize
the segment from the first recovery checkpoint notification when necessary. Do
not move Core recovery hooks or change execution/persistence ordering.

## Immediate export approved by the user

Verified against current Mastra source: `realtime: true` selects immediate export
and the Langfuse exporter processes only `SPAN_ENDED`. Equivalent behavior for
Tessar sends each completed observation without the batch timer when
`OpenTelemetryOptions.realtime` is `true`. The option is optional and defaults
to `false`, retaining BatchSpanProcessor. Immediate mode uses the installed SDK's
SimpleSpanProcessor for all adapters. It does not stream unfinished observations
or individual tokens. No platform SDK or custom processor is needed.

## Constraints and validation

Use Node.js >=24.22.1, pnpm 11.5.3 and existing dependencies. Preserve Langfuse
message display mappings and stable identifiers. No provider/storage execution
changes, new hook identifiers, token snapshots, publishing or version bumps.

Regression checks compare Session Turn starts to captured runtime timestamps,
and parallel tool span ends to the persisted tool completion timestamps. Cover
publication delay, hook errors, failed tools and recovered results without a
fresh tool start. Run relevant package tests, typecheck and boundary checks.
