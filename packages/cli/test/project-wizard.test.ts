import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { ProjectWizard } from "../src/scaffolding/project-wizard.js";

async function choose(answers: string) {
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += chunk.toString(); });
  const selection = await new ProjectWizard(Readable.from([answers]), output).run("sample");
  return { selection, text };
}

describe("project wizard", () => {
  it("skips Session and storage for an Agent-only project", async () => {
    const { selection, text } = await choose("n\ny\n");
    expect(selection).toEqual({ controller: false, session: false, backend: "memory" });
    expect(text).not.toContain("Use Session?");
    expect(text).not.toContain("Storage backend?");
    expect(text).toContain("Agent");
  });
  it.each(["memory", "libsql", "postgresql", "mongodb"])("selects Controller, Session and %s", async (backend) => {
    const number = ["memory", "libsql", "postgresql", "mongodb"].indexOf(backend) + 1;
    const { selection, text } = await choose(`y\ny\n${number}\ny\n`);
    expect(selection).toEqual({ controller: true, session: true, backend });
    expect(text).toContain("Session");
    expect(text.toLowerCase()).toContain(backend);
  });
  it("allows Controller without Session and retries invalid answers", async () => {
    const { selection, text } = await choose("invalid\ny\nn\n0\n5\n2\ny\n");
    expect(selection).toEqual({ controller: true, session: false, backend: "libsql" });
    expect(text).toContain("Enter");
  });
  it.each(["", "y\n", "y\ny\n", "y\ny\n1\n", "n\nn\n", "cancel\n", "\u0003\n"])("cancels without complete confirmed answers %j", async (answers) => {
    expect((await choose(answers)).selection).toBeNull();
  });
  it("cancels on terminal SIGINT", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
    const wizard = new ProjectWizard(input, output);
    const result = wizard.run("sample");
    input.write("\u0003");
    expect(await result).toBeNull();
  });
});
