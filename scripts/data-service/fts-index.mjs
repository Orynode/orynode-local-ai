/**
 * FTS5 关键词索引读写（data-service 内部）
 *
 * ML-P1：dual-write legacy FTS + FTS v2；检索优先 v2，失败/未就绪回落 v1。
 */

import {
  ANALYZER_VERSION,
  buildMultilingualFields,
  KEYWORD_V2_BUILD_ID,
} from "./multilingual-normalizer.mjs";
import {
  buildFtsMatchQuery,
  buildSearchText,
  extractSearchTerms,
} from "./search-text.mjs";

/**
 * @param {import("node:sqlite").DatabaseSync} database
 */
export function isFtsReady(database) {
  try {
    const row = database
      .prepare(
        `SELECT value FROM knowledge_engine_capabilities WHERE key = 'fts5'`,
      )
      .get();
    if (row?.value === "unavailable") return false;
    const table = database
      .prepare(
        `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_chunks_fts'`,
      )
      .get();
    return Boolean(table?.ok);
  } catch {
    return false;
  }
}

/**
 * @param {import("node:sqlite").DatabaseSync} database
 */
export function isFtsV2Ready(database) {
  try {
    const row = database
      .prepare(
        `SELECT value FROM knowledge_engine_capabilities WHERE key = 'fts5_v2'`,
      )
      .get();
    if (row?.value !== "ready") return false;
    const table = database
      .prepare(
        `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_chunks_fts_v2'`,
      )
      .get();
    return Boolean(table?.ok);
  } catch {
    return false;
  }
}

/**
 * @param {import("node:sqlite").DatabaseSync} database
 * @param {"library" | "conversation"} namespace
 * @param {string} documentId
 */
export function deleteFtsForDocument(database, namespace, documentId) {
  if (isFtsReady(database)) {
    const table =
      namespace === "conversation"
        ? "conversation_file_chunks_fts"
        : "knowledge_chunks_fts";
    database
      .prepare(`DELETE FROM ${table} WHERE document_id = ?`)
      .run(documentId);
  }
  if (isFtsV2Ready(database)) {
    const table =
      namespace === "conversation"
        ? "conversation_file_chunks_fts_v2"
        : "knowledge_chunks_fts_v2";
    database
      .prepare(`DELETE FROM ${table} WHERE document_id = ?`)
      .run(documentId);
  }
}

/**
 * Dual-write：legacy search_text + FTS v2 多字段
 * @param {import("node:sqlite").DatabaseSync} database
 * @param {"library" | "conversation"} namespace
 * @param {string} documentId
 * @param {Array<{ id: string, content: string }>} chunks
 */
export function upsertFtsChunks(database, namespace, documentId, chunks) {
  if (isFtsReady(database)) {
    const table =
      namespace === "conversation"
        ? "conversation_file_chunks_fts"
        : "knowledge_chunks_fts";
    database
      .prepare(`DELETE FROM ${table} WHERE document_id = ?`)
      .run(documentId);
    const insert = database.prepare(
      `INSERT INTO ${table} (chunk_id, document_id, search_text) VALUES (?, ?, ?)`,
    );
    for (const chunk of chunks) {
      insert.run(chunk.id, documentId, buildSearchText(chunk.content));
    }
  }

  if (isFtsV2Ready(database)) {
    const table =
      namespace === "conversation"
        ? "conversation_file_chunks_fts_v2"
        : "knowledge_chunks_fts_v2";
    database
      .prepare(`DELETE FROM ${table} WHERE document_id = ?`)
      .run(documentId);
    const insert = database.prepare(`
      INSERT INTO ${table} (
        chunk_id, document_id, index_build_id,
        exact_text, zh_text, en_text, mixed_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const chunk of chunks) {
      const fields = buildMultilingualFields(chunk.content);
      insert.run(
        chunk.id,
        documentId,
        KEYWORD_V2_BUILD_ID,
        fields.exactText,
        fields.zhText,
        fields.enText,
        fields.mixedText,
      );
    }
  }
}

/**
 * @param {string[]} terms
 * @param {Array<{ value: string }>} [exactTerms]
 */
function buildV2MatchQuery(terms, exactTerms = []) {
  const parts = [];
  for (const exact of exactTerms) {
    const value = String(exact.value ?? "").trim();
    if (!value) continue;
    const escaped = `"${value.replace(/"/g, '""')}"`;
    parts.push(`exact_text : ${escaped}`);
  }
  const general = buildFtsMatchQuery(terms);
  if (general) parts.push(general);
  if (parts.length === 0) return null;
  return parts.join(" OR ");
}

/**
 * @param {import("node:sqlite").DatabaseSync} database
 * @param {object} options
 */
export function searchKeywordIndex(database, options) {
  const {
    query,
    phrase,
    library,
    conversationFiles,
    topK = 8,
    terms: providedTerms,
    exactTerms = [],
    preferLegacy = false,
  } = options;

  if (!isFtsReady(database) && !isFtsV2Ready(database)) {
    return { chunks: [], strategy: "fts_unavailable" };
  }

  const terms =
    Array.isArray(providedTerms) && providedTerms.length > 0
      ? providedTerms
      : extractSearchTerms(query);

  const useV2 = isFtsV2Ready(database) && !preferLegacy;
  const candidateLimit = Math.max(Number(topK) * 5, 40);
  /** @type {Map<string, any>} */
  const byId = new Map();

  const searchScopes = (useV2Index, scopedMatch) => {
    if (library) {
      searchLibrary(database, {
        useV2: useV2Index,
        match: scopedMatch,
        library,
        candidateLimit,
        byId,
      });
    }
    if (conversationFiles) {
      searchConversation(database, {
        useV2: useV2Index,
        match: scopedMatch,
        conversationFiles,
        candidateLimit,
        byId,
      });
    }
  };

  const finish = (strategy, matchedTerms) => {
    const chunks = [...byId.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Number(topK) || 8));
    attachBlockLocators(database, chunks);
    return {
      chunks,
      strategy,
      terms: matchedTerms,
      analyzerVersion: useV2 ? ANALYZER_VERSION : "fts5-search-text",
      activeKeywordBuild: useV2 ? KEYWORD_V2_BUILD_ID : undefined,
    };
  };

  const normalizedPhrase = String(phrase ?? "").replace(/\s+/g, " ").trim();
  if (normalizedPhrase) {
    const phraseMatch = `"${normalizedPhrase.replace(/"/g, '""')}"`;
    searchScopes(useV2, phraseMatch);
    if (byId.size > 0) return finish("fts5_phrase", [normalizedPhrase]);

    const allMatch = terms.map(escapeFtsToken).join(" AND ");
    if (allMatch) searchScopes(useV2, allMatch);
    return finish("fts5_all", terms);
  }

  const match = useV2
    ? buildV2MatchQuery(terms, exactTerms)
    : buildFtsMatchQuery(terms);

  if (!match) {
    return {
      chunks: [],
      strategy: useV2 ? "fts5_v2" : "fts5",
      terms: [],
      analyzerVersion: useV2 ? ANALYZER_VERSION : "fts5-search-text",
    };
  }

  if (library) {
    searchLibrary(database, {
      useV2,
      match,
      library,
      candidateLimit,
      byId,
    });
  }

  if (conversationFiles) {
    searchConversation(database, {
      useV2,
      match,
      conversationFiles,
      candidateLimit,
      byId,
    });
  }

  // v2 无结果且未强制 legacy 时回落 v1
  if (useV2 && byId.size === 0 && isFtsReady(database)) {
    const legacyMatch = buildFtsMatchQuery(terms);
    if (legacyMatch) {
      if (library) {
        searchLibrary(database, {
          useV2: false,
          match: legacyMatch,
          library,
          candidateLimit,
          byId,
        });
      }
      if (conversationFiles) {
        searchConversation(database, {
          useV2: false,
          match: legacyMatch,
          conversationFiles,
          candidateLimit,
          byId,
        });
      }
      const chunks = [...byId.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, Number(topK) || 8));
      attachBlockLocators(database, chunks);
      return {
        chunks,
        strategy: "fts5",
        terms,
        analyzerVersion: "fts5-search-text",
        degradedReasons: ["LEGACY_INDEX_ACTIVE"],
      };
    }
  }

  const chunks = [...byId.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Number(topK) || 8));

  attachBlockLocators(database, chunks);

  return {
    chunks,
    strategy: useV2 ? "fts5_v2" : "fts5",
    terms,
    analyzerVersion: useV2 ? ANALYZER_VERSION : "fts5-search-text",
    activeKeywordBuild: useV2 ? KEYWORD_V2_BUILD_ID : undefined,
  };
}

function searchLibrary(database, { useV2, match, library, candidateLimit, byId }) {
  const mode = library.mode === "all" ? "all" : "documents";
  const documentIds =
    mode === "documents" && Array.isArray(library.documentIds)
      ? library.documentIds.filter((id) => typeof id === "string")
      : null;

  if (mode !== "all" && (!documentIds || documentIds.length === 0)) {
    return;
  }

  const fts = useV2 ? "knowledge_chunks_fts_v2" : "knowledge_chunks_fts";
  // bm25 weights: exact=8, zh=3, en=3, mixed=2（仅 v2 四列）
  const rankExpr = useV2
    ? `bm25(${fts}, 8.0, 3.0, 3.0, 2.0)`
    : `bm25(${fts})`;

  let sql = `
    SELECT
      ${fts}.chunk_id AS id,
      ${fts}.document_id AS documentId,
      docs.name AS documentName,
      chunks.page_number AS pageNumber,
      chunks.position AS position,
      chunks.content AS content,
      ${rankExpr} AS rank
    FROM ${fts}
    INNER JOIN knowledge_chunks AS chunks
      ON chunks.id = ${fts}.chunk_id
    INNER JOIN knowledge_documents AS docs
      ON docs.id = ${fts}.document_id
    WHERE ${fts} MATCH ?
      AND docs.status IN ('ready', 'embedding', 'indexed', 'error')
      AND ${fts}.document_id NOT IN (
        SELECT document_id FROM library_search_exclusions
      )
  `;
  const params = [match];
  if (documentIds) {
    sql += ` AND ${fts}.document_id IN (SELECT value FROM json_each(?))`;
    params.push(JSON.stringify(documentIds));
  }
  sql += ` ORDER BY rank LIMIT ?`;
  params.push(candidateLimit);

  for (const row of database.prepare(sql).all(...params)) {
    byId.set(row.id, {
      id: row.id,
      documentId: row.documentId,
      documentName: row.documentName,
      pageNumber: row.pageNumber,
      position: row.position,
      content: row.content,
      source: "library",
      score: typeof row.rank === "number" ? -row.rank : 0,
    });
  }
}

function searchConversation(
  database,
  { useV2, match, conversationFiles, candidateLimit, byId },
) {
  const conversationId =
    typeof conversationFiles.conversationId === "string"
      ? conversationFiles.conversationId.trim()
      : "";
  const fileIds = Array.isArray(conversationFiles.fileIds)
    ? conversationFiles.fileIds.filter((id) => typeof id === "string")
    : [];
  if (!conversationId || fileIds.length === 0) return;

  const fts = useV2
    ? "conversation_file_chunks_fts_v2"
    : "conversation_file_chunks_fts";
  const rankExpr = useV2
    ? `bm25(${fts}, 8.0, 3.0, 3.0, 2.0)`
    : `bm25(${fts})`;

  const sql = `
    SELECT
      ${fts}.chunk_id AS id,
      ${fts}.document_id AS documentId,
      files.name AS documentName,
      chunks.page_number AS pageNumber,
      chunks.position AS position,
      chunks.content AS content,
      ${rankExpr} AS rank
    FROM ${fts}
    INNER JOIN conversation_file_chunks AS chunks
      ON chunks.id = ${fts}.chunk_id
    INNER JOIN conversation_files AS files
      ON files.id = ${fts}.document_id
    WHERE ${fts} MATCH ?
      AND files.conversation_id = ?
      AND ${fts}.document_id IN (SELECT value FROM json_each(?))
      AND files.status IN ('ready', 'embedding', 'indexed', 'error')
    ORDER BY rank
    LIMIT ?
  `;
  for (const row of database
    .prepare(sql)
    .all(match, conversationId, JSON.stringify(fileIds), candidateLimit)) {
    byId.set(row.id, {
      id: row.id,
      documentId: row.documentId,
      documentName: row.documentName,
      pageNumber: row.pageNumber,
      position: row.position,
      content: row.content,
      source: "conversation_file",
      score: typeof row.rank === "number" ? -row.rank : 0,
    });
  }
}

/**
 * 有 chunk_block_refs 时附带 page locator + bbox（OCR）
 * @param {import("node:sqlite").DatabaseSync} database
 * @param {Array<Record<string, unknown>>} chunks
 */
function attachBlockLocators(database, chunks) {
  if (!chunks.length) return;
  let listRefs;
  let getLocator;
  try {
    listRefs = database.prepare(`
      SELECT
        b.page_number AS pageNumber,
        b.bbox_json AS bboxJson,
        r.bbox_degraded AS bboxDegraded
      FROM chunk_block_refs r
      JOIN document_blocks b ON b.id = r.block_id
      WHERE r.namespace = ? AND r.chunk_id = ?
      ORDER BY b.page_number ASC, b.reading_order ASC
    `);
  } catch {
    return;
  }
  try {
    getLocator = database.prepare(`
      SELECT page_number AS pageNumber, bbox_degraded AS bboxDegraded
      FROM chunk_locators
      WHERE namespace = ? AND chunk_id = ?
    `);
  } catch {
    getLocator = null;
  }

  for (const chunk of chunks) {
    const namespace =
      chunk.source === "conversation_file" ? "conversation" : "library";
    const page = Number(chunk.pageNumber) || 1;

    if (getLocator) {
      try {
        const locator = getLocator.get(namespace, chunk.id);
        if (locator?.bboxDegraded) {
          chunk.bboxDegraded = true;
          chunk.locatorHint = {
            kind: "page",
            page: Number(locator.pageNumber) || page,
          };
          delete chunk.bbox;
          continue;
        }
      } catch {
        // ignore
      }
    }

    let rows;
    try {
      rows = listRefs.all(namespace, chunk.id);
    } catch {
      continue;
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      chunk.locatorHint = { kind: "page", page };
      continue;
    }
    if (rows.some((row) => row.bboxDegraded)) {
      chunk.bboxDegraded = true;
      chunk.locatorHint = { kind: "page", page };
      delete chunk.bbox;
      continue;
    }

    const refs = rows.map((row) => ({
      pageNumber: row.pageNumber,
      bbox: row.bboxJson ? safeParseBbox(row.bboxJson) : null,
    }));
    const withBbox = refs.filter(
      (r) =>
        r.pageNumber === page &&
        r.bbox &&
        Number.isFinite(r.bbox.x) &&
        Number.isFinite(r.bbox.y),
    );
    if (withBbox.length === 0) {
      chunk.locatorHint = { kind: "page", page };
      continue;
    }

    if (withBbox.length === 1) {
      const b = withBbox[0].bbox;
      chunk.bbox = [b.x, b.y, b.width, b.height];
      chunk.locatorHint = {
        kind: "page",
        page,
        bbox: chunk.bbox,
      };
      continue;
    }

    let minX = 1;
    let minY = 1;
    let maxX = 0;
    let maxY = 0;
    let sumArea = 0;
    for (const r of withBbox) {
      const b = r.bbox;
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.width);
      maxY = Math.max(maxY, b.y + b.height);
      sumArea += b.width * b.height;
    }
    const width = Math.max(0, maxX - minX);
    const height = Math.max(0, maxY - minY);
    const unionArea = width * height;
    if (unionArea > sumArea * 3 || unionArea > 0.45) {
      chunk.bboxDegraded = true;
      chunk.locatorHint = { kind: "page", page };
      delete chunk.bbox;
    } else {
      chunk.bbox = [minX, minY, width, height];
      chunk.locatorHint = {
        kind: "page",
        page,
        bbox: chunk.bbox,
      };
    }
  }
}

function safeParseBbox(json) {
  try {
    const o = JSON.parse(json);
    if (
      typeof o?.x === "number" &&
      typeof o?.y === "number" &&
      typeof o?.width === "number" &&
      typeof o?.height === "number"
    ) {
      return o;
    }
  } catch {
    // ignore
  }
  return null;
}
