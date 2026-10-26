import type { AnyEvent, EventKind } from "../events/definition.js";
import type { Disposer, Plugin } from "./context.js";
export interface HandlerRegistration {
  name: AnyEvent;
  kind: EventKind;
  version: number;
  handler: (event: any, context: any) => any;
  pluginId: string;
  id: string;
  pluginVersion: number;
  configurationId: string | null;
}
export interface ValueRegistration {
  kind: string;
  id: string;
  value: unknown;
  version: number;
  pluginId: string;
  pluginVersion: number;
  configurationId: string | null;
}
export interface PluginSlot {
  plugin: Plugin;
  handlers: HandlerRegistration[];
  values: ValueRegistration[];
  disposers: Disposer[];
  references: number;
  detached: boolean;
  disposed: boolean;
}
export class RegistryLease {
  readonly handlers: readonly HandlerRegistration[];
  readonly values: readonly ValueRegistration[];
  private released = false;
  constructor(
    private readonly slots: readonly PluginSlot[],
    private readonly releaseSlot: (slot: PluginSlot) => Promise<void>,
    values: readonly ValueRegistration[] = [],
  ) {
    this.handlers = slots.flatMap((s) => s.handlers.slice());
    this.values = [...values, ...slots.flatMap((s) => s.values.slice())];
    for (const slot of slots) slot.references++;
  }
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    for (const slot of this.slots) {
      slot.references--;
      await this.releaseSlot(slot);
    }
  }
  /** Keep this captured handler/value set alive for an asynchronous notification. */
  retain(): () => Promise<void> {
    for (const slot of this.slots) slot.references++;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      for (const slot of this.slots) {
        slot.references--;
        await this.releaseSlot(slot);
      }
    };
  }
  find<T>(kind: string, id: string): T | undefined {
    return this.values.find((v) => v.kind === kind && v.id === id)?.value as
      | T
      | undefined;
  }
  list<T>(kind: string): readonly T[] {
    return this.values.filter((v) => v.kind === kind).map((v) => v.value as T);
  }
}
