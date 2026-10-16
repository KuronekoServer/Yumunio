import { DomainError } from "@yumunio/domain";
import { SqlStore } from "./sql-store.js";

/** Internal D1 binding driver; batches are D1 transactions. */
class D1Driver {
  constructor(binding) { this.binding = binding; }
  async batch(commands) {
    const statements = commands.map(({ sql, params = [] }) => this.binding.prepare(sql).bind(...params));
    const results = await this.binding.batch(statements);
    if (!Array.isArray(results) || results.length !== commands.length || results.some(result => result.success === false)) {
      throw new DomainError("STORAGE_ERROR", "The database batch failed.");
    }
    return results.map(result => ({ rows: result.results ?? [], changes: Number(result.meta?.changes ?? 0) }));
  }
}

/**
 * WorkspaceStore over an existing D1Database binding. Apply schema.sql first.
 * Uses the primary binding directly, without replica Sessions or remote setup.
 * No Cloudflare resource, migration, account, HTTP endpoint, or auth is created.
 * @extends {SqlStore}
 */
export class D1Store extends SqlStore {
  /** @param {{prepare: Function, batch: Function}} binding @param {{now?: () => string, createId?: () => string}} [options] */
  constructor(binding, options = {}) {
    if (!binding || typeof binding.prepare !== "function" || typeof binding.batch !== "function") {
      throw new DomainError("INVALID_INPUT", "Expected a D1 database binding.");
    }
    super(new D1Driver(binding), options);
  }
}
