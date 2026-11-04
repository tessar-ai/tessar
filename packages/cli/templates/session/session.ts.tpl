import type { Controller, Session, SessionOptions } from "@tessar/core";

export function create{{className}}Session(controller: Controller, options: SessionOptions = {}): Promise<Session> {
  return controller.createSession(options);
}
