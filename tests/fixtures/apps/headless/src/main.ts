import { stream as streamHooks } from "@tessar/core";
import {
  Agent,
  Controller,
  HumanMessage,
  type Plugin,
  type PluginContext,
} from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";

const provider = new ScriptedProvider([
  { text: "fixture answer" },
  { text: "stream answer" },
  { text: "session answer" },
]);
class FixturePlugin implements Plugin {
  readonly id = "fixture";
  setup(tessar: PluginContext): void {
    tessar.models.register({
      id: "scripted",
      create: () => provider,
    });
  }
}

const agent = new Agent({
  id: "headless",
  model: { providerId: "scripted", modelId: "test" },
});
const controller = new Controller({
  id: "headless-runtime",
  agent,
  plugins: [new FixturePlugin()],
});
await controller.initialize();
try {
  const result = await agent.generate(new HumanMessage("hello"));
  for await (const event of agent.stream(new HumanMessage("stream"))) {
    if (event.type === streamHooks.error)
      throw Error(event.payload.error.message);
  }
  const session = await controller.createSession({
    scope: { userId: "example" },
  });
  await session.thread.create();
  const done = new Promise<void>((resolve, reject) =>
    session.subscribe((event) => {
      if (event.type === streamHooks.end) resolve();
      if (event.type === streamHooks.error)
        reject(Error(event.payload.error.message));
    }),
  );
  await session.followUp("hello from an application");
  await done;
  console.log(
    JSON.stringify({
      status: result.status,
      output: result.output
        .flatMap((message) => message.content)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(""),
    }),
  );
} finally {
  await controller.dispose();
}
