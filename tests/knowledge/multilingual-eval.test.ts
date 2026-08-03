/**
 * ML-P0 多语言检索评测门禁
 *
 * 修改 tokenizer / normalizer / RRF / lexical rerank 时必须跑通本文件。
 * 阈值固化在 tests/fixtures/rag/gates.json，勿在断言中硬编码魔法数。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  compareReports,
  loadFixtureSet,
  loadGatesConfig,
  reportToJson,
  reportToMarkdown,
  runRetrievalEval,
  validateFixtureSet,
} from "../../services/knowledge/evaluation";
import { LexicalReranker } from "../../services/knowledge/retrieval/rerank";

test("fixture 契约：覆盖全部评测类别", () => {
  const fixture = loadFixtureSet();
  validateFixtureSet(fixture);
  assert.ok(fixture.cases.length >= 10);
});

test("CI 门禁：primary strategy 通过 gates.json", () => {
  const gates = loadGatesConfig();
  const report = runRetrievalEval({
    strategies: [
      gates.primaryStrategy,
      "multi_query",
      "lexical_rerank",
    ],
    enforceGates: true,
  });
  assert.equal(
    report.passed,
    true,
    report.failures.join("\n") || "gate failed",
  );
  const primary = report.strategies.find(
    (s) => s.strategy === gates.primaryStrategy,
  );
  assert.ok(primary);
  assert.ok(primary!.gatedCaseCount > 0);
  assert.ok(primary!.cases.every((c) => typeof c.queryLanguage === "string"));
});

test("报告：可输出 JSON 与 Markdown，并可对比两配置", () => {
  const dir = mkdtempSync(join(tmpdir(), "orynode-eval-"));
  const report = runRetrievalEval({
    strategies: ["keyword_multilingual_fields"],
    enforceGates: true,
  });
  const jsonPath = join(dir, "a.json");
  writeFileSync(jsonPath, reportToJson(report));
  const md = reportToMarkdown(report);
  assert.match(md, /Retrieval Eval Report/);
  assert.match(md, /Recall@8/);

  const baseline = JSON.parse(readFileSync(jsonPath, "utf8"));
  // 模拟同配置对比：无回归
  const comparison = compareReports(baseline, report, {
    strategy: "keyword_multilingual_fields",
  });
  assert.equal(comparison.regressions.length, 0);

  // 人为降低 candidate 制造回归
  const worse = structuredClone(report);
  worse.strategies[0]!.metrics.recallAt8 = Math.max(
    0,
    worse.strategies[0]!.metrics.recallAt8 - 0.5,
  );
  const regressed = compareReports(baseline, worse, {
    strategy: "keyword_multilingual_fields",
  });
  assert.ok(regressed.regressions.some((r) => r.includes("recallAt8")));
});

test("跨语言 lexical 全零时保持融合顺序（ADR-ML-005）", () => {
  const fixture = loadFixtureSet();
  const fusedOrder = [
    "chunk-en-rag",
    "chunk-zh-privacy",
    "chunk-zh-install",
  ];
  const reranker = new LexicalReranker();
  const result = reranker.rerankWithMeta(
    "comment reconstruire l'index vectoriel hors ligne",
    fusedOrder.map((id) => ({
      id,
      text: fixture.corpus.find((c) => c.id === id)?.text ?? "",
    })),
    3,
  );
  assert.equal(result.preservedOrder, true);
  assert.deepEqual(
    result.items.map((row) => row.id),
    fusedOrder,
  );
});

test("分阶段策略均可产出指标（含 hybrid stub）", () => {
  const report = runRetrievalEval({
    strategies: [
      "keyword",
      "keyword_multilingual_fields",
      "multi_query",
      "lexical_rerank",
      "hybrid_rrf_lexical_stub",
    ],
    enforceGates: false,
  });
  assert.equal(report.strategies.length, 5);
  for (const s of report.strategies) {
    assert.ok(s.caseCount > 0);
    assert.ok(typeof s.metrics.recallAt8 === "number");
  }
});
