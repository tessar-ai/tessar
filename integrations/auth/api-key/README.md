# @tessar/auth-api-key

Verifies an Authorization Bearer API key with a constant-time comparison.

Install this package alongside `@tessar/core`, `@tessar/server` and their required peers.

```ts
import { ApiKeyAuth } from "@tessar/auth-api-key";

const provider = new ApiKeyAuth({ key: process.env.TESSAR_API_KEY!, identity: { id: "service" } });
// Configure: new Tessar({ server: { auth: { provider } } })
```

Login, token issuance/refresh, user storage and custom route protection remain
developer-owned. See the [server authentication guide](../../../examples/guide/auth.md).
