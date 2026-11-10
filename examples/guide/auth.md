# Server authentication

Authentication is optional. Without `server.auth`, Tessar does not restrict its
built-in HTTP APIs. Configure it before exposing a self-hosted server to users.

```ts
import { Tessar } from "@tessar/server";
import { JwtAuth } from "@tessar/auth-jwt";
import { assistant } from "./agents/assistant.js";

export default new Tessar({
  agents: [assistant],
  server: {
    auth: {
      provider: new JwtAuth({
        secret: process.env.JWT_SECRET!,
        issuer: "my-application",
        audience: "tessar",
      }),
      authorize: ({ user, request }) =>
        request.method === "GET" || user.role === "editor",
      scope: user => ({ userId: user.sub }),
    },
  },
});
```

Clients send `Authorization: Bearer <token>` using their normal request headers.
JWT verification requires HS256, a secret of at least 32 UTF-8 bytes, and `sub` and
`exp` claims. Issuer and audience are checked when configured. The developer owns
token issuance, login, password storage, refresh and logout.

`authorize` and `scope` are optional. Authorization returns a boolean; Tessar
does not implement roles or RBAC. A missing identity returns 401; denied
authorization returns 403. Provider failures and invalid policy results fail
closed with 500.

Scope adds mandatory server-owned fields to runtime operations. Clients can add
fields to narrow the scope, but cannot override mandatory fields. Lists filter
before pagination; accesses to another scope's resources return 404. Without a
scope callback, authenticated users share the configured runtime data. Authentication
is checked when opening an SSE request; it does not continuously revalidate a token.

The server passes the authenticated scope into core's `agent.resume()` and
`agent.sendSignal()`. Core checks the target Thread before accepting the operation;
the server waits for the continuation's initial result before opening SSE. Abort
checks the scope attached to the running HTTP stream handle. No Session is restored
just to check access, and the server does not query stored Threads directly.

## Custom providers

```ts
import type { AuthProvider } from "@tessar/server";

type User = { id: string; role: string };
class ApplicationAuth implements AuthProvider<User> {
  async authenticate(request: Request): Promise<User | null> {
    return verifyApplicationCredential(request); // Your implementation.
  }
}
```

The returned user type is inferred in `authorize` and `scope`. Return `null` for
missing or invalid credentials. Tessar does not own a user database or authentication
session store.

## Available integrations

Install the integration you use alongside `@tessar/server` and its required peers.
Source packages live under `integrations/auth/`.

| Package | Class and options | Credential |
| --- | --- | --- |
| `@tessar/auth-api-key` | `new ApiKeyAuth({ key, identity: { id: "service" } })` | Bearer API key |
| `@tessar/auth-jwt` | `new JwtAuth({ secret, issuer?, audience? })` | HS256 JWT |
| `@tessar/auth-google` | `new GoogleAuth({ clientId })` | Google ID token |
| `@tessar/auth-clerk` | `new ClerkAuth({ issuer, authorizedParties? })` | Clerk session token |
| `@tessar/auth-better-auth` | `new BetterAuthProvider({ auth })` | Developer-owned Better Auth instance |

Google validates signatures through Google's JWKS and checks issuer, audience and
expiry. Clerk uses the configured HTTPS issuer's JWKS, checks session claims and
rejects pending sessions. Set `authorizedParties` to restrict allowed `azp` origins.
Google and Clerk return token claims; `sub` identifies the user.

Better Auth delegates to `auth.api.getSession({ headers })`, preserving its session
result. For a standard Better Auth session, use `scope: session => ({ userId:
session.user.id })`. The developer supplies and configures Better Auth, its database
and handlers. These integrations do not start OAuth flows or register login routes.

## Routes and middleware

`server.auth` protects built-in Tessar runtime endpoints only. Custom routes,
including routes below `/api`, and the OpenAPI document remain developer-owned.
Protect them with your middleware where needed. Existing middleware runs in
declaration order before the built-in authentication gate.

Use `registerRoute()` to connect your login/callback/refresh handlers; there is no
automatic public-route list. When integrating into an existing application server,
the host application remains responsible for authenticating its mounted Tessar routes.
