import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { TypeSafe, TypeSafeAPIError } from "@tessar/typesafe";
import { TessarError, errorInfo } from "@tessar/core";
import { createSqliteBackend } from "@tessar/sqlite";

const directory = await mkdtemp(join(tmpdir(), "tessar-typesafe-"));
const filename = join(directory, "state.db");
const requests: Record<string, any>[] = [];
const exampleError: unknown = new TypeSafeAPIError(
  429,
  { detail: "busy" },
  "fixture-request",
);
assert.equal(TessarError.isInstance(exampleError), true);
assert.ok(TypeSafeAPIError.isInstance(exampleError));
assert.equal(exampleError.status, 429);
assert.equal(errorInfo(exampleError).source, "provider");
let serverFailure: unknown;
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/systemone");
    assert.equal(request.method, "POST");
    assert.equal(request.headers.authorization, "Bearer local-test-key");
    assert.equal(request.headers["content-type"], "application/json");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
    response.writeHead(200, { "content-type": "application/json" });
    if (body.state === "slow-body") {
      response.write('{"model":'); // Keep the body open; the client timeout must cover reading it.
      return;
    }
    response.end(
      JSON.stringify({
        model: body.model,
        answers: body.questions.allowed
          ? { allowed: { type: "noul", noul: 0.1 } }
          : {
              route: {
                type: "choice",
                choice: "billing",
                confidence: 0.9,
                probabilities: { billing: 0.9, engineering: 0.1 },
              },
            },
        usage: { input_tokens: 20, output_tokens: 5 },
      }),
    );
  } catch (error) {
    serverFailure = error;
    response.writeHead(500);
    response.end("Fixture assertion failed");
  }
});
await new Promise<void>((done, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", done);
});
const address = server.address();
assert.ok(address && typeof address === "object");
try {
  const backend = await createSqliteBackend({ filename });
  try {
    const client = new TypeSafe({
      apiKey: "local-test-key",
      baseURL: `http://127.0.0.1:${address.port}`,
      model: "jev-guard",
      maxRetries: 0,
      records: backend.records,
    });
    const guard = await client.generate(
      {
        state: {
          bash: "rm config.json",
          policy: "Do not delete configuration files",
        },
        questions: {
          allowed: {
            type: "noul",
            instructions: "Does this comply with policy?",
          },
        },
      },
      {
        id: "guard-1",
        scope: { userId: "u" },
        metadata: { toolExecutionId: "execution-1" },
      },
    );
    assert.equal(guard.answers.allowed.noul, 0.1);
    const router = await client.generate(
      {
        model: "jev-router",
        state: ["charged twice"],
        questions: {
          route: {
            type: "choice",
            criteria: { billing: "Payments", engineering: "Errors" },
          },
        },
      },
      { scope: { userId: "u" }, metadata: { task: "routing" } },
    );
    assert.equal(router.answers.route.choice, "billing");
    assert.equal(requests.length, 2);
    assert.equal(requests[0]!.model, "jev-guard");
    assert.equal(requests[1]!.model, "jev-router");
    assert.deepEqual(await backend.threads.list(), []);
    const shortTimeout = new TypeSafe({
      apiKey: "local-test-key",
      baseURL: `http://127.0.0.1:${address.port}`,
      model: "jev-test",
      timeout: 30,
      maxRetries: 0,
    });
    await assert.rejects(
      shortTimeout.generate({
        state: "slow-body",
        questions: { allowed: { type: "noul" } },
      }),
      (error: unknown) =>
        error instanceof Error &&
        ["TimeoutError", "AbortError"].includes(error.name),
    );
  } finally {
    await backend.close();
  }
  const reopened = await createSqliteBackend({ filename });
  try {
    const stored = await reopened.records.get("typesafe.calls", "guard-1", {
      scope: { userId: "u" },
    });
    assert.ok(stored);
    const data = stored.data as Record<string, any>;
    assert.deepEqual(data.metadata, { toolExecutionId: "execution-1" });
    assert.equal(data.status, "completed");
    assert.equal(data.attemptCount, 1);
    assert.equal(data.response.answers.allowed.noul, 0.1);
    assert.equal(
      await reopened.records.get("typesafe.calls", "guard-1", {
        scope: { userId: "other" },
      }),
      null,
    );
    assert.equal(
      (
        await reopened.records.list({
          namespace: "typesafe.calls",
          scope: { userId: "u" },
        })
      ).items.length,
      2,
    );
  } finally {
    await reopened.close();
  }
  if (serverFailure) throw serverFailure;
} finally {
  server.closeAllConnections();
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
