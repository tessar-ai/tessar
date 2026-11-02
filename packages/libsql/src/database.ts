import Libsql from "libsql";

export interface LibsqlStorageOptions {
    filename: string;
}

export type SQLInputValue = string | number | bigint | Uint8Array | null;

export function openDatabase(options: LibsqlStorageOptions): Libsql.Database {
    const db = new Libsql(options.filename);
    try {
        db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
        return db;
    } catch (error) {
        try { db.close(); } catch { /* Preserve the initialization error. */ }
        throw error;
    }
}
