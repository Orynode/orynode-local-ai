/**
 * SQLite schema migration runner（Phase 0 基础设施）
 *
 * - 显式 schema_migrations 表记录已应用版本
 * - 每条迁移在事务中执行
 * - baseline 迁移必须幂等（CREATE IF NOT EXISTS + ensureColumn）
 */

/**
 * @typedef {{ id: string, up: (database: import("node:sqlite").DatabaseSync) => void }} Migration
 */

/**
 * @param {import("node:sqlite").DatabaseSync} database
 * @param {string} table
 */
export function tableExists(database, table) {
  const row = database
    .prepare(
      `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`,
    )
    .get(table);
  return Boolean(row?.ok);
}

/**
 * @param {string} ident
 */
function quoteIdent(ident) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) {
    throw new Error(`非法标识符: ${ident}`);
  }
  return ident;
}

/**
 * @param {import("node:sqlite").DatabaseSync} database
 * @param {string} table
 */
export function listColumns(database, table) {
  const rows = database.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
  return new Set(rows.map((row) => String(row.name)));
}

/**
 * @param {import("node:sqlite").DatabaseSync} database
 * @param {string} table
 * @param {string} column
 * @param {string} definition SQL 类型与约束片段
 */
export function ensureColumn(database, table, column, definition) {
  const columns = listColumns(database, table);
  if (columns.has(column)) return false;
  database.exec(
    `ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${quoteIdent(column)} ${definition}`,
  );
  return true;
}

/**
 * @param {import("node:sqlite").DatabaseSync} database
 */
export function ensureMigrationsTable(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
}

/**
 * @param {import("node:sqlite").DatabaseSync} database
 * @returns {Set<string>}
 */
export function getAppliedMigrations(database) {
  ensureMigrationsTable(database);
  const rows = database
    .prepare(`SELECT id FROM schema_migrations ORDER BY id ASC`)
    .all();
  return new Set(rows.map((row) => String(row.id)));
}

/**
 * @param {import("node:sqlite").DatabaseSync} database
 * @param {string} id
 */
export function stampMigration(database, id) {
  database
    .prepare(
      `INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(id, new Date().toISOString());
}

/**
 * @param {import("node:sqlite").DatabaseSync} database
 * @param {Migration[]} migrations
 * @returns {{ applied: string[], skipped: string[] }}
 */
export function runMigrations(database, migrations) {
  ensureMigrationsTable(database);
  const appliedSet = getAppliedMigrations(database);
  const newlyApplied = [];
  const skipped = [];

  for (const migration of migrations) {
    if (appliedSet.has(migration.id)) {
      skipped.push(migration.id);
      continue;
    }
    database.exec("BEGIN");
    try {
      migration.up(database);
      stampMigration(database, migration.id);
      database.exec("COMMIT");
      appliedSet.add(migration.id);
      newlyApplied.push(migration.id);
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  return { applied: newlyApplied, skipped };
}
