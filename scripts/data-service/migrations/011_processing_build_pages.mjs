/**
 * Migration 011: 页级 checkpoint + chunk_block_refs.bbox_degraded
 *
 * 空白页 / OCR 无文字页不会写入 document_blocks，需独立记录页完成状态。
 */

export const id = "011_processing_build_pages";

/**
 * @param {import("node:sqlite").DatabaseSync} database
 */
export function up(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS processing_build_pages (
      processing_build_id TEXT NOT NULL,
      page_number INTEGER NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('native', 'ocr', 'blank')),
      status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
      completed_at TEXT,
      error_code TEXT,
      PRIMARY KEY (processing_build_id, page_number),
      FOREIGN KEY (processing_build_id)
        REFERENCES processing_builds(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_processing_build_pages_build
      ON processing_build_pages(processing_build_id, page_number);
  `);

  const columns = database
    .prepare(`PRAGMA table_info(chunk_block_refs)`)
    .all()
    .map((row) => row.name);
  if (!columns.includes("bbox_degraded")) {
    database.exec(`
      ALTER TABLE chunk_block_refs
      ADD COLUMN bbox_degraded INTEGER NOT NULL DEFAULT 0
    `);
  }
}
