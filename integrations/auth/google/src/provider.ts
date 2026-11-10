import { createRemoteJWKSet, customFetch, jwtVerify, errors, type JWTPayload } from "jose";
import { TessarServerError, type AuthProvider } from "@tessar/server";

const INVALID_CONFIGURATION = "InvalidConfiguration";
const AUTHORIZATION_HEADER = "authorization";
const BEARER_PATTERN = /^Bearer ([^\s]+)$/i;
const GOOGLE_JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const JWT_ALGORITHM = "RS256";
const REQUIRED_CLAIMS = ["exp", "iat", "sub"];
export interface GoogleUser extends JWTPayload { sub: string; exp: number }
export interface GoogleAuthOptions { clientId: string; fetch?: typeof globalThis.fetch }
export class GoogleAuth implements AuthProvider<GoogleUser> {
  private readonly clientId: string;
  private readonly keys: ReturnType<typeof createRemoteJWKSet>;
  constructor(options: GoogleAuthOptions) {
    if (!options || typeof options.clientId !== "string" || !options.clientId.trim() || options.fetch !== undefined && typeof options.fetch !== "function")
      throw new TessarServerError(INVALID_CONFIGURATION, "Google clientId and an optional fetch function are required");
    this.clientId = options.clientId;
    this.keys = createRemoteJWKSet(new URL(GOOGLE_JWKS_URI), { [customFetch]: options.fetch });
  }
  async authenticate(request: Request): Promise<GoogleUser | null> {
    const token = BEARER_PATTERN.exec(request.headers.get(AUTHORIZATION_HEADER) ?? "")?.[1];
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, this.keys, { algorithms: [JWT_ALGORITHM], requiredClaims: REQUIRED_CLAIMS, issuer: GOOGLE_ISSUERS, audience: this.clientId });
      return typeof payload.sub === "string" && payload.sub.trim() ? payload as GoogleUser : null;
    } catch (error) { if (error instanceof errors.JOSEError) return null; throw error; }
  }
}
