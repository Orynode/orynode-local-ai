/**
 * 兼容旧门禁用例；完整多语言评测见 multilingual-eval.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { rrfFusion } from "../../services/knowledge/retrieval/keyword";
import { runRetrievalEval } from "../../services/knowledge/evaluation";

test("中英 fixture：Recall@8 门禁由 gates.json 驱动", () => {
  const report = runRetrievalEval({
    strategies: ["keyword_multilingual_fields"],
    enforceGates: true,
  });
  assert.equal(report.passed, true, report.failures.join("; "));
});

test("无答案查询误召回率受门禁约束", () => {
  const report = runRetrievalEval({
    strategies: ["keyword_multilingual_fields"],
    enforceGates: true,
  });
  const primary = report.strategies[0]!;
  assert.ok(primary.metrics.noAnswerFalseRecall <= 0.5);
});

test("RRF 融合保持稳定排序语义", () => {
  const fused = rrfFusion([
    ["zh-install", "en-rag", "noise"],
    ["en-rag", "zh-install", "zh-privacy"],
  ]);
  const top = [...fused.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  assert.ok(top === "zh-install" || top === "en-rag");
});

test("精确查询不扩展：评测门禁", async () => {
  const { buildMultiQueries } = await import(
    "../../services/knowledge/retrieval/multi-query"
  );
  const { detectQueryKind } = await import(
    "../../services/knowledge/retrieval/query-type"
  );
  assert.equal(detectQueryKind("ERR_CONNECTION_REFUSED"), "error_code");
  assert.deepEqual(buildMultiQueries("ERR_CONNECTION_REFUSED"), [
    "ERR_CONNECTION_REFUSED",
  ]);
  assert.equal(buildMultiQueries("如何安装本地服务").length >= 1, true);
});

test("资源压力时 Quality 降为 Balanced", async () => {
  const { resolveKnowledgeTier } = await import(
    "../../services/knowledge/retrieval/profile"
  );
  const resolved = resolveKnowledgeTier("quality", {
    embedding: true,
    vectorIndexReady: true,
    reranker: true,
    rerankerType: "lexical",
    ftsTokenizer: "fts5+bigram",
    memoryTier: "quality",
    externalConnectors: { web: true, github: true },
    resourcePressure: "high",
  });
  assert.equal(resolved.effectiveTier, "balanced");
  assert.ok(resolved.degradedReasons.includes("RESOURCE_PRESSURE"));
});
