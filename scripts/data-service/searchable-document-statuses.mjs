/**
 * 可参与关键词检索的文档 status 白名单。
 * 必须与 services/knowledge/status.ts 的 SEARCHABLE_DOCUMENT_STATUSES 保持一致
 *（由 tests/knowledge/searchable-status-contract.test.ts 门禁）。
 */
export const SEARCHABLE_DOCUMENT_STATUSES = [
  "ready",
  "embedding",
  "indexed",
  "error",
];

/** SQL: column IN ('ready', 'embedding', 'indexed', 'error') */
export function sqlInSearchableStatuses(columnSql) {
  const list = SEARCHABLE_DOCUMENT_STATUSES.map((s) => `'${s}'`).join(", ");
  return `${columnSql} IN (${list})`;
}
