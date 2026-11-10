import type { Tessar } from "../tessar.js";
import type { TessarOptions } from "../types.js";
import { TessarServerError, SERVER_ERROR_CODE } from "../errors.js";
import { RuntimeRegistry } from "./runtime-registry.js";
import { SessionRegistry } from "./session-registry.js";
import { ThreadStateHub } from "./thread-state-hub.js";
import { ObserverPlugin } from "./observer-plugin.js";

const contexts = new WeakMap<Tessar<any>, RuntimeContext>();

export class RuntimeContext {
  readonly registry: RuntimeRegistry;
  readonly hub = new ThreadStateHub();
  readonly sessions: SessionRegistry;
  readonly initialization: Promise<void>;
  private closing = false;
  private disposal?: Promise<void>;
  constructor(options: TessarOptions<any>) {
    this.registry = new RuntimeRegistry(options);
    this.sessions = new SessionRegistry(this.registry, (id, session) => this.hub.attach(id, session), session => this.hub.remove(session));
    this.initialization = this.initialize();
    void this.initialization.catch(() => {});
  }
  private async initialize(): Promise<void> {
    try {
      for (const controller of this.registry.controllers.values()) {
        await controller.initialize();
        if (this.closing) return;
        await controller.plugins.attach(new ObserverPlugin(store => this.registry.records.set(controller.id, store), this.hub));
      }
    } catch (error) {
      await this.registry.dispose().catch(() => {});
      throw error;
    }
  }
  async ready(): Promise<void> {
    if (this.closing) throw new TessarServerError(SERVER_ERROR_CODE.DISPOSED, "Tessar is shut down");
    await this.initialization;
    if (this.closing) throw new TessarServerError(SERVER_ERROR_CODE.DISPOSED, "Tessar is shut down");
  }
  shutdown(): Promise<void> {
    this.closing = true;
    return this.disposal ??= (async () => {
      await this.initialization.catch(() => {});
      this.hub.close();
      await this.registry.dispose();
    })();
  }
}

export function createRuntime(tessar: Tessar<any>, options: TessarOptions<any>): void {
  contexts.set(tessar, new RuntimeContext(options));
}
export function runtimeFor(tessar: Tessar<any>): RuntimeContext {
  const runtime = contexts.get(tessar);
  if (!runtime) throw new TessarServerError("InvalidConfiguration", "Expected a Tessar instance");
  return runtime;
}
