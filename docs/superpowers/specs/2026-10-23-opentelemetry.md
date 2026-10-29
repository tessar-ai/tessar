# Unified tracing package

Replace `@tessar/langfuse` with `@tessar/opentelemetry`. Public APIs use classes;
`index.ts` contains explicit public exports. Core and its hooks stay unchanged.

One `OpenTelemetryPlugin` observes the existing Tessar lifecycle. It accepts an
explicit array of adapters plus optional service name, trace name and tags.
`OTLPAdapter` exports standard OTLP/HTTP JSON to any configured trace endpoint,
including compatible collectors. `LangfuseAdapter` configures
credentials, ingestion v4 headers and Langfuse attributes. `ArizeAdapter`
configures credentials, project resource and OpenInference attributes.
`TraceloopAdapter` configures Traceloop authentication and OpenLLMetry mapping.
Shared GenAI attributes include system instructions and typed input/output parts,
preserving reasoning separately from answer text. Adapter display mappings prepend
System instructions, while original requests remain untouched in tessar.*.
Arize Turns retain CHAIN kind and display text transcripts. Langfuse Additional
Input omits instructions already shown in Messages. Opik support was removed
at the user's request after Cloud testing.

Use the official OTel SDK/exporter, without platform SDK dependencies. Adapter
mapping happens on separate exported span snapshots so destinations cannot
change shared spans. Keep one trace per Thread, stable parent IDs, checkpointed
turn numbering, auxiliary calls, retries, tool IO, usage provenance and TTFT.
Export failures do not fail agent execution. Startup failures dispose exporters
already created. Existing root snapshots remain immutable across restarts.

This is tracing only: no platform scoring or prompt-management clients, metrics,
logs, collector service, or changes to Core. No npm publish or git operations.


