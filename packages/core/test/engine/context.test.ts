import { expect, it } from "vitest";
import { AgentHarness } from "../../src/testing/harness.js";
import { HumanMessage } from "../../src/messages/message.js";
import { MessageCodec } from "../../src/messages/codec.js";
import { context, type Plugin } from "../../src/index.js";
it("assembles the complete canonical history and ordered instruction sources", async () => {
  const harness = await AgentHarness.create({
    instructions: "agent rules",
    modelScripts: [{ text: "ok" }],
  });
  try {
    const thread = await harness.createThread({
      instructions: "thread rules",
      messages: Array.from({ length: 60 }, (_, i) =>
        MessageCodec.encode(new HumanMessage(String(i))),
      ),
    });
    await harness.collect(
      harness.admit({
        kind: "input",
        threadId: thread.id,
        input: [MessageCodec.encode(new HumanMessage("next"))],
        model: { providerId: "scripted", modelId: "test" },
      }),
    );
    expect(harness.provider.calls[0]!.messages).toHaveLength(61);
    expect(
      harness.provider.calls[0]!.instructions.sections.map((s) => s.content),
    ).toEqual(["agent rules", "thread rules"]);
  } finally {
    await harness.dispose();
  }
});

it("orders late plugin instruction contributions independently of registration order", async () => {
  const plugin = (id: string, order: number): Plugin => ({
    id,
    setup(tessar) {
      // A plugin can construct the public Instruction shape without using a helper.
      tessar.hook(context.prepare, (event) => ({
        ...event.payload,
        instructions: {
          sections: [
            ...event.payload.instructions.sections,
            { id, content: id, order },
          ],
        },
      }));
    },
  });
  for (const plugins of [
    [plugin("a", 100), plugin("z", 100)],
    [plugin("z", 100), plugin("a", 100)],
  ]) {
    const harness = await AgentHarness.create({
      instructions: "base",
      modelScripts: [{ text: "ok" }],
      plugins: [
        ...plugins,
        {
          id: "late",
          setup(tessar) {
            tessar.hook(context.prepare, (event) => ({
              ...event.payload,
              instructions: {
                sections: [
                  { id: "last", content: "changes", order: 1000 },
                  ...event.payload.instructions.sections,
                ],
              },
            }));
          },
        },
      ],
    });
    try {
      const thread = await harness.createThread();
      await harness.collect(
        harness.admit({
          kind: "input",
          threadId: thread.id,
          input: [MessageCodec.encode(new HumanMessage("question"))],
          model: harness.provider.ref,
        }),
      );
      expect(
        harness.provider.calls[0]!.instructions.sections.map(
          (section) => section.content,
        ),
      ).toEqual(["base", "a", "z", "changes"]);
    } finally {
      await harness.dispose();
    }
  }
});
