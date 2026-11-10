import type { Scope } from "@tessar/core";

export interface AuthProvider<User = unknown> {
  authenticate(request: Request): User | null | Promise<User | null>;
}
export interface AuthorizationContext<User> {
  readonly user: User;
  readonly request: Request;
}
export interface AuthOptions<User = unknown> {
  provider: AuthProvider<User>;
  authorize?: (context: AuthorizationContext<User>) => boolean | Promise<boolean>;
  scope?: (user: User) => Scope | Promise<Scope>;
}
