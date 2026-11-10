import { expect, test, vi } from "vitest";
import { AssistantMessage, MessageCodec } from "@tessar/core";
import { createTool } from "@tessar/core/tool";
import { AgentHarness } from "@tessar/core/testing";
import { z } from "zod";
import { EnvironmentContextPlugin } from "../../examples/plugins/environment-context.js";
import { ToolApprovalPlugin } from "../../examples/plugins/tool-approval.js";

test("environment context preserves instructions and refreshes time for each prepared request", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T00:00:00Z"));
  let h: AgentHarness | undefined;
  try {
    h = await AgentHarness.create({
      instructions: "Keep the original instruction.",
      plugins: [new EnvironmentContextPlugin()],
      modelScripts: [{ text: "First" }, { text: "Second" }],
    });
    await h.agent.generate("What environment are you running in?");
    const sections = h.provider.calls[0]!.instructions.sections;
    expect(sections).toContainEqual(expect.objectContaining({ content: "Keep the original instruction." }));
    const environment = sections.find(section => section.id === "environment-context")!.content;
    expect(environment).toContain("2026-11-10T00:00:00.000Z");
    expect(environment).toContain(process.platform);
    expect(environment).toContain(process.version);
    expect(environment).toContain(process.cwd());
    expect(environment).toMatch(/Time zone: \S+/);
    vi.setSystemTime(new Date("2026-11-10T01:00:00Z"));
    await h.agent.generate("What time is it now?");
    const refreshed = h.provider.calls[1]!.instructions.sections.filter(section => section.id === "environment-context");
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]!.content).toContain("2026-11-10T01:00:00.000Z");
    expect(environment).not.toContain("2026-11-10T01:00:00.000Z");
  } finally { await h?.dispose(); vi.useRealTimers(); }
});

test.each([true, false])("sensitive tool waits for a validated human decision (approved=%s)", async approved => {
  const send = vi.fn(() => "sent");
  const h = await AgentHarness.create({
    plugins: [new ToolApprovalPlugin(["send_email"])],
    tools: { send_email: createTool({ name: "send_email", description: "Send email", schema: z.object({ to: z.string() }), execute: send }) },
    modelScripts: [{ response: { message: MessageCodec.encode(new AssistantMessage([
      { type: "tool-call", name: "send_email", toolCallId: "send-1", arguments: { to: "person@example.test" } },
    ])) } }, { text: "Handled." }],
  });
  try {
    const pending = await h.agent.generate("Send an email");
    expect(pending.status).toBe("suspended");
    expect(pending.interrupt!.payload).toMatchObject({ toolName: "send_email", arguments: { to: "person@example.test" } });
    expect(send).not.toHaveBeenCalled();
    const target = { threadId: pending.threadId, interruptId: pending.interrupt!.id };
    await expect(h.collect(h.agent.resume({ ...target, value: { approved: "yes" } }))).rejects.toMatchObject({ code: "InvalidResumeResponse" });
    expect(send).not.toHaveBeenCalled();
    await h.collect(h.agent.resume({ ...target, value: { approved } }));
    expect(send).toHaveBeenCalledTimes(approved ? 1 : 0);
    expect(h.provider.calls).toHaveLength(2);
  } finally { await h.dispose(); }
});

