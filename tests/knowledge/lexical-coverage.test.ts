import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLexicalLadder,
  classifyQuery,
  countTermCoverage,
  minimumShouldMatchForTermCount,
  minimumShouldMatchForZhBigrams,
  passesCoverage,
} from "../../services/knowledge/query/lexical-coverage";

test("minimumShouldMatch: 英文词数表", () => {
  assert.equal(minimumShouldMatchForTermCount(1), 1);
  assert.equal(minimumShouldMatchForTermCount(2), 2);
  assert.equal(minimumShouldMatchForTermCount(3), 3);
  assert.equal(minimumShouldMatchForTermCount(4), 3);
  assert.equal(minimumShouldMatchForTermCount(5), 3);
});

test("minimumShouldMatch: 中文 bigram 2–3 须全部", () => {
  assert.equal(minimumShouldMatchForZhBigrams(2), 2);
  assert.equal(minimumShouldMatchForZhBigrams(3), 3);
  assert.equal(minimumShouldMatchForZhBigrams(4), 3);
});

test("classifyQuery / ladder: 短复合禁止 minimum_match", () => {
  assert.equal(
    classifyQuery({
      query: "反向代理",
      phrase: "反向代理",
      searchTerms: ["反向", "向代", "代理"],
      hasHan: true,
    }),
    "zh_compound",
  );
  const ladder = buildLexicalLadder({
    queryClass: "zh_compound",
    phrase: "反向代理",
    terms: ["反向代理", "反向", "向代", "代理"],
  });
  assert.deepEqual(
    ladder.map((s) => s.mode),
    ["phrase", "all"],
  );
});

test("coverage: 代理不足以覆盖反向代理 bigrams", () => {
  const terms = ["反向", "向代", "代理"];
  assert.equal(countTermCoverage("仅配置浏览器代理", terms), 1);
  assert.equal(passesCoverage("仅配置浏览器代理", terms, 3), false);
  assert.equal(
    passesCoverage("配置反向代理到上游", terms, 3),
    true,
  );
});
