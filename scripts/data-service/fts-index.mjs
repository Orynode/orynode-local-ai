/**
 * FTS5 关键词索引读写（data-service 内部）
 *
 * ML-P1：dual-write legacy FTS + FTS v2；检索优先 v2，失败/未就绪回落 v1。
 */

import {
  ANALYZER_VERSION,
  buildMultilingualFields,
  hansHantVariants,
  KEYWORD_V2_BUILD_ID,
} from "./multilingual-normalizer.mjs";
import {
  buildLexicalLadder,
  classifyQuery,
  passesCoverage,
} from "./lexical-coverage.mjs";
import {
  buildSearchText,
  escapeFtsToken,
  extractSearchTerms,
} from "./search-text.mjs";
import { sqlInSearchableStatuses } from "./searchable-document-statuses.mjs";

/**
 * 词项 MATCH：汉字简繁变体用 OR 并列，再按 AND/OR 连接词项。
 * @param {string[]} terms
 * @param {{ operator?: "AND" | "OR" }} [options]
 */
function buildFtsMatchQueryHansHant(terms, options = {}) {
  if (!Array.isArray(terms) || terms.length === 0) return null;
  const operator = options.operator === "OR" ? "OR" : "AND";
  const clauses = [];
  for (const term of terms) {
    const variants = hansHantVariants(term);
    if (variants.length === 0) continue;
    if (variants.length === 1) {
      clauses.push(escapeFtsToken(variants[0]));
    } else {
      clauses.push(`(${variants.map(escapeFtsToken).join(" OR ")})`);
    }
  }
  if (clauses.length === 0) return null;
  return clauses.join(` ${operator} `);
}

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
 * AND 查询时去掉「整段汉字 + 其 bigram」中的整段：unicode61 不会把整段当成单 token，
 * 保留 bigram 即可；否则 `"知识引擎" AND "知识" AND …` 会空命中。
 * @param {string[]} terms
 */
function termsForAndMatch(terms) {
  if (!Array.isArray(terms) || terms.length === 0) return terms;
  const set = new Set(terms);
  return terms.filter((term) => {
    if (!/^[\p{Script=Han}]{3,}$/u.test(term)) return true;
    for (let i = 0; i < term.length - 1; i += 1) {
      if (!set.has(term.slice(i, i + 2))) return true;
    }
    return false;
  });
}

/**
 * @param {string[]} terms
 * @param {Array<{ value: string }>} [exactTerms]
 * @param {"AND" | "OR"} [operator]
 */
function buildV2MatchQuery(terms, exactTerms = [], operator = "AND") {
  const parts = [];
  for (const exact of exactTerms) {
    const value = String(exact.value ?? "").trim();
    if (!value) continue;
    const escaped = `"${value.replace(/"/g, '""')}"`;
    parts.push(`exact_text : ${escaped}`);
  }
  const lexicalTerms =
    operator === "AND" ? termsForAndMatch(terms) : terms;
  const general = buildFtsMatchQueryHansHant(lexicalTerms, { operator });
  if (general) parts.push(general);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  if (operator === "AND" && parts.length > 1 && general) {
    const exactOnly = parts.slice(0, -1);
    if (exactOnly.length === 0) return general;
    return `(${exactOnly.join(" OR ")}) OR (${general})`;
  }
  return parts.join(" OR ");
}

/**
 * 按查询语言收窄 FTS v2 列（降低跨语言噪声）
 * @param {string | null} match
 * @param {string | undefined} languagePrimary
 */
function wrapLanguageColumns(match, languagePrimary) {
  if (!match) return null;
  const lang = String(languagePrimary ?? "");
  if (lang.startsWith("zh")) {
    return `{zh_text mixed_text exact_text} : (${match})`;
  }
  if (lang === "en") {
    return `{en_text mixed_text exact_text} : (${match})`;
  }
  return match;
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
    languagePrimary,
    queryClass: providedClass,
    lexicalLadder: providedLadder,
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

  const finish = (strategy, matchedTerms, degradedReasons) => {
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
      degradedReasons:
        degradedReasons && degradedReasons.length > 0
          ? degradedReasons
          : undefined,
    };
  };

  const emptyFinish = (strategy) => ({
    chunks: [],
    strategy,
    terms,
    analyzerVersion: useV2 ? ANALYZER_VERSION : "fts5-search-text",
    activeKeywordBuild: useV2 ? KEYWORD_V2_BUILD_ID : undefined,
  });

  const queryText = String(query ?? "");
  const hasHan = /[\p{Script=Han}]/u.test(queryText);
  const hasLatin = /[A-Za-z]/.test(queryText);
  const normalizedPhrase = String(phrase ?? "").replace(/\s+/g, " ").trim();
  const queryClass =
    typeof providedClass === "string" && providedClass
      ? providedClass
      : classifyQuery({
          query: queryText,
          phrase: normalizedPhrase || undefined,
          searchTerms: terms,
          exactTermsCount: Array.isArray(exactTerms) ? exactTerms.length : 0,
          hasLatin,
          hasHan,
        });

  const ladder =
    Array.isArray(providedLadder) && providedLadder.length > 0
      ? providedLadder
      : buildLexicalLadder({
          queryClass,
          phrase: normalizedPhrase || undefined,
          terms,
        });

  const runAndStep = (stepTerms) => {
    byId.clear();
    const andTerms = termsForAndMatch(stepTerms);
    const andRaw = useV2
      ? buildV2MatchQuery(stepTerms, exactTerms, "AND")
      : buildFtsMatchQueryHansHant(andTerms, { operator: "AND" });
    const andMatch = useV2
      ? wrapLanguageColumns(andRaw, languagePrimary) ?? andRaw
      : andRaw;
    if (!andMatch) return false;
    searchScopes(useV2, andMatch);
    return byId.size > 0;
  };

  const requiresContiguousPhrase =
    Boolean(normalizedPhrase) &&
    (queryClass === "zh_compound" ||
      queryClass === "short_entity" ||
      queryClass === "quoted_phrase");

  const admitContiguousPhrase = () => {
    if (!requiresContiguousPhrase || !normalizedPhrase) return;
    const needle = normalizedPhrase.toLocaleLowerCase();
    for (const [id, chunk] of [...byId.entries()]) {
      const hay = String(chunk.content ?? "").toLocaleLowerCase();
      if (!hay.includes(needle)) byId.delete(id);
    }
  };

  for (const step of ladder) {
    const mode = step?.mode;
    if (mode === "phrase") {
      const p = String(step.phrase ?? normalizedPhrase)
        .replace(/\s+/g, " ")
        .trim();
      if (!p) continue;
      byId.clear();
      const phraseMatch = `"${p.replace(/"/g, '""')}"`;
      const scopedPhrase = useV2
        ? wrapLanguageColumns(phraseMatch, languagePrimary) ?? phraseMatch
        : phraseMatch;
      searchScopes(useV2, scopedPhrase);
      admitContiguousPhrase();
      if (byId.size > 0) return finish("fts5_phrase", [p]);
      continue;
    }

    if (mode === "all") {
      const stepTerms =
        Array.isArray(step.terms) && step.terms.length > 0 ? step.terms : terms;
      if (runAndStep(stepTerms)) {
        // 短复合：bigram AND 仍要求正文连续出现完整短语（「反向」+「代理」≠「反向代理」）
        admitContiguousPhrase();
        if (byId.size > 0) {
          // 连续短语准入与 FTS phrase 同级：禁止 hybrid 再混入向量近邻（如「钠离子电池」→「电池」）
          return finish(
            requiresContiguousPhrase
              ? "fts5_phrase"
              : useV2
                ? "fts5_v2"
                : "fts5",
            stepTerms,
          );
        }
      }
      continue;
    }

    if (mode === "minimum_match") {
      const stepTerms =
        Array.isArray(step.terms) && step.terms.length > 0 ? step.terms : terms;
      const minimum = Math.max(
        2,
        Math.min(
          stepTerms.length,
          Number(step.minimum) || minimumFallback(stepTerms),
        ),
      );
      byId.clear();
      const admitted = runMinimumMatch({
        useV2,
        languagePrimary,
        terms: stepTerms,
        exactTerms,
        minimum,
        searchScopes,
        byId,
        library,
        conversationFiles,
        candidateLimit,
        database,
      });
      if (admitted) {
        return finish(
          useV2 ? "fts5_v2" : "fts5",
          stepTerms,
          ["FTS_MINIMUM_MATCH"],
        );
      }
      continue;
    }

    if (mode === "explicit_or") {
      const stepTerms =
        Array.isArray(step.terms) && step.terms.length > 0 ? step.terms : terms;
      byId.clear();
      const orRaw = useV2
        ? buildV2MatchQuery(stepTerms, exactTerms, "OR")
        : buildFtsMatchQueryHansHant(stepTerms, { operator: "OR" });
      const orMatch = useV2
        ? wrapLanguageColumns(orRaw, languagePrimary) ?? orRaw
        : orRaw;
      if (orMatch) {
        searchScopes(useV2, orMatch);
        if (byId.size > 0) {
          return finish(useV2 ? "fts5_v2" : "fts5", stepTerms);
        }
      }
    }
  }

  // 阶梯全部未命中：宁可空结果，禁止无条件 OR
  return emptyFinish(useV2 ? "fts5_v2" : "fts5");
}

/**
 * @param {string[]} terms
 */
function minimumFallback(terms) {
  const zh = terms.filter((t) => /^[\p{Script=Han}]{2}$/u.test(t));
  if (zh.length >= 2 && zh.length === terms.length) {
    if (zh.length <= 3) return zh.length;
    if (zh.length <= 6) return Math.ceil(zh.length * 0.75);
    return Math.ceil(zh.length * 0.6);
  }
  const n = terms.length;
  if (n <= 2) return n;
  if (n <= 4) return Math.ceil(n * 0.75);
  if (n <= 8) return Math.ceil(n * 0.6);
  return Math.max(1, Math.ceil(n * 0.5));
}

/**
 * 生成长度为 k 的组合（上限防止爆炸）
 * @param {string[]} items
 * @param {number} k
 * @param {number} [limit]
 */
function combinations(items, k, limit = 48) {
  /** @type {string[][]} */
  const out = [];
  const n = items.length;
  if (k <= 0 || k > n) return out;
  const idx = Array.from({ length: k }, (_, i) => i);
  for (;;) {
    out.push(idx.map((i) => items[i]));
    if (out.length >= limit) break;
    let pivot = k - 1;
    while (pivot >= 0 && idx[pivot] === n - k + pivot) pivot -= 1;
    if (pivot < 0) break;
    idx[pivot] += 1;
    for (let j = pivot + 1; j < k; j += 1) idx[j] = idx[j - 1] + 1;
  }
  return out;
}

/**
 * minimum_should_match：优先 OR-of-ANDs；组合过多则 OR 候选 + coverage 准入。
 */
function runMinimumMatch({
  useV2,
  languagePrimary,
  terms,
  exactTerms,
  minimum,
  searchScopes,
  byId,
  library,
  conversationFiles,
  candidateLimit,
  database,
}) {
  const andTerms = termsForAndMatch(terms);
  const workTerms = andTerms.length > 0 ? andTerms : terms;
  if (workTerms.length === 0 || minimum > workTerms.length) return false;

  const subsets = combinations(workTerms, minimum, 48);
  const comboBudgetOk =
    subsets.length > 0 &&
    subsets.length < 48 &&
    // 未触达硬顶，或词数不大
    (workTerms.length <= 8 || subsets.length < 48);

  if (comboBudgetOk && subsets.length > 0 && subsets.length < 48) {
    const parts = [];
    for (const subset of subsets) {
      const clause = buildFtsMatchQueryHansHant(subset, { operator: "AND" });
      if (clause) parts.push(`(${clause})`);
    }
    if (parts.length > 0) {
      let match = parts.join(" OR ");
      if (useV2) {
        // exact 字段仍 OR 进召回，再靠正文 coverage 过滤
        const exactParts = [];
        for (const exact of exactTerms) {
          const value = String(exact.value ?? "").trim();
          if (!value) continue;
          exactParts.push(`exact_text : "${value.replace(/"/g, '""')}"`);
        }
        if (exactParts.length > 0) {
          match = `(${exactParts.join(" OR ")}) OR (${match})`;
        }
        match = wrapLanguageColumns(match, languagePrimary) ?? match;
      }
      searchScopes(useV2, match);
      filterByCoverage(byId, workTerms, minimum);
      return byId.size > 0;
    }
  }

  // 回退：宽召回 + 应用层覆盖率准入（仍禁止把未过 coverage 的结果返回）
  const orRaw = useV2
    ? buildV2MatchQuery(terms, exactTerms, "OR")
    : buildFtsMatchQueryHansHant(workTerms, { operator: "OR" });
  const orMatch = useV2
    ? wrapLanguageColumns(orRaw, languagePrimary) ?? orRaw
    : orRaw;
  if (!orMatch) return false;
  searchScopes(useV2, orMatch);

  // v2 空时尝试 legacy AND/OR 候选池，仍做 coverage
  if (useV2 && byId.size === 0 && isFtsReady(database)) {
    const legacyMatch = buildFtsMatchQueryHansHant(workTerms, {
      operator: "OR",
    });
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
    }
  }

  filterByCoverage(byId, workTerms, minimum);
  return byId.size > 0;
}

/**
 * @param {Map<string, any>} byId
 * @param {string[]} terms
 * @param {number} minimum
 */
function filterByCoverage(byId, terms, minimum) {
  for (const [id, chunk] of [...byId.entries()]) {
    const content = String(chunk.content ?? "");
    if (!passesCoverage(content, terms, minimum)) {
      byId.delete(id);
    }
  }
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
      AND ${sqlInSearchableStatuses("docs.status")}
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
      AND ${sqlInSearchableStatuses("files.status")}
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
      // 无 OCR block 时不伪造 page locator，留给 Context Builder 按文件类型推断（如 Markdown 标题路径）
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
