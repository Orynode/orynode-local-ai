/**
 * Migration 010: DocumentBlock + chunk_block_refs（OCR / 统一 block 管线）
 */

export const id = "010_ocr_document_blocks";

/**
 * @param {import("node:sqlite").DatabaseSync} database
 */
export function up(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS document_blocks (
      id TEXT PRIMARY KEY,
      processing_build_id TEXT NOT NULL,
      page_number INTEGER NOT NULL,
      block_type TEXT NOT NULL DEFAULT 'text',
      reading_order INTEGER NOT NULL,
      text TEXT NOT NULL,
      origin TEXT NOT NULL CHECK (origin IN ('native_text', 'ocr')),
      bbox_json TEXT,
      confidence REAL,
      language TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (processing_build_id)
        REFERENCES processing_builds(id) ON DELETE CASCADE,
      UNIQUE(processing_build_id, page_number, reading_order)
    );

    CREATE INDEX IF NOT EXISTS idx_document_blocks_build_page
      ON document_blocks(processing_build_id, page_number, reading_order);

    CREATE TABLE IF NOT EXISTS chunk_block_refs (
      namespace TEXT NOT NULL CHECK (namespace IN ('library', 'conversation')),
      chunk_id TEXT NOT NULL,
      block_id TEXT NOT NULL,
      start_offset INTEGER,
      end_offset INTEGER,
      PRIMARY KEY (namespace, chunk_id, block_id),
      FOREIGN KEY (block_id) REFERENCES document_blocks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chunk_block_refs_chunk
      ON chunk_block_refs(namespace, chunk_id);
  `);
}
