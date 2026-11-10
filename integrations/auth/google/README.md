# @tessar/auth-google

Verifies Google Bearer ID tokens using Google's JWKS, issuer, audience and expiry. This does not implement OAuth login.

Install this package alongside `@tessar/core`, `@tessar/server` and their required peers.

```ts
import { GoogleAuth } from "@tessar/auth-google";

const provider = new GoogleAuth({ clientId: process.env.GOOGLE_CLIENT_ID! });
// Configure: new Tessar({ server: { auth: { provider } } })
```

Login, token issuance/refresh, user storage and custom route protection remain
developer-owned. See the [server authentication guide](../../../examples/guide/auth.md).
