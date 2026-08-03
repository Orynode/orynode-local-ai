#!/usr/bin/env node
/**
 * 预下载 Embedding artifact（Xenova / transformers.js）
 *
 * 用法：
 *   node --import tsx scripts/install-embedding-artifact.mjs
 *   node --import tsx scripts/install-embedding-artifact.mjs multilingual-e5-small
 *   HF_ENDPOINT=https://hf-mirror.com node --import tsx scripts/install-embedding-artifact.mjs multilingual-e5-small
 *
 * 权重缓存目录：.orynode/models/transformers
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getEmbeddingArtifact,
  resolveEmbeddingArtifact,
} from "../scripts/data-service/embed-config.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = resolve(projectRoot, ".orynode/models/transformers");

const requested =
  process.argv[2] ||
  process.env.ORYNODE_EMBEDDING_ARTIFACT ||
  "multilingual-e5-small";

const resolved = resolveEmbeddingArtifact(requested);
if (resolved.fallback && requested !== resolved.artifact.id) {
  console.error(
    `未知 artifact「${requested}」，可用：bge-small-zh-v1.5 | multilingual-e5-small | bge-m3`,
  );
  process.exit(1);
}

const artifact =
  getEmbeddingArtifact(requested) ?? resolved.artifact;

mkdirSync(cacheDir, { recursive: true });

console.log(`artifact: ${artifact.id}`);
console.log(`model:    ${artifact.xenovaModelId}`);
console.log(`cache:    ${cacheDir}`);
if (process.env.HF_ENDPOINT) {
  console.log(`HF_ENDPOINT: ${process.env.HF_ENDPOINT}`);
}
console.log("Downloading / loading (first time may take several minutes)...");

const { pipeline, env } = await import("@xenova/transformers");
env.cacheDir = cacheDir;
env.allowRemoteModels = true;

const started = Date.now();
const extractor = await pipeline("feature-extraction", artifact.xenovaModelId);
const sample = artifact.queryTemplate
  ? artifact.queryTemplate.replace("{text}", "hello world")
  : "hello world";
const out = await extractor(sample, {
  pooling: artifact.pooling,
  normalize: artifact.normalization,
});
const dim = Array.from(out.data).length;
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

if (dim !== artifact.dimension) {
  console.warn(
    `警告：实际维度 ${dim} 与 registry 声明 ${artifact.dimension} 不一致`,
  );
}

console.log(`OK  dimension=${dim}  elapsed=${elapsed}s`);
console.log("下一步：");
console.log("  1. .env.local 确认 ORYNODE_SEMANTIC_SEARCH=1");
console.log(`  2. .env.local 确认 ORYNODE_EMBEDDING_ARTIFACT=${artifact.id}`);
console.log("  3. 重启 npm run local");
console.log(
  "  4. curl -s http://127.0.0.1:4318/knowledge/embed/status | python3 -m json.tool",
);
console.log("  5. 知识库触发向量重建 / backfill（维度变化后必须）");
