/**
 * P1–P4 确定性黄金集：身份、主张、增量、沉淀、故障与资源门禁。
 * 不接入真实 Gemma 生成评测；编译质量由结构化 schema、引用门禁与单测覆盖。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  bindClaimEvidence,
  diffWikiClaims,
  stripSourceFromKnowledge,
} from "../../services/knowledge/wiki/claim-diff";
import { compileConceptPages } from "../../services/knowledge/wiki/compile-concepts";
import {
  compileDocumentMirror,
  type WikiClaim,
  type WikiSection,
} from "../../services/knowledge/wiki/compile-document-mirror";
import { claimFingerprint } from "../../services/knowledge/wiki/compile-synthesis";
import {
  packWikiSections,
  WIKI_PACK_MAX_BATCHES,
} from "../../services/knowledge/wiki/context-packer";
import { hitsFromCompiledPage } from "../../services/knowledge/wiki/load-wiki-hits";
import { assertPublishableKnowledge } from "../../services/knowledge/wiki/publish";
import {
  appendWikiNotes,
  removeSettleNote,
  stripSettleMarkers,
  undoWikiSettle,
} from "../../services/knowledge/wiki/run-settle";
import { lastSettleId, settleIdForBody } from "../../services/knowledge/wiki/settle-markers";
import { reviewWikiCandidate } from "../../services/knowledge/wiki/run-candidate-review";
import { collapseSettleTargets } from "../../services/knowledge/wiki/settle-plan";
import { resolveWikiRelations, promotePendingWikiEdges } from "../../services/knowledge/wiki/wiki-relations";
import { WIKI_LIBRARY_SCAN_CAP } from "../../services/knowledge/wiki/compile-document-mirror";

function section(partial: Partial<WikiSection> & { chunkId: string }): WikiSection {
  return {
    heading: partial.heading || "节",
    excerpt: partial.excerpt || "摘录",
    chunkId: partial.chunkId,
    pageNumber: partial.pageNumber ?? 1,
    headingPath: partial.headingPath || [partial.heading || "节"],
    sourceDocumentId: partial.sourceDocumentId,
    sourceDocumentTitle: partial.sourceDocumentTitle,
  };
}

function claim(partial: Partial<WikiClaim> & { text: string; id: string }): WikiClaim {
  return {
    id: partial.id,
    text: partial.text,
    citationSectionIndexes: partial.citationSectionIndexes ?? [1],
    sourceChunkIds: partial.sourceChunkIds ?? [],
    fingerprint: partial.fingerprint || claimFingerprint(partial.text),
    evidence: partial.evidence,
    status: partial.status ?? "active",
  };
}

function mirror(documentId: string, heading: string, content: string) {
  return compileDocumentMirror({
    namespace: "library",
    documentId,
    title: `${documentId}.md`,
    chunks: [
      {
        id: `${documentId}-1`,
        pageNumber: 1,
        headingPath: [heading],
        content: `# ${heading}\n${content}`,
      },
    ],
  });
}

test("P1: OOP 与面向对象归并到同一 canonical 身份", () => {
  const { pages } = compileConceptPages({
    mirrors: [
      mirror("doc-oop", "OOP", "OOP 使用对象组织程序。"),
      mirror("doc-oo", "面向对象", "面向对象把数据与行为放在一起。"),
    ],
    terminologyEntries: [{ id: "object-oriented", terms: ["面向对象", "OOP"] }],
  });
  const page = pages.find((item) => item.identity?.stableId === "term:object-oriented");
  assert.ok(page);
  assert.equal(page?.title, "面向对象");
  assert.equal(pages.some((item) => item.title === "OOP"), false);
  assert.ok(page?.knowledge?.aliases.includes("OOP"));
  assert.equal(page?.sections.some((item) => item.sourceDocumentId === "doc-oop"), true);
  assert.equal(page?.sections.some((item) => item.sourceDocumentId === "doc-oo"), true);
});

test("P1: 人工 merge 把别名簇并入目标，split 按文档消歧", () => {
  const merged = compileConceptPages({
    mirrors: [
      mirror("doc-a", "封装", "把内部状态藏起来。"),
      mirror("doc-b", "继承", "子类复用父类。"),
    ],
    decisions: [
      {
        id: "d-merge",
        action: "merge",
        fromKey: "继承",
        toKey: "封装",
      },
    ],
  });
  assert.equal(merged.pages.length, 1);
  assert.equal(merged.pages[0]?.title, "封装");
  assert.ok(merged.pages[0]?.identity?.pinned);
  assert.ok(merged.pages[0]?.knowledge?.identity?.aliases.includes("继承"));

  const split = compileConceptPages({
    mirrors: [
      mirror("doc-java", "模型", "Java 的模型层。"),
      mirror("doc-ml", "模型", "机器学习的模型。"),
    ],
    decisions: [
      {
        id: "d-split",
        action: "split",
        fromKey: "模型",
        documentIds: ["doc-ml"],
        disambiguation: "ml",
      },
    ],
  });
  const modelPages = split.pages.filter((page) => page.title === "模型");
  assert.equal(modelPages.length, 2);
  const keys = modelPages.map((page) => page.sourceDocumentId).sort();
  assert.deepEqual(keys, ["concept:模型", "concept:模型ml"]);
});

test("P1: 没有有效 chunk 的 claim 不得发布", () => {
  const sections = [section({ chunkId: "c1", excerpt: "安装步骤" })];
  assert.throws(
    () =>
      assertPublishableKnowledge(
        {
          articleMarkdown: `${"没有出处的长段落。".repeat(12)}`,
          knowledge: {
            aliases: [],
            claims: [
              claim({
                id: "c1",
                text: "没有回源",
                citationSectionIndexes: [1],
                sourceChunkIds: [],
              }),
            ],
            relations: [],
          },
        },
        sections,
      ),
    /WIKI_KNOWLEDGE_NO_EVIDENCE/,
  );
  const bound = bindClaimEvidence(
    claim({
      id: "c1",
      text: "有回源",
      citationSectionIndexes: [1],
      sourceChunkIds: [],
    }),
    sections,
    "doc-1",
  );
  assert.equal(bound.evidence?.[0]?.chunkId, "c1");
  assert.equal(bound.evidence?.[0]?.documentId, "doc-1");
});

test("P2: claim diff 撤回旧主张，同证据不同文标 conflicted", () => {
  const previous = [
    claim({
      id: "old",
      text: "旧说法",
      sourceChunkIds: ["c1"],
      evidence: [{ documentId: "doc-a", chunkId: "c1" }],
    }),
  ];
  const next = [
    claim({
      id: "new",
      text: "新说法",
      sourceChunkIds: ["c1"],
      evidence: [{ documentId: "doc-a", chunkId: "c1" }],
    }),
  ];
  const diffed = diffWikiClaims(previous, next);
  assert.equal(diffed.find((item) => item.text === "新说法")?.status, "conflicted");
  assert.equal(diffed.find((item) => item.text === "旧说法")?.status, "withdrawn");
});

test("P2: 删除源后撤回失去证据的 claim，无悬空 chunk", () => {
  const knowledge = {
    aliases: [],
    claims: [
      claim({
        id: "keep",
        text: "仍在",
        sourceChunkIds: ["a1", "b1"],
        evidence: [
          { documentId: "doc-a", chunkId: "a1" },
          { documentId: "doc-b", chunkId: "b1" },
        ],
      }),
      claim({
        id: "drop",
        text: "只靠 A",
        sourceChunkIds: ["a1"],
        evidence: [{ documentId: "doc-a", chunkId: "a1" }],
      }),
    ],
    relations: [],
  };
  const next = stripSourceFromKnowledge(knowledge, "doc-a", new Set(["a1"]));
  assert.equal(next?.claims.find((item) => item.id === "drop")?.status, "withdrawn");
  assert.equal(next?.claims.find((item) => item.id === "keep")?.status, "active");
  assert.deepEqual(
    next?.claims.find((item) => item.id === "keep")?.evidence,
    [{ documentId: "doc-b", chunkId: "b1" }],
  );
});

test("P2: 无法解析的语义边保持 pending，禁止造页", () => {
  const resolved = resolveWikiRelations({
    fromId: "concept:library:oop",
    relations: [
      {
        target: "面向对象",
        rel: "is_a",
        citationSectionIndexes: [1],
      },
      {
        target: "尚未存在的概念",
        rel: "related_to",
        citationSectionIndexes: [1],
      },
    ],
    catalog: [
      {
        id: "concept:library:面向对象",
        title: "面向对象",
        aliases: ["OOP"],
      },
    ],
  });
  assert.equal(resolved.resolved.length, 1);
  assert.equal(resolved.resolved[0]?.toId, "concept:library:面向对象");
  assert.equal(resolved.pending.length, 1);
  assert.equal(resolved.pending[0]?.status, "pending");
  assert.equal(resolved.pending[0]?.target, "尚未存在的概念");
});

test("P2: 新概念出现后 pending 边可以提升为正式链接", () => {
  const promoted = promotePendingWikiEdges({
    pending: [
      {
        fromId: "concept:library:oop",
        target: "尚未存在的概念",
        rel: "related_to",
        citationSectionIndexes: [1],
      },
    ],
    catalog: [
      {
        id: "concept:library:new",
        title: "尚未存在的概念",
      },
    ],
  });
  assert.equal(promoted[0]?.resolved[0]?.toId, "concept:library:new");
  assert.equal(promoted[0]?.remaining.length, 0);
});

test("P2: 检索跳过 withdrawn claim", () => {
  const page = compileDocumentMirror({
    namespace: "library",
    documentId: "doc-1",
    title: "手册.md",
    chunks: [
      {
        id: "c1",
        pageNumber: 1,
        headingPath: ["安装"],
        content: "# 安装\n步骤。",
      },
    ],
  });
  page.knowledge = {
    aliases: [],
    claims: [
      claim({
        id: "live",
        text: "现行安装步骤",
        sourceChunkIds: ["c1"],
        status: "active",
      }),
      claim({
        id: "gone",
        text: "已撤回的说法",
        sourceChunkIds: ["c1"],
        status: "withdrawn",
      }),
    ],
    relations: [],
  };
  const hits = hitsFromCompiledPage(page, "library");
  const texts = hits.map((hit) => hit.content).join("\n");
  assert.match(texts, /现行安装步骤/);
  assert.equal(texts.includes("已撤回的说法"), false);
});

test("P3: 沉淀对准概念页，多文档不广播", () => {
  const plan = collapseSettleTargets({
    markdown: "面向对象把状态与行为放在一起。",
    targets: [
      { documentId: "doc-a", namespace: "library", title: "手册 A" },
      { documentId: "doc-b", namespace: "library", title: "手册 B" },
    ],
    concepts: [
      {
        id: "concept:library:面向对象",
        title: "面向对象",
        identity: {
          stableId: "term:object-oriented",
          canonicalTitle: "面向对象",
          aliases: ["OOP"],
        },
        knowledge: { aliases: ["OOP"], claims: [], relations: [] },
      },
    ],
  });
  assert.equal(plan?.mode, "concept");
  assert.equal(plan?.target.pageId, "concept:library:面向对象");
  assert.equal(plan?.pendingMerge, true);
  assert.deepEqual(plan?.skippedDocumentIds, ["doc-b"]);
});

test("P3: settle 笔记可按 settleId 撤销", async () => {
  const settleId = "settle-1";
  const notes = appendWikiNotes(
    undefined,
    "本轮回答",
    "2026-09-09T09:15:00.000Z",
    settleId,
  );
  assert.match(notes, /orynode-settle:settle-1/);
  assert.equal(stripSettleMarkers(notes).includes("orynode-settle"), false);
  assert.equal(lastSettleId(notes), settleId);
  assert.equal(settleIdForBody(notes, "本轮回答"), settleId);
  assert.match(stripSettleMarkers(notes), /本轮回答/);
  const removed = removeSettleNote(notes, settleId);
  assert.equal(removed.includes("本轮回答"), false);

  const patched: string[] = [];
  const page = await undoWikiSettle({
    settleId,
    pageId: "mirror:library:doc-a",
    fetchPageById: async () => ({
      id: "mirror:library:doc-a",
      slug: "mirror:library:doc-a",
      title: "手册",
      kind: "document_mirror",
      namespace: "library",
      sourceDocumentId: "doc-a",
      markdown: "md",
      sections: [],
      compiler: "heading_extract_v1",
      status: "ready",
      notesMarkdown: notes,
    }),
    patchPage: async (_pageId, patch) => {
      patched.push(patch.notesMarkdown || "");
      return {
        id: "mirror:library:doc-a",
        slug: "mirror:library:doc-a",
        title: "手册",
        kind: "document_mirror",
        namespace: "library",
        sourceDocumentId: "doc-a",
        markdown: "md",
        sections: [],
        compiler: "heading_extract_v1",
        status: "ready",
        notesMarkdown: patch.notesMarkdown,
      };
    },
  });
  assert.equal(page?.notesMarkdown?.includes("本轮回答"), false);
  assert.equal(patched[0]?.includes("本轮回答"), false);
});

test("P3: 拒绝 pending_merge 候选会撤回笔记", async () => {
  let undone = false;
  const reviewed = await reviewWikiCandidate({
    id: "cand-1",
    action: "reject",
    getCandidate: async () => ({
      id: "cand-1",
      pageId: "concept:library:oop",
      kind: "pending_merge",
      status: "pending",
      text: "待审核",
      payload: { skippedDocumentIds: ["doc-b"] },
    }),
    undoSettle: async () => {
      undone = true;
      return {
        id: "concept:library:oop",
        slug: "concept:library:oop",
        title: "面向对象",
        kind: "concept",
        namespace: "library",
        sourceDocumentId: "concept:oop",
        markdown: "md",
        sections: [],
        compiler: "concept_cluster_v1",
        status: "ready",
      };
    },
    patchStatus: async (_id, status) => ({
      id: "cand-1",
      pageId: "concept:library:oop",
      kind: "pending_merge",
      status,
      text: "待审核",
    }),
    saveDecision: async () => null,
  });
  assert.equal(undone, true);
  assert.equal(reviewed.candidate.status, "rejected");
});

test("P4: 8GB 装箱最多 3 批，全库扫描硬顶 500", () => {
  const sections = Array.from({ length: 40 }, (_, index) =>
    section({
      heading: `第${index + 1}节`,
      excerpt: "足够长的摘录用来打满 token 预算。".repeat(20),
      chunkId: `c${index + 1}`,
      pageNumber: index + 1,
    }),
  );
  const packed = packWikiSections(sections, {
    inputBudgetTokens: 200,
    excerptMaxTokens: 40,
    maxBatches: WIKI_PACK_MAX_BATCHES,
  });
  assert.ok(packed.batches.length <= WIKI_PACK_MAX_BATCHES);
  assert.equal(WIKI_LIBRARY_SCAN_CAP, 500);
});
