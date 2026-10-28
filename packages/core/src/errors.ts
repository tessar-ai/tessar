export interface ErrorOrigin {
  source: "tessar" | "provider" | "plugin" | "tool" | "storage" | "application";
  providerId?: string;
  modelId?: string;
  pluginId?: string;
  eventId?: string;
  toolName?: string;
  backendId?: string;
}
export interface ErrorInfo extends ErrorOrigin {
  name: string;
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

// Associate provenance without modifying exceptions owned by SDKs or plugins.
const origins = new WeakMap<object, ErrorOrigin>();
const causes = new WeakMap<ErrorInfo, unknown>();

export interface TessarErrorOptions extends ErrorOptions {
  source?: ErrorOrigin["source"];
  details?: Record<string, unknown>;
}

export class TessarError extends Error {
  readonly source: ErrorOrigin["source"];
  readonly details?: Record<string, unknown>;
  static isInstance<E extends TessarError>(
    this: abstract new (...args: any[]) => E,
    value: unknown,
  ): value is E {
    try {
      return value instanceof this;
    } catch {
      return false;
    }
  }
  constructor(
    readonly code: string,
    message: string,
    options: TessarErrorOptions = {},
  ) {
    super(message, options);
    this.name = new.target === TessarError ? "TessarError" : new.target.name;
    this.source = options.source ?? "tessar";
    this.details = options.details;
  }
  toJSON(): ErrorInfo {
    return errorInfo(this);
  }
}
export function fail(code: string, message: string): never {
  throw new TessarError(code, message);
}
export function requireId(id: string, name = "id"): string {
  if (typeof id !== "string" || !id.trim())
    fail("InvalidConfiguration", name + " must be a nonempty string");
  return id;
}
export function errorInfo(error: unknown, origin?: ErrorOrigin): ErrorInfo {
  const object =
    error !== null && (typeof error === "object" || typeof error === "function")
      ? error
      : undefined;
  const previous = object && origins.get(object);
  const selected: ErrorOrigin = previous ?? {
    ...(origin ?? { source: "tessar" as const }),
    ...(TessarError.isInstance(error) ? { source: error.source } : {}),
  };
  if (object && origin && !previous) origins.set(object, selected);
  const value = object as Record<string, unknown> | undefined;
  const details =
    TessarError.isInstance(error)
      ? error.details
      : Object.fromEntries(
          ["status", "requestID", "request_id", "type", "param"].flatMap(
            (key) => {
              const field = value?.[key];
              return typeof field === "string" ||
                typeof field === "boolean" ||
                (typeof field === "number" && Number.isFinite(field))
                ? [[key, field]]
                : [];
            },
          ),
        );
  const name =
    error instanceof Error
      ? error.name === "Error"
        ? error.constructor.name
        : error.name
      : "Error";
  const info: ErrorInfo = {
    ...selected,
    name,
    code: typeof value?.code === "string" ? value.code : name,
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
    ...(details && Object.keys(details).length ? { details } : {}),
  };
  causes.set(info, error);
  return info;
}
/** Retain the original exception in-process; persisted errors retain their source. */
export function errorFromInfo(info: ErrorInfo): unknown {
  if (causes.has(info)) return causes.get(info);
  const error =
    info.source === "tessar"
      ? new TessarError(info.code, info.message, { details: info.details })
      : Object.assign(new Error(info.message), {
          name: info.name,
          code: info.code,
          ...info.details,
        });
  origins.set(error, info);
  return error;
}
