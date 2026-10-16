import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { DomainError } from "@yumunio/domain";
import { SqlStore } from "./sql-store.js";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

/** Internal synchronous SQLite driver with atomic batches. */
class SqliteDriver {
  constructor(filename, timeout) {
    this.database = new DatabaseSync(filename, { timeout, enableForeignKeyConstraints: true });
    try {
      this.database.exec("BEGIN IMMEDIATE");
      this.database.exec(schema);
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      this.database.close();
      throw error;
    }
  }

  async batch(commands) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = commands.map(({ sql, params = [], write = false }) => {
        const statement = this.database.prepare(sql);
        if (write) return { rows: [], changes: Number(statement.run(...params).changes) };
        return { rows: statement.all(...params), changes: 0 };
      });
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close() { this.database.close(); }
}

/**
 * File-backed WorkspaceStore for a trusted Node caller. No HTTP/auth is exposed.
 * The parent directory must already exist. The constructor applies schema v1.
 * @extends {SqlStore}
 */
export class SqliteStore extends SqlStore {
  #driver;
  /** @param {string} filename @param {{now?: () => string, createId?: () => string, timeout?: number}} [options] */
  constructor(filename, { timeout = 5000, ...options } = {}) {
    if (typeof filename !== "string" || !filename || !Number.isInteger(timeout) || timeout < 0 || timeout > 60000) {
      throw new DomainError("INVALID_INPUT", "Expected a database filename and timeout from 0 to 60000 ms.");
    }
    const driver = new SqliteDriver(filename, timeout);
    try { super(driver, options); } catch (error) { driver.close(); throw error; }
    this.#driver = driver;
  }
  close() { this.#driver.close(); }
}
