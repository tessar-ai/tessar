import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, Controller, type StreamOutcome } from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";
import { PluginManager } from "@tessar/plugins";
import { LoggerPlugin, FileTransport, ConsoleTransport, logGroup, type LogEntry, type LogTransport } from "@tessar/plugins/logger";

class CaptureTransport implements LogTransport {
  readonly entries: LogEntry[] = [];
  closed = false;
  write(entry: LogEntry): void { this.entries.push(entry); }
  close(): void { this.closed = true; }
}

globalThis.fetch = async () => { throw Error("Unexpected network access"); };
const directory = await mkdtemp(join(tmpdir(), "tessar-built-logger-"));
const manager = new PluginManager({ directory: process.cwd(), hostUrl: import.meta.url });
const captured = new CaptureTransport();
const agent = new Agent({ id: "built-logger-agent", model: new ScriptedProvider([{ text: "one" }, { text: "two" }]) });
const logger = new LoggerPlugin({ level: "debug", transports: [
  new FileTransport({ path: join(directory, "app.jsonl"), groupBy: logGroup.session }),
  captured,
] });
const controller = new Controller({ id: "built-logger-controller", agent, plugins: [logger] });
try {
  assert.equal(typeof ConsoleTransport, "function");
  assert.ok(!("write" in logger));
  const [externalLogger] = await manager.load(["@tessar/plugins/logger"]);
  assert.equal(externalLogger?.id, "logger");
  await controller.initialize();
  const session = await controller.createSession({ id: "built-session" });
  for (const id of ["thread-one", "thread-two"]) {
    await session.thread.create({ id });
    const done = new Promise<StreamOutcome>(resolve => {
      const unsubscribe = session.subscribe("stream.end", event => { unsubscribe(); resolve(event.payload); });
    });
    await session.followUp("hello");
    assert.equal((await done).status, "completed");
  }
  await controller.dispose();
  assert.equal(captured.closed, true);
  for (const id of ["thread-one", "thread-two"]) {
    const rows = (await readFile(join(directory, "sessions", "built-session", id + ".jsonl"), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line) as LogEntry);
    assert.ok(rows.every(row => row.sessionId === "built-session" && row.threadId === id));
    assert.ok(rows.some(row => row.type === "message.delta" && row.level === "debug"));
    assert.ok(rows.some(row => row.type === "stream.end"));
  }
  assert.ok((await readFile(join(directory, "app.jsonl"), "utf8")).includes('"session.created"'));
  console.log("Built SDK smoke passed: public exports, PluginManager loading, custom transport, two Session Threads, debug logs and cleanup.");
} finally {
  await controller.dispose();
  manager.dispose();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
