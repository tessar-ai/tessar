import { Transport, HTTP_METHOD, resourceId, type TessarClientOptions, type RequestOptions } from "./transport.js";
import { AgentClient } from "./resources/agent.js";
import { ControllerClient } from "./resources/controller.js";
import type { AgentInfo, ControllerInfo } from "./types.js";
import { RESOURCE } from "./resources/paths.js";

export class TessarClient {
  private readonly transport: Transport;
  constructor(options: TessarClientOptions) { this.transport = new Transport(options); }
  listAgents(options?: RequestOptions): Promise<readonly AgentInfo[]> { return this.transport.request(HTTP_METHOD.GET, [RESOURCE.AGENTS], options); }
  listControllers(options?: RequestOptions): Promise<readonly ControllerInfo[]> { return this.transport.request(HTTP_METHOD.GET, [RESOURCE.CONTROLLERS], options); }
  getAgent(id: string): AgentClient { return new AgentClient(this.transport, resourceId(id)); }
  getController(id: string): ControllerClient { return new ControllerClient(this.transport, resourceId(id)); }
}
