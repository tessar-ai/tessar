import { expect, it, vi } from "vitest";
import Libsql from "libsql";
import { openDatabase } from "../src/database.js";

it("opens a connection with foreign keys and preserves driver timeout", () => {
  const connection = new Libsql(":memory:");
  const db = openDatabase({ database: connection });
  try {
    expect(db.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
    expect(db.prepare("PRAGMA busy_timeout").get()).toMatchObject({ timeout: 0 });
  } finally {
    connection.close();
  }
});

it("keeps the borrowed connection and preserves the error when configuration fails", () => {
  const connection = new Libsql(":memory:");
  const error = new Error("configuration failed");
  const exec = vi.spyOn(Libsql.prototype, "exec").mockImplementation(() => { throw error; });
  const close = vi.spyOn(Libsql.prototype, "close");
  try {
    expect(() => openDatabase({ database: connection })).toThrow(error);
    expect(close).not.toHaveBeenCalled();
  } finally {
    exec.mockRestore();
    close.mockRestore();
    connection.close();
  }
});
