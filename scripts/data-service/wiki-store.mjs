/**
 * Wiki 页薄存储。编译策略在 services/knowledge/wiki。
 */

import { contentTermsForLexicalMatch } from "./lexical-coverage.mjs";
import {
  buildFtsMatchQuery,
  buildSearchText,
  extractSearchTerms,
  termsForFts5Match,
} from "./search-text.mjs";

/**
 * Wiki FTS 与 L0 共用 MATCH 内容词（AND），再按 FTS5 分析器收窄 token。
 * @param {string} query
 * @returns {string | null}
 */
function wikiFtsMatch(query) {
  const terms = termsForFts5Match(
    contentTermsForLexicalMatch(
      extractSearchTerms(String(query || ""), 12),
    ),
  );
  return buildFtsMatchQuery(terms.slice(0, 4), { operator: "AND" });
}

/**
 * @param {import("node:sqlite").DatabaseSync} database
 */
export function createWikiStore(database) {
  const selectColumns = `
    id, slug, title, kind, namespace,
    source_document_id AS sourceDocumentId,
    markdown, sections_json AS sectionsJson,
    compiler, status,
    synthesis_markdown AS synthesisMarkdown,
    synthesis_compiler AS synthesisCompiler,
    user_edited AS userEdited,
    wiki_build_id AS wikiBuildId,
    notes_markdown AS notesMarkdown,
    knowledge_json AS knowledgeJson,
    created_at AS createdAt, updated_at AS updatedAt
  `;

  const getById = database.prepare(`
    SELECT ${selectColumns}
    FROM wiki_pages
    WHERE id = ?
  `);

  const getBySource = database.prepare(`
    SELECT ${selectColumns}
    FROM wiki_pages
    WHERE namespace = ? AND source_document_id = ?
    LIMIT 1
  `);

  const listBySource = database.prepare(`
    SELECT ${selectColumns}
    FROM wiki_pages
    WHERE namespace = ? AND source_document_id = ?
  `);

  const listRows = database.prepare(`
    SELECT ${selectColumns}
    FROM wiki_pages
    WHERE namespace = ?
      AND (? IS NULL OR kind = ?)
    ORDER BY updated_at DESC
    LIMIT ?
  `);

  const upsertRow = database.prepare(`
    INSERT INTO wiki_pages (
      id, slug, title, kind, namespace, source_document_id,
      markdown, sections_json, compiler, status,
      synthesis_markdown, synthesis_compiler,
      user_edited, wiki_build_id, notes_markdown, knowledge_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      slug = excluded.slug,
      title = excluded.title,
      kind = excluded.kind,
      namespace = excluded.namespace,
      source_document_id = excluded.source_document_id,
      markdown = excluded.markdown,
      sections_json = excluded.sections_json,
      compiler = excluded.compiler,
      status = excluded.status,
      synthesis_markdown = excluded.synthesis_markdown,
      synthesis_compiler = excluded.synthesis_compiler,
      user_edited = excluded.user_edited,
      wiki_build_id = excluded.wiki_build_id,
      notes_markdown = excluded.notes_markdown,
      knowledge_json = excluded.knowledge_json,
      updated_at = excluded.updated_at
  `);

  const deleteBySourceStmt = database.prepare(`
    DELETE FROM wiki_pages WHERE namespace = ? AND source_document_id = ?
  `);

  const deleteByIdStmt = database.prepare(`DELETE FROM wiki_pages WHERE id = ?`);

  const deleteByNamespaceStmt = database.prepare(
    `DELETE FROM wiki_pages WHERE namespace = ?`,
  );

  const listIdsByNamespace = database.prepare(
    `SELECT id FROM wiki_pages WHERE namespace = ?`,
  );

  const listConceptRows = database.prepare(`
    SELECT ${selectColumns}
    FROM wiki_pages
    WHERE namespace = 'library' AND kind = 'concept'
  `);

  const deleteLinksForPage = database.prepare(`
    DELETE FROM wiki_links WHERE from_id = ? OR to_id = ?
  `);

  const deleteOutgoing = database.prepare(
    `DELETE FROM wiki_links WHERE from_id = ?`,
  );

  const insertLink = database.prepare(`
    INSERT OR IGNORE INTO wiki_links (from_id, to_id, rel) VALUES (?, ?, ?)
  `);

  const listOutgoing = database.prepare(`
    SELECT from_id AS fromId, to_id AS toId, rel
    FROM wiki_links WHERE from_id = ?
  `);

  const listIncoming = database.prepare(`
    SELECT from_id AS fromId, to_id AS toId, rel
    FROM wiki_links WHERE to_id = ?
  `);

  const insertBuild = database.prepare(`
    INSERT INTO wiki_builds (
      id, namespace, compiler, page_count, link_count, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  let insertCompileRun = null;
  let deleteCompileRunsByPage = null;
  let listCompileRunsStmt = null;
  try {
    insertCompileRun = database.prepare(`
      INSERT INTO wiki_compile_runs (
        id, page_id, compiler, status, attempts, repaired,
        error_code, input_hash, section_count, batch_count, claim_count,
        token_in, duration_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    deleteCompileRunsByPage = database.prepare(
      `DELETE FROM wiki_compile_runs WHERE page_id = ?`,
    );
    listCompileRunsStmt = database.prepare(`
      SELECT id, page_id AS pageId, compiler, status, attempts, repaired,
             error_code AS errorCode, input_hash AS inputHash,
             section_count AS sectionCount, batch_count AS batchCount,
             claim_count AS claimCount, token_in AS tokenIn,
             duration_ms AS durationMs, created_at AS createdAt
      FROM wiki_compile_runs
      WHERE page_id = ?
      ORDER BY created_at DESC
      LIMIT 20
    `);
  } catch {
    insertCompileRun = null;
    deleteCompileRunsByPage = null;
    listCompileRunsStmt = null;
  }

  const WIKI_REVISION_KEEP = 20;
  let insertRevision = null;
  let deleteRevisionsByPage = null;
  let deleteRevisionById = null;
  let maxRevisionStmt = null;
  let listRevisionIdsStmt = null;
  let listRevisionsStmt = null;
  let getRevisionStmt = null;
  try {
    insertRevision = database.prepare(`
      INSERT INTO wiki_page_revisions (
        id, page_id, revision, reason, snapshot_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    deleteRevisionsByPage = database.prepare(
      `DELETE FROM wiki_page_revisions WHERE page_id = ?`,
    );
    deleteRevisionById = database.prepare(
      `DELETE FROM wiki_page_revisions WHERE id = ?`,
    );
    maxRevisionStmt = database.prepare(
      `SELECT MAX(revision) AS revision FROM wiki_page_revisions WHERE page_id = ?`,
    );
    listRevisionIdsStmt = database.prepare(`
      SELECT id FROM wiki_page_revisions
      WHERE page_id = ?
      ORDER BY revision DESC
    `);
    listRevisionsStmt = database.prepare(`
      SELECT id, page_id AS pageId, revision, reason,
             snapshot_json AS snapshotJson, created_at AS createdAt
      FROM wiki_page_revisions
      WHERE page_id = ?
      ORDER BY revision DESC
      LIMIT 20
    `);
    getRevisionStmt = database.prepare(`
      SELECT id, page_id AS pageId, revision, reason,
             snapshot_json AS snapshotJson, created_at AS createdAt
      FROM wiki_page_revisions
      WHERE page_id = ? AND revision = ?
    `);
  } catch {
    insertRevision = null;
    deleteRevisionsByPage = null;
    deleteRevisionById = null;
    maxRevisionStmt = null;
    listRevisionIdsStmt = null;
    listRevisionsStmt = null;
    getRevisionStmt = null;
  }

  let insertDecision = null;
  let listDecisionsStmt = null;
  let deletePendingFrom = null;
  let listPendingFrom = null;
  let listAllPendingStmt = null;
  let insertPendingEdge = null;
  let insertCandidate = null;
  let getCandidateStmt = null;
  let listCandidatesStmt = null;
  let updateCandidateStmt = null;
  let deleteCandidatesByPage = null;
  try {
    insertDecision = database.prepare(`
      INSERT OR REPLACE INTO wiki_decisions (id, action, payload_json, created_at)
      VALUES (?, ?, ?, ?)
    `);
    listDecisionsStmt = database.prepare(`
      SELECT id, action, payload_json AS payloadJson
      FROM wiki_decisions
      ORDER BY created_at ASC
      LIMIT 10000
    `);
    deletePendingFrom = database.prepare(
      `DELETE FROM wiki_pending_edges WHERE from_id = ?`,
    );
    listPendingFrom = database.prepare(`
      SELECT from_id AS fromId, target, rel, citations_json AS citationsJson, status
      FROM wiki_pending_edges
      WHERE from_id = ?
    `);
    listAllPendingStmt = database.prepare(`
      SELECT from_id AS fromId, target, rel, citations_json AS citationsJson, status
      FROM wiki_pending_edges
      LIMIT 2000
    `);
    insertPendingEdge = database.prepare(`
      INSERT OR REPLACE INTO wiki_pending_edges
        (from_id, target, rel, citations_json, status)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertCandidate = database.prepare(`
      INSERT OR REPLACE INTO wiki_candidates (
        id, page_id, kind, status, text, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    getCandidateStmt = database.prepare(`
      SELECT id, page_id AS pageId, kind, status, text,
             payload_json AS payloadJson, created_at AS createdAt
      FROM wiki_candidates
      WHERE id = ?
    `);
    listCandidatesStmt = database.prepare(`
      SELECT id, page_id AS pageId, kind, status, text,
             payload_json AS payloadJson, created_at AS createdAt
      FROM wiki_candidates
      WHERE page_id = ? AND (? IS NULL OR status = ?)
      ORDER BY created_at DESC
      LIMIT 50
    `);
    updateCandidateStmt = database.prepare(`
      UPDATE wiki_candidates SET status = ? WHERE id = ?
    `);
    deleteCandidatesByPage = database.prepare(
      `DELETE FROM wiki_candidates WHERE page_id = ?`,
    );
  } catch {
    insertDecision = null;
    listDecisionsStmt = null;
    deletePendingFrom = null;
    listPendingFrom = null;
    listAllPendingStmt = null;
    insertPendingEdge = null;
    insertCandidate = null;
    getCandidateStmt = null;
    listCandidatesStmt = null;
    updateCandidateStmt = null;
    deleteCandidatesByPage = null;
  }

  function ftsReady() {
    try {
      const row = database
        .prepare(
          `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'wiki_pages_fts'`,
        )
        .get();
      return Boolean(row?.ok);
    } catch {
      return false;
    }
  }

  function linksReady() {
    try {
      const row = database
        .prepare(
          `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'wiki_links'`,
        )
        .get();
      return Boolean(row?.ok);
    } catch {
      return false;
    }
  }

  function buildsReady() {
    try {
      const row = database
        .prepare(
          `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'wiki_builds'`,
        )
        .get();
      return Boolean(row?.ok);
    } catch {
      return false;
    }
  }

  function compileRunsReady() {
    try {
      const row = database
        .prepare(
          `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'wiki_compile_runs'`,
        )
        .get();
      return Boolean(row?.ok);
    } catch {
      return false;
    }
  }

  function revisionsReady() {
    try {
      const row = database
        .prepare(
          `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'wiki_page_revisions'`,
        )
        .get();
      return Boolean(row?.ok);
    } catch {
      return false;
    }
  }

  function revisionFingerprint(page) {
    return JSON.stringify({
      markdown: page?.markdown || "",
      sections: page?.sections || [],
      synthesis: page?.synthesisMarkdown || "",
      notes: page?.notesMarkdown || "",
      knowledge: page?.knowledge || null,
      userEdited: Boolean(page?.userEdited),
    });
  }

  function inferRevisionReason(previous, next) {
    const outlineChanged =
      (previous.markdown || "") !== (next.markdown || "") ||
      JSON.stringify(previous.sections || []) !==
        JSON.stringify(next.sections || []);
    const notesChanged =
      (previous.notesMarkdown || "") !== (next.notesMarkdown || "");
    const synthesisChanged =
      (previous.synthesisMarkdown || "") !== (next.synthesisMarkdown || "");
    const knowledgeChanged =
      JSON.stringify(previous.knowledge || null) !==
      JSON.stringify(next.knowledge || null);
    const editedChanged = Boolean(previous.userEdited) !== Boolean(next.userEdited);
    if (notesChanged && !synthesisChanged && !knowledgeChanged) return "settle";
    if ((next.userEdited || editedChanged) && (synthesisChanged || editedChanged)) {
      return "edit";
    }
    if (synthesisChanged || knowledgeChanged) return "compile";
    if (outlineChanged) return "outline";
    return null;
  }

  function snapshotFromPage(page) {
    return {
      title: page.title,
      markdown: page.markdown || "",
      sections: Array.isArray(page.sections) ? page.sections : [],
      synthesisMarkdown: page.synthesisMarkdown || "",
      notesMarkdown: page.notesMarkdown || "",
      knowledge: page.knowledge || null,
      userEdited: Boolean(page.userEdited),
      status: page.status,
      compiler: page.compiler,
      synthesisCompiler: page.synthesisCompiler || "",
    };
  }

  function recordRevision(page, reason) {
    if (!revisionsReady() || !insertRevision || !page?.id || !reason) return;
    const pageId = String(page.id);
    const latest = maxRevisionStmt?.get(pageId);
    const revision = (Number(latest?.revision) || 0) + 1;
    insertRevision.run(
      `${pageId}#${revision}`,
      pageId,
      revision,
      String(reason),
      JSON.stringify(snapshotFromPage(page)),
      new Date().toISOString(),
    );
    const extras = (listRevisionIdsStmt?.all(pageId) || []).slice(
      WIKI_REVISION_KEEP,
    );
    for (const row of extras) {
      deleteRevisionById?.run(row.id);
    }
  }

  function parseRevisionRow(row) {
    if (!row) return null;
    let snapshot = {};
    try {
      const parsed = JSON.parse(row.snapshotJson || "{}");
      if (parsed && typeof parsed === "object") snapshot = parsed;
    } catch {
      snapshot = {};
    }
    const synthesis = String(snapshot.synthesisMarkdown || "");
    const notes = String(snapshot.notesMarkdown || "");
    return {
      id: row.id,
      pageId: row.pageId,
      revision: Number(row.revision) || 0,
      reason: row.reason,
      createdAt: row.createdAt,
      userEdited: Boolean(snapshot.userEdited),
      excerpt: (synthesis || notes).slice(0, 160),
      snapshot,
    };
  }

  let txDepth = 0;
  function withTransaction(work) {
    const started = txDepth === 0;
    if (started) {
      database.exec("BEGIN IMMEDIATE");
      txDepth = 1;
    } else {
      txDepth += 1;
    }
    try {
      const result = work();
      if (started) database.exec("COMMIT");
      return result;
    } catch (error) {
      if (started) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // ignore rollback failure
        }
      }
      throw error;
    } finally {
      txDepth = started ? 0 : Math.max(0, txDepth - 1);
    }
  }

  function maturityReady() {
    try {
      const row = database
        .prepare(
          `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'wiki_decisions'`,
        )
        .get();
      return Boolean(row?.ok);
    } catch {
      return false;
    }
  }

  function rowToPage(row) {
    if (!row) return null;
    let sections = [];
    try {
      sections = JSON.parse(row.sectionsJson);
    } catch {
      sections = [];
    }
    const synthesisMarkdown =
      typeof row.synthesisMarkdown === "string" && row.synthesisMarkdown.trim()
        ? row.synthesisMarkdown
        : undefined;
    const synthesisCompiler =
      typeof row.synthesisCompiler === "string" && row.synthesisCompiler.trim()
        ? row.synthesisCompiler
        : undefined;
    const wikiBuildId =
      typeof row.wikiBuildId === "string" && row.wikiBuildId.trim()
        ? row.wikiBuildId
        : undefined;
    const notesMarkdown =
      typeof row.notesMarkdown === "string" && row.notesMarkdown.trim()
        ? row.notesMarkdown
        : undefined;
    let knowledge;
    try {
      const parsed = JSON.parse(row.knowledgeJson || "null");
      if (parsed && typeof parsed === "object") knowledge = parsed;
    } catch {
      knowledge = undefined;
    }
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      kind: row.kind,
      namespace: row.namespace,
      sourceDocumentId: row.sourceDocumentId,
      markdown: row.markdown,
      sections: Array.isArray(sections) ? sections : [],
      compiler: row.compiler,
      status: row.status,
      userEdited: Boolean(row.userEdited),
      ...(synthesisMarkdown ? { synthesisMarkdown } : {}),
      ...(synthesisCompiler ? { synthesisCompiler } : {}),
      ...(wikiBuildId ? { wikiBuildId } : {}),
      ...(notesMarkdown ? { notesMarkdown } : {}),
      ...(knowledge ? { knowledge } : {}),
      ...(knowledge?.identity ? { identity: knowledge.identity } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  function upsertFts(
    pageId,
    title,
    markdown,
    synthesisMarkdown,
    notesMarkdown,
    knowledge,
  ) {
    if (!ftsReady()) return;
    const knowledgeText = knowledge
      ? [
          ...(Array.isArray(knowledge.aliases) ? knowledge.aliases : []),
          ...(Array.isArray(knowledge.claims)
            ? knowledge.claims
                .filter(
                  (claim) => !claim?.status || claim.status === "active",
                )
                .map((claim) => claim?.text)
            : []),
          ...(Array.isArray(knowledge.relations)
            ? knowledge.relations.map((relation) => relation?.target)
            : []),
        ].filter(Boolean).join("\n")
      : "";
    const combined = [
      title,
      markdown,
      synthesisMarkdown,
      notesMarkdown,
      knowledgeText,
    ]
      .filter(Boolean)
      .join("\n\n");
    database.prepare(`DELETE FROM wiki_pages_fts WHERE page_id = ?`).run(pageId);
    database
      .prepare(
        `INSERT INTO wiki_pages_fts (page_id, search_text) VALUES (?, ?)`,
      )
      .run(pageId, buildSearchText(combined));
  }

  function deleteFts(pageId) {
    if (!ftsReady() || !pageId) return;
    database.prepare(`DELETE FROM wiki_pages_fts WHERE page_id = ?`).run(pageId);
  }

  function removePageGraph(pageId) {
    if (pageId) deleteFts(pageId);
    if (linksReady() && pageId) deleteLinksForPage.run(pageId, pageId);
    if (compileRunsReady() && deleteCompileRunsByPage && pageId) {
      deleteCompileRunsByPage.run(pageId);
    }
    if (revisionsReady() && deleteRevisionsByPage && pageId) {
      deleteRevisionsByPage.run(pageId);
    }
    if (maturityReady() && pageId) {
      deletePendingFrom?.run(pageId);
      deleteCandidatesByPage?.run(pageId);
    }
  }

  function parseCandidate(row) {
    if (!row) return null;
    let payload = {};
    try {
      const parsed = JSON.parse(row.payloadJson || "{}");
      if (parsed && typeof parsed === "object") payload = parsed;
    } catch {
      payload = {};
    }
    return {
      id: row.id,
      pageId: row.pageId,
      kind: row.kind,
      status: row.status,
      text: row.text,
      payload,
      createdAt: row.createdAt,
    };
  }

  function stripKnowledgeForDocument(knowledge, documentId, droppedChunkIds) {
    if (!knowledge || typeof knowledge !== "object") return knowledge;
    const claims = Array.isArray(knowledge.claims) ? knowledge.claims : [];
    return {
      ...knowledge,
      claims: claims.map((claim) => {
        const evidence = (claim.evidence || []).filter(
          (item) =>
            item.documentId !== documentId &&
            !droppedChunkIds.has(item.chunkId),
        );
        const sourceChunkIds = (claim.sourceChunkIds || []).filter(
          (chunkId) => !droppedChunkIds.has(chunkId),
        );
        const empty = evidence.length === 0 && sourceChunkIds.length === 0;
        return {
          ...claim,
          evidence,
          sourceChunkIds,
          status: empty ? "withdrawn" : claim.status,
        };
      }),
    };
  }

  const WIKI_MARKDOWN_MAX = 200_000;
  const WIKI_NOTES_MAX = 48_000;

  function upsertPage(input, options = {}) {
    const id = String(input.id || input.slug || "").trim();
    const slug = String(input.slug || id).trim();
    const title = String(input.title || "").trim();
    const namespace =
      input.namespace === "conversation" ? "conversation" : "library";
    const sourceDocumentId = String(input.sourceDocumentId || "").trim();
    const markdown = String(input.markdown || "");
    if (!id || !slug || !title || !sourceDocumentId) {
      throw new Error("wiki 页缺少 id/slug/title/sourceDocumentId");
    }
    if (markdown.length > WIKI_MARKDOWN_MAX) {
      throw new Error("wiki 正文过长");
    }
    const now = new Date().toISOString();
    const existing = rowToPage(getById.get(id));
    const keepSynthesis = !Object.prototype.hasOwnProperty.call(
      input,
      "synthesisMarkdown",
    );
    const synthesisMarkdown = keepSynthesis
      ? existing?.synthesisMarkdown ?? null
      : input.synthesisMarkdown
        ? String(input.synthesisMarkdown)
        : null;
    const synthesisCompiler = keepSynthesis
      ? existing?.synthesisCompiler ?? null
      : input.synthesisCompiler
        ? String(input.synthesisCompiler)
        : null;
    const userEdited = Object.prototype.hasOwnProperty.call(input, "userEdited")
      ? input.userEdited
        ? 1
        : 0
      : existing?.userEdited
        ? 1
        : 0;
    const wikiBuildId = Object.prototype.hasOwnProperty.call(
      input,
      "wikiBuildId",
    )
      ? input.wikiBuildId
        ? String(input.wikiBuildId)
        : null
      : existing?.wikiBuildId ?? null;
    const keepNotes = !Object.prototype.hasOwnProperty.call(
      input,
      "notesMarkdown",
    );
    const notesMarkdown = keepNotes
      ? existing?.notesMarkdown ?? null
      : input.notesMarkdown
        ? String(input.notesMarkdown)
        : null;
    if (notesMarkdown && String(notesMarkdown).length > WIKI_NOTES_MAX) {
      throw new Error("wiki 笔记过长");
    }
    if (synthesisMarkdown && String(synthesisMarkdown).length > WIKI_MARKDOWN_MAX) {
      throw new Error("wiki 综述过长");
    }
    const keepKnowledge = !Object.prototype.hasOwnProperty.call(
      input,
      "knowledge",
    );
    const knowledge = keepKnowledge
      ? existing?.knowledge
      : input.knowledge && typeof input.knowledge === "object"
        ? input.knowledge
        : undefined;
    upsertRow.run(
      id,
      slug,
      title,
      String(input.kind || "document_mirror"),
      namespace,
      sourceDocumentId,
      markdown,
      JSON.stringify(Array.isArray(input.sections) ? input.sections : []),
      String(input.compiler || "heading_extract_v1"),
      String(input.status || "ready"),
      synthesisMarkdown,
      synthesisCompiler,
      userEdited,
      wikiBuildId,
      notesMarkdown,
      knowledge ? JSON.stringify(knowledge) : null,
      existing?.createdAt || now,
      now,
    );
    upsertFts(
      id,
      title,
      markdown,
      synthesisMarkdown,
      notesMarkdown,
      knowledge,
    );
    const next = rowToPage(getById.get(id));
    const previous = existing;
    if (
      previous &&
      next &&
      revisionFingerprint(previous) !== revisionFingerprint(next)
    ) {
      const reason =
        options.revisionReason || inferRevisionReason(previous, next);
      if (reason) recordRevision(previous, reason);
    }
    return next;
  }

  return {
    getById: (id) => rowToPage(getById.get(id)),
    getBySource: (namespace, sourceDocumentId) =>
      rowToPage(getBySource.get(namespace, sourceDocumentId)),
    list({ namespace = "library", kind = null, limit = 40, sourceDocumentIds = null } = {}) {
      const ns = namespace === "conversation" ? "conversation" : "library";
      const kindFilter = kind ? String(kind) : null;
      const cap = Math.min(Math.max(Number(limit) || 40, 1), 500);
      const allowed = Array.isArray(sourceDocumentIds)
        ? [...new Set(sourceDocumentIds.map((id) => String(id || "").trim()).filter(Boolean))]
        : null;
      if (allowed && allowed.length === 0) return [];
      if (allowed) {
        const placeholders = allowed.map(() => "?").join(", ");
        return database
          .prepare(
            `
            SELECT ${selectColumns}
            FROM wiki_pages
            WHERE namespace = ?
              AND (? IS NULL OR kind = ?)
              AND source_document_id IN (${placeholders})
            ORDER BY updated_at DESC
            LIMIT ?
          `,
          )
          .all(ns, kindFilter, kindFilter, ...allowed, cap)
          .map(rowToPage)
          .filter(Boolean);
      }
      return listRows.all(ns, kindFilter, kindFilter, cap).map(rowToPage).filter(Boolean);
    },
    search({ query, namespace = "library", kind = null, limit = 16 } = {}) {
      const ns = namespace === "conversation" ? "conversation" : "library";
      const cap = Math.min(Math.max(Number(limit) || 16, 1), 40);
      const match = wikiFtsMatch(String(query || ""));
      if (!match || !ftsReady()) return [];
      const kindFilter = kind ? String(kind) : null;
      try {
        const rows = database
          .prepare(
            `
            SELECT ${selectColumns}
            FROM wiki_pages_fts
            INNER JOIN wiki_pages ON wiki_pages.id = wiki_pages_fts.page_id
            WHERE wiki_pages_fts MATCH ?
              AND wiki_pages.namespace = ?
              AND (? IS NULL OR wiki_pages.kind = ?)
            ORDER BY bm25(wiki_pages_fts)
            LIMIT ?
          `,
          )
          .all(match, ns, kindFilter, kindFilter, cap);
        return rows.map(rowToPage).filter(Boolean);
      } catch {
        return [];
      }
    },
    upsert(input, options = {}) {
      return withTransaction(() => upsertPage(input, options));
    },
    publish(input) {
      return withTransaction(() => {
        const pageInput = input.page;
        if (!pageInput) {
          throw new Error("publish 需要 page");
        }
        const page = upsertPage(pageInput, {
          ...(input.revisionReason ? { revisionReason: input.revisionReason } : {}),
        });
        if (Array.isArray(input.links)) {
          this.replaceLinks(page.id, input.links);
        }
        if (Array.isArray(input.pendingEdges)) {
          this.replacePendingEdges(page.id, input.pendingEdges);
        }
        return page;
      });
    },
    deleteBySource(namespace, sourceDocumentId) {
      withTransaction(() => {
        for (const row of listBySource.all(namespace, sourceDocumentId)) {
          if (row?.id) removePageGraph(row.id);
        }
        deleteBySourceStmt.run(namespace, sourceDocumentId);
      });
    },
    deleteById(id) {
      const pageId = String(id || "").trim();
      if (!pageId) return;
      withTransaction(() => {
        removePageGraph(pageId);
        deleteByIdStmt.run(pageId);
      });
    },
    deleteByNamespace(namespace) {
      const ns = namespace === "conversation" ? "conversation" : "library";
      withTransaction(() => {
        for (const row of listIdsByNamespace.all(ns)) {
          removePageGraph(row.id);
        }
        deleteByNamespaceStmt.run(ns);
      });
    },
    replaceLinks(fromId, links) {
      return withTransaction(() => {
        if (!linksReady()) return [];
        const id = String(fromId || "").trim();
        if (!id) return [];
        deleteOutgoing.run(id);
        const written = [];
        for (const link of Array.isArray(links) ? links : []) {
          const toId = String(link.toId || "").trim();
          const rel = String(link.rel || "see_also").trim() || "see_also";
          if (!toId || toId === id) continue;
          insertLink.run(id, toId, rel);
          written.push({ fromId: id, toId, rel });
        }
        return written;
      });
    },
    listLinks(pageId) {
      if (!linksReady()) return { outgoing: [], incoming: [] };
      const id = String(pageId || "").trim();
      if (!id) return { outgoing: [], incoming: [] };
      return {
        outgoing: listOutgoing.all(id),
        incoming: listIncoming.all(id),
      };
    },
    recordBuild(input) {
      if (!buildsReady()) return null;
      const id = String(input.id || "").trim();
      if (!id) return null;
      const now = new Date().toISOString();
      insertBuild.run(
        id,
        input.namespace === "conversation" ? "conversation" : "library",
        String(input.compiler || ""),
        Number(input.pageCount) || 0,
        Number(input.linkCount) || 0,
        now,
      );
      return {
        id,
        namespace: input.namespace === "conversation" ? "conversation" : "library",
        compiler: String(input.compiler || ""),
        pageCount: Number(input.pageCount) || 0,
        linkCount: Number(input.linkCount) || 0,
        createdAt: now,
      };
    },
    recordCompileRun(input) {
      if (!compileRunsReady() || !insertCompileRun) return null;
      const id = String(input.id || "").trim();
      const pageId = String(input.pageId || "").trim();
      if (!id || !pageId) return null;
      const now = new Date().toISOString();
      insertCompileRun.run(
        id,
        pageId,
        String(input.compiler || ""),
        String(input.status || "failed"),
        Number(input.attempts) || 1,
        input.repaired ? 1 : 0,
        input.errorCode ? String(input.errorCode) : null,
        input.inputHash ? String(input.inputHash) : null,
        Number(input.sectionCount) || 0,
        Number(input.batchCount) || 0,
        Number(input.claimCount) || 0,
        Number(input.tokenIn) || 0,
        Number(input.durationMs) || 0,
        now,
      );
      return {
        id,
        pageId,
        compiler: String(input.compiler || ""),
        status: String(input.status || "failed"),
        attempts: Number(input.attempts) || 1,
        repaired: Boolean(input.repaired),
        errorCode: input.errorCode ? String(input.errorCode) : undefined,
        createdAt: now,
      };
    },
    listCompileRuns(pageId) {
      if (!compileRunsReady() || !listCompileRunsStmt) return [];
      const id = String(pageId || "").trim();
      if (!id) return [];
      return listCompileRunsStmt.all(id).map((row) => ({
        id: row.id,
        pageId: row.pageId,
        compiler: row.compiler,
        status: row.status,
        attempts: Number(row.attempts) || 1,
        repaired: Boolean(row.repaired),
        errorCode: row.errorCode || undefined,
        inputHash: row.inputHash || undefined,
        sectionCount: Number(row.sectionCount) || 0,
        batchCount: Number(row.batchCount) || 0,
        claimCount: Number(row.claimCount) || 0,
        tokenIn: Number(row.tokenIn) || 0,
        durationMs: Number(row.durationMs) || 0,
        createdAt: row.createdAt,
      }));
    },
    listRevisions(pageId) {
      if (!revisionsReady() || !listRevisionsStmt) return [];
      const id = String(pageId || "").trim();
      if (!id) return [];
      return listRevisionsStmt.all(id).map(parseRevisionRow).filter(Boolean);
    },
    restoreRevision(pageId, revision) {
      if (!revisionsReady() || !getRevisionStmt) return null;
      const id = String(pageId || "").trim();
      const rev = Number(revision);
      if (!id || !Number.isFinite(rev)) return null;
      const parsed = parseRevisionRow(getRevisionStmt.get(id, rev));
      const existing = this.getById(id);
      if (!parsed || !existing) return null;
      const snap = parsed.snapshot || {};
      return this.upsert(
        {
          ...existing,
          title: snap.title || existing.title,
          markdown: Object.prototype.hasOwnProperty.call(snap, "markdown")
            ? snap.markdown
            : existing.markdown,
          sections: Array.isArray(snap.sections)
            ? snap.sections
            : existing.sections,
          synthesisMarkdown: snap.synthesisMarkdown || "",
          notesMarkdown: snap.notesMarkdown || "",
          knowledge: Object.prototype.hasOwnProperty.call(snap, "knowledge")
            ? snap.knowledge
            : existing.knowledge,
          userEdited: Boolean(snap.userEdited),
          status: snap.status || existing.status,
          compiler: snap.compiler || existing.compiler,
          synthesisCompiler: snap.synthesisCompiler || existing.synthesisCompiler,
        },
        { revisionReason: "restore" },
      );
    },
    markConceptsStaleForSource(sourceDocumentId) {
      const id = String(sourceDocumentId || "").trim();
      if (!id) return 0;
      return withTransaction(() => {
        let stale = 0;
        for (const row of listConceptRows.all()) {
          const page = rowToPage(row);
          if (!page || page.status === "stale") continue;
          const citesSections = (
            Array.isArray(page.sections) ? page.sections : []
          ).some((section) => String(section.sourceDocumentId || "") === id);
          const citesKnowledge = (page.knowledge?.claims || []).some((claim) =>
            (claim.evidence || []).some((item) => item.documentId === id),
          );
          if (!citesSections && !citesKnowledge) continue;
          this.upsert({ ...page, status: "stale" });
          stale += 1;
        }
        return stale;
      });
    },
    dropDocumentFromConcepts(sourceDocumentId) {
      const id = String(sourceDocumentId || "").trim();
      if (!id) return { updated: 0, deleted: 0 };
      return withTransaction(() => {
        let updated = 0;
        let deleted = 0;
        for (const row of listConceptRows.all()) {
          const page = rowToPage(row);
          if (!page) continue;
          const sections = Array.isArray(page.sections) ? page.sections : [];
          const droppedChunkIds = new Set(
            sections
              .filter((section) => String(section.sourceDocumentId || "") === id)
              .map((section) => String(section.chunkId || ""))
              .filter(Boolean),
          );
          const nextSections = sections.filter(
            (section) => String(section.sourceDocumentId || "") !== id,
          );
          const citesKnowledge = (page.knowledge?.claims || []).some((claim) =>
            (claim.evidence || []).some((item) => item.documentId === id),
          );
          if (nextSections.length === sections.length && !citesKnowledge) continue;
          if (nextSections.length === 0) {
            this.deleteById(page.id);
            deleted += 1;
            continue;
          }
          const knowledge = stripKnowledgeForDocument(
            page.knowledge,
            id,
            droppedChunkIds,
          );
          this.upsert({
            ...page,
            sections: nextSections,
            knowledge,
            status: "stale",
          });
          updated += 1;
        }
        return { updated, deleted };
      });
    },
    withdrawLibrarySource(sourceDocumentId) {
      const id = String(sourceDocumentId || "").trim();
      if (!id) return { updated: 0, deleted: 0, droppedMirror: 0 };
      return withTransaction(() => {
        const dropped = this.dropDocumentFromConcepts(id);
        let droppedMirror = 0;
        for (const row of listBySource.all("library", id)) {
          if (!row?.id) continue;
          this.deleteById(row.id);
          droppedMirror += 1;
        }
        return { ...dropped, droppedMirror };
      });
    },
    saveDecision(input) {
      if (!maturityReady() || !insertDecision) return null;
      const id = String(input.id || "").trim();
      if (!id) return null;
      const now = new Date().toISOString();
      insertDecision.run(
        id,
        String(input.action || ""),
        JSON.stringify(input),
        now,
      );
      return { ...input, createdAt: now };
    },
    listDecisions() {
      if (!maturityReady() || !listDecisionsStmt) return [];
      return listDecisionsStmt.all().map((row) => {
        try {
          return JSON.parse(row.payloadJson);
        } catch {
          return { id: row.id, action: row.action };
        }
      });
    },
    replacePendingEdges(fromId, edges) {
      if (!maturityReady() || !deletePendingFrom || !insertPendingEdge) {
        return [];
      }
      return withTransaction(() => {
        const id = String(fromId || "").trim();
        if (!id) return [];
        deletePendingFrom.run(id);
        const written = [];
        for (const edge of Array.isArray(edges) ? edges : []) {
          const target = String(edge.target || "").trim();
          const rel = String(edge.rel || "related_to").trim();
          if (!target) continue;
          insertPendingEdge.run(
            id,
            target,
            rel,
            JSON.stringify(edge.citationSectionIndexes || []),
            "pending",
          );
          written.push({ fromId: id, target, rel, status: "pending" });
        }
        return written;
      });
    },
    listPendingEdges(fromId) {
      if (!maturityReady() || !listPendingFrom) return [];
      const id = String(fromId || "").trim();
      if (!id) return [];
      return listPendingFrom.all(id).map((row) => {
        let citationSectionIndexes = [];
        try {
          citationSectionIndexes = JSON.parse(row.citationsJson || "[]");
        } catch {
          citationSectionIndexes = [];
        }
        return {
          fromId: row.fromId,
          target: row.target,
          rel: row.rel,
          citationSectionIndexes: Array.isArray(citationSectionIndexes)
            ? citationSectionIndexes
            : [],
          status: row.status,
        };
      });
    },
    listAllPendingEdges() {
      if (!maturityReady() || !listAllPendingStmt) return [];
      return listAllPendingStmt.all().map((row) => {
        let citationSectionIndexes = [];
        try {
          citationSectionIndexes = JSON.parse(row.citationsJson || "[]");
        } catch {
          citationSectionIndexes = [];
        }
        return {
          fromId: row.fromId,
          target: row.target,
          rel: row.rel,
          citationSectionIndexes: Array.isArray(citationSectionIndexes)
            ? citationSectionIndexes
            : [],
          status: row.status,
        };
      });
    },
    saveCandidate(input) {
      if (!maturityReady() || !insertCandidate) return null;
      const id = String(input.id || "").trim();
      const pageId = String(input.pageId || "").trim();
      if (!id || !pageId) return null;
      const now = new Date().toISOString();
      insertCandidate.run(
        id,
        pageId,
        String(input.kind || "note"),
        String(input.status || "pending"),
        String(input.text || ""),
        JSON.stringify(input.payload || {}),
        now,
      );
      return { ...input, createdAt: now };
    },
    getCandidate(id) {
      if (!maturityReady() || !getCandidateStmt) return null;
      const candidateId = String(id || "").trim();
      if (!candidateId) return null;
      return parseCandidate(getCandidateStmt.get(candidateId));
    },
    listCandidates(input = {}) {
      if (!maturityReady() || !listCandidatesStmt) return [];
      const pageId = String(input.pageId || "").trim();
      if (!pageId) return [];
      const status = String(input.status || "").trim() || null;
      return listCandidatesStmt
        .all(pageId, status, status)
        .map(parseCandidate)
        .filter(Boolean);
    },
    updateCandidateStatus(id, status) {
      if (!maturityReady() || !updateCandidateStmt) return null;
      const candidateId = String(id || "").trim();
      const nextStatus = String(status || "").trim();
      if (!candidateId || !nextStatus) return null;
      updateCandidateStmt.run(nextStatus, candidateId);
      return this.getCandidate(candidateId);
    },
  };
}
