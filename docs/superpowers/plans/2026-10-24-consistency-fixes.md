# Consistency fixes and Langfuse completion

Approved scope: fix C01–C09 from docs/consistency-audit.md and complete Langfuse
tracing, including the approved per-invocation Agent roots and realtime=false default.

Work in the current authorized checkout; preserve unrelated changes. No commits,
publishing, new dependencies or public feature frameworks. Execute inline and
use one final independent review. Tests must demonstrate the old failure first.

1. C01/C08: unify tool registration identity and bind Agent aliases without
   mutating original tools. Cover plugin/Agent continuation compatibility.
2. C02: retain executable model connections for Session execution and current
   runtime restoration; maintain strict persisted-connection checks on restart.
3. C03: attach storage error provenance at every storage port, preserving the
   original exception. Include custom registered backends.
4. C05/C07: timestamp each publication once and align error hooks/subscribers,
   including admission failures and consumer buffer failures. No recursive error reporting.
5. C06: close Session handles/queues/subscriptions on Controller disposal before
   disposing plugins/backends; preserve abort, suspended recovery and idempotence.
6. C09: make the OpenAI plugin use the same native provider implementation and
   protocol/configuration contract as direct OpenAIProvider instances.
7. C04/Langfuse: use record timing consistently, preserving fresh resume-segment
   boundaries, recovery correlation, tool/model I/O, thinking, usage and grouping.
   Verify completed spans arrive before execution ends in realtime mode.
8. Update API/developer docs and audit resolution evidence; run build, typecheck,
   package/integration tests and boundaries. Verify Langfuse ingestion through
   Cloud API using existing local test configuration without exposing credentials.

Pre-flight: tool configuration and model connection identity feed persisted
continuation manifests; changes require both positive and negative resume tests.
Event timestamp changes must preserve the same value in hooks and subscribers.
Controller shutdown must flush Session events before logger/tracing disposal.
Record logical lifetimes differ from resume-segment span intervals; do not backdate
resumed children before their new root. Keep monotonic active durations unchanged.
