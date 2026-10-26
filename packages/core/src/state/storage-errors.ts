import { errorInfo, TessarError } from "../errors.js";
import type { StorageBackend } from "./storage-ports.js";

/** Attribute driver failures at the host boundary, preserving original errors. */
export function guardStorage(backend: StorageBackend): StorageBackend {
  const failed = (error: unknown): never => {
    if (!(error instanceof TessarError))
      errorInfo(error, { source: "storage", backendId: backend.id });
    throw error;
  };
  const port = <T extends object>(target: T): T =>
    new Proxy({} as T, {
      set(_facade, key, value) {
        return Reflect.set(target, key, value);
      },
      get(_facade, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          try {
            return await Reflect.apply(value, target, args);
          } catch (error) {
            return failed(error);
          }
        };
      },
    });
  return {
    ...backend,
    sessions: port(backend.sessions),
    ownedState: port(backend.ownedState),
    threads: port(backend.threads),
    checkpoints: port(backend.checkpoints),
    executions: port(backend.executions),
    ownership: port(backend.ownership),
    commits: port(backend.commits),
    close: () => port(backend).close(),
  };
}
