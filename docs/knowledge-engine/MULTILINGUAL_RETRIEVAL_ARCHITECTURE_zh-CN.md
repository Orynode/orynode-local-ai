# Orynode 中英多语言检索架构设计

> 状态：开发实施方案（Proposed）  
> 适用范围：本地资料库、会话附件、Chat RAG、Agent Knowledge Tools  
> 目标语言：第一阶段简体中文、繁体中文、英文及中英混合技术内容  
> 依赖文档：[AI Knowledge Engine 长期架构](KNOWLEDGE_ENGINE_ARCHITECTURE_zh-CN.md)、[架构整改实施计划](KNOWLEDGE_ENGINE_IMPLEMENTATION_PLAN_zh-CN.md)  
> 查询逻辑规范：[知识库查询语义标准](KNOWLEDGE_QUERY_SEMANTICS_STANDARD_zh-CN.md)  
> 核心约束：本地优先、离线可用、可降级、索引可版本化、结果可评测

## 1. 背景与问题定义

当前检索已经具备 FTS5、中文 bigram、可选向量召回、RRF、多查询和 lexical rerank，但“支持中文字符和英文字符”不等同于“多语言检索”。当前主要风险包括：

1. 英文只抽取 ASCII 字母、数字和下划线，`C++`、`C#`、`Node.js` 等技术词容易被破坏；
2. 中文连续文本产生大量 bigram，长问题可能在核心词进入前耗尽 `maxSearchTerms`；
3. 所有 FTS 查询词用 `OR` 连接，常用词和噪声词可能压过核心短语；
4. 默认向量模型 `bge-small-zh-v1.5` 以中文为主，不能作为稳定的跨语言语义空间；
5. 多查询只是原查询的词项裁剪，没有同义词、术语映射或跨语言改写；
6. Quality 档 lexical reranker 会以字面重合分覆盖融合分，可能破坏跨语言向量召回结果；
7. 缺少中英、跨语言、简繁体及技术标识符的系统评测门禁。

本方案要解决三种不同问题，开发时不得混为一谈：

| 场景 | 示例 | 主要解决手段 |
|---|---|---|
| 同语言检索 | 中文问中文、英文问英文 | 语言感知词法分析 + 向量召回 |
| 跨语言检索 | 中文问英文、英文问中文 | 多语言 embedding + 可选查询改写 |
| 混合技术检索 | “Node.js 如何配置访问令牌” | 精确术语字段 + 中英文分析 + 向量召回 |

## 2. 目标与非目标

### 2.1 目标

1. 中文、英文和中英混合资料在默认离线环境下均有可靠的关键词召回；
2. 开启语义能力时，中文查询可召回英文资料，英文查询可召回中文资料；
3. 文件名、错误码、产品名、API 名和代码符号保持精确检索能力；
4. 查询分析、召回、融合和重排均输出稳定 diagnostics，便于定位质量问题；
5. tokenizer、normalizer、embedding 或 reranker 升级通过新 `IndexBuild` 灰度切换并可回滚；
6. 低资源机器至少保留 Lite 关键词基线，不因多语言模型不可用而失去检索能力；
7. 所有策略升级必须通过中英离线评测，不以少量人工样例决定默认值。

### 2.2 非目标

- 第一阶段不支持所有自然语言，不承诺日语、韩语、阿拉伯语等语言质量；
- 不默认把用户文档翻译后另存一份；
- 不把云翻译、云 embedding 或外部搜索服务作为基础依赖；
- 不在第一阶段引入 Elasticsearch/OpenSearch；SQLite FTS5 仍为默认关键词索引；
- 不让 Chat、Agent 或 UI 各自实现语言识别和查询改写。

## 3. 架构决策

### ADR-ML-001：采用多路召回，不采用单一路径

最终结果由以下候选列表融合：

1. 精确召回：文件名、标题、错误码、代码符号、原始短语；
2. 语言感知 FTS：中文、英文和通用 n-gram 字段；
3. 多语言向量：同语言语义与跨语言语义；
4. 可选改写查询：受控术语扩展、简繁归一化和必要的跨语言改写。

任何一路不可用时，系统继续使用剩余路径并记录稳定降级码。

### ADR-ML-002：语言识别用于路由和诊断，不用于硬过滤

短查询、技术词和中英混合文本很难可靠识别单一语言。因此：

- 文档/Chunk 保存 `languageHints`，查询生成 `LanguageProfile`；
- 语言结果决定 analyzer、候选权重和是否考虑跨语言改写；
- 不因语言不一致直接排除候选；
- `mixed` 和 `undetermined` 是一等状态，不作为错误。

### ADR-ML-003：默认不翻译整库

跨语言主路径是多语言 embedding。查询翻译仅为 Quality 档的可选补充，并满足：

- 仅在查询与主要资料语言明显不一致时触发；
- 先用本地术语表，再考虑本地模型改写；
- 文件名、错误码、代码符号和引号短语不翻译；
- 原查询始终参与召回，译文不能替换原查询；
- diagnostics 保存改写类型，不保存或上传用户资料到外部服务。

### ADR-ML-004：模型和分析器变化必须生成新 IndexBuild

下列变化必须构建新索引，完成后原子切换 active build：

- `normalizerVersion`；
- `tokenizer/analyzerVersion`；
- `embeddingModel`、revision、dimension 或 query/passage 模板；
- chunk strategy；
- sparse/keyword 字段结构。

新旧向量模型严禁混用。失败时保留旧 active build。

### ADR-ML-005：无语义 reranker 时不得覆盖融合顺序

Lexical overlap 只允许作为小幅 feature boost，不能作为最终重排分覆盖 RRF/向量结果。若没有可用的多语言语义 reranker：

- Balanced：直接保留融合顺序；
- Quality：可做多查询、去重和多样性处理，但不得宣称 semantic rerank；
- 所有 lexical 得分为零时必须保持原顺序和原分数。

### ADR-ML-006：查询证据必须跨层保持结构与来源

`QueryPlanner` 生成的术语、短语和改写不得先拼成普通字符串、再由索引层重新分词。
例如 `原子尺度 → ["atomistic", "atomic-scale"]` 必须以结构化词项传到 FTS；不得退化为
`atomistic OR atomic-scale OR atomic OR scale`。否则召回层会引入仅包含 `scale` 的结果，
而高亮层仍按 `atomistic` 判断，形成“已召回但无法高亮”的协议矛盾。

同时遵守以下不变量：

- `displayName` 是展示元数据，不是正文相关性证据，不参与召回和阈值豁免；
- 短语意图必须按 `phrase → all terms (AND) → semantic fallback` 分层召回，禁止直接退化为单词 `OR`；
- 只有实际贡献候选的召回列表才能进入融合；空列表不触发 RRF；
- diagnostics 描述实际贡献，而不是仅描述配置或尝试过的能力；
- 单一贡献列表保留原始索引分数，不得用 RRF 分数覆盖；
- UI 高亮使用与召回响应同源的结构化 `highlightTerms`。

跨进程 HTTP DTO 同样属于该契约。`phrase`、`terms`、`exactTerms` 等规划字段必须在
Planner、Adapter、data-service 路由和索引实现之间逐项保留，并由契约测试防止字段被静默丢弃。

## 4. 目标架构

```text
                         SearchRequest
                              │
                 Query Analyzer / Language Profile
                 ┌────────────┼────────────┐
                 │            │            │
              Exact       Lexical Plan   Semantic Plan
              terms       zh/en/mixed     multilingual
                 │            │            │
                 ▼            ▼            ▼
           Exact Index    FTS5 Fields   Vector Index
                 │            │            │
                 └────── Candidate Sets ───┘
                              │
                    Normalize + Weighted RRF
                              │
                    Dedupe + Diversity Filter
                              │
               Optional Multilingual Semantic Reranker
                              │
                Threshold + Neighbor Expansion + Packing
                              │
               RetrievalResponse + Diagnostics + Citations
```

所有入口统一调用 `KnowledgeEngine.retrieve()`；Chat、Agent 和知识工作台不得绕过本流水线直接查 FTS 或向量表。

## 5. 领域模型与接口

### 5.1 LanguageProfile

新增平台中立类型：

```ts
export type LanguageTag =
  | "zh-Hans"
  | "zh-Hant"
  | "en"
  | "mixed"
  | "undetermined";

export interface LanguageSignal {
  tag: LanguageTag;
  confidence: number; // 0..1
  share?: number;     // 文本中的估算比例
}

export interface LanguageProfile {
  primary: LanguageTag;
  signals: LanguageSignal[];
  hasHan: boolean;
  hasLatin: boolean;
  hasTechnicalTerms: boolean;
  normalizedQuery: string;
}
```

第一阶段使用确定性脚本比例 + 简繁特征进行轻量识别，不强制加载独立语言模型。识别器通过 port 暴露，未来可替换：

```ts
export interface LanguageAnalyzerPort {
  analyze(text: string): Promise<LanguageProfile>;
}
```

### 5.2 QueryPlan

查询分析只生成计划，不执行检索：

```ts
export interface QueryVariant {
  id: string;
  text: string;
  kind: "original" | "normalized" | "term_expansion" | "translation";
  language: LanguageTag;
  weight: number;
  /** 结构化词项；尤其用于保持术语扩展和复合短语的边界 */
  terms?: string[];
}

export interface ExactTerm {
  value: string;
  kind: "filename" | "error_code" | "symbol" | "quoted" | "product";
  weight: number;
}

export interface RetrievalQueryPlan {
  language: LanguageProfile;
  variants: QueryVariant[];
  exactTerms: ExactTerm[];
  strategies: Array<"exact" | "keyword" | "vector" | "rerank">;
  budgets: {
    exactCandidates: number;
    keywordCandidates: number;
    vectorCandidates: number;
    rerankCandidates: number;
  };
}
```

`QueryPlanner` 是唯一允许决定查询改写、候选规模和召回路径的组件。现有 `buildMultiQueries()` 迁入该组件，避免 pipeline 分散判断。

### 5.3 索引端口扩展

现有 `KeywordIndex.search(query, options)` 不足以表达多字段和权重，演进为：

```ts
export interface KeywordQuery {
  variants: QueryVariant[];
  exactTerms: ExactTerm[];
  language: LanguageProfile;
}

export interface KeywordSearchOptions {
  topK: number;
  candidateLimit: number;
  spaceIds?: string[];
  documentIds?: string[];
  activeBuildIds?: string[];
}

export interface KeywordIndex {
  upsert(build: IndexBuildRef, chunks: IndexChunk[]): Promise<void>;
  search(query: KeywordQuery, options: KeywordSearchOptions): Promise<IndexCandidate[]>;
}
```

迁移期保留 legacy adapter，把字符串查询包装为单个 `original` variant。

### 5.4 Diagnostics 扩展

新增以下字段，默认不向最终模型 prompt 注入：

```ts
export interface MultilingualDiagnostics {
  queryLanguage: LanguageProfile;
  variants: Array<{ kind: string; language: string; weight: number }>;
  candidateCounts: Record<string, number>;
  activeKeywordBuild?: string;
  activeVectorBuild?: string;
  embeddingModel?: string;
  rerankerModel?: string;
  fusion: "none" | "weighted_rrf" | "keyword_only" | "vector_only";
  degradedReasons: MultilingualDegradedReason[];
}

export type MultilingualDegradedReason =
  | "LANGUAGE_UNDETERMINED"
  | "MULTILINGUAL_VECTOR_UNAVAILABLE"
  | "VECTOR_BUILD_NOT_READY"
  | "SEMANTIC_RERANKER_UNAVAILABLE"
  | "QUERY_REWRITE_UNAVAILABLE"
  | "KEYWORD_ANALYZER_FALLBACK"
  | "LEGACY_INDEX_ACTIVE";
```

## 6. 文本规范化与关键词索引

### 6.1 规范化分层

必须同时保留原始文本和检索派生文本：

| 字段 | 用途 | 允许的变换 |
|---|---|---|
| `content` | 引用、展示、模型上下文 | 不改写 |
| `exact_text` | 文件名、代码、错误码、精确短语 | Unicode NFC、大小写折叠副本 |
| `zh_text` | 中文词法召回 | 简繁扩展、bigram/可替换中文 tokenizer |
| `en_text` | 英文词法召回 | Unicode 分词、可选 stemming/lemmatization |
| `mixed_text` | 中英相邻词、产品术语 | 保留标点的技术 token + n-gram |

不要把简体或翻译结果覆盖进 `content`。所有派生字段必须由 `normalizerVersion` 和 `analyzerVersion` 标识，可重新生成。

### 6.2 第一阶段 SQLite FTS5 实现

为降低迁移风险，第一阶段建议使用一个 external-content 风格的 FTS 表，多列存储：

```sql
CREATE VIRTUAL TABLE knowledge_chunks_fts_v2 USING fts5(
  chunk_id UNINDEXED,
  document_id UNINDEXED,
  index_build_id UNINDEXED,
  exact_text,
  zh_text,
  en_text,
  mixed_text,
  tokenize = 'unicode61 remove_diacritics 2'
);
```

查询时使用列权重 BM25，例如初始值：

```sql
bm25(knowledge_chunks_fts_v2, 8.0, 3.0, 3.0, 2.0)
```

具体权重只能通过评测确定，不作为永久常量。

### 6.3 中文策略

第一阶段继续使用 bigram，但修正当前缺陷：

- 以句段和标点为边界，不对整条长查询无限展开；
- 区分核心短语、bigram 和低信息词，不全部等权；
- 查询词选择按信息量和词类预算，而不是出现顺序截取前 40 个；
- 添加可版本化简繁映射，索引原形式和映射形式；
- 停用词只能降权，不能在精确短语中删除；
- 后续可在 `KeywordIndex` adapter 内替换为 ICU/专用中文 tokenizer，上层契约不变。

### 6.4 英文和技术词策略

- 使用 Unicode 字母类而不是仅 `[a-z]`；
- 英文正文支持基本词形归一，但 exact 字段保留原形；
- 技术 tokenizer 必须识别 `C++`、`C#`、`.NET`、`Node.js`、`foo_bar`、`foo-bar`、路径、版本号、HTTP 状态码；
- 单字符词仅在白名单或技术上下文中保留，例如 `C`、`R`；
- 文件名、标题、heading、source path 应进入独立高权重字段或 exact term 路径。

### 6.5 术语库（可学习）

```ts
interface TerminologyEntry {
  id: string;
  terms: string[];       // ["访问令牌", "access token"]
  domain?: string;
  exclude?: string[];
  source: "builtin" | "learned" | "user";
}
```

- 内置表只放极小冷启动种子；
- 正式路径：`resolveQueryRewrite` → SQLite 术语库命中则跳过 LLM；未命中则本地 LLM 结构化改写并晋升入库；
- QueryPlanner **只消费**注入的 `StructuredQueryRewrite`，不再内部查表；
- 术语扩展属于查询 variant，不修改用户原查询，也不修改文档原文。

## 7. 多语言向量索引

### 7.1 模型要求

候选模型必须满足：

- 明确支持中文和英文跨语言检索；
- 本地离线推理；
- Apple Silicon CPU/统一内存可接受；
- query/document 编码约定明确；
- 模型 revision、dimension、最大输入长度可记录；
- 许可允许项目分发或由安装器下载。

不要在设计文档中硬编码最终默认模型。首轮基准至少比较：

- 当前 `bge-small-zh-v1.5`，作为回归基线；
- 一个小型 multilingual E5 类模型；
- BGE-M3 或同等级多语言模型，作为质量上限参考。

### 7.2 模板与向量兼容性

`IndexBuild.configHash` 必须覆盖：

```text
model + revision + dimension + pooling + normalization
+ queryTemplate + passageTemplate + maxInputTokens
+ chunkStrategyVersion
```

如果模型要求 `query:` / `passage:` 前缀，索引和查询必须分别使用正确模板。模板变化视同模型变化，必须重建向量。

### 7.3 资源档位

| 档位 | 行为 |
|---|---|
| Lite | 精确 + 多语言关键词，不加载 embedding |
| Balanced | 精确 + 关键词 + 多语言向量 + weighted RRF |
| Quality | Balanced + 受控改写 + 可用时多语言语义 reranker |

`auto` 仍由 Capability Registry 解析；模型未下载、内存不足或索引未就绪时降级 Lite，并返回原因码。

## 8. 召回、融合与重排

### 8.1 候选召回

推荐初始候选规模，仅作为评测起点：

```text
Exact Top 20
Keyword Top 40
Vector Top 40
每个 Query Variant Top 20～40
合并去重后最多 80
Rerank Top 30
最终 Top 8～12
```

候选规模应受 scope、资料规模和资源档位约束。

### 8.2 Weighted RRF

不同召回分数不可直接相加。使用带权 RRF：

```text
score(d) = Σ weight(list) / (k + rank(d, list) + 1)
```

建议初始权重：

| 列表 | 初始权重 |
|---|---:|
| exact phrase/symbol | 2.0 |
| original keyword | 1.2 |
| original vector | 1.2 |
| normalized query | 1.0 |
| terminology expansion | 0.8 |
| translated query | 0.7 |

权重和 `k` 必须进入检索配置版本和评测报告。

### 8.3 Rerank

优先级：

1. 可用的本地多语言 cross-encoder/语义 reranker；
2. 无语义 reranker时保持 weighted RRF；
3. lexical feature 只用于相同语言或 exact boost，最大只能产生有限增量；
4. 禁止把全零 lexical 分数写回并覆盖融合分。

Reranker 输入必须是原查询和原始 chunk 内容，不能只使用翻译查询。

### 8.4 Threshold 和无答案

不同模型和召回器的 raw score 不可共用固定阈值。阈值策略需要：

- 在融合后基于排名、候选覆盖和 reranker 分数共同决定；
- 按 active model/build 版本校准；
- 无高质量候选时返回空上下文或低置信诊断，不强迫模型回答；
- 评测无答案误召回率。

## 9. 数据库与索引版本迁移

### 9.1 Schema 扩展

建议扩展而不是覆盖旧表：

```text
chunk_language_profiles
  namespace, chunk_id, processing_build_id
  primary_language, signals_json, detector_version

keyword_index_builds（或复用 index_builds）
  analyzer_version, normalizer_version, terminology_version
  config_hash, status, is_active

query_terminology
  id, terms_json, domains_json, enabled, source, updated_at
```

现有 `index_builds` 能表达的字段优先复用；不要建立第二套彼此冲突的 build 生命周期。

### 9.2 Expand / Migrate / Contract

1. **Expand**：新增 FTS v2 表、语言 profile 和新 build 字段；旧索引继续服务；
2. **Dual write**：新导入内容同时写 legacy FTS 和 FTS v2；
3. **Backfill**：后台 Job 按文档生成语言 profile 和 v2 keyword build；
4. **Shadow read**：线上仍返回旧结果，同时采样执行新 pipeline，仅记录差异；
5. **Activate**：评测达标后原子切换 active build；
6. **Rollback window**：至少保留一个稳定版本的旧 build；
7. **Contract**：确认升级、恢复和备份兼容后，再停止 legacy 写入；删除旧表另立任务。

迁移不能要求用户重新上传原件。

### 9.3 Job 类型

新增或扩展：

- `analyze_document_language`；
- `build_keyword_index_v2`；
- `build_multilingual_vector_index`；
- `backfill_multilingual_indexes`；
- `evaluate_retrieval_snapshot`。

Job 必须具备 idempotency key、lease、heartbeat、retry、取消安全点和进度信息。

## 10. 代码模块调整建议

```text
services/knowledge/
├── query/
│   ├── language-analyzer.ts
│   ├── exact-terms.ts
│   ├── terminology.ts
│   └── planner.ts
├── retrieval/
│   ├── recall.ts
│   ├── weighted-rrf.ts
│   ├── diversity.ts
│   ├── threshold.ts
│   └── rerank.ts
├── indexing/
│   ├── multilingual-normalizer.ts
│   ├── keyword-build.ts
│   └── vector-build.ts
├── ports/
│   ├── indexes.ts
│   ├── models.ts
│   └── language.ts
└── evaluation/
    ├── fixtures.ts
    ├── metrics.ts
    └── runner.ts
```

建议迁移映射：

| 当前模块 | 调整 |
|---|---|
| `retrieval/keyword.ts` | 保留纯函数；拆出 exact、Unicode token、weighted RRF |
| `retrieval/search-text.ts` | 迁为版本化 multilingual normalizer |
| `retrieval/multi-query.ts` | 合并进 `QueryPlanner` |
| `retrieval/query-type.ts` | 合并进 exact term/query classification |
| `retrieval/rerank.ts` | lexical 不再冒充最终 reranker；增加保序 fallback |
| `application/engine.ts` | 只编排 QueryPlan → Recall → Fusion → Rerank → Pack |
| `scripts/data-service/fts-index.mjs` | 实现 FTS v2 adapter 和 active build 过滤 |
| `embed-config.mjs` | 改为 artifact registry，不再只有固定中文模型常量 |

## 11. API 与 UI 行为

### 11.1 API

`SearchRequest` 保持兼容，新增字段均为可选：

```ts
interface SearchRequest {
  query: string;
  scope: RetrievalScope;
  topK?: number;
  knowledgeTier?: "auto" | "lite" | "balanced" | "quality";
  languageHint?: LanguageTag; // 仅提示，不可信、不可硬过滤
  diagnosticsLevel?: "none" | "summary" | "debug";
}
```

普通 Chat 默认 `summary`；知识检索调试页可用 `debug`。debug 信息不得包含绝对路径、凭证或完整私有原文。

### 11.2 UI

普通用户不需要选择“中文/英文检索”。设置页只显示：

- 自动；
- 省资源；
- 更高质量。

能力状态可显示：

- “多语言语义检索已就绪”；
- “当前使用关键词检索”；
- “正在重建多语言索引”；
- “语义模型不可用，已自动降级”。

开发诊断页可展示 query language、改写、各路候选数、active build 和降级原因。

## 12. 安全、隐私与资源约束

1. 语言识别、术语扩展、embedding、rerank 和翻译默认在本机完成；
2. 不为语言识别上传查询或文档；
3. 外部翻译只能作为未来显式启用的 adapter，并必须显示数据出口；
4. diagnostics 不记录完整私有查询和 chunk，默认保存 hash、长度、语言和排名信息；
5. embedding/rerank 与 Chat 共享 Resource Coordinator，Chat 优先；
6. 模型下载必须校验 artifact 版本与完整性，并允许用户删除；
7. 低内存档位不加载大型多语言 reranker。

## 13. 评测体系与门禁

### 13.1 Fixture 维度

至少建立以下类别，每类包含有答案和无答案样例：

| 类别 | 示例 |
|---|---|
| zh→zh | 中文问题检索中文段落 |
| en→en | English query retrieves English passage |
| zh→en | “如何创建 access token”检索英文文档 |
| en→zh | “how to rebuild vector index”检索中文文档 |
| mixed | Node.js、API token、中英文混排 |
| zh-Hans↔zh-Hant | 简体查询检索繁体内容，反向亦然 |
| exact | 文件名、错误码、代码符号、版本号 |
| paraphrase | 同义表达但无字面重合 |
| long query | 长自然语言问题，核心词位于后半段 |
| conflict | 多来源冲突，验证排序和引用 |

Fixture 必须来自无隐私、可提交的小型文档集，并保存期望 relevant chunk ids。

### 13.2 指标

- Recall@5、Recall@8；
- MRR@10；
- nDCG@10；
- 无答案误召回率；
- 跨语言 Recall@8 单独统计；
- exact query Top-1 accuracy；
- P50/P95 检索延迟；
- 索引耗时、峰值 RSS、磁盘增量；
- 降级模式成功率。

### 13.3 上线门禁

默认模型或 analyzer 切换至少满足：

1. 中文同语言 Recall@8 不低于当前基线；
2. 英文同语言与跨语言指标显著高于当前基线；
3. exact Top-1 不回退；
4. 无答案误召回率不恶化超过约定阈值；
5. Lite P95 和内存仍满足低资源预算；
6. 新 build 失败可回退旧 build；
7. 离线、重启、取消和升级路径通过集成测试。

具体数值由首次基准确定后固化在 CI 配置，不在代码中散落。

## 14. 分阶段实施计划

### ML-P0：建立事实基线

- 新增中英双语 fixture 与评测 runner；
- 为当前 keyword、hybrid、multi-query、rerank 分阶段记录指标；
- 增加 query/chunk language diagnostics；
- 添加跨语言 lexical 全零时保持融合顺序的回归测试。

**验收：** CI 可生成机器可读 JSON 和 Markdown 报告，并能比较两个检索配置。

### ML-P1：关键词索引 v2

- 实现 Unicode/技术词 tokenizer；
- 实现中文分段 bigram、简繁扩展和信息量预算；
- 建立 exact/zh/en/mixed 多字段 FTS；
- 增加 active keyword build 和 dual write/backfill；
- QueryPlanner 取代当前简单 term 截断。

**验收：** Lite 档覆盖 zh→zh、en→en、mixed、exact 和简繁场景，且可回滚 legacy FTS。

### ML-P2：多语言向量

- 建立 embedding artifact registry；
- 对候选模型运行质量、延迟、内存基准；
- 选择默认多语言模型及低资源策略；
- 创建新 Vector IndexBuild，后台回填并原子切换；
- 严格校验模型 revision、dimension 和模板兼容。

**验收：** zh→en 与 en→zh Recall@8 达到首次设定门禁，旧向量 build 可恢复。

### ML-P3：融合与重排

- 实现 weighted RRF；
- lexical feature 改为有限 boost；
- 引入可选多语言语义 reranker adapter；
- 加入 diversity、动态 threshold 和无答案策略；
- 完善 pipeline diagnostics。

**验收：** rerank 不降低跨语言指标，未安装 reranker 时结果顺序稳定且降级原因明确。

### ML-P4：受控查询改写

- 上线内置和用户术语表；
- 增加简繁和缩写扩展；
- 可选本地跨语言 query rewrite；
- 对精确查询禁用翻译；
- 为改写单独设置候选预算与 RRF 权重。

**验收：** 改写提高 paraphrase/跨语言指标，且 exact、延迟和无答案指标不越过门禁。

## 15. 开发任务拆分

| ID | 任务 | 主要文件/模块 | 依赖 |
|---|---|---|---|
| ML-001 | 双语 fixture 与指标 runner | `tests/fixtures`、`services/knowledge/evaluation` | 无 |
| ML-002 | LanguageProfile 与 analyzer port | `core/types.ts`、`ports/language.ts` | ML-001 |
| ML-003 | QueryPlanner 与 exact term parser | `query/*` | ML-002 |
| ML-004 | Unicode/技术词 normalizer | `indexing/multilingual-normalizer.ts` | ML-001 |
| ML-005 | FTS5 v2 migration 与 adapter | `scripts/data-service`、`adapters` | ML-004 |
| ML-006 | Keyword IndexBuild dual write/backfill | Job、index build、worker | ML-005 |
| ML-007 | Weighted RRF 与保序 fallback | `retrieval/*` | ML-003 |
| ML-008 | Embedding artifact registry | platform/models、config | ML-001 |
| ML-009 | 多语言模型 benchmark/选型 | evaluation、scripts | ML-008 |
| ML-010 | 多语言 Vector IndexBuild 迁移 | vector adapter、worker | ML-009 |
| ML-011 | 多语言 reranker adapter | model port、retrieval | ML-007、ML-010 |
| ML-012 | 术语表与受控 query rewrite | query、data-service API | ML-003 |
| ML-013 | Diagnostics/API/UI 状态 | engine、API、Settings | ML-002～012 |
| ML-014 | 升级/回滚/备份集成测试 | tests/data-service | ML-006、ML-010 |

并行开发时，ML-001 必须先稳定 fixture 契约；ML-004/005 与 ML-008/009 可并行，最终在 ML-007/010 汇合。

## 16. 必测失败场景

- semantic 开关关闭；
- 多语言模型未下载或校验失败；
- 新模型 dimension 与 active build 不一致；
- keyword v2 backfill 中途退出；
- 新 build ready 但 activate 前进程退出；
- 查询只包含单字符、标点、emoji 或代码符号；
- 中文长问题超过 40 个潜在 bigram；
- lexical rerank 全零；
- 文档语言识别错误或 `undetermined`；
- 简繁映射造成专有名词误扩展；
- translated variant 无结果或引入错误结果；
- 低内存时 reranker 被 Resource Coordinator 拒绝；
- 删除文档时旧新两套索引均被清理；
- 从旧版本备份恢复后仅 legacy build 存在。

## 17. 完成定义

以下条件全部满足后，才能宣称资料库具备中英多语言检索能力：

1. Lite 档在中文、英文、混合技术词和简繁体上通过关键词门禁；
2. Balanced 档使用经评测的多语言 embedding，并通过双向跨语言门禁；
3. Quality 档若显示“语义重排”，必须实际加载多语言语义 reranker；
4. 新旧索引可灰度切换、失败回滚，不要求用户重新上传文件；
5. Chat、Agent 和搜索 API 使用同一 QueryPlanner 和 Retrieval Pipeline；
6. diagnostics 能解释查询语言、召回路径、active build 和降级原因；
7. CI 包含质量、性能、离线、升级和回滚测试；
8. 文档、设置 UI 和故障排查说明与实际 capability 一致。

## 18. 首轮开发建议

第一轮不要直接更换默认模型。建议按以下顺序提交：

1. ML-001：先固定双语评测集和当前基线；
2. 修复 lexical reranker 全零覆盖融合分的问题；
3. ML-002～007：完成 QueryPlanner、技术词处理、FTS v2 和 weighted RRF；
4. ML-008～010：用同一评测集选择多语言模型并迁移 Vector IndexBuild；
5. 指标证明仍有收益空间后，再进入语义 reranker 和 query rewrite。

这样可以把“中文分词问题”“英文精确检索问题”“跨语言模型问题”和“排序问题”分别度量，避免一次更换多个变量后无法定位回归来源。
