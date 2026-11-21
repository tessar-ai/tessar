import { stateChanged, TessarError, type Session, type SessionOptions, type Scope, type RuntimeState } from "@tessar/core";
import { AsyncLocalStorage } from "node:async_hooks";
import { visible } from "../http/access.js";
import type { RuntimeRegistry } from "./runtime-registry.js";
import { required, HTTP_ERROR_CODE } from "../http/protocol.js";
import { TessarServerError, SERVER_ERROR_CODE } from "../errors.js";

const MAX_IDLE_SESSIONS = 100;
const MAX_IDLE_SESSION_BYTES = 16 * 1024 * 1024;
const RETAINED_STATUSES = new Set(["running", "pending", "suspended", "interrupted"]);
interface Entry {
  pending: Promise<Session>;
  session?: Session;
  pins: number;
  detach?: () => void;
  state?: RuntimeState;
  bytes: number;
}
interface RequestScope { active: boolean; entries: Set<Entry> }

export class SessionRegistry {
  private readonly sessions = new Map<string, Entry>();
  private readonly requests = new AsyncLocalStorage<RequestScope>();
  private closed = false;
  private pruning?: Promise<void>;
  private pruneAgain = false;
  constructor(private readonly runtimes: RuntimeRegistry,
    private readonly attached: (controllerId: string, session: Session) => void = () => { },
    private readonly removed: (session: Session) => void = () => { },
    private readonly canEvict: (session: Session) => boolean = () => true) { }
  private check(): void {
    if (this.closed) throw new TessarServerError(SERVER_ERROR_CODE.DISPOSED, "Session registry is shut down");
  }
  private key(controllerId: string, sessionId: string) { return JSON.stringify([controllerId, sessionId]); }
  async request<T>(action: () => Promise<T>): Promise<T> {
    const scope: RequestScope = { active: true, entries: new Set() };
    return this.requests.run(scope, async () => {
      try { return await action(); }
      finally {
        scope.active = false;
        for (const entry of scope.entries) entry.pins--;
        scope.entries.clear();
        await this.prune();
      }
    });
  }
  private track(entry: Entry): void {
    const scope = this.requests.getStore();
    if (scope?.active && !scope.entries.has(entry)) { scope.entries.add(entry); entry.pins++; }
  }
  private watch(entry: Entry, session: Session): void {
    if (entry.session) return;
    entry.session = session;
    entry.detach = session.subscribe(stateChanged, () => {
      entry.state = undefined;
      if (session.isIdle()) queueMicrotask(() => { void this.prune().catch(error => console.error(error)); });
    });
  }
  private forget(key: string, entry: Entry): void {
    if (this.sessions.get(key) === entry) this.sessions.delete(key);
    entry.detach?.();
    if (entry.session) this.removed(entry.session);
  }
  async create(controllerId: string, options: SessionOptions): Promise<Session> {
    this.check();
    const session = await required(this.runtimes.controllers.get(controllerId)).createSession(options);
    this.check();
    const entry: Entry = { pending: Promise.resolve(session), pins: 0, bytes: 0 };
    this.sessions.set(this.key(controllerId, session.id), entry);
    this.track(entry); this.watch(entry, session);
    this.attached(controllerId, session);
    return session;
  }
  async get(controllerId: string, sessionId: string, scope?: Scope): Promise<Session> {
    this.check();
    const key = this.key(controllerId, sessionId);
    let entry = this.sessions.get(key);
    if (!entry) {
      // Share restoration, not a caller's scoped lookup; visibility is checked below for each request.
      entry = { pending: required(this.runtimes.controllers.get(controllerId)).getSession(sessionId).then(required), pins: 0, bytes: 0 };
    }
    this.sessions.delete(key); this.sessions.set(key, entry);
    this.track(entry);
    let session: Session;
    try { session = await entry.pending; } catch (error) {
      this.forget(key, entry);
      throw error;
    }
    this.check();
    if (session.isDisposed()) { this.forget(key, entry); return this.get(controllerId, sessionId, scope); }
    this.watch(entry, session);
    if (!visible(session.scope(), scope)) return required<Session>(undefined);
    this.attached(controllerId, session);
    return session;
  }
  invalidate(controllerId: string, session: Session): void {
    if (session.isIdle()) {
      const key = this.key(controllerId, session.id), entry = this.sessions.get(key);
      if (entry?.session === session) this.forget(key, entry);
      void session.dispose().catch(error => console.error(error));
    }
  }
  async close(controllerId: string, sessionId: string, scope?: Scope): Promise<void> {
    const session = await this.get(controllerId, sessionId, scope);
    await session.dispose();
    const key = this.key(controllerId, sessionId), entry = this.sessions.get(key);
    if (entry?.session === session) this.forget(key, entry);
  }
  prune(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.pruneAgain = true;
    return this.pruning ??= (async () => {
      while (this.pruneAgain && !this.closed) {
        this.pruneAgain = false;
        await this.trim();
      }
    })().finally(() => { this.pruning = undefined; });
  }
  private evictable(entry: Entry): boolean {
    const session = entry.session;
    return !!session && !entry.pins && !session.isDisposed() && session.isIdle()
      && !session.state.get().interrupt && !RETAINED_STATUSES.has(session.state.get().status) && this.canEvict(session);
  }
  private async trim(): Promise<void> {
    const idle = [...this.sessions].filter(([, entry]) => this.evictable(entry));
    let count = idle.length, bytes = 0;
    for (const [, entry] of idle) {
      const state = entry.session!.state.get();
      if (state !== entry.state) {
        // Estimate UTF-16 payload bytes without allocating an encoded buffer.
        entry.bytes = JSON.stringify({ state, metadata: entry.session!.metadata() }).length * 2;
        entry.state = state;
      }
      bytes += entry.bytes;
    }
    for (const [key, entry] of idle) {
      if (this.closed || (count <= MAX_IDLE_SESSIONS && bytes <= MAX_IDLE_SESSION_BYTES)) break;
      if (!this.evictable(entry)) continue;
      const session = entry.session!;
      // Readers wait for eviction before restoring; never return a closing handle.
      entry.pending = session.dispose().then(() => session, error => {
        if (!TessarError.isInstance(error) || error.code !== HTTP_ERROR_CODE.SESSION_BUSY) console.error(error);
        return session;
      });
      await entry.pending;
      if (session.isDisposed()) { this.forget(key, entry); count--; bytes -= entry.bytes; }
    }
  }
  clear(): void {
    this.closed = true;
    for (const [key, entry] of this.sessions) this.forget(key, entry);
    this.sessions.clear();
  }
}
