import { ready, stream, session } from "@tessar/core";
import { workerData } from "node:worker_threads";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

class ProbePlugin {
  id = "signal-deadlock-probe";
  entered = deferred();
  release = deferred();
  receiptReady = deferred();
  agent;
  threadId;
  streamId;
  fired = false;
  hasStarted = false;
  trace = [];
  receipt;

  setup(tessar) {
    const config = workerData;
    const remember = (event, context) => {
      if (event.agentId) this.agent = context.registry.get("agent", event.agentId);
      if (event.threadId) this.threadId = event.threadId;
      if (event.streamId) this.streamId = event.streamId;
      if (event.type === stream.started) this.hasStarted = true;
    };
    tessar.hook(ready, remember);
    tessar.hook(stream.started, remember);
    tessar.hook(session.threadCreated, remember);
    if (config.hook) tessar.hook(config.hook, async (event, context) => {
      remember(event, context);
      if (this.fired) return;
      if (config.assistantOnly && (event.payload.message ?? event.payload).role !== "assistant") return;
      if (config.afterAdmission && !this.hasStarted) return;
      this.fired = true;
      this.trace.push("hook-entered");
      this.entered.resolve();
      if (config.pauseOnly) {
        await this.release.promise;
      } else if (config.timer) {
        const timer = setTimeout(() => this.notify(), 10);
        tessar.defer(() => clearTimeout(timer));
      } else {
        const receipt = this.notify();
        // This diagnostic escape breaks a confirmed cycle without changing SDK code.
        await Promise.race([receipt, this.release.promise]);
      }
      this.trace.push("hook-returned");
      if (["thread.prepare", "input.prepare", "message.prepare", "context.prepare", "model.request", "model.response", "tools.select", "tool.prepare", "tool.result"].includes(config.hook))
        return event.payload;
    });
  }

  notify() {
    const config = workerData;
    const target = config.target === "thread"
      ? { threadId: this.threadId }
      : { streamId: this.streamId ?? "probe-target" };
    this.trace.push("signal-sent");
    this.receipt = this.agent.sendSignal({ ...target, content: "probe notification", persist: config.persist ?? true })
      .then(() => { this.trace.push("signal-fulfilled"); return { status: "fulfilled" }; },
        (error) => { this.trace.push("signal-rejected:" + error.code); return { status: "rejected", code: error.code, message: error.message }; });
    this.receiptReady.resolve();
    return this.receipt;
  }
}

export default new ProbePlugin();
