# @tessar/auth-better-auth

Pass your configured Better Auth instance as auth. Delegates to auth.api.getSession({ headers }); you own its database and HTTP handlers.

Install this package alongside `@tessar/core`, `@tessar/server` and their required peers.

```ts
import { BetterAuthProvider } from "@tessar/auth-better-auth";

const provider = new BetterAuthProvider({ auth });
// Configure: new Tessar({ server: { auth: { provider } } })
```

Login, token issuance/refresh, user storage and custom route protection remain
developer-owned. See the [server authentication guide](../../../examples/guide/auth.md).
