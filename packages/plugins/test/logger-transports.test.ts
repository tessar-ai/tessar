import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { AgentHarness } from "@tessar/core/testing";
import { AssistantMessage, MessageCodec, createTool } from "@tessar/core";
import { z } from "zod";
import {
  ConsoleTransport,
  FileTransport,
  LoggerPlugin,
  logGroup,
  type LogEntry,
  type LoggerOptions,
  type LogTransport,
} from "@tessar/plugins/logger";

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "tessar-logger-"));
  onTestFinished(() =>
    rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  );
  return path;
}

const entry = (identity: Partial<LogEntry> = {}): LogEntry => ({
  type: "stream.started",
  level: "info",
  timestamp: "2026-10-22T00:00:00.000Z",
  payload: { text: "one\ntwo" },
  ...identity,
});

it.each(["log", "jsonl"])(
  "routes each group and preserves the .%s extension",
  async (extension) => {
    const root = await directory();
    const identity = {
      sessionId: "session-a",
      threadId: "thread-a",
      streamId: "stream-a",
    };
    const destinations = [
      [logGroup.none, `app.${extension}`],
      [logGroup.thread, `threads/thread-a.${extension}`],
      [logGroup.session, `sessions/session-a/thread-a.${extension}`],
      [logGroup.stream, `streams/stream-a.${extension}`],
    ] as const;
    for (const [groupBy, destination] of destinations) {
      const groupRoot = join(root, groupBy);
      const transport = new FileTransport({
        path: join(groupRoot, `app.${extension}`),
        groupBy,
      });
      await transport.write(entry(identity));
      // A Session alone does not create a separate Session-level file.
      await transport.write(
        entry(
          groupBy === logGroup.none ? identity : { sessionId: "session-a" },
        ),
      );
      await transport.close();
      const text = await readFile(join(groupRoot, destination), "utf8");
      expect(text.endsWith("\n")).toBe(true);
      expect(
        text
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toContainEqual(entry(identity));
      if (groupBy !== logGroup.none) {
        expect(
          JSON.parse(
            (
              await readFile(join(groupRoot, `app.${extension}`), "utf8")
            ).trim(),
          ),
        ).toEqual(entry({ sessionId: "session-a" }));
      }
    }
  },
);

it("defaults to one named file and drains concurrent writes before closing", async () => {
  const root = await directory();
  const path = join(root, "nested", "my-app.log");
  const transport = new FileTransport({ path });
  const entries = Array.from({ length: 16 }, (_, index) =>
    entry({ payload: { index, text: "x".repeat(100_000) } }),
  );
  const writing = entries.map((value) => transport.write(value));
  await transport.close();
  await Promise.all(writing);
  expect(
    (await readFile(path, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line)),
  ).toEqual(entries);
  await transport.close();
  await expect(transport.write(entry())).rejects.toThrow(/closed/i);
});

it("encodes caller-supplied IDs as portable filenames within the configured directory", async () => {
  const root = await directory();
  const transport = new FileTransport({
    path: join(root, "app.log"),
    groupBy: logGroup.session,
  });
  const ids = [
    "../escape",
    "..\\escape",
    "CON",
    "..",
    "a/b",
    "a%2Fb",
    "report.",
    "case",
    "CASE",
  ];
  for (const id of ids)
    await transport.write(entry({ sessionId: "tenant/../one", threadId: id }));
  await transport.close();
  const files = await readdir(root, { recursive: true });
  const logs = files.filter((path) => path.endsWith(".log"));
  expect(logs).toHaveLength(ids.length);
  expect(new Set(logs.map((path) => path.toLowerCase())).size).toBe(ids.length);
  for (const path of logs) {
    expect(relative(root, join(root, path)).startsWith("..")).toBe(false);
    expect(path.split(/[\\/]/)).toHaveLength(3);
    const value = JSON.parse(
      (await readFile(join(root, path), "utf8")).trim(),
    ) as LogEntry;
    expect(ids).toContain(value.threadId);
  }
});

it("reports a failed file write without poisoning later writes", async () => {
  const root = await directory();
  await writeFile(
    join(root, "threads"),
    "This path is a file, not a directory.",
  );
  const transport = new FileTransport({
    path: join(root, "app.log"),
    groupBy: logGroup.thread,
  });
  await expect(
    transport.write(entry({ threadId: "blocked" })),
  ).rejects.toThrow();
  await transport.write(entry());
  await transport.close();
  expect(
    JSON.parse((await readFile(join(root, "app.log"), "utf8")).trim()),
  ).toEqual(entry());
});

it("validates transport configuration", () => {
  expect(() => new FileTransport({ path: " " })).toThrow();
  expect(() => new FileTransport({ path: "logs/" })).toThrow();
  expect(
    () => new FileTransport({
      path: "app.log",
      // @ts-expect-error Only the supported grouping options are accepted.
      groupBy: "user",
    }),
  ).toThrow();
  // @ts-expect-error level is a typed threshold.
  expect(() => new LoggerPlugin({ level: "verbose" })).toThrow();
  // @ts-expect-error Custom output is provided through LogTransport.
  const oldOptions: LoggerOptions = { write() {} };
  void oldOptions;
  expect(new LoggerPlugin()).not.toHaveProperty("write");
});

it("writes structured JSON to stderr through ConsoleTransport", () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    new ConsoleTransport().write(entry());
    expect(stderr).toHaveBeenCalledWith(JSON.stringify(entry()));
  } finally {
    stderr.mockRestore();
  }
});

it.each(["debug", "info", "warn", "error"] as const)(
  "filters before fan-out at level %s",
  async (level) => {
    const entries: LogEntry[] = [];
    const harness = await AgentHarness.create({
      modelScripts: [{ text: "ok" }, { error: Error("provider unavailable") }],
      plugins: [
        new LoggerPlugin({
          level,
          transports: [
            {
              write(value) {
                entries.push(value);
              },
            },
          ],
        }),
      ],
    });
    try {
      const result = await harness.agent.generate("hello", {
        model: harness.provider.ref,
      });
      expect(result.status).toBe("completed");
      await expect(
        harness.agent.generate("fail", { model: harness.provider.ref }),
      ).rejects.toThrow("provider unavailable");
      expect(
        entries.some(
          (value) => value.type === "model.error" && value.level === "error",
        ),
      ).toBe(true);
      const ranks = { debug: 0, info: 1, warn: 2, error: 3 };
      expect(entries.every((value) => ranks[value.level] >= ranks[level])).toBe(
        true,
      );
      if (level === "debug") {
        expect(entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "text.delta", level: "debug" }),
            expect.objectContaining({ type: "stream.end", level: "info" }),
          ]),
        );
      } else if (level === "info") {
        expect(entries.some((value) => value.type === "stream.end")).toBe(true);
        expect(entries.some((value) => value.type === "text.delta")).toBe(
          false,
        );
      } else {
        expect(entries.every((value) => value.level === "error")).toBe(true);
      }
    } finally {
      await harness.dispose();
    }
  },
);

it("fans out despite transport failures, reports diagnostics, and closes every transport", async () => {
  const entries: LogEntry[] = [];
  const closed: string[] = [];
  const transports: LogTransport[] = [
    {
      write() {
        throw Error("sink failed");
      },
      close() {
        closed.push("failed");
        throw Error("close failed");
      },
    },
    {
      write(value) {
        entries.push(value);
      },
      close() {
        closed.push("healthy");
      },
    },
  ];
  const harness = await AgentHarness.create({
    modelScripts: [{ text: "ok" }],
    plugins: [new LoggerPlugin({ transports })],
  });
  try {
    const result = await harness.agent.generate("hello", {
      model: harness.provider.ref,
    });
    expect(result.status).toBe("completed");
    expect(entries.some((value) => value.type === "stream.end")).toBe(true);
    expect(
      entries.some(
        (value) => value.type === "diagnostic" && value.level === "error",
      ),
    ).toBe(true);
    expect(entries.length).toBeLessThan(100);
  } finally {
    await harness.dispose();
  }
  expect(closed.sort()).toEqual(["failed", "healthy"]);
});

it("waits for outstanding Session notifications before Controller disposal closes transports", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let written = false,
    closed = false,
    disposed = false;
  const harness = await AgentHarness.create({
    plugins: [
      new LoggerPlugin({
        transports: [
          {
            async write(value) {
              if (value.type === "session.created") {
                await gate;
                written = true;
              }
            },
            close() {
              expect(written).toBe(true);
              closed = true;
            },
          },
        ],
      }),
    ],
  });
  try {
    await harness.controller.createSession({ model: harness.provider.ref });
    const disposal = harness.dispose().then(() => {
      disposed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(disposed).toBe(false);
    release();
    await disposal;
    expect(closed).toBe(true);
  } finally {
    release();
    await harness.dispose();
  }
});

it.each(["warn", "error"] as const)(
  "filters suspended execution warnings at level %s",
  async (level) => {
    const entries: LogEntry[] = [];
    const ask = createTool({
      name: "ask",
      description: "Wait for input",
      schema: z.object({}),
      execute: (_input, context) => context.suspend({ question: "Continue?" }),
    });
    const harness = await AgentHarness.create({
      tools: { ask },
      modelScripts: [
        {
          response: {
            message: MessageCodec.encode(
              new AssistantMessage([
                {
                  type: "tool-call",
                  toolCallId: "ask-call",
                  name: "ask",
                  arguments: {},
                },
              ]),
            ),
          },
        },
      ],
      plugins: [
        new LoggerPlugin({
          level,
          transports: [
            {
              write(value) {
                entries.push(value);
              },
            },
          ],
        }),
      ],
    });
    try {
      const result = await harness.agent.generate("Ask me", {
        model: harness.provider.ref,
      });
      expect(result.status).toBe("suspended");
      expect(
        entries.some(
          (value) =>
            value.type === "stream.suspended" && value.level === "warn",
        ),
      ).toBe(level === "warn");
    } finally {
      await harness.dispose();
    }
  },
);

it("groups events from multiple Session Threads and retains Session lifecycle in the root file", async () => {
  const root = await directory();
  const harness = await AgentHarness.create({
    modelScripts: [{ text: "one" }, { text: "two" }],
    plugins: [
      new LoggerPlugin({
        transports: [
          new FileTransport({
            path: join(root, "app.log"),
            groupBy: logGroup.session,
          }),
        ],
      }),
    ],
  });
  const session = await harness.controller.createSession({
    id: "chat-session",
    model: harness.provider.ref,
  });
  const finished = () =>
    new Promise<void>((resolve) => {
      const unsubscribe = session.subscribe("stream.end", () => {
        unsubscribe();
        resolve();
      });
    });
  try {
    for (const id of ["thread-one", "thread-two"]) {
      await session.thread.create({ id });
      const done = finished();
      await session.followUp("hello");
      await done;
    }
  } finally {
    await harness.dispose();
  }
  for (const id of ["thread-one", "thread-two"]) {
    const rows = (
      await readFile(
        join(root, "sessions", "chat-session", `${id}.log`),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as LogEntry);
    expect(
      rows.every(
        (value) => value.sessionId === "chat-session" && value.threadId === id,
      ),
    ).toBe(true);
    expect(rows.some((value) => value.type === "stream.end")).toBe(true);
  }
  const rows = (await readFile(join(root, "app.log"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as LogEntry);
  expect(rows.some((value) => value.type === "ready")).toBe(true);
  expect(
    rows.some(
      (value) =>
        value.type === "session.created" && value.sessionId === "chat-session",
    ),
  ).toBe(true);
});
