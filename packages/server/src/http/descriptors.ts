import type { Controller, Session, Thread } from "@tessar/core";

export function agentDescriptor(controller: Controller) {
  const agent = controller.agent;
  const model = agent.getModel();
  return {
    id: agent.id, controllerId: controller.id,
    model: "ref" in model ? model.ref : model,
    instructions: agent.getInstruction(), limits: agent.limits()
  };
}
export function controllerDescriptor(controller: Controller) {
  return { id: controller.id, agentId: controller.agent.id, ready: controller.isReady() };
}
export function sessionDescriptor(controllerId: string, session: Session) {
  return {
    id: session.id, controllerId, agentId: session.agent.id, scope: session.scope(),
    metadata: session.metadata(), selectedThreadId: session.thread.getId(), model: session.model.info(),
    idle: session.isIdle(), disposed: session.isDisposed()
  };
}
export function threadDescriptor(thread: Thread) { return { id: thread.id, scope: thread.scope() }; }
