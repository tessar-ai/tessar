import { EventEnvelope, stateChanged, stream, thread, errorInfo, type ErrorInfo, type RuntimeState, type Session } from "@tessar/core";
import { TessarServerError } from "../errors.js";

type StateEvent = EventEnvelope<{ state: RuntimeState }>;
const THREAD_UNAVAILABLE = { code: "ThreadNotFound", message: "Selected Thread is unavailable" } as const;
const LIFECYCLE_EVENTS = new Set<string>([stream.started, stream.resumed, stream.end, stream.suspended, stream.error]);
interface ThreadView { streamId: string; handleId?: string; awaitingHandle?: boolean; state?: RuntimeState; active: boolean; deleted?: boolean }
interface SessionView {
  controllerId: string;
  session: Session;
  listeners: Map<(event: StateEvent) => void, () => void>;
  detach: () => void;
  localError?: ErrorInfo;
}

export class ThreadStateHub {
  private readonly threads = new Map<string, ThreadView>();
  private readonly sessions = new Map<Session, SessionView>();
  private sequence = 0;
  private key(controllerId: string, threadId: string) { return JSON.stringify([controllerId, threadId]); }

  observe(event: EventEnvelope): void {
    if (!event.controllerId || !event.threadId) return;
    if (event.type !== stateChanged && event.type !== thread.deleted && !LIFECYCLE_EVENTS.has(event.type)) return;
    if (event.type === stream.error && event.payload.target === "consumer") return;
    const key = this.key(event.controllerId, event.threadId);
    let view = this.threads.get(key);
    if (event.type === stream.started || event.type === stream.resumed) {
      if (!event.streamId) return;
      if (event.handleId && view?.streamId === event.streamId && (!view.handleId || view.handleId === event.handleId)) {
        view.handleId = event.handleId;
        view.awaitingHandle = false;
      } else {
        view = {
          streamId: event.streamId, handleId: event.handleId,
          awaitingHandle: event.type === stream.resumed && !event.handleId, active: true
        };
        this.threads.set(key, view);
        for (const slot of this.sessions.values()) if (slot.controllerId === event.controllerId && slot.session.thread.getId() === event.threadId)
          slot.localError = undefined;
      }
    } else if (event.type === thread.deleted) {
      view ??= { streamId: "", active: false };
      view.deleted = true;
      this.threads.set(key, view);
    } else if (view && event.streamId === view.streamId &&
      (!event.handleId || event.handleId === view.handleId || (!view.handleId && !view.awaitingHandle))) {
      if (event.type === stateChanged) {
        if (!event.handleId) return;
        view.handleId ??= event.handleId;
        view.state = event.payload.state;
      }
      if (event.type === stream.end || event.type === stream.suspended || event.type === stream.error) view.active = false;
    } else return;
    for (const slot of this.sessions.values()) {
      if (slot.controllerId === event.controllerId && slot.session.thread.getId() === event.threadId) this.publish(slot);
    }
    this.prune();
  }

  attach(controllerId: string, session: Session): void {
    if (session.isDisposed() || this.sessions.has(session)) return;
    const slot: SessionView = { controllerId, session, listeners: new Map(), detach: () => { } };
    this.sessions.set(session, slot);
    slot.detach = session.subscribe(event => {
      // Raw lifecycle events include the handle before delayed plugin snapshots arrive.
      this.observe(event);
      if (event.type === stateChanged) {
        const id = session.thread.getId();
        const view = id && this.threads.get(this.key(controllerId, id));
        if (!event.payload.state.error) slot.localError = undefined;
        else if (view && (event.streamId !== view.streamId || (view.handleId && event.handleId !== view.handleId)))
          slot.localError = event.payload.state.error;
        this.publish(slot); this.prune();
        if (session.isDisposed()) this.remove(session);
      }
    });
  }
  remove(session: Session): void {
    const slot = this.sessions.get(session);
    if (slot) for (const close of slot.listeners.values()) close();
    slot?.detach();
    this.sessions.delete(session);
    this.prune();
  }
  private compose(controllerId: string, session: Session): RuntimeState {
    const own = session.state.get();
    const id = session.thread.getId();
    const view = id && this.threads.get(this.key(controllerId, id));
    if (view && view.deleted) throw new TessarServerError(THREAD_UNAVAILABLE.code, THREAD_UNAVAILABLE.message);
    return view && view.state ? {
      ...view.state, queuedInputs: own.queuedInputs,
      error: this.sessions.get(session)?.localError ?? view.state.error
    } : own;
  }
  private publish(slot: SessionView): void {
    let state: RuntimeState;
    try { state = this.compose(slot.controllerId, slot.session); }
    catch (error) { state = { ...slot.session.state.get(), status: "failed", error: errorInfo(error) }; }
    const event = new EventEnvelope(stateChanged, { state }, {
      controllerId: slot.controllerId, agentId: slot.session.agent.id, sessionId: slot.session.id,
      threadId: slot.session.thread.getId() ?? undefined, scope: slot.session.scope(), sequence: ++this.sequence,
    });
    for (const listener of slot.listeners.keys()) listener(event);
  }
  subscribe(controllerId: string, session: Session, callback: (event: StateEvent) => void, close: () => void = () => { }): () => void {
    this.attach(controllerId, session);
    const slot = this.sessions.get(session)!;
    slot.listeners.set(callback, close);
    return () => { slot.listeners.delete(callback); };
  }
  async getSnapshot(controllerId: string, session: Session): Promise<RuntimeState> {
    this.attach(controllerId, session);
    const id = session.thread.getId();
    if (id) {
      const handle = await session.thread.get(id);
      if (session.thread.getId() !== id) return this.getSnapshot(controllerId, session);
      if (!handle) throw new TessarServerError(THREAD_UNAVAILABLE.code, THREAD_UNAVAILABLE.message);
      handle.dispose();
    }
    return this.compose(controllerId, session);
  }
  private prune(): void {
    const interested = new Set([...this.sessions.values()].filter(slot => !slot.session.isDisposed())
      .map(slot => this.key(slot.controllerId, slot.session.thread.getId() ?? "")));
    for (const [key, view] of this.threads) if (!view.active && !interested.has(key)) this.threads.delete(key);
  }
  close(): void {
    for (const slot of this.sessions.values()) slot.detach();
    this.sessions.clear(); this.threads.clear();
  }
}
