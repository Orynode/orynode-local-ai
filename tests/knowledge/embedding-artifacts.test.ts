/**
 * ML-P2：embedding artifact registry 与 hybrid stub 评测
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPAT_BASELINE_ARTIFACT_ID,
  DEFAULT_EMBEDDING_ARTIFACT_ID,
  applyEmbeddingTemplate,
  embeddingConfigFingerprint,
  isEmbeddingBuildCompatible,
  listEmbeddingArtifacts,
  resolveEmbeddingArtifact,
} from "../../config/embedding-artifacts";
import { runRetrievalEval } from "../../services/knowledge/evaluation";
import { resolveRetrievalProfile } from "../../services/knowledge/retrieval/profile";

test("registry: 默认推荐 multilingual-e5-small", () => {
  const { artifact, fallback } = resolveEmbeddingArtifact(undefined);
  assert.equal(fallback, false);
  assert.equal(artifact.id, DEFAULT_EMBEDDING_ARTIFACT_ID);
  assert.equal(artifact.id, "multilingual-e5-small");
  assert.equal(artifact.role, "default");
  assert.equal(artifact.dimension, 384);
});

test("registry: multilingual-e5-small 带 query/passage 模板", () => {
  const { artifact } = resolveEmbeddingArtifact("multilingual-e5-small");
  assert.equal(artifact.role, "default");
  assert.equal(artifact.dimension, 384);
  assert.equal(
    applyEmbeddingTemplate(artifact.queryTemplate, "hello"),
    "query: hello",
  );
  assert.equal(
    applyEmbeddingTemplate(artifact.passageTemplate, "doc"),
    "passage: doc",
  );
  assert.ok(embeddingConfigFingerprint(artifact).includes("query: {text}"));
});

test("registry: 未知 id 回落默认推荐（非 BGE）", () => {
  const { artifact, fallback, requestedId } =
    resolveEmbeddingArtifact("not-a-real-model");
  assert.equal(fallback, true);
  assert.equal(requestedId, "not-a-real-model");
  assert.equal(artifact.id, "multilingual-e5-small");
});

test("registry: BGE 保留为 compat_baseline", () => {
  const { artifact } = resolveEmbeddingArtifact(COMPAT_BASELINE_ARTIFACT_ID);
  assert.equal(artifact.role, "compat_baseline");
  assert.equal(artifact.dimension, 512);
  const ids = listEmbeddingArtifacts().map((a) => a.id);
  assert.ok(ids.includes("bge-small-zh-v1.5"));
  assert.ok(ids.includes("multilingual-e5-small"));
});

test("isEmbeddingBuildCompatible: 拒绝维度/模型混用", () => {
  const e5 = resolveEmbeddingArtifact("multilingual-e5-small").artifact;
  assert.equal(
    isEmbeddingBuildCompatible(e5, {
      model: "multilingual-e5-small",
      dimension: 384,
    }),
    true,
  );
  assert.equal(
    isEmbeddingBuildCompatible(e5, {
      model: "bge-small-zh-v1.5",
      dimension: 512,
    }),
    false,
  );
  assert.equal(
    isEmbeddingBuildCompatible(e5, {
      model: "multilingual-e5-small",
      dimension: 512,
    }),
    false,
  );
});

test("profile: multilingual 不可用时写入 MULTILINGUAL_VECTOR_UNAVAILABLE", () => {
  const profile = resolveRetrievalProfile("balanced", {
    embedding: false,
    vectorIndexReady: false,
    reranker: true,
    rerankerType: "lexical",
    ftsTokenizer: "fts5-multilingual-v1",
    memoryTier: "quality",
    externalConnectors: { web: true, github: true },
    embeddingArtifactId: "multilingual-e5-small",
    embeddingArtifactRole: "default",
    multilingualVectorUnavailable: true,
  });
  assert.equal(profile.effectiveTier, "lite");
  assert.ok(
    profile.degradedReasons.includes("SEMANTIC_RUNTIME_UNAVAILABLE") ||
      profile.degradedReasons.includes("SEMANTIC_SEARCH_DISABLED") ||
      profile.degradedReasons.includes("VECTOR_INDEX_NOT_READY"),
  );
});

test("profile: balanced + multilingualVectorUnavailable 诊断码", () => {
  const profile = resolveRetrievalProfile("balanced", {
    embedding: true,
    vectorIndexReady: true,
    reranker: true,
    rerankerType: "lexical",
    ftsTokenizer: "fts5-multilingual-v1",
    memoryTier: "quality",
    externalConnectors: { web: true, github: true },
    embeddingArtifactRole: "default",
    multilingualVectorUnavailable: true,
  });
  assert.equal(profile.embedding, true);
  assert.ok(
    profile.degradedReasons.includes("MULTILINGUAL_VECTOR_UNAVAILABLE"),
  );
});

test("hybrid_rrf_lexical_stub: 通过 semanticGates 且不下载模型", () => {
  const report = runRetrievalEval({
    strategies: ["hybrid_rrf_lexical_stub"],
    enforceGates: true,
  });
  const hybrid = report.strategies.find(
    (s) => s.strategy === "hybrid_rrf_lexical_stub",
  );
  assert.ok(hybrid);
  assert.equal(
    hybrid!.gateFailures.length,
    0,
    hybrid!.gateFailures.join("\n"),
  );
  assert.ok(hybrid!.metrics.recallAt8 >= 0.75);
});
