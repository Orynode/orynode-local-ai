/**
 * 检索评测 runner（ML-P0）
 */

import { analyzeLanguage } from "../query/language-analyzer";
import {
  defaultFixturePath,
  defaultGatesPath,
  loadFixtureSet,
  loadGatesConfig,
} from "./fixtures";
import { mean, mrrAtK, ndcgAtK, percentile, recallAtK } from "./metrics";
import { getRanker, listRankerStrategies } from "./rankers";
import type {
  CaseMetricRow,
  EvalCase,
  EvalFixtureSet,
  EvalGatesConfig,
  EvalRunReport,
  GateThresholds,
  RankerStrategyId,
  StrategyReport,
} from "./types";

const DEFAULT_GATE_STRATEGIES: RankerStrategyId[] = [
  "keyword_multilingual_fields",
];

export type RunEvalOptions = {
  fixturePath?: string;
  gatesPath?: string;
  fixture?: EvalFixtureSet;
  gates?: EvalGatesConfig;
  strategies?: RankerStrategyId[];
  /** 仅跑门禁用的 primary；仍可传 strategies 覆盖 */
  enforceGates?: boolean;
};

export function runRetrievalEval(options: RunEvalOptions = {}): EvalRunReport {
  const fixture =
    options.fixture ?? loadFixtureSet(options.fixturePath ?? defaultFixturePath());
  const gates =
    options.gates ?? loadGatesConfig(options.gatesPath ?? defaultGatesPath());
  const strategies =
    options.strategies ??
    unique(
      [
        gates.primaryStrategy,
        gates.semanticStrategy,
        ...listRankerStrategies().filter(
          (s) => s !== "keyword" && s !== gates.semanticStrategy,
        ),
      ].filter(Boolean) as RankerStrategyId[],
    );
  const enforceGates = options.enforceGates !== false;

  const strategyReports = strategies.map((strategy) => {
    const isPrimary = strategy === gates.primaryStrategy;
    const isSemantic = strategy === gates.semanticStrategy;
    const thresholds: GateThresholds = isSemantic && gates.semanticGates
      ? { ...gates.thresholds, ...gates.semanticGates }
      : gates.thresholds;
    return evaluateStrategy(
      strategy,
      fixture,
      thresholds,
      enforceGates && (isPrimary || Boolean(isSemantic && gates.semanticGates)),
    );
  });

  const failures = strategyReports.flatMap((s) => {
    if (
      s.strategy === gates.primaryStrategy ||
      s.strategy === gates.semanticStrategy
    ) {
      return s.gateFailures;
    }
    return [];
  });

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    fixtureVersion: fixture.version,
    fixtureDescription: fixture.description,
    gatesVersion: gates.version,
    strategies: strategyReports,
    passed: failures.length === 0,
    failures,
  };
}

function evaluateStrategy(
  strategy: RankerStrategyId,
  fixture: EvalFixtureSet,
  thresholds: GateThresholds,
  enforceGates: boolean,
): StrategyReport {
  const rank = getRanker(strategy);
  const rows: CaseMetricRow[] = [];
  const elapsed: number[] = [];

  for (const item of fixture.cases) {
    const started = performance.now();
    const rankedIds = rank(item.query, fixture.corpus);
    const elapsedMs = performance.now() - started;
    elapsed.push(elapsedMs);

    const relevant = new Set(item.relevantChunkIds);
    const gated = isGatedCase(item, strategy);
    const queryLanguage = analyzeLanguage(item.query).primary;

    rows.push({
      caseId: item.id,
      category: item.category,
      query: item.query,
      queryLanguage,
      rankedIds,
      relevantChunkIds: item.relevantChunkIds,
      recallAt5: recallAtK(rankedIds, relevant, 5),
      recallAt8: recallAtK(rankedIds, relevant, 8),
      mrrAt10: mrrAtK(rankedIds, relevant, 10),
      ndcgAt10: ndcgAtK(rankedIds, relevant, 10),
      top1Hit:
        relevant.size === 0
          ? rankedIds.length === 0
          : Boolean(rankedIds[0] && relevant.has(rankedIds[0])),
      elapsedMs,
      gated,
    });
  }

  const gatedRows = rows.filter((r) => r.gated);
  const noAnswerRows = rows.filter((r) => r.category === "no_answer");
  const exactRows = rows.filter((r) => r.category === "exact" && r.gated);
  const crossRows = rows.filter(
    (r) =>
      (r.category === "zh→en" || r.category === "en→zh") && r.gated,
  );
  const zhRows = rows.filter((r) => r.category === "zh→zh" && r.gated);
  const enRows = rows.filter((r) => r.category === "en→en" && r.gated);

  const metrics = {
    recallAt5: mean(gatedRows.map((r) => r.recallAt5)),
    recallAt8: mean(gatedRows.map((r) => r.recallAt8)),
    mrrAt10: mean(gatedRows.map((r) => r.mrrAt10)),
    ndcgAt10: mean(gatedRows.map((r) => r.ndcgAt10)),
    noAnswerFalseRecall:
      noAnswerRows.length === 0
        ? 0
        : mean(noAnswerRows.map((r) => (r.rankedIds.length > 0 ? 1 : 0))),
    exactTop1:
      exactRows.length === 0 ? 1 : mean(exactRows.map((r) => (r.top1Hit ? 1 : 0))),
    crossLingualRecallAt8:
      crossRows.length === 0 ? 1 : mean(crossRows.map((r) => r.recallAt8)),
    zhZhRecallAt8: zhRows.length === 0 ? 1 : mean(zhRows.map((r) => r.recallAt8)),
    enEnRecallAt8: enRows.length === 0 ? 1 : mean(enRows.map((r) => r.recallAt8)),
  };

  const byCategory: StrategyReport["byCategory"] = {};
  for (const row of rows) {
    const bucket = byCategory[row.category] ?? {
      count: 0,
      recallAt8: 0,
      mrrAt10: 0,
    };
    bucket.count += 1;
    bucket.recallAt8 += row.recallAt8;
    bucket.mrrAt10 += row.mrrAt10;
    byCategory[row.category] = bucket;
  }
  for (const key of Object.keys(byCategory)) {
    const bucket = byCategory[key]!;
    bucket.recallAt8 /= bucket.count;
    bucket.mrrAt10 /= bucket.count;
  }

  const sortedElapsed = [...elapsed].sort((a, b) => a - b);
  const gateFailures = enforceGates
    ? collectGateFailures(strategy, metrics, thresholds)
    : [];

  return {
    strategy,
    caseCount: rows.length,
    gatedCaseCount: gatedRows.length,
    metrics,
    byCategory,
    cases: rows,
    elapsedMsP50: percentile(sortedElapsed, 50),
    elapsedMsP95: percentile(sortedElapsed, 95),
    gateFailures,
  };
}

function isGatedCase(item: EvalCase, strategy: RankerStrategyId): boolean {
  if (item.expectNoAnswer || item.category === "no_answer") {
    return false;
  }
  const allowed = item.gateStrategies ?? DEFAULT_GATE_STRATEGIES;
  if (allowed.includes(strategy)) return true;
  // hybrid stub 继承 keyword_multilingual_fields 门禁集合
  if (
    strategy === "hybrid_rrf_lexical_stub" &&
    allowed.includes("keyword_multilingual_fields")
  ) {
    return true;
  }
  return false;
}

function collectGateFailures(
  strategy: RankerStrategyId,
  metrics: StrategyReport["metrics"],
  thresholds: GateThresholds,
): string[] {
  const failures: string[] = [];
  const check = (name: string, actual: number, min: number, higherBetter = true) => {
    if (higherBetter) {
      if (actual + 1e-9 < min) {
        failures.push(
          `${strategy}: ${name}=${actual.toFixed(4)} < gate ${min.toFixed(4)}`,
        );
      }
    } else if (actual - 1e-9 > min) {
      failures.push(
        `${strategy}: ${name}=${actual.toFixed(4)} > gate ${min.toFixed(4)}`,
      );
    }
  };

  check("recallAt5", metrics.recallAt5, thresholds.recallAt5Min);
  check("recallAt8", metrics.recallAt8, thresholds.recallAt8Min);
  check("mrrAt10", metrics.mrrAt10, thresholds.mrrAt10Min);
  check("ndcgAt10", metrics.ndcgAt10, thresholds.ndcgAt10Min);
  check(
    "noAnswerFalseRecall",
    metrics.noAnswerFalseRecall,
    thresholds.noAnswerFalseRecallMax,
    false,
  );
  check("exactTop1", metrics.exactTop1, thresholds.exactTop1Min);
  check(
    "crossLingualRecallAt8",
    metrics.crossLingualRecallAt8,
    thresholds.crossLingualRecallAt8Min,
  );
  check("zhZhRecallAt8", metrics.zhZhRecallAt8, thresholds.zhZhRecallAt8Min);
  check("enEnRecallAt8", metrics.enEnRecallAt8, thresholds.enEnRecallAt8Min);
  return failures;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
