import { jwtVerify, errors, type JWTPayload } from "jose";
import { TessarServerError, type AuthProvider } from "@tessar/server";

const INVALID_CONFIGURATION = "InvalidConfiguration";
const AUTHORIZATION_HEADER = "authorization";
const BEARER_PATTERN = /^Bearer ([^\s]+)$/i;
const JWT_ALGORITHM = "HS256";
const MIN_SECRET_BYTES = 32;
const REQUIRED_CLAIMS = ["sub", "exp"];
export interface JwtUser extends JWTPayload { sub: string; exp: number }
export interface JwtAuthOptions { secret: string; issuer?: string; audience?: string }
export class JwtAuth implements AuthProvider<JwtUser> {
  private readonly key: Uint8Array;
  private readonly options: Readonly<JwtAuthOptions>;
  constructor(options: JwtAuthOptions) {
    if (!options || typeof options.secret !== "string") throw new TessarServerError(INVALID_CONFIGURATION, "JWT secret is required");
    this.key = new TextEncoder().encode(options.secret);
    if (this.key.length < MIN_SECRET_BYTES || [options.issuer, options.audience].some(value => value !== undefined && (typeof value !== "string" || !value.trim())))
      throw new TessarServerError(INVALID_CONFIGURATION, "JWT requires a secret of at least 32 bytes and nonempty issuer/audience when specified");
    this.options = Object.freeze({ ...options });
  }
  async authenticate(request: Request): Promise<JwtUser | null> {
    const token = BEARER_PATTERN.exec(request.headers.get(AUTHORIZATION_HEADER) ?? "")?.[1];
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: [JWT_ALGORITHM], requiredClaims: REQUIRED_CLAIMS, issuer: this.options.issuer, audience: this.options.audience });
      return typeof payload.sub === "string" && payload.sub.trim() && typeof payload.exp === "number" ? payload as JwtUser : null;
    } catch (error) { if (error instanceof errors.JOSEError) return null; throw error; }
  }
}
