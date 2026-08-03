/**
 * Source 文档检索可见性（KE-P0-02）
 *
 * 手动上传的 library 文档不受影响；仅 SourceItem 管理的文档参与排除。
 */

/**
 * @param {import("node:sqlite").DatabaseSync} database
 */
export function createSourceVisibilityStore(database) {
  const exclude = database.prepare(`
    INSERT INTO library_search_exclusions (
      document_id, reason, source_item_id, created_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(document_id) DO UPDATE SET
      reason = excluded.reason,
      source_item_id = excluded.source_item_id,
      created_at = excluded.created_at
  `);

  const clear = database.prepare(`
    DELETE FROM library_search_exclusions WHERE document_id = ?
  `);

  const hasActiveBinding = database.prepare(`
    SELECT 1 AS ok
    FROM source_items
    WHERE document_id = ?
      AND tombstone = 0
    LIMIT 1
  `);

  const wasEverSourceManaged = database.prepare(`
    SELECT 1 AS ok
    FROM source_items
    WHERE document_id = ?
    LIMIT 1
  `);

  return {
    /**
     * 根据 SourceItem 变更刷新排除表。
     * @param {{
     *   previousDocumentId?: string | null,
     *   nextDocumentId?: string | null,
     *   tombstone: boolean,
     *   sourceItemId?: string | null,
     * }} change
     */
    applyItemChange(change) {
      const now = new Date().toISOString();
      const prev = change.previousDocumentId || null;
      const next = change.nextDocumentId || null;
      const itemId = change.sourceItemId || null;

      if (prev && prev !== next) {
        this.refreshDocument(prev, {
          preferReason: "source_superseded",
          sourceItemId: itemId,
          now,
        });
      }
      if (next) {
        this.refreshDocument(next, {
          preferReason: change.tombstone
            ? "source_tombstone"
            : null,
          sourceItemId: itemId,
          now,
          forceActive: !change.tombstone,
        });
      }
    },

    /**
     * @param {string} documentId
     * @param {{
     *   preferReason?: string | null,
     *   sourceItemId?: string | null,
     *   now?: string,
     *   forceActive?: boolean,
     * }} [options]
     */
    refreshDocument(documentId, options = {}) {
      if (!documentId) return;
      const now = options.now || new Date().toISOString();

      if (options.forceActive || hasActiveBinding.get(documentId)) {
        clear.run(documentId);
        return;
      }

      // supersede 后旧 document_id 已不在 source_items；仍需按 preferReason 排除
      if (options.preferReason || wasEverSourceManaged.get(documentId)) {
        exclude.run(
          documentId,
          options.preferReason || "source_tombstone",
          options.sourceItemId || null,
          now,
        );
        return;
      }

      clear.run(documentId);
    },

    isExcluded(documentId) {
      return Boolean(
        database
          .prepare(
            `SELECT 1 AS ok FROM library_search_exclusions WHERE document_id = ?`,
          )
          .get(documentId),
      );
    },

    /** SQL 片段：排除库文档（绑定参数名由调用方拼接） */
    exclusionPredicate(column = "knowledge_chunks.document_id") {
      return `${column} NOT IN (SELECT document_id FROM library_search_exclusions)`;
    },
  };
}
