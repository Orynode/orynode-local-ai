import assert from "node:assert/strict";
import test from "node:test";
import { buildHighlightTerms } from "../../services/knowledge/retrieval/highlight-terms";

test("buildHighlightTerms: 中文查询展开英文高亮提示", () => {
  const terms = buildHighlightTerms({
    query: "钠离子电解质",
    searchTerms: ["钠离子电解质", "钠离", "离子"],
  });
  assert.ok(terms.includes("钠离子电解质") || terms.includes("钠离子"));
  assert.ok(terms.some((t) => t.toLowerCase() === "sodium" || t.includes("sodium")));
  assert.ok(terms.some((t) => t.toLowerCase().includes("electrolyte")));
});

test("buildHighlightTerms: 简繁展开", () => {
  const terms = buildHighlightTerms({ query: "数据库" });
  assert.ok(terms.includes("数据库"));
  assert.ok(terms.includes("數據庫"));
});

test("buildHighlightTerms: 与 QueryPlanner 共用关键字术语", () => {
  const terms = buildHighlightTerms({ query: "关键字" });
  assert.ok(terms.includes("keyword"));
  assert.ok(terms.includes("keywords"));
});
