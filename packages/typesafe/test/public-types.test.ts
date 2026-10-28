import { it } from "vitest";
import { TypeSafe, TypeSafeAPIError, TypeSafeResponseError } from "../src/index.js";
import { TessarError } from "@tessar/core";

it("infers named answers and choice labels without exposing legacy APIs", async () => {
  if (false) {
    const client = new TypeSafe({ apiKey: "key", model: "jev-latest" });
    const result = await client.generate({
      state: { message: "charged twice" },
      questions: {
        route: {
          type: "choice",
          criteria: { billing: "Payments", engineering: "Errors" },
        },
        allowed: { type: "noul", instructions: "Allowed?" },
      },
    });
    const route: "billing" | "engineering" = result.answers.route.choice;
    const probability: number = result.answers.allowed.noul;
    void [route, probability];
    // @ts-expect-error generate always requires state and questions
    await client.generate("message");
    await client.generate({
      // @ts-expect-error state is not a boolean
      state: false,
      questions: { allowed: { type: "noul" } },
    });
    // @ts-expect-error questions do not belong in the constructor
    new TypeSafe({ questions: { allowed: { type: "noul" } } });
    await client.generate({
      state: "x",
      questions: { allowed: { type: "noul" } },
      // @ts-expect-error local metadata belongs in the second argument
      metadata: {},
    });
    // @ts-expect-error no systemOne compatibility alias
    client.systemOne;
    // @ts-expect-error no unrequested question key
    result.answers.other;
    // @ts-expect-error noul answers do not have choice fields
    result.answers.allowed.choice;
  }
});

it("narrows unknown errors to the concrete class through the inherited guard", () => {
  const inspect = (failure: unknown) => {
    if (TypeSafeAPIError.isInstance(failure)) {
      const status: number = failure.status;
      const requestId: string | null = failure.requestId;
      void [status, requestId];
      // @ts-expect-error concrete guard does not add fields from another error class
      failure.operation;
    }
    if (TypeSafeResponseError.isInstance(failure)) {
      const body: string = failure.body;
      void body;
      // @ts-expect-error malformed response errors have no HTTP status
      failure.status;
    }
    if (TessarError.isInstance(failure)) {
      const code: string = failure.code;
      void code;
      // @ts-expect-error the shared base does not promise provider-specific fields
      failure.status;
    }
  };
  inspect(new TypeSafeAPIError(429, {}, null));
  inspect(new TypeSafeResponseError("Invalid", "body"));
  inspect(new TessarError("InvalidData", "Bad"));
});
