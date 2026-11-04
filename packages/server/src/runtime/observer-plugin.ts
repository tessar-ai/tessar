import { stateChanged, stream, thread, type EventEnvelope, type Plugin, type PluginContext, type RecordStore } from "@tessar/core";

export class ObserverPlugin implements Plugin {
  readonly id = "tessar.server.observer";
  constructor(private readonly records: (store: RecordStore) => void,
    private readonly observe: (event: EventEnvelope) => void) { }
  setup(context: PluginContext): void {
    this.records(context.storage.records);
    for (const name of [stateChanged, stream.started, stream.resumed, stream.end, stream.suspended, thread.deleted] as const)
      context.hook(name, event => { this.observe(event); });
  }
}
