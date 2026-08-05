# Orynode 知识库查询语义标准

> 状态：Draft / 实施基线  
> 适用范围：资料库 Search、Chat RAG Retrieve、Agent Knowledge Tools  
> 目标：让同一个查询在中文、英文、中英混合和跨语言场景下具有可预测、可测试、可解释的语义

## 1. 为什么需要本标准

检索正确性不能用“是否返回了若干看起来相关的结果”定义。系统必须先定义用户查询的逻辑语义，再执行召回。

以下行为均视为协议错误：

- 把 `Passive Mobs` 无条件解释为 `passive OR mobs`；
- 把 `原子尺度 → [atomistic, atomic-scale]` 再拆成 `atomic OR scale`；
- 为满足 `topK` 数量而返回不可靠向量近邻；
- 单一候选列表仍执行 RRF，并用 RRF 分数覆盖原始分数；
- 召回使用一组词，高亮使用另一组词；
- `displayName` 作为正文相关性证据；
- Planner 已生成 `phrase`，但跨 HTTP/Adapter 时字段被静默丢弃。

本标准将“正确”定义为：查询 AST、候选证据、准入规则、融合策略和 UI 解释保持一致，并通过固定 qrels 评测。

## 2. 参考基线

本标准采用成熟检索系统的共同语义，而不是复制某一产品的默认参数：

1. PostgreSQL：普通文本查询匹配全部非停用词；短语查询保持词序；只有显式 `OR` 才表达析取。
2. Elasticsearch/OpenSearch：区分 `match`、`match_phrase`，并用 `operator` / `minimum_should_match` 控制多词覆盖率。
3. SQLite FTS5：原生支持 phrase、AND、OR、NOT、NEAR；应用必须显式选择逻辑，不应默认生成宽泛 OR。
4. Elasticsearch RRF：用于两个及以上独立结果集；单列表不属于融合。
5. MIRACL：BM25 与多语言 dense hybrid 是强基线；多语言质量必须用按语言标注的检索集评测。
6. multilingual-E5：用于共享多语言向量空间；查询和文档必须遵守模型的 `query:` / `passage:` 模板。

参考资料见文末。

## 3. 核心原则

### QS-001：查询先解析成 AST，禁止以字符串作为跨层语义

```ts
type QueryPlan = {
  raw: string;
  language: LanguageProfile;
  intent: QueryIntent;
  clauses: QueryClause[];
  expansions: QueryExpansion[];
  semantic: SemanticPlan;
};

type QueryClause =
  | { type: "exact"; value: string; field: "content" | "source_name" | "symbol" }
  | { type: "phrase"; tokens: string[]; slop: number }
  | { type: "all"; terms: string[] }
  | { type: "minimum_match"; terms: string[]; minimum: number }
  | { type: "exclude"; terms: string[] };
```

Planner、Adapter、data-service 和 Index 必须传递同一结构。禁止把结构化词项拼成字符串后再次分词。

### QS-002：默认采用逐级放宽，不采用无条件 OR

统一词法召回顺序：

```text
L0 exact identifier / quoted phrase
L1 ordered phrase（完整短语）
L2 all terms（AND）
L3 minimum_should_match（受控放宽）
L4 multilingual semantic（原始查询向量）
```

上一级存在可靠命中时，是否继续下一级由查询类型决定；精确词和短实体默认短路，不继续扩散候选。

`OR` 仅允许两种情况：

- 用户显式输入 OR；
- L3 内部根据 `minimum_should_match` 生成受控候选。

禁止使用“任意一个词出现即可”作为默认检索语义。

### QS-003：topK 是上限，不是配额

候选必须先通过各召回通道的可靠性门禁，再进入 topK 截断。0 条、1 条、5 条均是合法结果。

### QS-004：融合前准入，融合后不复活噪声

- FTS 候选先满足 phrase / AND / minimum-match；
- 向量候选先满足按模型、语言和查询类型校准的阈值；
- 只有准入候选才能进入融合；
- RRF 不能把未通过阈值的向量候选重新带回结果集。

### QS-005：每条结果必须携带证据来源

```ts
type RetrievalEvidence = {
  channel: "exact" | "phrase" | "all_terms" | "minimum_match" | "vector";
  queryVariantId: string;
  matchedTerms?: string[];
  matchedPhrase?: string;
  rawScore: number;
  acceptedBy: string;
};
```

UI 的“关键词命中 / 语义命中”、高亮、诊断和最终排序必须由该证据生成，禁止客户端重新猜测。

## 4. 查询分类与标准行为

| 查询类型 | 示例 | 首选语义 | 回退 | 是否默认融合向量 |
|---|---|---|---|---|
| 引号短语 | `"Passive Mobs"` | exact phrase | 无 | 否 |
| 短实体/术语 | `Passive Mobs` | phrase | AND → semantic | phrase 命中时否 |
| 技术标识 | `ERR_CONNECTION_REFUSED`、`Node.js` | exact token | normalized exact | 否 |
| 中文短词 | `原子尺度` | whole phrase | 受控 bigram coverage → semantic | 词法不足时是 |
| 普通多词 | `sodium ion transport` | phrase boost + AND | minimum-match → semantic | 是 |
| 自然语言问题 | `钠离子电池为什么需要电解质` | 核心词 AND/coverage | semantic | 是 |
| 中英混合 | `Node.js 访问令牌` | 技术词 MUST + 中文 coverage | semantic | 是 |
| 跨语言术语 | `原子尺度` 查英文 | 原文词法 + 结构化术语扩展 | multilingual vector | 是 |
| 明确析取 | `sodium OR lithium` | OR | semantic 可选 | 是 |

## 5. 分词与组合标准

### 5.1 英文及空格分隔语言

- Unicode 大小写归一化，拉丁字符可配置去音标；
- 保留 `C++`、`C#`、`.NET`、`Node.js`、版本号、错误码等技术 token；
- 2–6 个 token 的短查询产生 phrase 候选；
- phrase 无命中时使用 AND；
- 长查询使用 minimum-match，不直接 OR。

建议最低覆盖率：

| 有效词数 | minimum_should_match |
|---:|---:|
| 1–2 | 100% |
| 3–4 | 至少 75%，向上取整 |
| 5–8 | 至少 60%，向上取整 |
| >8 | 核心实体 MUST，其余至少 50% |

停用词只影响普通自然语言查询；不得删除引号短语、代码符号和产品名中的 token。

### 5.2 中文

SQLite `unicode61` 会把连续汉字视为一个 token，不能单独承担中文召回。标准索引同时保存：

- `zh_phrase`：原始连续汉字短语；
- `zh_bigram`：字符 bigram，用于召回；
- `mixed`：原文归一化字段；
- 可选词典分词字段：产品词、领域词、用户术语。

中文短查询的顺序：

```text
完整短语 > 词典术语 > bigram 覆盖率 > multilingual vector
```

bigram 不得使用任意一个命中即返回。长度为 N 的汉字串产生 N-1 个 bigram，默认至少满足：

- 2–3 个 bigram：全部满足；
- 4–6 个 bigram：至少 75%；
- 更长查询：抽取核心词，核心词 MUST，其余按 60% 覆盖。

### 5.3 其他语言

第一阶段采用：

- Unicode 规范化 + `unicode61` 词法基线；
- multilingual-E5 语义召回；
- 不支持可靠词界的语言标记 `LEXICAL_ANALYZER_LIMITED`；
- 只有评测证明收益后才增加语言专用 tokenizer/stemmer。

不得把“能存 Unicode”宣称为“已支持该语言检索”。

### 5.4 中英混合与技术文本

技术标识符为 MUST 条件；自然语言词项用于召回和排序。例如：

```text
Node.js 访问令牌
MUST exact(Node.js)
AND coverage(访问, 问令, 令牌)
SHOULD terminology(access token)
```

## 6. 跨语言标准

跨语言不是把两个语言的单词全部 OR 在一起。标准流程：

1. 原始查询始终保留；
2. 术语库 / 可学习 Rewrite 产生结构化 expansion，每个术语保持边界；
3. expansion 只走词法召回，不再次向量化；
4. 原始查询使用 multilingual-E5 `query:` 模板；文档使用 `passage:` 模板；
5. 术语库未覆盖时：本地 LLM 结构化改写并写入术语库后再检索；也可依赖共享向量空间；
6. 翻译改写若未来启用，必须作为独立 variant，并记录来源和版本。

示例：

```text
原子尺度
original lexical: phrase("原子尺度")
term expansion: phrase("atomistic") OR phrase("atomic-scale")
semantic: embed("query: 原子尺度")
```

这里的 OR 是“两个完整同义术语之间的 OR”，不是把 `atomic-scale` 拆成 `atomic OR scale`。

## 7. 候选准入、融合与重排

### 7.1 准入

- exact / phrase：存在正文证据即可；
- AND / coverage：满足规定覆盖率；
- vector：阈值必须按 embedding artifact、query language、query class 校准；
- `displayName` 不提供任何正文准入豁免；
- 无答案查询低于阈值时返回 0 条。

当前统一 `0.85` 只能作为临时安全阈值，不能作为永久标准。正式阈值来自每个模型版本的正负样本分布和无答案误召回门禁。

### 7.2 融合

- 只有两个及以上非空、已准入、相互独立的结果列表才执行 RRF；
- 单列表保留 BM25/余弦原始分数；
- exact/phrase 短路结果默认不与向量融合；
- RRF 的 `rank_constant`、window 和列表权重必须版本化；
- diagnostics 必须区分 `attemptedChannels` 与 `contributingChannels`。

### 7.3 重排

- 有经过多语言评测的 cross-encoder 时可对已准入候选重排；
- lexical overlap 只能小幅 boost，不能覆盖跨语言融合顺序；
- reranker 不得承担召回或可靠性门禁职责。

## 8. Search 与 Retrieve 的边界

两者共用 QueryPlan、召回、准入和排序，不共用展示预算：

- Search：面向人工浏览，分页或 cursor，允许较大结果窗口；
- Retrieve：面向 Chat/Agent 上下文，通常只取前 8 条并做 token packing；
- Search 分页不得通过重复执行不同 topK 产生漂移；正式实现应使用稳定排序键或 cursor；
- `candidateCount` 必须明确是“本页数量”“已准入总数”还是“召回窗口数量”。

## 9. 响应与诊断契约

最小响应字段：

```ts
type SearchResponse = {
  hits: Array<RetrievalHit & { evidence: RetrievalEvidence[] }>;
  diagnostics: {
    queryClass: string;
    attemptedChannels: string[];
    contributingChannels: string[];
    fusion: "none" | "rrf";
    thresholds: Record<string, number>;
    analyzerVersion: string;
    embeddingBuild?: string;
  };
  page: { limit: number; nextCursor?: string; acceptedCount?: number };
};
```

高亮只依据 `evidence.matchedTerms/matchedPhrase`。语义命中没有词法证据时显示“语义命中”，不制造高亮。

## 10. 正确性评测门禁

### 10.1 必测集合

- 中文→中文；
- 英文→英文；
- 中文→英文；
- 英文→中文；
- 中英混合技术词；
- 短语、错误码、文件名、代码符号；
- 同义词、形态变化、简繁体；
- 无答案和干扰文档。

### 10.2 指标

- Recall@8；
- MRR@10；
- nDCG@10；
- Phrase Precision@K；
- No-answer false positive rate；
- 每种语言和 query class 分桶统计；
- p50/p95 延迟与峰值内存。

### 10.3 发布门禁

任何 tokenizer、normalizer、术语表、embedding、阈值或融合策略变化必须：

1. 生成新版本号；
2. 跑固定 qrels；
3. 与当前 active build 对比；
4. 无答案误召回不得恶化；
5. 通过后原子切换，可回滚。

## 11. 验收样例

| 查询 | 预期 |
|---|---|
| `Passive Mobs` | 有完整短语时只返回完整短语片段；不得返回只有 `mobs` 的页面 |
| `passive creatures` | phrase 无命中后可用 AND；两词必须都出现，否则进入高阈值 semantic |
| `原子尺度` | 可召回 `atomistic` / `atomic-scale`，但不得拆成 `atomic OR scale` |
| `原子刻度` | 没有可靠词法或向量证据时返回 0 条 |
| `访问令牌` | 术语库命中 → `access token` 等完整短语 expansion；未命中则 LLM 改写后入库 |
| `Node.js 访问令牌` | `Node.js` 必须命中；中文/英文 access-token 作为补充证据 |

## 12. 当前实现差距

已具备：

- QueryPlanner、统一 Search/Retrieve Engine；
- `resolveQueryRewrite`（术语库 → LLM 晋升）+ Planner 只消费注入 rewrite；
- 词法阶梯 phrase → all → minimum_should_match（禁止无条件 OR）；
- 结构化 terminology terms / term_expansion 完整边界；
- displayName 与正文证据分离；
- 空列表不参与多查询 RRF；
- multilingual-E5 query/passage 模板；
- 无答案向量安全阈值。

仍需整改：

1. 将 QueryPlan 从若干可选字段提升为完整 AST，并共享 HTTP schema；
2. RetrievalHit 增加逐条 evidence/provenance；
3. diagnostics 分离 attempted 与 contributing；
4. 向量阈值按模型、语言、查询类型重新校准；
5. Search 从“最多取 64 条后客户端分页”演进为稳定 cursor；
6. 增加短语精度和无答案误召回的 CI 门禁。

## 13. 参考资料

- PostgreSQL Text Search Functions: https://www.postgresql.org/docs/current/functions-textsearch.html
- Elasticsearch Match Query: https://www.elastic.co/docs/reference/query-languages/query-dsl/query-dsl-match-query
- Elasticsearch minimum_should_match: https://www.elastic.co/docs/reference/query-languages/query-dsl/query-dsl-minimum-should-match
- Elasticsearch Reciprocal Rank Fusion: https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion
- OpenSearch Hybrid Search: https://docs.opensearch.org/latest/vector-search/ai-search/hybrid-search/index/
- SQLite FTS5: https://www.sqlite.org/fts5.html
- Multilingual E5 Technical Report: https://arxiv.org/abs/2402.05672
- MIRACL: https://aclanthology.org/2023.tacl-1.63/

