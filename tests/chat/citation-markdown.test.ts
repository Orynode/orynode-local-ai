import assert from "node:assert/strict";
import test from "node:test";
import { defaultUrlTransform } from "react-markdown";
import {
  citationIdsFromHref,
  citationUrlTransform,
  prepareAssistantCitationMarkdown,
} from "../../app/lib/citation-markdown";

test("根因回归: defaultUrlTransform 会清空 citation: 协议", () => {
  assert.equal(defaultUrlTransform("citation:S5"), "");
});

test("citationUrlTransform: 放行 citation:，其余走默认安全过滤", () => {
  assert.equal(citationUrlTransform("citation:S5"), "citation:S5");
  assert.equal(
    citationUrlTransform("citation:S5,S7,S1"),
    "citation:S5,S7,S1",
  );
  assert.equal(citationUrlTransform("https://example.com"), "https://example.com");
  assert.equal(citationUrlTransform("javascript:alert(1)"), "");
});

test("citationIdsFromHref: 解析单标与合并组", () => {
  assert.deepEqual(citationIdsFromHref("citation:S7"), ["S7"]);
  assert.deepEqual(citationIdsFromHref("citation:S5,S7,S1"), [
    "S5",
    "S7",
    "S1",
  ]);
  assert.deepEqual(citationIdsFromHref(""), []);
  assert.deepEqual(citationIdsFromHref("https://x"), []);
  assert.deepEqual(citationIdsFromHref("citation:evil"), []);
});

test("prepareAssistantCitationMarkdown: 同行连续引用合并为一个组链接", () => {
  const markdown = prepareAssistantCitationMarkdown(
    "结论。[S5, S7] 以及 [S1]",
    [
      {
        id: "S5",
        chunkId: "c5",
        documentId: "d",
        title: "a.pdf",
        sourceType: "library",
        locator: { kind: "page", page: 1 },
        excerpt: "…",
      },
      {
        id: "S7",
        chunkId: "c7",
        documentId: "d",
        title: "a.pdf",
        sourceType: "library",
        locator: { kind: "page", page: 2 },
        excerpt: "…",
      },
      {
        id: "S1",
        chunkId: "c1",
        documentId: "d",
        title: "a.pdf",
        sourceType: "library",
        locator: { kind: "page", page: 3 },
        excerpt: "…",
      },
    ],
  );
  assert.equal(markdown, "结论。 以及[来源](citation:S5,S7,S1)");
});

test("prepareAssistantCitationMarkdown: 无 provided 时不改写", () => {
  assert.equal(
    prepareAssistantCitationMarkdown("有 [S1] 但无元数据", undefined),
    "有 [S1] 但无元数据",
  );
});
