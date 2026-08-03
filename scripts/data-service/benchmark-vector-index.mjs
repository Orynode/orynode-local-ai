/**
 * 向量索引基准（BLOB 扫描）— 为是否启用 sqlite-vec 提供数据
 *
 * 用法: node scripts/data-service/benchmark-vector-index.mjs [count=2000] [dim=512]
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

const count = Number(process.argv[2] || 2000);
const dim = Number(process.argv[3] || 512);
const topK = 8;

function randomUnit(dim) {
  const v = new Float32Array(dim);
  let norm = 0;
  for (let i = 0; i < dim; i += 1) {
    v[i] = Math.random() * 2 - 1;
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i += 1) v[i] /= norm;
  return v;
}

function cosine(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

const vectors = Array.from({ length: count }, () => randomUnit(dim));
const query = randomUnit(dim);

const t0 = performance.now();
const scored = vectors.map((v, i) => ({ i, score: cosine(query, v) }));
scored.sort((a, b) => b.score - a.score);
const top = scored.slice(0, topK);
const elapsedMs = performance.now() - t0;
const mem = process.memoryUsage();

const report = {
  backend: "blob_scan",
  count,
  dim,
  topK,
  elapsedMs: Number(elapsedMs.toFixed(3)),
  pApprox: "single-query full scan",
  heapUsedMb: Number((mem.heapUsed / 1024 / 1024).toFixed(2)),
  topIds: top.map((t) => t.i),
  recommendation:
    elapsedMs > 50
      ? "P95 粗估偏高：可在后续版本评估 sqlite-vec adapter"
      : "当前规模下 blob_scan 可接受；暂不引入 sqlite-vec",
  generatedAt: new Date().toISOString(),
};

const out = resolve(
  new URL("../..", import.meta.url).pathname,
  ".orynode/benchmarks",
  `vector-blob-${count}x${dim}.json`,
);
try {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(resolve(out, ".."), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  console.log(`wrote ${out}`);
} catch (error) {
  console.log(JSON.stringify(report, null, 2));
  console.warn("无法写入报告文件", error instanceof Error ? error.message : error);
}
