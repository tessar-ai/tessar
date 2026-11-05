import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TessarCLIError, CLI_ERROR_CODE } from "../errors.js";

export function runDev(cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-transform-types", fileURLToPath(new URL("../development/runner.js", import.meta.url))], {
      cwd, stdio: ["inherit", "inherit", "inherit", "ipc"], windowsHide: true,
    });
    const stop = () => { if (child.connected) child.send("shutdown", () => { }); };
    const message = (value: unknown) => { if (value === "shutdown") stop(); };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    process.on("message", message);
    const detach = () => { process.off("SIGINT", stop); process.off("SIGTERM", stop); process.off("message", message); };
    child.once("error", error => { detach(); reject(error); });
    child.once("exit", code => {
      detach();
      if (code === 0) resolve();
      else reject(new TessarCLIError(CLI_ERROR_CODE.INVALID_PROJECT, "Development server exited unsuccessfully"));
    });
  });
}
