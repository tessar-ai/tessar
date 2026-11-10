# @tessar/auth-clerk

Verifies Clerk Bearer session tokens using the HTTPS issuer's JWKS. Rejects pending sessions; authorizedParties restricts azp when configured.

Install this package alongside `@tessar/core`, `@tessar/server` and their required peers.

```ts
import { ClerkAuth } from "@tessar/auth-clerk";

const provider = new ClerkAuth({ issuer: process.env.CLERK_ISSUER!, authorizedParties: ["https://app.example.com"] });
// Configure: new Tessar({ server: { auth: { provider } } })
```

Login, token issuance/refresh, user storage and custom route protection remain
developer-owned. See the [server authentication guide](../../../examples/guide/auth.md).
