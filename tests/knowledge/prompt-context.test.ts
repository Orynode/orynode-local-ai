import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCitedKnowledgePrompt,
  buildKnowledgePrompt,
  canonicalizeAssistantCitations,
  extractReferencedCitationIds,
} from "../../services/chat/prompt";
import {
  resolveContextBudget,
  estimateTokens,
} from "../../services/chat/context";
import {
  buildContextPackage,
  citationsFromHits,
  locatorFromHit,
} from "../../services/knowledge/context/build-context";
import {
  diversifyHits,
  findNeighborHits,
  KNOWLEDGE_OMISSION_MARK,
} from "../../services/knowledge/context/token-pack";
import type { RetrievalHit } from "../../services/knowledge/types";

function hit(
  partial: Partial<RetrievalHit> & Pick<RetrievalHit, "id" | "documentId" | "content">,
): RetrievalHit {
  return {
    documentName: partial.documentName ?? `${partial.documentId}.md`,
    pageNumber: partial.pageNumber ?? 1,
    position: partial.position ?? 0,
    score: partial.score ?? 1,
    source: partial.source ?? "library",
    ...partial,
  };
}

const libraryHit: RetrievalHit = hit({
  id: "c1",
  documentId: "d1",
  documentName: "手册.md",
  pageNumber: 2,
  content: "资料库内容",
});

const attachmentHit: RetrievalHit = hit({
  id: "c2",
  documentId: "f1",
  documentName: "笔记.txt",
  content: "附件内容",
  source: "conversation_file",
});

test("buildKnowledgePrompt: 区分资料库与会话附件并使用 [S#]", () => {
  const both = buildKnowledgePrompt([libraryHit, attachmentHit]);
  assert.match(both, /本地资料库与本对话附件/);
  assert.match(both, /\[S1\]/);
  assert.match(both, /\[S2\]/);
  assert.match(both, /LOCAL_KNOWLEDGE/);
  assert.match(both, /资料库 · 手册\.md/);
  assert.match(both, /本对话附件 · 笔记\.txt/);
});

test("citationsFromHits: 分配 S1..Sn、chunkId 与 locator", () => {
  const citations = citationsFromHits([libraryHit, attachmentHit]);
  assert.equal(citations[0]?.id, "S1");
  assert.equal(citations[0]?.chunkId, "c1");
  assert.equal(citations[1]?.id, "S2");
  assert.equal(citations[1]?.chunkId, "c2");
  assert.equal(citations[0]?.locator.kind, "markdown");
  assert.equal(citations[0]?.revisionId, "legacy");
});

test("locatorFromHit: PDF 用 page，Markdown 用 markdown", () => {
  const pdf = locatorFromHit(
    hit({
      id: "p1",
      documentId: "pdf1",
      documentName: "报告.pdf",
      pageNumber: 3,
      content: "x",
      startOffset: 10,
      endOffset: 40,
    }),
  );
  assert.deepEqual(pdf, {
    kind: "page",
    page: 3,
    startOffset: 10,
    endOffset: 40,
  });

  const md = locatorFromHit(
    hit({
      id: "m1",
      documentId: "md1",
      documentName: "readme.md",
      content: "y",
      headingPath: ["安装"],
      startLine: 12,
      endLine: 20,
    }),
  );
  assert.deepEqual(md, {
    kind: "markdown",
    headingPath: ["安装"],
    startLine: 12,
    endLine: 20,
  });
});

test("buildContextPackage: text 与 tokenEstimate", () => {
  const pkg = buildContextPackage({ hits: [libraryHit] });
  assert.match(pkg.text, /资料库内容/);
  assert.match(pkg.text, /\[S1\]/);
  assert.ok(pkg.tokenEstimate > 0);
  assert.equal(pkg.citations.length, 1);
  assert.equal(pkg.approximateTokens, true);
});

test("buildContextPackage: 预算下只保留完整进入 text 的 citations", () => {
  const longA = "甲".repeat(400);
  const longB = "乙".repeat(400);
  const hits = [
    hit({ id: "a", documentId: "dA", content: longA, score: 2 }),
    hit({ id: "b", documentId: "dB", content: longB, score: 1 }),
  ];
  const pkg = buildContextPackage({ hits, maxTokens: 220, expandNeighbors: false });
  assert.ok(pkg.citations.length >= 1);
  assert.ok(pkg.citations.length < hits.length || pkg.text.includes(KNOWLEDGE_OMISSION_MARK));
  for (const citation of pkg.citations) {
    assert.match(pkg.text, new RegExp(`\\[${citation.id}\\]`));
  }
  // citations 必须与 LOCAL_KNOWLEDGE 区内真实来源块一致
  const knowledgeBody =
    pkg.text.split("<<<LOCAL_KNOWLEDGE>>>")[1]?.split("<<<END_LOCAL_KNOWLEDGE>>>")[0] ??
    "";
  for (const citation of pkg.citations) {
    assert.match(knowledgeBody, new RegExp(`\\[${citation.id}\\]`));
  }
});

test("buildContextPackage: 极小预算仍保留指令头与 [S1]，不半截截断标记", () => {
  const pkg = buildContextPackage({
    hits: [hit({ id: "huge", documentId: "d", content: "内容".repeat(500) })],
    maxTokens: 80,
    expandNeighbors: false,
  });
  assert.match(pkg.text, /LOCAL_KNOWLEDGE/);
  assert.match(pkg.text, /\[S1\]/);
  assert.match(pkg.text, /END_LOCAL_KNOWLEDGE/);
  assert.equal(pkg.citations.length, 1);
  assert.match(pkg.text, new RegExp(KNOWLEDGE_OMISSION_MARK.replace(/[[\]]/g, "\\$&")));
});

test("diversifyHits: 轮询不同文档", () => {
  const hits = [
    hit({ id: "a1", documentId: "A", content: "a1", score: 5 }),
    hit({ id: "a2", documentId: "A", content: "a2", score: 4 }),
    hit({ id: "b1", documentId: "B", content: "b1", score: 3 }),
  ];
  const ordered = diversifyHits(hits);
  assert.equal(ordered[0]?.documentId, "A");
  assert.equal(ordered[1]?.documentId, "B");
  assert.equal(ordered[2]?.documentId, "A");
});

test("findNeighborHits: 同 revision 相邻 position", () => {
  const selected = [
    hit({ id: "n2", documentId: "D", content: "中", position: 2, revisionId: "r1" }),
  ];
  const candidates = [
    hit({ id: "n1", documentId: "D", content: "前", position: 1, revisionId: "r1" }),
    hit({ id: "n3", documentId: "D", content: "后", position: 3, revisionId: "r1" }),
    hit({ id: "other", documentId: "D", content: "旧", position: 1, revisionId: "r0" }),
  ];
  const neighbors = findNeighborHits(selected, candidates);
  assert.deepEqual(
    neighbors.map((n) => n.id).sort(),
    ["n1", "n3"],
  );
});

test("resolveContextBudget: knowledge 与 history 独立且不超窗", () => {
  const budget = resolveContextBudget({
    modelContextTokens: 8192,
    systemBaseTokens: 800,
    outputReserveTokens: 1024,
    safetyMarginTokens: 64,
  });
  assert.ok(budget.knowledgeBudgetTokens >= 128);
  assert.ok(budget.historyBudgetTokens >= 128);
  assert.ok(
    budget.knowledgeBudgetTokens +
      budget.historyBudgetTokens +
      800 +
      1024 +
      64 <=
      8192,
  );
  assert.ok(estimateTokens("ab") >= 1);
});

test("extractReferencedCitationIds: 只保留允许集合", () => {
  const ids = extractReferencedCitationIds(
    "根据资料 [S1] 与伪造的 [S9]，以及再次 [S1]。",
    ["S1", "S2"],
  );
  assert.deepEqual(ids, ["S1"]);
});

test("canonicalizeAssistantCitations: 中段收到该行末尾（协议）", () => {
  assert.equal(
    canonicalizeAssistantCitations("第一句。[S1][S2]", ["S1", "S2"]).content,
    "第一句。[S1][S2]",
  );
  assert.equal(
    canonicalizeAssistantCitations("中间[S1]。仍保留。", ["S1"]).content,
    "中间。仍保留。[S1]",
  );
  assert.equal(
    canonicalizeAssistantCitations("甲[S1]。\n乙[S2]。", ["S1", "S2"]).content,
    "甲。[S1]\n乙。[S2]",
  );
});

test("buildCitedKnowledgePrompt: 空输入", () => {
  assert.equal(buildCitedKnowledgePrompt([], []), "");
});
