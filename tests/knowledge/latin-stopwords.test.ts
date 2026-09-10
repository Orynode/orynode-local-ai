import assert from "node:assert/strict";
import test from "node:test";
import {
  containsLatinStopword,
  contentTermsForLexicalMatch,
  isLatinStopword,
} from "../../services/knowledge/query/latin-stopwords";
import { peelZhFunctionAffixes } from "../../services/knowledge/query/zh-function-words";
import { buildLexicalLadder } from "../../services/knowledge/query/lexical-coverage";
import { extractSearchTerms } from "../../services/knowledge/retrieval/keyword";

test("isLatinStopword: 功能词命中，内容词不命中", () => {
  assert.equal(isLatinStopword("How"), true);
  assert.equal(isLatinStopword("the"), true);
  assert.equal(isLatinStopword("proxy"), false);
  assert.equal(isLatinStopword("代理"), false);
});

test("containsLatinStopword: 自然语言问句信号", () => {
  assert.equal(containsLatinStopword("how to install node.js"), true);
  assert.equal(containsLatinStopword("reverse proxy"), false);
  assert.equal(containsLatinStopword("node.js"), false);
});

test("contentTermsForLexicalMatch: 去功能词，全功能词时回退", () => {
  assert.deepEqual(
    contentTermsForLexicalMatch(["how", "does", "reverse", "proxy"]),
    ["reverse", "proxy"],
  );
  assert.deepEqual(contentTermsForLexicalMatch(["why", "is", "the"]), [
    "why",
    "is",
    "the",
  ]);
});

test("peelZhFunctionAffixes: 按低信息 bigram 切开，不是问句尾巴列表", () => {
  assert.equal(peelZhFunctionAffixes("内存池是什么"), "内存池");
  assert.equal(peelZhFunctionAffixes("什么是冰块"), "冰块");
  assert.equal(peelZhFunctionAffixes("怎么样"), "");
});

test("contentTermsForLexicalMatch: 中文问句剥低信息，不靠句尾正则", () => {
  const terms = contentTermsForLexicalMatch(
    extractSearchTerms("zend内存池是什么"),
  );
  assert.ok(terms.some((item) => item.toLowerCase() === "zend"));
  assert.ok(terms.some((item) => item.includes("内存池")));
  assert.equal(terms.includes("什么"), false);
  assert.deepEqual(contentTermsForLexicalMatch(["什么", "如何"]), []);
});

test("buildLexicalLadder: general 匹配词去功能词；technical 保留完整 terms", () => {
  const general = buildLexicalLadder({
    queryClass: "general",
    terms: ["how", "does", "reverse", "proxy", "work"],
  });
  const all = general.find((s) => s.mode === "all");
  assert.ok(all);
  assert.deepEqual(all!.terms, ["reverse", "proxy", "work"]);

  const technical = buildLexicalLadder({
    queryClass: "technical",
    terms: ["node.js", "install"],
  });
  const techAll = technical.find((s) => s.mode === "all");
  assert.ok(techAll);
  assert.deepEqual(techAll!.terms, ["node.js", "install"]);
});
