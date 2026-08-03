/**
 * JSON / Markdown 报告与配置对比
 */

import type { EvalRunReport, StrategyReport } from "./types";

export function reportToJson(report: EvalRunReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function reportToMarkdown(report: EvalRunReport): string {
  const lines: string[] = [];
  lines.push(`# Retrieval Eval Report`);
  lines.push("");
  lines.push(`- generatedAt: ${report.generatedAt}`);
  lines.push(`- fixture: v${report.fixtureVersion} — ${report.fixtureDescription}`);
  lines.push(`- gates: v${report.gatesVersion}`);
  lines.push(`- passed: **${report.passed ? "yes" : "no"}**`);
  if (report.failures.length > 0) {
    lines.push("");
    lines.push(`## Failures`);
    for (const f of report.failures) lines.push(`- ${f}`);
  }

  for (const strategy of report.strategies) {
    lines.push("");
    lines.push(`## Strategy \`${strategy.strategy}\``);
    lines.push("");
    lines.push(
      `| metric | value |`,
    );
    lines.push(`|---|---:|`);
    lines.push(`| Recall@5 | ${pct(strategy.metrics.recallAt5)} |`);
    lines.push(`| Recall@8 | ${pct(strategy.metrics.recallAt8)} |`);
    lines.push(`| MRR@10 | ${pct(strategy.metrics.mrrAt10)} |`);
    lines.push(`| nDCG@10 | ${pct(strategy.metrics.ndcgAt10)} |`);
    lines.push(
      `| no-answer false recall | ${pct(strategy.metrics.noAnswerFalseRecall)} |`,
    );
    lines.push(`| exact Top-1 | ${pct(strategy.metrics.exactTop1)} |`);
    lines.push(
      `| cross-lingual Recall@8 | ${pct(strategy.metrics.crossLingualRecallAt8)} |`,
    );
    lines.push(`| zh→zh Recall@8 | ${pct(strategy.metrics.zhZhRecallAt8)} |`);
    lines.push(`| en→en Recall@8 | ${pct(strategy.metrics.enEnRecallAt8)} |`);
    lines.push(`| latency P50 ms | ${strategy.elapsedMsP50.toFixed(2)} |`);
    lines.push(`| latency P95 ms | ${strategy.elapsedMsP95.toFixed(2)} |`);
    lines.push(`| gated cases | ${strategy.gatedCaseCount} |`);

    if (strategy.gateFailures.length > 0) {
      lines.push("");
      lines.push(`Gate failures:`);
      for (const f of strategy.gateFailures) lines.push(`- ${f}`);
    }

    lines.push("");
    lines.push(`### By category`);
    lines.push(`| category | n | Recall@8 | MRR@10 |`);
    lines.push(`|---|---:|---:|---:|`);
    for (const [cat, row] of Object.entries(strategy.byCategory).sort()) {
      lines.push(
        `| ${cat} | ${row.count} | ${pct(row.recallAt8)} | ${pct(row.mrrAt10)} |`,
      );
    }
  }

  lines.push("");
  return lines.join("\n");
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export type CompareResult = {
  baseline: EvalRunReport;
  candidate: EvalRunReport;
  deltas: Array<{
    strategy: string;
    metric: string;
    baseline: number;
    candidate: number;
    delta: number;
  }>;
  regressions: string[];
};

/**
 * 比较两份报告：对 primary 策略的关键指标计算 delta；
 * 若 candidate 相对 baseline 下降超过 tol，记为 regression。
 */
export function compareReports(
  baseline: EvalRunReport,
  candidate: EvalRunReport,
  options: { strategy?: string; tol?: number } = {},
): CompareResult {
  const tol = options.tol ?? 1e-9;
  const strategyId =
    options.strategy ??
    candidate.strategies[0]?.strategy ??
    baseline.strategies[0]?.strategy;
  const base = baseline.strategies.find((s) => s.strategy === strategyId);
  const cand = candidate.strategies.find((s) => s.strategy === strategyId);
  if (!base || !cand) {
    return {
      baseline,
      candidate,
      deltas: [],
      regressions: [`缺少策略 ${strategyId} 用于对比`],
    };
  }

  const keys: Array<keyof StrategyReport["metrics"]> = [
    "recallAt5",
    "recallAt8",
    "mrrAt10",
    "ndcgAt10",
    "exactTop1",
    "crossLingualRecallAt8",
    "zhZhRecallAt8",
    "enEnRecallAt8",
  ];
  // 误召回：越低越好
  const lowerBetter = new Set(["noAnswerFalseRecall"]);

  const deltas: CompareResult["deltas"] = [];
  const regressions: string[] = [];

  for (const key of keys) {
    const b = base.metrics[key];
    const c = cand.metrics[key];
    deltas.push({
      strategy: strategyId!,
      metric: key,
      baseline: b,
      candidate: c,
      delta: c - b,
    });
    if (c + tol < b) {
      regressions.push(
        `${strategyId}.${key}: ${b.toFixed(4)} → ${c.toFixed(4)} (Δ=${(c - b).toFixed(4)})`,
      );
    }
  }

  {
    const key = "noAnswerFalseRecall" as const;
    const b = base.metrics[key];
    const c = cand.metrics[key];
    deltas.push({
      strategy: strategyId!,
      metric: key,
      baseline: b,
      candidate: c,
      delta: c - b,
    });
    if (lowerBetter.has(key) && c - tol > b) {
      regressions.push(
        `${strategyId}.${key}: ${b.toFixed(4)} → ${c.toFixed(4)} (worse)`,
      );
    }
  }

  return { baseline, candidate, deltas, regressions };
}

export function compareToMarkdown(result: CompareResult): string {
  const lines = [
    `# Retrieval Eval Compare`,
    "",
    `regressions: **${result.regressions.length === 0 ? "none" : result.regressions.length}**`,
    "",
  ];
  if (result.regressions.length > 0) {
    lines.push(`## Regressions`);
    for (const r of result.regressions) lines.push(`- ${r}`);
    lines.push("");
  }
  lines.push(`| strategy | metric | baseline | candidate | delta |`);
  lines.push(`|---|---|---:|---:|---:|`);
  for (const d of result.deltas) {
    lines.push(
      `| ${d.strategy} | ${d.metric} | ${d.baseline.toFixed(4)} | ${d.candidate.toFixed(4)} | ${d.delta.toFixed(4)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
