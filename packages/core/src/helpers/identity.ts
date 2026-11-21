import { fail } from "../errors.js";

type Reservation = {
  entries: Map<string, WeakRef<object>>;
  id: string;
  reference: WeakRef<object>;
};
const agents = new Map<string, WeakRef<object>>();
const controllers = new Map<string, WeakRef<object>>();
function release({ entries, id, reference }: Reservation): void {
  if (entries.get(id) === reference) entries.delete(id);
}
// Track identity without keeping otherwise-unused SDK instances alive.
const collected = new FinalizationRegistry<Reservation>(release);

export function reserveId(
  kind: "Agent" | "Controller",
  id: string,
  instance: object,
): () => void {
  const entries = kind === "Agent" ? agents : controllers;
  if (entries.get(id)?.deref())
    fail("RegistrationConflict", `${kind} ID already in use: ${id}`);
  const reference = new WeakRef(instance);
  const reservation = { entries, id, reference };
  entries.set(id, reference);
  collected.register(instance, reservation, reference);
  return () => {
    release(reservation);
    collected.unregister(reference);
  };
}
