import { mkdtemp, readFile, mkdir, writeFile, symlink, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TessarCLI } from "../src/cli.js";
import type { ScaffoldMetadata } from "../src/templates.js";
import { defaultProjectOptions } from "../src/project-options.js";
import { TessarError } from "@tessar/core";

const metadata: ScaffoldMetadata = {
  coreVersion: "0.1.5", openaiVersion: "0.1.4", zodVersion: "^4.6.7",
  typescriptVersion: "7.0.2", nodeTypesVersion: "^24.0.0",
  hooks: { "context.prepare": "transformation", "tool.before": "decision" },
  backendVersions: { libsql: "0.1.0", postgresql: "0.1.0", mongodb: "0.1.0" },
  driverVersions: { libsql: "0.5.29", pg: "^8.16.3", mongodb: "^6.21.0", pgTypes: "^8.15.5" },
};
const temporaryDirectories: string[] = [];
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "tessar-cli-"));
  temporaryDirectories.push(cwd);
  const output: string[] = [];
  const cli = new TessarCLI(cwd, metadata, "0.1.0", (line) => output.push(line), async () => ({ ...defaultProjectOptions }));
  return { cwd, cli, output };
}
describe("CLI scaffolding", () => {
  it("uses a CLI-specific TessarError for its own validation failures", async () => {
    const { cli } = await fixture();
    const error = await cli.run(["new", "../escape"]).catch(error => error);
    expect(error).toBeInstanceOf(TessarError);
    expect(error).toMatchObject({ name: "TessarCLIError", code: "InvalidName", source: "tessar" });
    const command = await cli.run(["unknown"]).catch(error => error);
    expect(command).toMatchObject({ name: "TessarCLIError", code: "InvalidArguments" });
  });

  it("preserves native filesystem failures when a generated file already exists", async () => {
    const { cwd, cli } = await fixture();
    await writeFile(join(cwd, "package.json"), "{}");
    await cli.run(["g", "agent", "helper"]);
    const error = await cli.run(["g", "agent", "helper"]).catch(error => error);
    expect(error.code).toBe("EEXIST");
    expect(error).not.toBeInstanceOf(TessarError);
  });
  it("does not write files until confirmed, and cancellation leaves nothing", async () => {
    const { cwd } = await fixture();
    const cli = new TessarCLI(cwd, metadata, "0.1.0", () => {}, async () => {
      expect(await readdir(cwd)).toEqual([]);
      return null;
    });
    await cli.run(["new", "cancelled"]);
    expect(await readdir(cwd)).toEqual([]);
  });
  it("rejects existing targets before prompting", async () => {
    const { cwd } = await fixture();
    await mkdir(join(cwd, "existing"));
    let prompted = false;
    const cli = new TessarCLI(cwd, metadata, "0.1.0", () => {}, async () => {
      prompted = true;
      return { ...defaultProjectOptions };
    });
    await expect(cli.run(["new", "existing"])).rejects.toThrow(/already exists/);
    expect(prompted).toBe(false);
  });
  it("creates a runnable project without replacing an existing target", async () => {
    const { cwd, cli } = await fixture();
    await cli.run(["new", "sample"]);
    expect(JSON.parse(await readFile(join(cwd, "sample/package.json"), "utf8")).name).toBe("sample");
    await expect(cli.run(["new", "sample"])).rejects.toThrow();
  });
  it("supports g and generate and preserves existing files", async () => {
    const { cwd, cli } = await fixture();
    await writeFile(join(cwd, "package.json"), "{}");
    await cli.run(["g", "agent", "helper"]);
    const path = join(cwd, "src/agents/helper.ts");
    const before = await readFile(path, "utf8");
    await expect(cli.run(["generate", "agent", "helper"])).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(before);
    await cli.run(["generate", "controller", "main"]);
    await cli.run(["g", "session", "chat"]);
    const sessionPath = join(cwd, "src/sessions/chat.ts");
    const session = await readFile(sessionPath, "utf8");
    await expect(cli.run(["generate", "session", "chat"])).rejects.toThrow();
    expect(await readFile(sessionPath, "utf8")).toBe(session);
  });
  it.each([
    ["new", "../escape"], ["new", "CON"], ["new", "node_modules"],
    ["new", "sample", "extra"], ["new", "sample", "--force"],
    ["g", "unknown", "sample"], ["g", "agent", "../escape"],
    ["g", "agent", "sample", "--type", "hook"],
    ["g", "session", "sample", "--event", "session.created"],
    ["g", "plugin", "sample", "--type", "hook", "--event", "invalid"],
  ])("rejects invalid arguments %j", async (...args) => {
    const { cli } = await fixture();
    await expect(cli.run(args)).rejects.toThrow();
  });
  it("requires a project for generators", async () => {
    const { cli } = await fixture();
    await expect(cli.run(["g", "tool", "lookup"])).rejects.toThrow(/package.json/);
  });
  it("rejects directories redirected outside the project", async () => {
    const { cwd, cli } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "tessar-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(join(cwd, "package.json"), "{}");
    await mkdir(join(cwd, "src"));
    await symlink(outside, join(cwd, "src/agents"), "junction");
    await expect(cli.run(["g", "agent", "helper"])).rejects.toThrow(/outside/);
  });
  it("prints help and version without creating files", async () => {
    const { cli, output } = await fixture();
    await cli.run(["--help"]);
    await cli.run(["--version"]);
    expect(output.join("\n")).toContain("tool");
    expect(output.at(-1)).toBe("0.1.0");
  });
});
