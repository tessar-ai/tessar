import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMemoryBackend, type RecordStore } from "@tessar/core";
import {
  TypeSafe,
  TypeSafeAPIError,
  TypeSafeResponseError,
} from "../src/index.js";

const request = {
  state: { text: "hello" },
  questions: { allowed: { type: "noul" as const, instructions: "Allowed?" } },
};
const response = {
  model: "jev-resolved",
  answers: { allowed: { type: "noul", noul: 0.95 } },
  usage: { input_tokens: 12, output_tokens: 3 },
};
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  vi.stubEnv("TYPESAFE_API_KEY", "test-key");
  vi.stubEnv("TYPESAFE_BASE_URL", "https://typesafe.invalid");
  fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const client = (options = {}) =>
  new TypeSafe({ model: "jev-latest", ...options });

it("sends native context/questions and keeps record options outside the HTTP payload", async () => {
  const backend = createMemoryBackend();
  try {
    const api = client({ records: backend.records });
    const result = await api.generate(request, {
      id: "call-1",
      scope: { userId: "u" },
      metadata: { threadId: "thread", policy: "v1" },
    });
    expect(result).toEqual(response);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://typesafe.invalid/v1/systemone");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer test-key",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "jev-latest",
      ...request,
    });
    const record = await backend.records.get("typesafe.calls", "call-1", {
      scope: { userId: "u" },
    });
    expect(record?.data).toMatchObject({
      request: { model: "jev-latest", ...request },
      response,
      metadata: { threadId: "thread", policy: "v1" },
      status: "completed",
      attemptCount: 1,
    });
    expect(JSON.stringify(record)).not.toContain("test-key");
    expect(await backend.threads.list()).toEqual([]);
  } finally {
    await backend.close();
  }
});

it("uses a single instance concurrently for different purposes without changing its model", async () => {
  fetcher.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return Response.json({
      model: body.model,
      answers: body.questions.allowed
        ? response.answers
        : {
            route: {
              type: "choice",
              choice: "billing",
              confidence: 0.9,
              probabilities: { billing: 0.9, engineering: 0.1 },
            },
          },
      usage: response.usage,
    });
  });
  const api = client();
  const [guard, router] = await Promise.all([
    api.generate({ ...request, model: "different" }),
    api.generate({
      state: ["charged twice"],
      questions: {
        route: {
          type: "choice",
          criteria: { billing: "Payments", engineering: "Errors" },
        },
      },
    }),
  ]);
  expect(guard.model).toBe("different");
  expect(router.model).toBe("jev-latest");
  expect(router.answers.route.choice).toBe("billing");
});

it("supports object/array/text state and mixed native question answers including inline images", async () => {
  const questions = {
    allowed: { type: "noul" as const },
    urgency: { type: "score" as const, criteria: ["Low", "High"] },
    region: { type: "box" as const, instructions: "Locate the object" },
  };
  const mixed = {
    ...response,
    answers: {
      ...response.answers,
      urgency: {
        type: "score",
        score: 0.7,
        confidence: 0.8,
        legend: { 0: "Low", 1: "High" },
        probabilities: { 0: 0.3, 1: 0.7 },
      },
      region: {
        type: "box",
        box: { top: 0.1, bottom: 0.8, left: 0.2, right: 0.9 },
        confidence: null,
      },
    },
  };
  fetcher.mockImplementation(async () => Response.json(mixed));
  const api = client({ headers: { "TypeSafe-Danger-Zone-Images": "true" } });
  for (const state of ["photo", { image: "photo" }, ["photo"]])
    expect(
      await api.generate({
        state,
        questions,
        assets: {
          photo: { type: "image", format: "png", data_base64: "aW1hZ2U=" },
        },
      }),
    ).toEqual(mixed);
  expect(
    new Headers(fetcher.mock.calls[0]![1]?.headers).get(
      "TypeSafe-Danger-Zone-Images",
    ),
  ).toBe("true");
});

it("validates configuration and requires state/questions on every call", async () => {
  expect(() => client({ timeout: 0 })).toThrow();
  expect(() => client({ maxRetries: -1 })).toThrow();
  vi.stubEnv("TYPESAFE_API_KEY", "");
  expect(() => client()).toThrow();
  const api = client({
    apiKey: "explicit",
    baseURL: "https://custom.invalid/prefix/",
  });
  await expect(
    api.generate({ state: "x", questions: {} }),
  ).rejects.toMatchObject({ code: "InvalidConfiguration" });
  await expect(
    api.generate({ ...request, state: Number.NaN } as any),
  ).rejects.toThrow();
  await expect(
    api.generate({ ...request, state: null } as any),
  ).rejects.toThrow();
  await expect(
    api.generate({
      ...request,
      questions: { bad: { type: "choice", criteria: {} } },
    }),
  ).rejects.toThrow();
  await expect(
    new TypeSafe({ apiKey: "key" }).generate(request),
  ).rejects.toMatchObject({ code: "InvalidConfiguration" });
  expect(fetcher).not.toHaveBeenCalled();
  await api.generate(request);
  expect(String(fetcher.mock.calls[0]![0])).toBe(
    "https://custom.invalid/prefix/v1/systemone",
  );
});

it("retries HTTP overloads and retains one logical-call record", async () => {
  fetcher
    .mockResolvedValueOnce(
      new Response("busy", { status: 429, headers: { "retry-after": "0" } }),
    )
    .mockResolvedValueOnce(
      new Response("busy", { status: 503, headers: { "retry-after-ms": "0" } }),
    )
    .mockResolvedValueOnce(Response.json(response));
  const backend = createMemoryBackend();
  try {
    await client({ records: backend.records }).generate(request);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const rows = await backend.records.list({ namespace: "typesafe.calls" });
    expect(rows.items).toHaveLength(1);
    expect(rows.items[0]?.data).toMatchObject({
      status: "completed",
      attemptCount: 3,
    });
  } finally {
    await backend.close();
  }
});

it("defaults to three retries and preserves final HTTP details", async () => {
  fetcher.mockImplementation(
    async () =>
      new Response('{"detail":"overloaded"}', {
        status: 503,
        headers: { "retry-after": "0", "x-request-id": "provider-id" },
      }),
  );
  const result = client().generate(request);
  await expect(result).rejects.toBeInstanceOf(TypeSafeAPIError);
  await expect(result).rejects.toMatchObject({
    status: 503,
    body: { detail: "overloaded" },
    requestId: "provider-id",
  });
  expect(fetcher).toHaveBeenCalledTimes(4);
});

it("never retries client HTTP errors and saves their details", async () => {
  fetcher.mockResolvedValue(
    new Response('{"detail":"invalid"}', { status: 422 }),
  );
  const backend = createMemoryBackend();
  try {
    await expect(
      client({ records: backend.records }).generate(request, { id: "bad" }),
    ).rejects.toMatchObject({ status: 422 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      (await backend.records.get("typesafe.calls", "bad"))?.data,
    ).toMatchObject({
      status: "failed",
      response: null,
      error: {
        source: "provider",
        details: { status: 422, body: { detail: "invalid" }, requestId: null },
      },
    });
    const data = (await backend.records.get("typesafe.calls", "bad"))?.data;
    for (const field of ["status", "body", "requestId"])
      expect(data).not.toHaveProperty("error." + field);
  } finally {
    await backend.close();
  }
});

it.each([
  { ...response, answers: {} },
  { ...response, answers: { allowed: { type: "noul", noul: 2 } } },
  {
    ...response,
    answers: { allowed: { type: "box", box: {}, confidence: null } },
  },
  { ...response, usage: { input_tokens: -1, output_tokens: 3 } },
])(
  "rejects malformed successful responses without retrying",
  async (invalid) => {
    fetcher.mockImplementation(async () => Response.json(invalid));
    await expect(client().generate(request)).rejects.toBeInstanceOf(
      TypeSafeResponseError,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

it("retries timeouts and honors maxRetries zero for network failures", async () => {
  fetcher.mockImplementation(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener(
          "abort",
          () => reject(init!.signal!.reason),
          { once: true },
        );
      }),
  );
  await expect(
    client({ timeout: 5, maxRetries: 1 }).generate(request),
  ).rejects.toMatchObject({ name: "TimeoutError" });
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockReset().mockRejectedValue(new TypeError("connection lost"));
  await expect(client({ maxRetries: 0 }).generate(request)).rejects.toThrow(
    "connection lost",
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("cancels retry waits and preserves the caller's abort reason", async () => {
  const controller = new AbortController();
  const reason = Error("User cancelled");
  fetcher.mockImplementation(async () => {
    setTimeout(() => controller.abort(reason), 5);
    return new Response("busy", {
      status: 429,
      headers: { "retry-after": "60" },
    });
  });
  await expect(
    client().generate(request, { signal: controller.signal }),
  ).rejects.toBe(reason);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("snapshots per-call state and metadata before asynchronous work", async () => {
  const backend = createMemoryBackend();
  const state = { text: "original" },
    metadata = { threadId: "original" };
  try {
    const pending = client({ records: backend.records }).generate(
      { ...request, state },
      { id: "snapshot", metadata },
    );
    state.text = "changed";
    metadata.threadId = "changed";
    await pending;
    expect(
      (await backend.records.get("typesafe.calls", "snapshot"))?.data,
    ).toMatchObject({
      request: { state: { text: "original" } },
      metadata: { threadId: "original" },
    });
  } finally {
    await backend.close();
  }
});

it("validates the response against the questions captured when the call started", async () => {
  const criteria = { billing: "Payments", engineering: "Errors" };
  fetcher.mockResolvedValue(
    Response.json({
      ...response,
      answers: {
        route: {
          type: "choice",
          choice: "billing",
          confidence: 0.9,
          probabilities: { billing: 0.9, engineering: 0.1 },
        },
      },
    }),
  );
  const pending = client().generate({
    state: "charged twice",
    questions: { route: { type: "choice", criteria } },
  });
  Reflect.deleteProperty(criteria, "billing");
  await expect(pending).resolves.toMatchObject({
    answers: { route: { choice: "billing" } },
  });
});

it.each([{}, { unrelated: 1 }])(
  "rejects choice answers missing the requested probability keys",
  async (probabilities) => {
    fetcher.mockResolvedValue(
      Response.json({
        ...response,
        answers: {
          route: {
            type: "choice",
            choice: "billing",
            confidence: 0.9,
            probabilities,
          },
        },
      }),
    );
    await expect(
      client().generate({
        state: "charged twice",
        questions: {
          route: {
            type: "choice",
            criteria: { billing: "Payments", engineering: "Errors" },
          },
        },
      }),
    ).rejects.toBeInstanceOf(TypeSafeResponseError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

it("persists an already-cancelled call without making an HTTP attempt", async () => {
  const backend = createMemoryBackend();
  const reason = Error("No longer needed");
  try {
    await expect(
      client({ records: backend.records }).generate(request, {
        id: "cancelled",
        signal: AbortSignal.abort(reason),
      }),
    ).rejects.toBe(reason);
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      (await backend.records.get("typesafe.calls", "cancelled"))?.data,
    ).toMatchObject({
      status: "cancelled",
      attemptCount: 0,
      response: null,
      error: { message: "No longer needed", source: "application" },
    });
  } finally {
    await backend.close();
  }
});

it("keeps raw malformed-success data in the failure record without retry", async () => {
  const backend = createMemoryBackend();
  fetcher.mockResolvedValue(new Response("invalid JSON", { status: 200 }));
  try {
    await expect(
      client({ records: backend.records }).generate(request, {
        id: "malformed",
      }),
    ).rejects.toBeInstanceOf(TypeSafeResponseError);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      (await backend.records.get("typesafe.calls", "malformed"))?.data,
    ).toMatchObject({
      status: "failed",
      error: {
        name: "TypeSafeResponseError",
        details: { body: "invalid JSON" },
      },
    });
    expect((await backend.records.get("typesafe.calls", "malformed"))?.data)
      .not.toHaveProperty("error.body");
  } finally {
    await backend.close();
  }
});

it("does not retry the provider on storage failure and retains both errors when needed", async () => {
  const backend = createMemoryBackend();
  const storageError = Error("DB unavailable");
  const records: RecordStore = {
    ...backend.records,
    append: async () => {
      throw storageError;
    },
  };
  try {
    await expect(client({ records }).generate(request)).rejects.toBe(
      storageError,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher
      .mockReset()
      .mockResolvedValue(new Response("forbidden", { status: 403 }));
    const failed = client({ records }).generate(request);
    await expect(failed).rejects.toBeInstanceOf(AggregateError);
    await expect(failed).rejects.toMatchObject({
      errors: [expect.any(TypeSafeAPIError), storageError],
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    await backend.close();
  }
});
