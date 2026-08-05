import assert from "node:assert/strict";
import test from "node:test";
import { buildHighlightTerms } from "../../services/knowledge/retrieval/highlight-terms";

test("buildHighlightTerms: 注入 synonyms 后展开跨语言高亮", () => {
  const terms = buildHighlightTerms({
    query: "反向代理",
    searchTerms: ["反向代理"],
    synonyms: ["reverse proxy", "reverse-proxy"],
  });
  assert.ok(terms.includes("反向代理"));
  assert.ok(terms.some((t) => /reverse/i.test(t)));
});

test("buildHighlightTerms: 简繁展开", () => {
  const terms = buildHighlightTerms({ query: "数据库" });
  assert.ok(terms.includes("数据库"));
  assert.ok(terms.includes("數據庫"));
});

test("buildHighlightTerms: 无 synonyms 时不偷偷查术语表", () => {
  const terms = buildHighlightTerms({ query: "访问令牌" });
  assert.ok(terms.includes("访问令牌"));
  assert.equal(
    terms.some((t) => /access/i.test(t)),
    false,
  );
});
