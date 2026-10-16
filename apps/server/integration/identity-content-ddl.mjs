/** Narrow DDL preparation for a newly owned, empty identity integration database. */
export const CONTENT_TEST_TABLES = Object.freeze([
  'yumunio_account_content', 'yumunio_content_chunks', 'yumunio_content_guards',
]);

export function assertEmptyIdentityTestDatabase(result) {
  if (!result || !Array.isArray(result.rows) || result.rows.length !== 0) {
    throw new Error('Refusing identity fixture setup: the dedicated test database must have no preexisting tables.');
  }
}

/** Validate the whole current schema before issuing any SQL; never adopt an existing table. */
export function planIdentityContentTestDdl(source, dialect) {
  const invalid = () => new Error('Identity content fixture requires exactly the three allowlisted content CREATE TABLE statements.');
  if (!['mysql', 'postgres'].includes(dialect) || typeof source !== 'string' || source.length > 20000) throw invalid();
  const statements = source.replace(/^\s*--[^\r\n]*$/gm, '').split(';').map(part => part.trim()).filter(Boolean);
  if (statements.length !== CONTENT_TEST_TABLES.length) throw invalid();
  const seen = new Set();
  const plan = statements.map(statement => {
    const match = /^CREATE TABLE IF NOT EXISTS ([a-z0-9_]+)\s*\(/i.exec(statement);
    const table = match?.[1];
    const ending = dialect === 'mysql' ? /\) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin$/i : /\)$/;
    if (!CONTENT_TEST_TABLES.includes(table) || seen.has(table) || !ending.test(statement) || /--|\/\*|\*\//.test(statement)) throw invalid();
    seen.add(table);
    return Object.freeze({table, statement: statement.replace(/^CREATE TABLE IF NOT EXISTS /i, 'CREATE TABLE ')});
  });
  if (seen.size !== CONTENT_TEST_TABLES.length) throw invalid();
  return Object.freeze(plan);
}

/** A failed/unknown CREATE is deliberately not recorded as owned and must not be dropped. */
export async function createOwnedIdentityContentTables(client, source, dialect, created) {
  const plan = planIdentityContentTestDdl(source, dialect);
  if (!client || typeof client.query !== 'function' || !Array.isArray(created) || plan.some(({table}) => created.includes(table))) {
    throw new Error('Invalid identity content fixture ownership.');
  }
  for (const {table, statement} of plan) {
    await client.query(statement);
    created.push(table);
  }
}
