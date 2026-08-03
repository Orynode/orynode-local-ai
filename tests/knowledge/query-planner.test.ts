import assert from "node:assert/strict";
import test from "node:test";
import { analyzeLanguage } from "../../services/knowledge/query/language-analyzer";
import { extractExactTerms } from "../../services/knowledge/query/exact-terms";
import { planQuery } from "../../services/knowledge/query/planner";
import { buildMultilingualFields } from "../../services/knowledge/indexing/multilingual-normalizer";

test("analyzeLanguage: 中英混合为 mixed", () => {
  const profile = analyzeLanguage("如何配置 Node.js access token");
  assert.equal(profile.primary, "mixed");
  assert.equal(profile.hasHan, true);
  assert.equal(profile.hasLatin, true);
  assert.equal(profile.hasTechnicalTerms, true);
});

test("analyzeLanguage: 纯中文", () => {
  const profile = analyzeLanguage("如何重建向量索引");
  assert.ok(profile.primary === "zh-Hans" || profile.primary === "zh-Hant");
  assert.equal(profile.hasLatin, false);
});

test("analyzeLanguage: 纯英文", () => {
  const profile = analyzeLanguage("how to rebuild the vector index");
  assert.equal(profile.primary, "en");
});

test("extractExactTerms: 错误码与符号", () => {
  const terms = extractExactTerms("ERR_CONNECTION_REFUSED in KnowledgeEngine.retrieve()");
  assert.ok(terms.some((t) => t.kind === "error_code"));
});

test("planQuery: 原句始终在 variants[0]", () => {
  const plan = planQuery("Orynode 本地知识引擎", { multiQuery: true });
  assert.equal(plan.variants[0]?.kind, "original");
  assert.equal(plan.variants[0]?.text, "Orynode 本地知识引擎");
  assert.ok(plan.searchTerms.length > 0);
  assert.ok(plan.strategies.includes("keyword"));
});

test("planQuery: 精确查询不扩展", () => {
  const plan = planQuery("ERR_CONNECTION_REFUSED", { multiQuery: true });
  assert.equal(plan.variants.length, 1);
  assert.ok(plan.exactTerms.some((t) => t.kind === "error_code"));
});

test("planQuery: 关键字生成英文术语扩展供真实召回", () => {
  const plan = planQuery("关键字", { embedding: true });
  const expanded = plan.variants.find((v) => v.kind === "term_expansion");
  assert.ok(expanded);
  assert.match(expanded.text, /keyword/);
  assert.equal(expanded.language, "en");
  assert.ok(expanded.weight < plan.variants[0]!.weight);
});

test("planQuery: 术语扩展保留结构化边界，避免复合词被拆成宽泛 OR", () => {
  const plan = planQuery("原子尺度", { embedding: true });
  const expansion = plan.variants.find((item) => item.kind === "term_expansion");

  assert.deepEqual(expansion?.terms, ["atomistic", "atomic-scale"]);
  assert.equal(expansion?.terms?.includes("atomic"), false);
  assert.equal(expansion?.terms?.includes("scale"), false);
});

test("planQuery: 短英文术语保留 phrase 意图", () => {
  const plan = planQuery("Passive Mobs", { embedding: true });
  assert.equal(plan.phrase, "Passive Mobs");
  assert.deepEqual(plan.searchTerms, ["passive", "mobs"]);
});

test("buildMultilingualFields: 简繁扩展与技术词", () => {
  const fields = buildMultilingualFields("知识引擎与 Node.js 配置");
  assert.match(fields.zhText, /知识|識/);
  assert.match(fields.enText, /node/i);
  assert.match(fields.exactText, /node\.js/);
  assert.match(fields.mixedText, /知识引擎/);
});
