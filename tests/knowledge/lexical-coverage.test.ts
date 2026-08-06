import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLexicalLadder,
  classifyQuery,
  countTermCoverage,
  isHanRunCoveredByBigrams,
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

test("isHanRunCoveredByBigrams: 整段被 bigram 全覆盖时去重（QS §5.2）", () => {
  const termSet = new Set(["反向", "向代", "代理"]);
  assert.equal(isHanRunCoveredByBigrams("反向代理", termSet), true);
  // 缺一个 bigram 不算覆盖
  assert.equal(isHanRunCoveredByBigrams("反向代理", new Set(["反向", "代理"])), false);
  // 2 字不是整段
  assert.equal(isHanRunCoveredByBigrams("反向", termSet), false);
});

test("countTermCoverage: 汉字整段与其 bigram 不双重计分", () => {
  // 词表同时含整段「反向代理」与其全部 bigram：命中内容时计 3 而非 4
  const terms = ["反向代理", "反向", "向代", "代理"];
  assert.equal(countTermCoverage("配置反向代理到上游", terms), 3);
  // 整段未命中（内容中 bigram 被拆散）时 bigram 各自计数，整段不额外加分
  assert.equal(countTermCoverage("反向与代理分离", terms), 2);
});

test("buildLexicalLadder: 被 bigram 覆盖的整段不计入 minimum 基数", () => {
  // terms = 整段 4 字 + 3 bigram：有效基数 3 → minimum 3，等于基数 → 不生成 minimum_match
  const ladder = buildLexicalLadder({
    queryClass: "general",
    terms: ["反向代理的", "反向", "向代", "代理"],
  });
  // 「反向代理的」bigram 为 反向/向代/代理/理的…其中「理的」不在词表 → 不被覆盖，基数 4
  assert.ok(ladder.some((s) => s.mode === "minimum_match"));

  const ladder2 = buildLexicalLadder({
    queryClass: "general",
    terms: ["反向代理", "反向", "向代", "代理"],
  });
  const mm = ladder2.find((s) => s.mode === "minimum_match");
  // 整段被剔除后有效基数 3 → minimumShouldMatchForZhBigrams 路径要求 ≥2 bigrams 且 minimum < n，此处 n=3 → minimum=3，不生成
  assert.equal(mm, undefined);
});
