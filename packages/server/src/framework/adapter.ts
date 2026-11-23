import { runtimeFor } from "../runtime/context.js";
import { fields, invalid } from "../runtime/validation.js";
import { TessarServerError, SERVER_ERROR_CODE } from "../errors.js";
import { DEFAULT_OPENAPI_PATH, validateServerPaths } from "../http/paths.js";
import type { Tessar } from "../tessar.js";
import type { TessarServerOptions } from "../types.js";

export abstract class ServerAdapter<App> {
  protected readonly app: App;
  protected readonly tessar: Tessar<any>;
  protected readonly prefix: string;
  protected readonly openapiPath: string;
  private initialization?: Promise<void>;
  private disposal?: Promise<void>;
  protected closed = false;

  constructor(options: TessarServerOptions<App>) {
    fields(options, ["app", "tessar", "prefix", "openapiPath"]);
    if (!options?.app) invalid("An application is required");
    runtimeFor(options.tessar);
    this.app = options.app;
    this.tessar = options.tessar;
    this.prefix = options.prefix ?? options.tessar.server.prefix ?? "";
    this.openapiPath = options.openapiPath ?? options.tessar.server.openapiPath ?? DEFAULT_OPENAPI_PATH;
    validateServerPaths(this.prefix, this.openapiPath);
  }

  protected abstract mount(): void | Promise<void>;
  protected abstract closeTransport(): void;

  protected disposed(): TessarServerError {
    return new TessarServerError(SERVER_ERROR_CODE.DISPOSED, "Server adapter is shut down");
  }

  init(): Promise<void> {
    if (this.closed) return Promise.reject(this.disposed());
    return this.initialization ??= (async () => {
      try {
        await runtimeFor(this.tessar).ready();
        if (this.closed) throw this.disposed();
        await this.mount();
        if (this.closed) throw this.disposed();
      } catch (error) {
        this.closed = true;
        this.closeTransport();
        throw error;
      }
    })();
  }

  shutdown(): Promise<void> {
    this.closed = true;
    return this.disposal ??= (async () => {
      await this.initialization?.catch(() => { });
      this.closeTransport();
    })();
  }
}
