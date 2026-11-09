import { Transport, HTTP_METHOD, resourceId, type RequestOptions } from "../transport.js";
import { SessionClient } from "./session.js";
import type { ControllerInfo, SessionOptions, SessionInfo, SessionData, ScopedPageOptions, Page, AppendRecordInput, RecordData, RecordsOptions } from "../types.js";
import type { Scope } from "../wire.js";
import { RESOURCE } from "./paths.js";

export class ControllerClient {
  private readonly path: readonly string[];
  constructor(private readonly transport: Transport, readonly id: string) { this.path = [RESOURCE.CONTROLLERS, id]; }
  info(options?: RequestOptions): Promise<ControllerInfo> { return this.transport.request(HTTP_METHOD.GET, this.path, options); }
  getSession(id: string): SessionClient { return new SessionClient(this.transport, [...this.path, RESOURCE.SESSIONS, resourceId(id)], id); }
  async createSession(options: SessionOptions = {}): Promise<SessionClient> {
    const { signal, ...body } = options;
    const session = await this.transport.request<SessionInfo>(HTTP_METHOD.POST, [...this.path, RESOURCE.SESSIONS], { signal, body });
    return this.getSession(session.id);
  }
  listSessions(options: ScopedPageOptions = {}): Promise<Page<SessionData>> {
    const { signal, ...query } = options;
    return this.transport.request(HTTP_METHOD.GET, [...this.path, RESOURCE.SESSIONS], { signal, query });
  }
  readonly records = {
    append: (input: AppendRecordInput, options?: RequestOptions): Promise<RecordData> => {
      const { namespace, ...body } = input;
      return this.transport.request(HTTP_METHOD.POST, [...this.path, RESOURCE.RECORDS, namespace], { ...options, body });
    },
    get: (namespace: string, id: string, options: RequestOptions & { scope?: Scope } = {}): Promise<RecordData> => {
      const { signal, ...query } = options;
      return this.transport.request(HTTP_METHOD.GET, [...this.path, RESOURCE.RECORDS, namespace, id], { signal, query });
    },
    list: (options: RecordsOptions): Promise<Page<RecordData>> => {
      const { namespace, signal, ...query } = options;
      return this.transport.request(HTTP_METHOD.GET, [...this.path, RESOURCE.RECORDS, namespace], { signal, query });
    },
  };
}
