import { createContentBatch } from './content-batch.js';

export const SETUP_SCHEMA = 'CREATE TABLE IF NOT EXISTS yumunio_instance_settings (id INTEGER NOT NULL PRIMARY KEY, revision INTEGER NOT NULL, sealed TEXT NOT NULL)';
export const setupConflict = () => Object.assign(new Error('Instance settings changed.'), { code: 'SETUP_CONFLICT', status: 409 });

/** The settings row and initial owner are committed in one transaction, including on D1. */
export function createSetupStore(client) {
  const dialect = client.dialect, batch = createContentBatch(client);
  if (!batch) throw new Error('Setup requires atomic database writes.');
  const quote = name => (dialect === 'mysql' ? '`' : '"') + name + (dialect === 'mysql' ? '`' : '"');
  const sql = text => { let n = 0; return dialect === 'postgres' ? text.replace(/\?/g, () => '$' + ++n) : text; };
  const command = (text, params = []) => ({ sql: sql(text), params });
  const query = (text, params = []) => client.query(sql(text), params);
  const insert = (table, values) => command('INSERT INTO ' + table + ' (' + Object.keys(values).map(quote).join(',') + ') VALUES (' + Object.keys(values).map(() => '?').join(',') + ')', Object.values(values));
  return {
    async ensureSchema() { await query(SETUP_SCHEMA); },
    async read() { return (await query('SELECT revision, sealed FROM yumunio_instance_settings WHERE id = 1')).rows[0] ?? null; },
    async fresh() {
      // These tables are guaranteed by the installation schema. An existing instance
      // cannot gain a new administrator merely by setting a bootstrap key.
      for (const table of ['yumunio_users', 'yumunio_workspaces', 'yumunio_prototype_snapshots']) {
        if (Number((await query('SELECT COUNT(*) AS total FROM ' + table)).rows[0].total) !== 0) return false;
      }
      return true;
    },
    async initialize({ sealed, owner, passwordHash, workspaceName }) {
      const stamp = dialect === 'sqlite' ? Date.now() : new Date();
      const workspaceId = crypto.randomUUID();
      // A failed singleton insert or concurrent claim rolls back every identity row.
      const commands = [
        command('INSERT INTO yumunio_instance_settings(id, revision, sealed) SELECT 1, 1, CASE WHEN NOT EXISTS (SELECT 1 FROM yumunio_users) AND NOT EXISTS (SELECT 1 FROM yumunio_workspaces) AND NOT EXISTS (SELECT 1 FROM yumunio_prototype_snapshots) THEN ? ELSE NULL END', [sealed]),
        insert('yumunio_users', { id: owner.id, name: owner.name, email: owner.email, emailVerified: dialect === 'sqlite' ? 1 : true, createdAt: stamp, updatedAt: stamp }),
        insert('yumunio_auth_accounts', { id: crypto.randomUUID(), accountId: owner.id, providerId: 'credential', userId: owner.id, password: passwordHash, createdAt: stamp, updatedAt: stamp }),
        insert('yumunio_workspaces', { id: workspaceId, name: workspaceName, slug: 'workspace-' + workspaceId, createdAt: stamp }),
        insert('yumunio_memberships', { id: crypto.randomUUID(), organizationId: workspaceId, userId: owner.id, role: 'owner', createdAt: stamp })
      ];
      // NOT NULL and the singleton primary key enforce the guard inside D1's
      // atomic batch as well as the checked Node transaction.
      commands[0].expectChanges = 1;
      try { await batch(commands); } catch { throw setupConflict(); }
    },
    async update(revision, sealed) {
      const result = await query('UPDATE yumunio_instance_settings SET sealed = ?, revision = revision + 1 WHERE id = 1 AND revision = ?', [sealed, revision]);
      if (result.affectedRows !== 1) throw setupConflict();
    }
  };
}

export function createSqliteSetupStore(database) {
  const run = ({ sql, params = [] }) => {
    const statement = database.prepare(sql);
    return /^SELECT\b/.test(sql) ? { rows: statement.all(...params), affectedRows: 0 } : { rows: [], affectedRows: Number(statement.run(...params).changes) };
  };
  return createSetupStore({ dialect: 'sqlite', query: (sql, params) => run({ sql, params }), async batch(commands) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const results = commands.map(command => { const result = run(command); if (command.expectChanges !== undefined && result.affectedRows !== command.expectChanges) throw setupConflict(); return result; });
      database.exec('COMMIT'); return results;
    } catch (error) { database.exec('ROLLBACK'); throw error; }
  } });
}

export function createD1SetupStore(database) {
  return createSetupStore({ dialect: 'sqlite', async query(sql, params = []) {
    const result = await database.prepare(sql).bind(...params).all();
    return { rows: result.results, affectedRows: result.meta.changes };
  }, async batch(commands) {
    await database.batch(commands.map(command => database.prepare(command.sql).bind(...command.params)));
  } });
}
