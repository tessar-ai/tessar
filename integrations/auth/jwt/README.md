# @tessar/auth-jwt

Verifies HS256 Bearer JWTs. Requires a secret of at least 32 UTF-8 bytes and sub/exp claims; checks issuer and audience when configured.

Install this package alongside `@tessar/core`, `@tessar/server` and their required peers.

```ts
import { JwtAuth } from "@tessar/auth-jwt";

const provider = new JwtAuth({ secret: process.env.JWT_SECRET!, issuer: "app", audience: "tessar" });
// Configure: new Tessar({ server: { auth: { provider } } })
```

Login, token issuance/refresh, user storage and custom route protection remain
developer-owned. See the [server authentication guide](../../../examples/guide/auth.md).
