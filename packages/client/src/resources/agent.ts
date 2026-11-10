import { Transport, HTTP_METHOD, MIME, type RequestOptions } from "../transport.js";
import { stateStream, type StateStream } from "../sse.js";
import { RESOURCE } from "./paths.js";
import type { AgentInfo, ToolInfo, Input, ExecutionOptions, GenerateResult, SignalInput, AbortOptions, AgentResumeInput } from "../types.js";

export class AgentClient {
  private readonly path: readonly string[];
  constructor(private readonly transport: Transport, readonly id: string) { this.path = [RESOURCE.AGENTS, id]; }
  info(options?: RequestOptions): Promise<AgentInfo> { return this.transport.request(HTTP_METHOD.GET, this.path, options); }
  listTool(options?: RequestOptions): Promise<readonly ToolInfo[]> { return this.transport.request(HTTP_METHOD.GET, [...this.path, RESOURCE.TOOLS], options); }
  generate(input: Input, options: ExecutionOptions = {}): Promise<GenerateResult> {
    const { signal, ...execution } = options;
    return this.transport.request(HTTP_METHOD.POST, [...this.path, RESOURCE.GENERATE], { signal, body: { input, options: execution } });
  }
  async stream(input: Input, options: ExecutionOptions = {}): Promise<StateStream> {
    const { signal, ...execution } = options;
    const response = await this.transport.response(HTTP_METHOD.POST, [...this.path, RESOURCE.STREAM], { signal, body: { input, options: execution } }, MIME.SSE);
    return stateStream(response, signal);
  }
  async resume(input: AgentResumeInput, options?: RequestOptions): Promise<StateStream> {
    const response = await this.transport.response(HTTP_METHOD.POST, [...this.path, RESOURCE.RESUME], { ...options, body: input }, MIME.SSE);
    return stateStream(response, options?.signal);
  }
  sendSignal(input: SignalInput, options?: RequestOptions): Promise<void> {
    return this.transport.request(HTTP_METHOD.POST, [...this.path, RESOURCE.SIGNALS], { ...options, body: input });
  }
  abort(streamId: string, options: AbortOptions = {}): Promise<void> {
    const { signal, reason } = options;
    return this.transport.request(HTTP_METHOD.POST, [...this.path, RESOURCE.STREAMS, streamId, RESOURCE.ABORT], { signal, body: { reason } });
  }
}
