import { expect, it, vi } from "vitest";
import Libsql from "libsql";
import { openDatabase } from "../src/database.js";

it("opens a connection with foreign keys and a busy timeout", () => {
  const db = openDatabase({ filename: ":memory:" });
  try {
    expect(db.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
    expect(db.prepare("PRAGMA busy_timeout").get()).toMatchObject({ timeout: 5000 });
  } finally {
    db.close();
  }
});

it("closes the connection and preserves the error when configuration fails", () => {
  const error = new Error("configuration failed");
  const exec = vi.spyOn(Libsql.prototype, "exec").mockImplementation(() => { throw error; });
  const close = vi.spyOn(Libsql.prototype, "close");
  try {
    expect(() => openDatabase({ filename: ":memory:" })).toThrow(error);
    expect(close).toHaveBeenCalledOnce();
  } finally {
    exec.mockRestore();
    close.mockRestore();
  }
});
