import { expect, it, vi } from "vitest";
import type { StorageBackend } from "@tessar/core";
import { PluginHost } from "../../core/src/plugins/host.js";
const { open } = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("../src/backend.js", () => ({ createSqliteBackend: open }));
import { SqliteStoragePlugin } from "../src/index.js";

it("registers a backend whose connection is closed by plugin disposal", async () => {
  const close = vi.fn().mockResolvedValue(undefined);
  const backend = { close } as unknown as StorageBackend;
  open.mockResolvedValueOnce(backend);
  const host = new PluginHost();
  try {
    await host.initialize([new SqliteStoragePlugin({ filename: ":memory:" })]);
    expect(host.registrations()).toMatchObject([
      { kind: "storage", id: "primary", value: { close: expect.any(Function) } },
    ]);
    expect(close).not.toHaveBeenCalled();
  } finally {
    await host.dispose();
  }
  expect(close).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "closes a rejected backend without replacing the registration error (close rejects=%s)",
  async (rejectClose) => {
    const close = rejectClose
      ? vi.fn().mockRejectedValue(Error("close failed"))
      : vi.fn().mockResolvedValue(undefined);
    const existingClose = vi.fn().mockResolvedValue(undefined);
    open.mockResolvedValueOnce({ close });
    const host = new PluginHost();
    try {
      await host.initialize([
        {
          id: "existing",
          setup(tessar) {
            tessar.storage.register({
              close: existingClose,
            } as unknown as StorageBackend);
          },
        },
      ]);
      await expect(
        host.attach(new SqliteStoragePlugin({ filename: ":memory:" })),
      ).rejects.toMatchObject({ code: "RegistrationConflict" });
      expect(close).toHaveBeenCalledOnce();
      expect(existingClose).not.toHaveBeenCalled();
    } finally {
      await host.dispose();
    }
    expect(existingClose).toHaveBeenCalledOnce();
  },
);
