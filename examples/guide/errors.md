# Identify and handle errors

[All guides](README.md)

Tessar's own error classes extend `TessarError`. Its inherited static
`isInstance(value: unknown)` checks the actual class and narrows to the class on
which it was called. No casts, error IDs or package-qualified names are required.

```ts
import { TessarError } from "@tessar/core";
import { TypeSafeAPIError, TypeSafeResponseError } from "@tessar/typesafe";

function handle(error: unknown): void {
  if (TypeSafeAPIError.isInstance(error)) {
    console.error(error.status, error.body, error.requestId);
  } else if (TypeSafeResponseError.isInstance(error)) {
    console.error(error.body);
  } else if (TessarError.isInstance(error)) {
    console.error(error.source, error.code, error.message, error.details);
  } else if (error instanceof Error) {
    console.error(error.stack);
  }
}
```

Check specific classes before the shared parent. A parent recognizes actual
subclasses; sibling classes and unrelated classes with the same `name` remain
distinct. The guard handles null, primitives and failing prototype lookups by
returning false. It does not treat JSON data or another independently loaded
copy of a package's class as an instance of this class.

## Define an application or plugin error

```ts
import { TessarError } from "@tessar/core";

class PermissionFailure extends TessarError {
  readonly name = "PermissionFailure";
  constructor(readonly permission: string, cause?: unknown) {
    super("PermissionDenied", "Permission was denied", {
      source: "plugin",
      details: { permission },
      cause,
    });
  }
}

const error: unknown = new PermissionFailure("write");
if (PermissionFailure.isInstance(error)) {
  console.log(error.permission); // inferred string
}
```

Implement `isInstance` only in the shared base; subclasses inherit it. `name` is
for display and defaults to the constructor's name; set it explicitly when a
stable display name matters. No registry, static identifier or name comparison
is used for identity.

`new TessarError(code, message, options?)` accepts `source?`, `details?` and native
`cause?` in options. Source defaults to `tessar`; other sources are `provider`,
`plugin`, `tool`, `storage`, `application`. The third argument is the options
object: additional data belongs in `options.details`. Reading `.source` identifies
origin independently of inheritance; a TypeSafe HTTP error is both a TessarError
subclass and a provider-origin error. External SDK exceptions retain their native
classes rather than being wrapped just to join this hierarchy.

## Events and persisted failures

`errorInfo(error, origin?)` and `error.toJSON()` produce JSON-compatible failure
information for events/storage. A declared TessarError source is preserved when
outer tool/plugin/provider boundaries add context. Existing captured origins for
native SDK errors are also preserved.

Additional failure data belongs in `ErrorInfo.details`. For example, a persisted
TypeSafe HTTP failure stores `error.details.status`, `error.details.body` and
`error.details.requestId`; the thrown `TypeSafeAPIError` still exposes its direct
`.status`, `.body` and `.requestId` properties.

An `ErrorInfo` object in a Stream/Session event or database is data, not a class
instance; inspect its `source`, `code`, `message`, `details`. `errorFromInfo(info)`
retains the original exception while its in-process reference is available;
serialized data cannot recreate a provider's class identity. Native exceptions
have `.stack` and optional `.cause`; these are not currently serialized in
`ErrorInfo`. Inheritance and instance guards do not change retry policy.
