import { Transport, HTTP_METHOD, type RequestOptions } from "../transport.js";
import { RESOURCE } from "./paths.js";
import type { ThreadDescriptor, CheckpointData, SnapshotData, HistoryOptions, HistoryPage, PageOptions, Page, CheckpointSummary, StreamData, InterruptData, ExecutionListOptions, TurnData, ModelAttemptData, ToolExecutionData } from "../types.js";

export class ThreadClient {
  constructor(private readonly transport: Transport, private readonly path: readonly string[], readonly id: string) { }
  info(options?: RequestOptions): Promise<ThreadDescriptor> { return this.transport.request(HTTP_METHOD.GET, this.path, options); }
  snapshot(options?: RequestOptions): Promise<SnapshotData> { return this.transport.request(HTTP_METHOD.GET, [...this.path, RESOURCE.SNAPSHOT], options); }
  getHistory(options?: HistoryOptions): Promise<HistoryPage> { return this.list(RESOURCE.HISTORY, options); }
  listCheckpoints(options?: PageOptions): Promise<Page<CheckpointSummary>> { return this.list(RESOURCE.CHECKPOINTS, options); }
  getCheckpoint(id: string, options?: RequestOptions): Promise<CheckpointData> { return this.transport.request(HTTP_METHOD.GET, [...this.path, RESOURCE.CHECKPOINTS, id], options); }
  getStream(id: string, options?: RequestOptions): Promise<StreamData> { return this.transport.request(HTTP_METHOD.GET, [...this.path, RESOURCE.STREAMS, id], options); }
  getInterrupt(id: string, options?: RequestOptions): Promise<InterruptData> { return this.transport.request(HTTP_METHOD.GET, [...this.path, RESOURCE.INTERRUPTS, id], options); }
  listStreams(options?: ExecutionListOptions): Promise<Page<StreamData>> { return this.list(RESOURCE.STREAMS, options); }
  listTurns(options?: ExecutionListOptions): Promise<Page<TurnData>> { return this.list(RESOURCE.TURNS, options); }
  listModelAttempts(options?: ExecutionListOptions): Promise<Page<ModelAttemptData>> { return this.list(RESOURCE.MODEL_ATTEMPTS, options); }
  listToolExecutions(options?: ExecutionListOptions): Promise<Page<ToolExecutionData>> { return this.list(RESOURCE.TOOL_EXECUTIONS, options); }
  listInterrupts(options?: ExecutionListOptions): Promise<Page<InterruptData>> { return this.list(RESOURCE.INTERRUPTS, options); }
  private list<T>(resource: string, options: PageOptions = {}): Promise<T> {
    const { signal, ...query } = options;
    return this.transport.request(HTTP_METHOD.GET, [...this.path, resource], { signal, query });
  }
}
