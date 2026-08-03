/**
 * 006_source_search_visibility — Source 活动文档与检索隔离（KE-P0-02 expand）
 *
 * tombstone / 被新 document 取代的旧 document 写入排除表，
 * 默认 FTS / vector / chunk query 跳过；Citation 仍可按 id 打开历史片段。
 */

export const id = "006_source_search_visibility";

/** @param {import("node:sqlite").DatabaseSync} database */
export function up(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS library_search_exclusions (
      document_id TEXT PRIMARY KEY,
      reason TEXT NOT NULL
        CHECK (reason IN ('source_tombstone', 'source_superseded')),
      source_item_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_library_search_exclusions_reason
      ON library_search_exclusions(reason);
  `);

  // 回填：当前 tombstone 且无其他活动 SourceItem 引用的文档
  database.exec(`
    INSERT OR IGNORE INTO library_search_exclusions (
      document_id, reason, source_item_id, created_at
    )
    SELECT
      si.document_id,
      'source_tombstone',
      si.id,
      COALESCE(si.updated_at, datetime('now'))
    FROM source_items si
    WHERE si.tombstone = 1
      AND si.document_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM source_items active
        WHERE active.document_id = si.document_id
          AND active.tombstone = 0
      );
  `);
}
