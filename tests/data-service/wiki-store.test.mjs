import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "../../scripts/data-service/migrations/index.mjs";
import { createWikiStore } from "../../scripts/data-service/wiki-store.mjs";

function withStore(run) {
  const dir = mkdtempSync(join(tmpdir(), "orynode-wiki-"));
  const database = new DatabaseSync(join(dir, "test.db"));
  try {
    migrateDatabase(database);
    return run(createWikiStore(database), database);
  } finally {
    database.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("wiki-store: 重抽大纲保留综述，人改后标记 userEdited", () => {
  withStore((store) => {
    store.upsert({
      id: "mirror:library:doc-1",
      slug: "mirror:library:doc-1",
      title: "手册",
      kind: "document_mirror",
      namespace: "library",
      sourceDocumentId: "doc-1",
      markdown: "# 手册\n\n## 安装",
      sections: [{ heading: "安装", excerpt: "步骤", chunkId: "c1", pageNumber: 1, headingPath: ["安装"] }],
      compiler: "heading_extract_v1",
      status: "ready",
      synthesisMarkdown: "这是综述 [S1]",
      synthesisCompiler: "gemma_synthesis_v1",
      notesMarkdown: "旧笔记",
      knowledge: {
        aliases: ["手册"],
        claims: [
          {
            id: "cl1",
            text: "安装分两步",
            citationSectionIndexes: [1],
            sourceChunkIds: ["c1"],
          },
        ],
        relations: [],
      },
    });
    const refreshed = store.upsert({
      id: "mirror:library:doc-1",
      slug: "mirror:library:doc-1",
      title: "手册",
      kind: "document_mirror",
      namespace: "library",
      sourceDocumentId: "doc-1",
      markdown: "# 手册\n\n## 安装\n新大纲",
      sections: [{ heading: "安装", excerpt: "新步骤", chunkId: "c1", pageNumber: 1, headingPath: ["安装"] }],
      compiler: "heading_extract_v1",
      status: "stale",
    });
    assert.equal(refreshed.synthesisMarkdown, "这是综述 [S1]");
    assert.equal(refreshed.status, "stale");
    assert.equal(refreshed.userEdited, false);
    assert.equal(refreshed.notesMarkdown, "旧笔记");
    assert.equal(refreshed.knowledge?.claims?.[0]?.id, "cl1");
    assert.equal(refreshed.knowledge?.aliases?.[0], "手册");

    const edited = store.upsert({
      ...refreshed,
      synthesisMarkdown: "人手改过的综述",
      userEdited: true,
      status: "ready",
    });
    assert.equal(edited.userEdited, true);
    assert.equal(edited.synthesisMarkdown, "人手改过的综述");
  });
});

test("wiki-store: 链接与反链、删除页时清边", () => {
  withStore((store) => {
    store.upsert({
      id: "concept:library:install",
      slug: "concept:library:install",
      title: "安装",
      kind: "concept",
      namespace: "library",
      sourceDocumentId: "concept:install",
      markdown: "# 安装",
      sections: [],
      compiler: "concept_cluster_v1",
      status: "ready",
    });
    store.upsert({
      id: "mirror:library:doc-1",
      slug: "mirror:library:doc-1",
      title: "手册",
      kind: "document_mirror",
      namespace: "library",
      sourceDocumentId: "doc-1",
      markdown: "# 手册",
      sections: [],
      compiler: "heading_extract_v1",
      status: "ready",
    });
    store.replaceLinks("concept:library:install", [
      { toId: "mirror:library:doc-1", rel: "cites" },
    ]);
    const links = store.listLinks("mirror:library:doc-1");
    assert.equal(links.incoming.length, 1);
    assert.equal(links.incoming[0].fromId, "concept:library:install");
    store.deleteById("concept:library:install");
    assert.equal(store.listLinks("mirror:library:doc-1").incoming.length, 0);
    assert.equal(store.getById("concept:library:install"), null);
  });
});

test("wiki-store: 删除资料时从概念页摘掉该文档，无剩余节则删页", () => {
  withStore((store) => {
    store.upsert({
      id: "concept:library:install",
      slug: "concept:library:install",
      title: "安装",
      kind: "concept",
      namespace: "library",
      sourceDocumentId: "concept:install",
      markdown: "# 安装",
      sections: [
        { heading: "A", excerpt: "a", chunkId: "c1", pageNumber: 1, sourceDocumentId: "doc-a" },
        { heading: "B", excerpt: "b", chunkId: "c2", pageNumber: 1, sourceDocumentId: "doc-b" },
      ],
      compiler: "concept_cluster_v1",
      status: "ready",
      synthesisMarkdown: "旧概念综述 [S1]",
      knowledge: {
        aliases: [],
        claims: [
          {
            id: "keep",
            text: "B 仍在",
            citationSectionIndexes: [2],
            sourceChunkIds: ["c2"],
            status: "active",
            evidence: [{ documentId: "doc-b", chunkId: "c2" }],
          },
          {
            id: "drop",
            text: "只靠 A",
            citationSectionIndexes: [1],
            sourceChunkIds: ["c1"],
            status: "active",
            evidence: [{ documentId: "doc-a", chunkId: "c1" }],
          },
        ],
        relations: [],
      },
    });
    const stale = store.markConceptsStaleForSource("doc-a");
    assert.equal(stale, 1);
    assert.equal(store.getById("concept:library:install").status, "stale");
    const dropped = store.dropDocumentFromConcepts("doc-a");
    assert.equal(dropped.updated, 1);
    assert.equal(dropped.deleted, 0);
    const kept = store.getById("concept:library:install");
    assert.equal(kept.sections.length, 1);
    assert.equal(kept.sections[0].sourceDocumentId, "doc-b");
    assert.equal(
      kept.knowledge.claims.find((claim) => claim.id === "drop").status,
      "withdrawn",
    );
    assert.equal(
      kept.knowledge.claims.find((claim) => claim.id === "keep").status,
      "active",
    );
    const removed = store.dropDocumentFromConcepts("doc-b");
    assert.equal(removed.deleted, 1);
    assert.equal(store.getById("concept:library:install"), null);
  });
});

test("wiki-store: FTS 用内容词 AND，问句词不能单独命中小说", () => {
  withStore((store) => {
    store.upsert({
      id: "mirror:library:novel",
      slug: "mirror:library:novel",
      title: "百年孤独",
      kind: "document_mirror",
      namespace: "library",
      sourceDocumentId: "novel",
      markdown: "# 百年孤独\n多年以后他想起了什么是冰块。",
      sections: [
        { heading: "第 1 页", excerpt: "多年以后他想起了什么", chunkId: "n1", pageNumber: 1 },
      ],
      compiler: "heading_extract_v1",
      status: "ready",
    });
    store.upsert({
      id: "mirror:library:php",
      slug: "mirror:library:php",
      title: "PHP7内核剖析",
      kind: "document_mirror",
      namespace: "library",
      sourceDocumentId: "php",
      markdown: "# PHP7\nZend 内存池负责请求级分配。",
      sections: [
        { heading: "内存管理", excerpt: "Zend 内存池", chunkId: "p1", pageNumber: 40 },
      ],
      compiler: "heading_extract_v1",
      status: "ready",
    });
    const found = store.search({ query: "zend内存池是什么", namespace: "library" });
    assert.equal(found[0]?.title.includes("PHP7"), true);
    assert.equal(found.some((page) => page.title.includes("孤独")), false);
  });
});

test("wiki-store: 编译失败 run 可记录且不改页", () => {
  withStore((store) => {
    store.upsert({
      id: "mirror:library:doc-1",
      slug: "mirror:library:doc-1",
      title: "手册",
      kind: "document_mirror",
      namespace: "library",
      sourceDocumentId: "doc-1",
      markdown: "# 手册",
      sections: [{ heading: "安装", excerpt: "步骤", chunkId: "c1", pageNumber: 1, headingPath: ["安装"] }],
      compiler: "heading_extract_v1",
      status: "ready",
      synthesisMarkdown: "旧综述 [S1]",
    });
    const run = store.recordCompileRun({
      id: "run-1",
      pageId: "mirror:library:doc-1",
      compiler: "gemma_knowledge_v3",
      status: "failed",
      attempts: 2,
      repaired: true,
      errorCode: "WIKI_KNOWLEDGE_NOT_JSON",
      sectionCount: 3,
      batchCount: 1,
      claimCount: 0,
      tokenIn: 800,
      durationMs: 12,
    });
    assert.equal(run.status, "failed");
    assert.equal(store.getById("mirror:library:doc-1").synthesisMarkdown, "旧综述 [S1]");
  });
});

test("wiki-store: 决策、pending 边与候选可落表", () => {
  withStore((store) => {
    store.saveDecision({
      id: "dec-1",
      action: "merge",
      fromKey: "OOP",
      toKey: "面向对象",
    });
    const decisions = store.listDecisions();
    assert.equal(decisions[0].action, "merge");
    const edges = store.replacePendingEdges("concept:library:oop", [
      { target: "尚未存在", rel: "related_to", citationSectionIndexes: [1] },
    ]);
    assert.equal(edges.length, 1);
    assert.equal(store.listPendingEdges("concept:library:oop")[0].target, "尚未存在");
    const candidate = store.saveCandidate({
      id: "cand-1",
      pageId: "concept:library:oop",
      kind: "pending_merge",
      status: "pending",
      text: "待审核",
      payload: { skippedDocumentIds: ["doc-b"] },
    });
    assert.equal(candidate.kind, "pending_merge");
    const listed = store.listCandidates({
      pageId: "concept:library:oop",
      status: "pending",
    });
    assert.equal(listed.length, 1);
    const accepted = store.updateCandidateStatus("cand-1", "accepted");
    assert.equal(accepted.status, "accepted");
    assert.equal(
      store.listCandidates({ pageId: "concept:library:oop", status: "pending" })
        .length,
      0,
    );
  });
});

test("wiki-store: 删页级联 compile runs / pending / candidates，发布带边原子", () => {
  withStore((store) => {
    store.upsert({
      id: "concept:library:oop",
      slug: "concept:library:oop",
      title: "OOP",
      kind: "concept",
      namespace: "library",
      sourceDocumentId: "concept:oop",
      markdown: "# OOP",
      sections: [],
      compiler: "concept_cluster_v1",
      status: "ready",
    });
    store.recordCompileRun({
      id: "run-del",
      pageId: "concept:library:oop",
      compiler: "gemma_knowledge_v3",
      status: "failed",
      attempts: 1,
    });
    store.replacePendingEdges("concept:library:oop", [
      { target: "ghost", rel: "related_to", citationSectionIndexes: [1] },
    ]);
    store.saveCandidate({
      id: "cand-del",
      pageId: "concept:library:oop",
      kind: "pending_merge",
      status: "pending",
      text: "待清",
      payload: {},
    });
    store.deleteById("concept:library:oop");
    assert.equal(store.getById("concept:library:oop"), null);
    assert.equal(store.listPendingEdges("concept:library:oop").length, 0);
    assert.equal(store.listCandidates({ pageId: "concept:library:oop" }).length, 0);
    assert.equal(store.listRevisions("concept:library:oop").length, 0);
    assert.equal(store.listCompileRuns("concept:library:oop").length, 0);

    const published = store.publish({
      page: {
        id: "mirror:library:doc-1",
        slug: "mirror:library:doc-1",
        title: "手册",
        kind: "document_mirror",
        namespace: "library",
        sourceDocumentId: "doc-1",
        markdown: "# 手册",
        sections: [],
        compiler: "heading_extract_v1",
        status: "ready",
      },
      links: [{ toId: "concept:library:install", rel: "see_also" }],
      pendingEdges: [{ target: "未解析", rel: "related_to" }],
    });
    assert.equal(published.title, "手册");
    assert.equal(store.listLinks("mirror:library:doc-1").outgoing.length, 1);
    assert.equal(store.listPendingEdges("mirror:library:doc-1")[0].target, "未解析");
  });
});

test("wiki-store: 综述变更写入历史并可回滚", () => {
  withStore((store) => {
    store.upsert({
      id: "mirror:library:doc-1",
      slug: "mirror:library:doc-1",
      title: "手册",
      kind: "document_mirror",
      namespace: "library",
      sourceDocumentId: "doc-1",
      markdown: "# 手册",
      sections: [],
      compiler: "heading_extract_v1",
      status: "ready",
    });
    store.publish({
      page: {
        id: "mirror:library:doc-1",
        slug: "mirror:library:doc-1",
        title: "手册",
        kind: "document_mirror",
        namespace: "library",
        sourceDocumentId: "doc-1",
        markdown: "# 手册",
        sections: [],
        compiler: "heading_extract_v1",
        status: "ready",
        synthesisMarkdown: "第一版综述 [S1]",
        knowledge: { aliases: [], claims: [], relations: [] },
      },
    });
    store.upsert(
      {
        id: "mirror:library:doc-1",
        slug: "mirror:library:doc-1",
        title: "手册",
        kind: "document_mirror",
        namespace: "library",
        sourceDocumentId: "doc-1",
        markdown: "# 手册",
        sections: [],
        compiler: "heading_extract_v1",
        status: "ready",
        synthesisMarkdown: "人手改过",
        userEdited: true,
      },
      { revisionReason: "edit" },
    );
    const history = store.listRevisions("mirror:library:doc-1");
    assert.ok(history.length >= 1);
    assert.equal(history[0].reason, "edit");
    const restored = store.restoreRevision("mirror:library:doc-1", history[0].revision);
    assert.equal(restored.synthesisMarkdown, "第一版综述 [S1]");
    assert.equal(restored.userEdited, false);
    assert.equal(store.listCompileRuns("mirror:library:doc-1").length, 0);
    store.recordCompileRun({
      id: "run-list",
      pageId: "mirror:library:doc-1",
      compiler: "gemma_knowledge_v3",
      status: "failed",
      attempts: 2,
      errorCode: "WIKI_KNOWLEDGE_NOT_JSON",
    });
    assert.equal(store.listCompileRuns("mirror:library:doc-1")[0].errorCode, "WIKI_KNOWLEDGE_NOT_JSON");
  });
});

test("wiki-store: 大纲与 sections 变更进入历史并可回滚", () => {
  withStore((store) => {
    const base = {
      id: "mirror:library:doc-outline",
      slug: "mirror:library:doc-outline",
      title: "手册",
      kind: "document_mirror",
      namespace: "library",
      sourceDocumentId: "doc-outline",
      markdown: "# 旧大纲",
      sections: [{ chunkId: "c1", heading: "旧章节", excerpt: "旧内容" }],
      compiler: "heading_extract_v1",
      status: "ready",
    };
    store.upsert(base);
    store.upsert({
      ...base,
      markdown: "# 新大纲",
      sections: [{ chunkId: "c2", heading: "新章节", excerpt: "新内容" }],
    });
    const [history] = store.listRevisions(base.id);
    assert.equal(history.reason, "outline");
    const restored = store.restoreRevision(base.id, history.revision);
    assert.equal(restored.markdown, "# 旧大纲");
    assert.equal(restored.sections[0].chunkId, "c1");
  });
});

test("wiki-store: 同 namespace+source 不能双页", () => {
  withStore((store) => {
    const page = {
      slug: "mirror:library:doc-1",
      title: "手册",
      kind: "document_mirror",
      namespace: "library",
      sourceDocumentId: "doc-1",
      markdown: "# 手册",
      sections: [],
      compiler: "heading_extract_v1",
      status: "ready",
    };
    store.upsert({ ...page, id: "mirror:library:doc-1" });
    assert.throws(
      () => store.upsert({ ...page, id: "mirror:library:doc-1-dup" }),
      /UNIQUE/i,
    );
    assert.equal(store.getBySource("library", "doc-1").id, "mirror:library:doc-1");
  });
});

test("wiki-store: 按 sourceDocumentIds 先过滤再 LIMIT", () => {
  withStore((store) => {
    for (const id of ["s1", "s2", "s3"]) {
      store.upsert({
        id: `mirror:conversation:${id}`,
        slug: `mirror:conversation:${id}`,
        title: id,
        kind: "document_mirror",
        namespace: "conversation",
        sourceDocumentId: id,
        markdown: `# ${id}`,
        sections: [],
        compiler: "heading_extract_v1",
        status: "ready",
      });
    }
    const listed = store.list({
      namespace: "conversation",
      limit: 1,
      sourceDocumentIds: ["s1"],
    });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].sourceDocumentId, "s1");
  });
});
