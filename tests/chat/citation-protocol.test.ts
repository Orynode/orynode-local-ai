import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeAssistantCitations,
  extractReferencedCitationIds,
  toCitationMarkdownLinks,
} from "../../services/chat/citation-protocol";
import { buildCitedKnowledgePrompt } from "../../services/chat/prompt";
import type { Citation } from "../../services/knowledge/core/types";

const ALLOWED = ["S1", "S2", "S5", "S7"];

test("extractReferencedCitationIds: 支持 [S5, S7] 与 [S1][S2]", () => {
  assert.deepEqual(
    extractReferencedCitationIds("结论。[S5, S7]", ALLOWED),
    ["S5", "S7"],
  );
  assert.deepEqual(
    extractReferencedCitationIds("结论。[S1][S2]", ALLOWED),
    ["S1", "S2"],
  );
  assert.deepEqual(
    extractReferencedCitationIds("混用 [S5、S7] 与再提 [S1]", ALLOWED),
    ["S5", "S7", "S1"],
  );
});

test("extractReferencedCitationIds: 只保留 allowed", () => {
  assert.deepEqual(
    extractReferencedCitationIds("有 [S1] 与伪造 [S9] 再 [S1]", ["S1", "S2"]),
    ["S1"],
  );
});

test("canonicalizeAssistantCitations: [S5, S7] → 该行末尾规范序列", () => {
  const { content, referencedIds } = canonicalizeAssistantCitations(
    "马孔多是一个村落。[S5, S7]",
    ALLOWED,
  );
  assert.deepEqual(referencedIds, ["S5", "S7"]);
  assert.equal(content, "马孔多是一个村落。[S5][S7]");
});

test("canonicalizeAssistantCitations: 同行中段收到该行末尾", () => {
  const { content, referencedIds } = canonicalizeAssistantCitations(
    "中间[S1]。仍保留。",
    ALLOWED,
  );
  assert.deepEqual(referencedIds, ["S1"]);
  assert.equal(content, "中间。仍保留。[S1]");
});

test("canonicalizeAssistantCitations: 多行各自留在行末，不堆到最后一行", () => {
  const { content, referencedIds } = canonicalizeAssistantCitations(
    "轨迹起点[S5, S7]。\n中间经过[S1]。\n终点[S6][S3]。",
    ["S1", "S3", "S5", "S6", "S7"],
  );
  assert.deepEqual(referencedIds, ["S5", "S7", "S1", "S6", "S3"]);
  assert.equal(
    content,
    "轨迹起点。[S5][S7]\n中间经过。[S1]\n终点。[S6][S3]",
  );
});

test("canonicalizeAssistantCitations: 去重保序并过滤非法 id（同行）", () => {
  const { content, referencedIds } = canonicalizeAssistantCitations(
    "先 [S2] 后 [S9] 再 [S2][S1]",
    ["S1", "S2"],
  );
  assert.deepEqual(referencedIds, ["S2", "S1"]);
  assert.equal(content, "先 后 再[S2][S1]");
});

test("canonicalizeAssistantCitations: 独占一行的引用并入上一行末尾", () => {
  const { content, referencedIds } = canonicalizeAssistantCitations(
    "马孔多是一个村落。\n\n[S1]",
    ALLOWED,
  );
  assert.deepEqual(referencedIds, ["S1"]);
  assert.equal(content, "马孔多是一个村落。[S1]");
});

test("toCitationMarkdownLinks: 连续单标合并为一个 citation 组链接", () => {
  const linked = toCitationMarkdownLinks("结尾。[S5][S7][S1]", ALLOWED);
  assert.equal(linked, "结尾。[来源](citation:S5,S7,S1)");
  assert.equal(
    toCitationMarkdownLinks("单条。[S5]", ALLOWED),
    "单条。[来源](citation:S5)",
  );
  assert.equal(
    toCitationMarkdownLinks("仍是 [S5, S7]", ALLOWED),
    "仍是 [S5, S7]",
  );
});

test("buildCitedKnowledgePrompt: 含协议规则（行末 / 禁止逗号合并）", () => {
  const citations: Citation[] = [
    {
      id: "S1",
      chunkId: "c1",
      documentId: "d1",
      revisionId: "r1",
      processingBuildId: "b1",
      title: "doc.md",
      sourceType: "library",
      locator: { kind: "page", page: 1 },
      excerpt: "片段",
    },
  ];
  const prompt = buildCitedKnowledgePrompt(citations, [
    {
      documentName: "doc.md",
      pageNumber: 1,
      content: "片段",
      source: "library",
    },
  ]);
  assert.match(prompt, /该行末尾/);
  assert.match(prompt, /禁止写成 \[S1, S2\]/);
});
