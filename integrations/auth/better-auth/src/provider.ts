import { TessarServerError, type AuthProvider } from "@tessar/server";

const INVALID_CONFIGURATION = "InvalidConfiguration";
export interface BetterAuthInstance<Session extends object> {
  api: { getSession(options: { headers: Headers }): Promise<Session | null> };
}
export interface BetterAuthProviderOptions<Session extends object> { auth: BetterAuthInstance<Session> }
export class BetterAuthProvider<Session extends object> implements AuthProvider<Session> {
  private readonly auth: BetterAuthInstance<Session>;
  constructor(options: BetterAuthProviderOptions<Session>) {
    if (!options?.auth || typeof options.auth.api?.getSession !== "function")
      throw new TessarServerError(INVALID_CONFIGURATION, "auth must provide api.getSession");
    this.auth = options.auth;
  }
  authenticate(request: Request): Promise<Session | null> {
    return this.auth.api.getSession({ headers: request.headers });
  }
}
