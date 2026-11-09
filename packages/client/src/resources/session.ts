import type { JsonObject } from "../wire.js";
import { Transport, HTTP_METHOD, MIME, resourceId, type RequestOptions } from "../transport.js";
import { stateStream, type StateStream } from "../sse.js";
import { ThreadClient } from "./thread.js";
import { RESOURCE } from "./paths.js";
import type { SessionInfo, Input, InputReceipt, ResumeInput, RecoverInput, ContinuationReceipt, AbortOptions, ModelInfo, State, CreateThreadOptions, ThreadDescriptor, PageOptions, Page, ThreadData, ThreadTarget, ForkOptions } from "../types.js";

export class SessionClient {
  constructor(private readonly transport: Transport, private readonly path: readonly string[], readonly id: string) { }
  info(options?: RequestOptions): Promise<SessionInfo> { return this.transport.request(HTTP_METHOD.GET, this.path, options); }
  close(options?: RequestOptions): Promise<void> { return this.post(RESOURCE.CLOSE, {}, options); }
  followUp(input: Input, options?: RequestOptions): Promise<InputReceipt> { return this.post(RESOURCE.FOLLOW_UP, { input }, options); }
  resume(input: ResumeInput, options?: RequestOptions): Promise<ContinuationReceipt> { return this.post(RESOURCE.RESUME, input, options); }
  recover(input: RecoverInput, options?: RequestOptions): Promise<ContinuationReceipt> { return this.post(RESOURCE.RECOVER, input, options); }
  abort(options: AbortOptions = {}): Promise<void> { const { reason, signal } = options; return this.post(RESOURCE.ABORT, { reason }, { signal }); }
  readonly queue = { info: (options?: RequestOptions): Promise<{ count: number; isEmpty: boolean }> => this.transport.request(HTTP_METHOD.GET, [...this.path, RESOURCE.QUEUE], options) };
  readonly model = {
    info: (options?: RequestOptions): Promise<ModelInfo> => this.transport.request(HTTP_METHOD.GET, [...this.path, RESOURCE.MODEL], options),
    list: (options?: RequestOptions): Promise<readonly ModelInfo[]> => this.transport.request(HTTP_METHOD.GET, [...this.path, RESOURCE.MODELS], options),
    switch: (modelId: string, options: RequestOptions & { options?: JsonObject } = {}): Promise<void> => {
      const { signal, options: modelOptions } = options;
      return this.transport.request(HTTP_METHOD.POST, [...this.path, RESOURCE.MODEL, RESOURCE.SWITCH], { signal, body: { modelId, options: modelOptions } });
    },
    setEffort: (level: string, options?: RequestOptions): Promise<void> => this.transport.request(HTTP_METHOD.POST, [...this.path, RESOURCE.MODEL, RESOURCE.EFFORT], { ...options, body: { level } }),
  };
  readonly state = {
    get: (options?: RequestOptions): Promise<State> => this.transport.request(HTTP_METHOD.GET, [...this.path, RESOURCE.STATE], options),
    stream: async (options?: RequestOptions): Promise<StateStream> => {
      const response = await this.transport.response(HTTP_METHOD.GET, [...this.path, RESOURCE.STATE, RESOURCE.STREAM], options, MIME.SSE);
      return stateStream(response, options?.signal);
    },
  };
  readonly thread = {
    get: (id: string): ThreadClient => new ThreadClient(this.transport, [...this.path, RESOURCE.THREADS, resourceId(id)], id),
    create: async (options: CreateThreadOptions = {}): Promise<ThreadClient> => {
      const { signal, ...body } = options;
      const value = await this.post<ThreadDescriptor>(RESOURCE.THREADS, body, { signal });
      return this.thread.get(value.id);
    },
    list: (options: PageOptions = {}): Promise<Page<ThreadData>> => {
      const { signal, ...query } = options;
      return this.transport.request(HTTP_METHOD.GET, [...this.path, RESOURCE.THREADS], { signal, query });
    },
    switch: async (id: string, options?: RequestOptions): Promise<ThreadClient> => {
      const value = await this.transport.request<ThreadDescriptor>(HTTP_METHOD.POST, [...this.path, RESOURCE.THREAD, RESOURCE.SWITCH], { ...options, body: { threadId: resourceId(id) } });
      return this.thread.get(value.id);
    },
    rename: (title: string, options: ThreadTarget): Promise<void> => this.transport.request(HTTP_METHOD.POST, [...this.path, RESOURCE.THREADS, options.threadId, RESOURCE.RENAME], { signal: options.signal, body: { title } }),
    fork: async (options: ForkOptions): Promise<ThreadClient> => {
      const { signal, threadId, ...body } = options;
      const value = await this.transport.request<ThreadDescriptor>(HTTP_METHOD.POST, [...this.path, RESOURCE.THREADS, threadId, RESOURCE.FORK], { signal, body });
      return this.thread.get(value.id);
    },
    delete: (options: ThreadTarget): Promise<void> => this.transport.request(HTTP_METHOD.DELETE, [...this.path, RESOURCE.THREADS, options.threadId], { signal: options.signal }),
    purge: (options: ThreadTarget): Promise<void> => this.transport.request(HTTP_METHOD.POST, [...this.path, RESOURCE.THREADS, options.threadId, RESOURCE.PURGE], { signal: options.signal, body: {} }),
  };
  private post<T>(resource: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.transport.request(HTTP_METHOD.POST, [...this.path, resource], { ...options, body });
  }
}
