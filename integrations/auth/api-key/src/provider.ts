import { timingSafeEqual } from "node:crypto";
import { TessarServerError, type AuthProvider } from "@tessar/server";

const INVALID_CONFIGURATION = "InvalidConfiguration";
const AUTHORIZATION_HEADER = "authorization";
const BEARER_PATTERN = /^Bearer ([^\s]+)$/i;
export interface ApiKeyAuthOptions<User extends object> { key: string; identity: User }
export class ApiKeyAuth<User extends object> implements AuthProvider<User> {
  private readonly key: Buffer;
  private readonly identity: User;
  constructor(options: ApiKeyAuthOptions<User>) {
    if (!options || typeof options.key !== "string" || !options.key.trim() || /\s/.test(options.key) ||
      !options.identity || typeof options.identity !== "object" || Array.isArray(options.identity))
      throw new TessarServerError(INVALID_CONFIGURATION, "A nonempty API key and identity object are required");
    this.key = Buffer.from(options.key);
    this.identity = structuredClone(options.identity);
  }
  async authenticate(request: Request): Promise<User | null> {
    const token = BEARER_PATTERN.exec(request.headers.get(AUTHORIZATION_HEADER) ?? "")?.[1];
    if (!token) return null;
    const value = Buffer.from(token);
    return value.length === this.key.length && timingSafeEqual(value, this.key) ? structuredClone(this.identity) : null;
  }
}
