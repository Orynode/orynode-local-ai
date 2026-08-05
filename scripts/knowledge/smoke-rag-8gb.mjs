#!/usr/bin/env node
/**
 * RAG 8GB 离线冒烟（RU-001）
 *
 * 在 CI / 开发机上可跑的自动门禁；真机「启动→上传→对话」见清单文档。
 *
 * 用法：
 *   npm run test:smoke-rag
 *   node scripts/knowledge/smoke-rag-8gb.mjs
 *
 * 检查项：
 * 1. 主检索评测门禁（keyword + hybrid stub）
 * 2. 代码树无查询时 CE / bge-reranker 接线
 * 3. ResourceCoordinator Chat 优先
 * 4. 打印真机清单路径
 */

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createResourceCoordinator } from "../data-service/resource-coordinator.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const failures = [];

function fail(msg) {
  failures.push(msg);
  console.error(`FAIL  ${msg}`);
}

function ok(msg) {
  console.log(`OK    ${msg}`);
}

function runEval() {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/knowledge/run-retrieval-eval.ts",
      "--json",
      ".orynode/eval/smoke-latest.json",
      "--md",
      ".orynode/eval/smoke-latest.md",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: process.env,
    },
  );
  if (result.status !== 0) {
    fail(
      `retrieval-eval exit ${result.status}: ${(result.stderr || result.stdout || "").slice(0, 800)}`,
    );
    return;
  }
  ok("retrieval-eval 门禁通过（keyword + hybrid_rrf_lexical_stub）");
}

const FORBIDDEN = [
  /bge-reranker/i,
  /cross[-_]?encoder/i,
  /CrossEncoder/,
  /semantic_rerank/,
  /ORYNODE_RERANKER\s*=/,
];

function walkSourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (
      name === "node_modules" ||
      name === ".git" ||
      name === "dist" ||
      name === ".next" ||
      name === ".orynode" ||
      name === "docs"
    ) {
      continue;
    }
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkSourceFiles(full, out);
      continue;
    }
    if (!/\.(ts|tsx|mjs|js|json)$/.test(name)) continue;
    // 本脚本与评测说明可提到否决项
    if (full.includes("smoke-rag-8gb")) continue;
    if (full.includes("gates.json")) continue;
    out.push(full);
  }
  return out;
}

function assertNoCeWiring() {
  const files = [
    ...walkSourceFiles(join(root, "services")),
    ...walkSourceFiles(join(root, "app")),
    ...walkSourceFiles(join(root, "scripts")),
    ...walkSourceFiles(join(root, "config")),
  ];
  const hits = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const pattern of FORBIDDEN) {
      if (pattern.test(text)) {
        hits.push(`${file.replace(root + "/", "")} ~ ${pattern}`);
      }
    }
  }
  if (hits.length > 0) {
    fail(`发现查询时 CE / reranker 接线嫌疑:\n  - ${hits.slice(0, 12).join("\n  - ")}`);
    return;
  }
  ok("代码树无查询时 CE / bge-reranker 产品接线");
}

function assertChatPriority() {
  const rc = createResourceCoordinator();
  const token = rc.markChatActive(10_000);
  const acquire = rc.tryAcquire({ kind: "embedding", owner: "smoke" });
  if (acquire.ok || acquire.reason !== "chat_priority") {
    fail(`Chat 优先失败: ${JSON.stringify(acquire)}`);
    rc.markChatIdle(token);
    return;
  }
  rc.markChatIdle(token);
  ok("ResourceCoordinator：Chat active 时 embedding 被拒绝");
}

console.log("=== RAG 8GB offline smoke (RU-001) ===\n");
runEval();
assertNoCeWiring();
assertChatPriority();

console.log("\n真机验收：在 8GB Mac 上手动跑通 上传→检索→对话→引用预览（见架构文档 · 低配 Mac 内存策略）");

if (failures.length > 0) {
  console.error(`\nsmoke-rag-8gb FAILED (${failures.length})`);
  process.exit(1);
}

console.log("\nsmoke-rag-8gb OK");
