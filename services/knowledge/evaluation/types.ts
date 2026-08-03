/**
 * 检索评测领域类型（ML-001 / ML-P0）
 */

export type RetrievalEvalCategory =
  | "zh→zh"
  | "en→en"
  | "zh→en"
  | "en→zh"
  | "mixed"
  | "zh-Hans↔zh-Hant"
  | "exact"
  | "paraphrase"
  | "long_query"
  | "conflict"
  | "no_answer";

export type RankerStrategyId =
  | "keyword"
  | "keyword_multilingual_fields"
  | "multi_query"
  | "lexical_rerank"
  /**
   * 实验/延期：词袋 stub 模拟 hybrid RRF 管线，不下载真实 embedding。
   * 真实模型下载、向量写入与召回阈值评测另开里程碑。
   */
  | "hybrid_rrf_lexical_stub";

export interface EvalChunk {
  id: string;
  documentId: string;
  text: string;
  /** 可选语言提示，仅诊断 */
  language?: string;
}

export interface EvalCase {
  id: string;
  category: RetrievalEvalCategory;
  query: string;
  /** 期望相关 chunk id；无答案为空 */
  relevantChunkIds: string[];
  /** true：不应召回任何相关正分（或仅噪声） */
  expectNoAnswer?: boolean;
  /**
   * 参与 keyword 门禁的策略；缺省仅 keyword_multilingual_fields
   * paraphrase / 纯跨语言无字面重合可设为 []，只记基线不分门禁
   */
  gateStrategies?: RankerStrategyId[];
  notes?: string;
}

export interface EvalFixtureSet {
  version: number;
  description: string;
  corpus: EvalChunk[];
  cases: EvalCase[];
}

export interface GateThresholds {
  /** 整体 / 分项 Recall@k 下限 */
  recallAt8Min: number;
  recallAt5Min: number;
  mrrAt10Min: number;
  ndcgAt10Min: number;
  /** 无答案误召回率上限（召回了非空结果的比例） */
  noAnswerFalseRecallMax: number;
  /** exact 类 Top-1 准确率下限 */
  exactTop1Min: number;
  /** 跨语言（zh→en + en→zh）Recall@8 下限；keyword 基线可较低 */
  crossLingualRecallAt8Min: number;
  /** 同语言中文 Recall@8 */
  zhZhRecallAt8Min: number;
  /** 同语言英文 Recall@8 */
  enEnRecallAt8Min: number;
}

export interface EvalGatesConfig {
  version: number;
  description: string;
  /** 默认用于 CI 门禁的 ranker */
  primaryStrategy: RankerStrategyId;
  thresholds: GateThresholds;
  /** 可选：hybrid_rrf_lexical_stub（实验管线）或未来真实语义策略；非发布阻塞门禁 */
  semanticStrategy?: RankerStrategyId;
  semanticGates?: Partial<GateThresholds>;
}

export interface CaseMetricRow {
  caseId: string;
  category: RetrievalEvalCategory;
  query: string;
  queryLanguage: string;
  rankedIds: string[];
  relevantChunkIds: string[];
  recallAt5: number;
  recallAt8: number;
  mrrAt10: number;
  ndcgAt10: number;
  top1Hit: boolean;
  elapsedMs: number;
  gated: boolean;
}

export interface StrategyReport {
  strategy: RankerStrategyId;
  caseCount: number;
  gatedCaseCount: number;
  metrics: {
    recallAt5: number;
    recallAt8: number;
    mrrAt10: number;
    ndcgAt10: number;
    noAnswerFalseRecall: number;
    exactTop1: number;
    crossLingualRecallAt8: number;
    zhZhRecallAt8: number;
    enEnRecallAt8: number;
  };
  byCategory: Record<
    string,
    { count: number; recallAt8: number; mrrAt10: number }
  >;
  cases: CaseMetricRow[];
  elapsedMsP50: number;
  elapsedMsP95: number;
  gateFailures: string[];
}

export interface EvalRunReport {
  version: 1;
  generatedAt: string;
  fixtureVersion: number;
  fixtureDescription: string;
  gatesVersion: number;
  strategies: StrategyReport[];
  passed: boolean;
  failures: string[];
}
