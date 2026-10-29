import { workerData } from "node:worker_threads";
import { ready, thread, stream, checkpoint, input, TessarError } from "@tessar/core";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

export default new class {
  id = "signal-audit-extra";
  entered = deferred();
  release = deferred();
  trace = [];
  enteredCount = 0;
  armed = false;
  receipts = [];
  setup(tessar) {
    tessar.hook(ready, (event, context) => {
      this.agent = context.registry.get("agent", event.agentId);
    });
    const config = workerData;
    if (config.kind === "parallel") {
      let fired = false;
      tessar.hook(checkpoint.committed, async (event) => {
        if (!this.armed) return;
        const revision = event.payload.revision;
        this.trace.push("enter:" + revision);
        if (!fired) {
          fired = true;
          this.blockedRevision = revision;
          this.entered.resolve();
          await this.release.promise;
        }
        this.trace.push("exit:" + revision);
      });
      return;
    }
    if (config.kind === "cross") {
      tessar.hook(thread.prepare, async (event) => {
        const index = this.enteredCount++;
        if (this.enteredCount === 2) this.entered.resolve();
        await this.entered.promise;
        const id = index === 0 ? "target-b" : "target-a";
        this.trace.push("send-to:" + id);
        const receipt = this.agent.sendSignal({ streamId: id, content: "cross-signal" })
          .then(() => ({ status: "fulfilled" }), (error) => ({ status: "rejected", code: error.code }));
        this.receipts.push(receipt);
        await Promise.race([receipt, this.release.promise]);
        this.trace.push("hook-return:" + index);
        return event.payload;
      });
      return;
    }
    const hook = config.kind === "admission" ? config.hook
      : config.kind === "idle-burst" ? input.prepare
      : config.kind === "closing" ? stream.beforeEnd : checkpoint.committed;
    let fired = false;
    tessar.hook(hook, async (event) => {
      if (fired || (config.kind === "commit" && !this.armed)) return config.hook === thread.prepare || config.kind === "idle-burst" ? event.payload : undefined;
      fired = true;
      this.trace.push("hook-enter:" + event.type);
      if (config.kind === "admission") {
        const receipt = this.agent.sendSignal({ streamId: "target-a", content: "self-signal", persist: config.persist ?? true })
          .then(() => ({ status: "fulfilled" }), (error) => ({ status: "rejected", code: error.code }));
        this.receipts.push(receipt);
        this.entered.resolve();
        await Promise.race([receipt, this.release.promise]);
      } else {
        this.entered.resolve();
        await this.release.promise;
      }
      this.trace.push("hook-return:" + event.type);
      if (config.throwAfterCommit) throw new TessarError("StorageUnavailable", "diagnostic notification failure after commit");
      if (config.hook === thread.prepare || config.kind === "idle-burst") return event.payload;
    });
  }
}();
