import type { Session, SessionOptions, Scope } from "@tessar/core";
import { visible } from "../http/access.js";
import type { RuntimeRegistry } from "./runtime-registry.js";
import { required } from "../http/protocol.js";

export class SessionRegistry {
  private readonly sessions = new Map<string, Promise<Session>>();
  constructor(private readonly runtimes: RuntimeRegistry,
    private readonly attached: (controllerId: string, session: Session) => void = () => { },
    private readonly removed: (session: Session) => void = () => { }) { }
  private key(controllerId: string, sessionId: string) { return JSON.stringify([controllerId, sessionId]); }
  async create(controllerId: string, options: SessionOptions): Promise<Session> {
    const session = await required(this.runtimes.controllers.get(controllerId)).createSession(options);
    this.sessions.set(this.key(controllerId, session.id), Promise.resolve(session));
    this.attached(controllerId, session);
    return session;
  }
  async get(controllerId: string, sessionId: string, scope?: Scope): Promise<Session> {
    const key = this.key(controllerId, sessionId);
    let pending = this.sessions.get(key);
    if (!pending) {
      pending = required(this.runtimes.controllers.get(controllerId)).getSession(sessionId, { scope }).then(required);
      this.sessions.set(key, pending);
    }
    let session: Session;
    try { session = await pending; } catch (error) {
      if (this.sessions.get(key) === pending) this.sessions.delete(key);
      throw error;
    }
    if (!visible(session.scope(), scope)) return required<Session>(undefined);
    if (session.isDisposed()) { this.sessions.delete(key); return this.get(controllerId, sessionId, scope); }
    this.attached(controllerId, session);
    return session;
  }
  invalidate(controllerId: string, session: Session): void {
    if (session.isIdle()) {
      this.sessions.delete(this.key(controllerId, session.id));
      this.removed(session);
      void session.dispose().catch(error => console.error(error));
    }
  }
  async close(controllerId: string, sessionId: string, scope?: Scope): Promise<void> {
    const session = await this.get(controllerId, sessionId, scope);
    await session.dispose();
    this.removed(session);
    this.sessions.delete(this.key(controllerId, sessionId));
  }
}
