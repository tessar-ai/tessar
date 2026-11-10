import { Session, stateChanged, stream, thread, type Plugin, type PluginContext, type RecordStore } from "@tessar/core";
import type { ThreadStateHub } from "./thread-state-hub.js";

export class ObserverPlugin implements Plugin {
  readonly id = "tessar.server.observer";
  constructor(private readonly records: (store: RecordStore) => void,
    private readonly hub: ThreadStateHub) { }
  setup(context: PluginContext): void {
    this.records(context.storage.records);
    for (const name of [stateChanged, stream.started, stream.resumed, stream.end, stream.suspended, stream.error, thread.deleted] as const)
      context.hook(name, (event, execution) => {
        if (execution.session instanceof Session && event.controllerId) this.hub.attach(event.controllerId, execution.session);
        this.hub.observe(event);
      });
  }
}
