#!/usr/bin/env node
/**
 * 离线检索评测 CLI（ML-P0）
 *
 * CI 门禁以 keyword_multilingual_fields 为主。
 * hybrid_rrf_lexical_stub 为实验管线（词袋 stub，不下载真实 embedding）；
 * 真实模型写入与召回评测另开里程碑。
 *
 * 用法：
 *   npm run test:retrieval-eval
 *   node --import tsx scripts/knowledge/run-retrieval-eval.ts --json out/eval.json --md out/eval.md
 *   node --import tsx scripts/knowledge/run-retrieval-eval.ts --compare tests/fixtures/rag/baseline-report.json
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  compareReports,
  compareToMarkdown,
  loadGatesConfig,
  reportToJson,
  reportToMarkdown,
  runRetrievalEval,
} from "../../services/knowledge/evaluation/index";

function argValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

function ensureParent(filePath: string) {
  mkdirSync(dirname(filePath), { recursive: true });
}

const jsonOut = argValue("--json");
const mdOut = argValue("--md");
const comparePath = argValue("--compare");
const fixturePath = argValue("--fixture") ?? undefined;
const gatesPath = argValue("--gates") ?? undefined;

const report = runRetrievalEval({
  fixturePath: fixturePath ? resolve(fixturePath) : undefined,
  gatesPath: gatesPath ? resolve(gatesPath) : undefined,
});

const jsonText = reportToJson(report);
const mdText = reportToMarkdown(report);

if (jsonOut) {
  const path = resolve(jsonOut);
  ensureParent(path);
  writeFileSync(path, jsonText, "utf8");
  console.error(`wrote ${path}`);
}
if (mdOut) {
  const path = resolve(mdOut);
  ensureParent(path);
  writeFileSync(path, mdText, "utf8");
  console.error(`wrote ${path}`);
}

if (!jsonOut && !mdOut) {
  process.stdout.write(mdText);
}

if (comparePath) {
  const baseline = JSON.parse(readFileSync(resolve(comparePath), "utf8"));
  const gates = loadGatesConfig(gatesPath ? resolve(gatesPath) : undefined);
  const refined = compareReports(baseline, report, {
    strategy: gates.primaryStrategy,
  });
  process.stdout.write(`\n${compareToMarkdown(refined)}`);
  if (refined.regressions.length > 0) {
    console.error("REGRESSION detected");
    process.exitCode = 1;
  }
}

if (!report.passed) {
  console.error("GATE FAILED:");
  for (const f of report.failures) console.error(`  - ${f}`);
  process.exitCode = 1;
}
