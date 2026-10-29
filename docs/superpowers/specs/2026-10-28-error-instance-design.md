# TessarError instance identification

User approved TessarError as the shared branded base, with one inherited static
isInstance(value) type guard. No BaseError class, errorId, Symbol markers, package
prefixes, name-based structural checks or cross-package-copy equivalence.

## Contract

- TessarError extends native Error and provides a polymorphic static type guard.
  Calling Subclass.isInstance(value) narrows to that subclass; a parent recognizes
  actual descendants, siblings and same-named unrelated classes remain distinct.
- Guard accepts unknown, never instantiates the class and returns false for
  null, primitives, lookalike JSON and proxies that throw during prototype lookup.
- Constructor is `(code, message, options?)`, where options contains optional
  source, details, cause. Source defaults to tessar, details is JSON-compatible
  additional data and cause uses native ErrorOptions behavior.
- Class name defaults from the class constructor; subclasses may set readonly
  name. Runtime name is presentation, not identity. Native stack remains native.
- TypeSafeAPIError and TypeSafeResponseError extend TessarError with provider
  source, preserving existing constructor arguments, public names, body/status/
  requestId and serialized error-code values.

## Source handling

Inheritance identifies an SDK class, not a core-origin error. Every existing
instanceof TessarError guard that suppresses boundary attribution must now check
source === tessar explicitly. errorInfo honors a TessarError's declared source,
retains first captured origin metadata and does not replace original exceptions.
JSON ErrorInfo values are not recognized as class instances. errorFromInfo updates
its constructor call for options but does not invent provider subclass instances.

## Scope

No error-code catalog, retryable removal, persisted stack/cause redesign, global
error registry, aliases or external SDK wrapping. Preserve other uncommitted work.
After tests, run requested ponytail-audit across repository sources as a separate
report only; no automatic audit fixes.

Verify subclass field inference, unsafe inputs, same names, native causes,
cross-boundary provider/source behavior, JSON restoration, native SDK errors,
and a built TypeSafe/SQLite HTTP consumer.
