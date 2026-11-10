import { createRemoteJWKSet, customFetch, jwtVerify, errors, type JWTPayload } from "jose";
import { TessarServerError, type AuthProvider } from "@tessar/server";

const INVALID_CONFIGURATION = "InvalidConfiguration";
const AUTHORIZATION_HEADER = "authorization";
const BEARER_PATTERN = /^Bearer ([^\s]+)$/i;
const JWT_ALGORITHM = "RS256";
const REQUIRED_CLAIMS = ["exp", "nbf", "sub", "sid"];
const JWKS_PATH = "/.well-known/jwks.json";
const HTTPS_PROTOCOL = "https:";
const PENDING_SESSION = "pending";
export interface ClerkUser extends JWTPayload { sub: string; sid: string; exp: number }
export interface ClerkAuthOptions { issuer: string; authorizedParties?: readonly string[]; fetch?: typeof globalThis.fetch }
export class ClerkAuth implements AuthProvider<ClerkUser> {
  private readonly issuer: string;
  private readonly authorizedParties?: readonly string[];
  private readonly keys: ReturnType<typeof createRemoteJWKSet>;
  constructor(options: ClerkAuthOptions) {
    let issuer: URL;
    try { issuer = new URL(options.issuer); }
    catch { throw new TessarServerError(INVALID_CONFIGURATION, "Clerk issuer must be a valid HTTPS origin"); }
    if (issuer.protocol !== HTTPS_PROTOCOL || issuer.username || issuer.password || issuer.pathname !== "/" || issuer.search || issuer.hash ||
      options.authorizedParties !== undefined && (!Array.isArray(options.authorizedParties) || !options.authorizedParties.length || options.authorizedParties.some(value => typeof value !== "string" || !value.trim())) ||
      options.fetch !== undefined && typeof options.fetch !== "function")
      throw new TessarServerError(INVALID_CONFIGURATION, "Clerk requires an HTTPS issuer and nonempty authorized parties when specified");
    this.issuer = issuer.origin;
    this.authorizedParties = options.authorizedParties && [...options.authorizedParties];
    this.keys = createRemoteJWKSet(new URL(JWKS_PATH, issuer), { [customFetch]: options.fetch });
  }
  async authenticate(request: Request): Promise<ClerkUser | null> {
    const token = BEARER_PATTERN.exec(request.headers.get(AUTHORIZATION_HEADER) ?? "")?.[1];
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, this.keys, { algorithms: [JWT_ALGORITHM], requiredClaims: REQUIRED_CLAIMS, issuer: this.issuer });
      if (typeof payload.sub !== "string" || !payload.sub.trim() || typeof payload.sid !== "string" || !payload.sid.trim() || payload.sts === PENDING_SESSION ||
        this.authorizedParties && (typeof payload.azp !== "string" || !this.authorizedParties.includes(payload.azp))) return null;
      return payload as ClerkUser;
    } catch (error) { if (error instanceof errors.JOSEError) return null; throw error; }
  }
}
