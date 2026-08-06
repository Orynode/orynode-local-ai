import assert from "node:assert/strict";
import test from "node:test";
import {
  containsLatinStopword,
  contentTermsForLexicalMatch,
  isLatinStopword,
} from "../../services/knowledge/query/latin-stopwords";
import { buildLexicalLadder } from "../../services/knowledge/query/lexical-coverage";

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
