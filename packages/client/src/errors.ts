import type { ErrorInfo } from "./wire.js";

export const CLIENT_ERROR_CODE = {
  INVALID_CONFIGURATION: "InvalidConfiguration",
  HTTP_ERROR: "HttpError",
  INVALID_RESPONSE: "InvalidResponse",
  CONSUMER_ALREADY_ATTACHED: "ConsumerAlreadyAttached",
} as const;

export class TessarClientError extends Error {
  readonly source = "tessar" as const;
  readonly details = undefined;
  readonly status?: number;
  readonly remote?: ErrorInfo;
  static isInstance<E extends TessarClientError>(this: abstract new (...args: any[]) => E, value: unknown): value is E {
    return value instanceof this;
  }
  constructor(readonly code: string, message: string, options: { status?: number; remote?: ErrorInfo; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.status = options.status;
    this.remote = options.remote;
  }
  toJSON(): ErrorInfo {
    return { source: this.source, name: this.name, code: this.code, message: this.message, retryable: false };
  }
}
