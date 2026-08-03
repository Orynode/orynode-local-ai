# 知识库检索档位与普通用户体验调整方案

## 1. 调整目标

保留现有 Lite、Balanced、Quality 三档内部检索架构，同时避免普通用户必须理解关键词检索、向量检索、RRF、Embedding 和 Reranker 等技术概念。

普通用户默认只需要选择“自动”，系统根据当前主机能力、索引状态和资源压力决定实际执行档位。

## 2. 调整后的分层

```text
用户设置
├─ 自动（默认）
│    ├─ 语义能力可用 → Balanced
│    └─ 语义能力不可用 → Lite
├─ 省资源
│    └─ Lite
└─ 更高质量
     ├─ 语义和重排能力满足 → Quality
     ├─ 只有语义能力 → Balanced
     └─ 语义能力不可用 → Lite
```

内部继续保留完整档位：

```ts
type KnowledgeTier = "auto" | "lite" | "balanced" | "quality";
```

需要区分：

- `requestedTier`：用户请求的档位；
- `effectiveTier`：本次检索实际执行的档位；
- `degradedReasons`：发生降级时的稳定原因码。

## 3. 档位职责

### 3.1 Lite

- 使用 FTS5、中文 bigram 和关键词排序；
- 支持精确词、短语、文件名、错误码和代码符号；
- 不依赖 Embedding 模型；
- 不生成向量；
- 作为任何安装环境都必须可用的基础能力。

Lite 不是错误或残缺状态，而是可靠的最低资源检索基线。

### 3.2 Balanced

- 关键词与向量召回并行执行；
- 两路分别获取候选结果；
- 使用 RRF 按排名融合，不直接相加 BM25 和向量相似度；
- 语义能力不可用时自动降级 Lite；
- 作为语义能力已启用时的日常推荐档位。

建议初始候选规模：

```text
Keyword Top 30 ─┐
                 ├─ RRF → Top 8～12
Vector Top 30 ───┘
```

### 3.3 Quality

- 根据查询类型决定是否生成查询变体；
- 查询变体最多 2～3 个；
- 每个查询执行关键词和向量混合召回；
- 对结果进行 RRF、去重和本地重排；
- 语义、重排或资源能力不足时自动降级 Balanced 或 Lite。

推荐流程：

```text
原始查询
  → 判断是否需要 Query Expansion
  → 原始查询 + 最多 2～3 个变体
  → 每个查询执行 Keyword + Vector
  → RRF 合并
  → 去重
  → Top 20～40 本地重排
  → 返回 Top 8～12
```

文件名、错误码、函数名、精确短语等查询应跳过多查询，避免扩大噪声并增加延迟。

如果当前本地重排只是词汇重叠算法，能力类型应标记为 `lexical`，不得对外声明为独立语义 Reranker。

## 4. 默认配置

默认设置调整为：

```json
{
  "knowledgeTier": "auto"
}
```

`ORYNODE_SEMANTIC_SEARCH` 只表示主机是否允许启用语义能力，不作为普通用户的必要配置步骤。

```text
ORYNODE_SEMANTIC_SEARCH=0
  → Auto 使用 Lite

ORYNODE_SEMANTIC_SEARCH=1
  → Embedding Runtime 就绪后，Auto 使用 Balanced
```

语义能力不可用时不得阻止知识库导入、关键词索引和检索。

## 5. 档位解析器

档位解析必须集中实现，UI、Chat、Agent 和检索器不得分别复制判断逻辑。

建议契约：

```ts
type RetrievalCapabilities = {
  embeddingRuntimeReady: boolean;
  vectorIndexReady: boolean;
  rerankerReady: boolean;
  resourcePressure: "normal" | "high";
};

type ResolvedRetrievalProfile = {
  requestedTier: KnowledgeTier;
  effectiveTier: "lite" | "balanced" | "quality";
  degradedReasons: string[];
};
```

参考逻辑：

```ts
function resolveKnowledgeTier(
  requested: KnowledgeTier,
  capabilities: RetrievalCapabilities,
): ResolvedRetrievalProfile {
  const semanticReady =
    capabilities.embeddingRuntimeReady &&
    capabilities.vectorIndexReady;

  if (requested === "lite") {
    return {
      requestedTier: requested,
      effectiveTier: "lite",
      degradedReasons: [],
    };
  }

  if (requested === "auto" || requested === "balanced") {
    return semanticReady
      ? {
          requestedTier: requested,
          effectiveTier: "balanced",
          degradedReasons: [],
        }
      : {
          requestedTier: requested,
          effectiveTier: "lite",
          degradedReasons: ["SEMANTIC_SEARCH_UNAVAILABLE"],
        };
  }

  if (!semanticReady) {
    return {
      requestedTier: requested,
      effectiveTier: "lite",
      degradedReasons: ["SEMANTIC_SEARCH_UNAVAILABLE"],
    };
  }

  if (
    !capabilities.rerankerReady ||
    capabilities.resourcePressure === "high"
  ) {
    return {
      requestedTier: requested,
      effectiveTier: "balanced",
      degradedReasons: ["QUALITY_RETRIEVAL_UNAVAILABLE"],
    };
  }

  return {
    requestedTier: requested,
    effectiveTier: "quality",
    degradedReasons: [],
  };
}
```

## 6. 能力判断

是否可以执行 Balanced 不能只判断环境变量，至少需要同时满足：

```text
ORYNODE_SEMANTIC_SEARCH 已开启
AND Embedding Runtime 已就绪
AND 当前检索范围存在可用的 active vector index
```

向量索引状态应按文档判断：

- 已有 active vector index 的文档执行混合召回；
- 尚未完成向量索引的文档继续执行关键词召回；
- 单个文档缺少向量不得导致整个检索请求失败；
- 向量索引构建失败不得影响原有关键词索引。

## 7. 普通用户 UI

普通设置页面只显示三个选项：

```text
知识库搜索

● 自动（推荐）
  根据当前设备和索引状态自动选择

○ 省资源
  仅使用本地关键词搜索

○ 更高质量
  使用查询扩展和本地重排，响应可能稍慢
```

普通界面不要直接显示：

- FTS5；
- Embedding；
- Vector Index；
- RRF；
- Reranker；
- `ORYNODE_SEMANTIC_SEARCH` 等环境变量名称。

高级设置或诊断页面可以显示实际能力：

```text
请求模式：自动
当前模式：Balanced
关键词索引：可用
语义模型：可用
向量索引：28/30 个文档
本地重排：未启用
```

## 8. 语义能力安装与补建

如果语义能力需要额外模型或 Runtime，必须由用户明确启用，不得静默下载。

建议界面：

```text
智能搜索尚未安装

启用后可以找到表达不同但含义相近的内容。
下载大小：按实际 Artifact Manifest 显示
预计额外内存：按实际 Benchmark 显示

[启用智能搜索]
```

安装和索引要求：

- 下载前显示真实大小、来源和许可证；
- 下载失败时继续使用 Lite；
- 安装完成后后台为已有文档补建向量；
- 补建期间关键词检索始终可用；
- UI 显示处理进度；
- Chat 活跃或资源紧张时暂停 Embedding；
- 不得因为向量索引未完成而把文档从关键词检索中隐藏。

建议状态文案：

```text
正在增强知识库搜索：12/30 个文档
期间仍可使用基础搜索
```

## 9. API 与 Diagnostics

能力接口建议返回：

```json
{
  "knowledgeSearch": {
    "requestedTier": "auto",
    "effectiveTier": "balanced",
    "keyword": {
      "available": true
    },
    "semantic": {
      "enabled": true,
      "runtimeReady": true,
      "indexedDocuments": 28,
      "totalDocuments": 30
    },
    "reranker": {
      "available": false,
      "type": null
    },
    "degradedReasons": []
  }
}
```

每次检索的 diagnostics 建议返回：

```json
{
  "requestedTier": "auto",
  "effectiveTier": "balanced",
  "strategies": ["keyword", "vector", "rrf"],
  "degradedReasons": []
}
```

稳定降级原因建议至少包括：

```text
SEMANTIC_SEARCH_DISABLED
SEMANTIC_RUNTIME_UNAVAILABLE
VECTOR_INDEX_NOT_READY
RERANKER_UNAVAILABLE
RESOURCE_PRESSURE
QUALITY_RETRIEVAL_UNAVAILABLE
```

UI 根据稳定码显示普通用户文案，不解析服务端自然语言错误。

## 10. 兼容策略

- API 保留 `lite`、`balanced`、`quality`，新增 `auto`；
- 未设置 `knowledgeTier` 的用户迁移为 `auto`；
- 已明确保存其他档位的用户继续保留原选择；
- 环境变量继续作为高级部署覆盖项；
- 旧客户端无法识别 `auto` 时，兼容接口可以返回 `effectiveTier`；
- Chat、Agent 和 Search API 使用同一个档位解析器。

## 11. 开发顺序

### P0：降低普通用户门槛

1. `KnowledgeTier` 增加 `auto`；
2. 新安装默认值改为 `auto`；
3. 增加 `requestedTier`、`effectiveTier`、`degradedReasons`；
4. UI 改为“自动 / 省资源 / 更高质量”；
5. 将档位判断收敛到单一 resolver。

### P1：能力与索引联动

6. Auto 根据真实 Embedding Runtime 状态选择档位；
7. 按文档检查 active vector index；
8. 语义能力启用后自动补建已有文档向量；
9. UI 显示补建进度；
10. Chat 活跃时暂停或延迟向量构建。

### P2：Quality 优化

11. 增加查询类型判断；
12. 查询变体限制为最多 2～3 个；
13. 增加资源压力降级；
14. 明确 Reranker 的真实类型和 capability；
15. 完善 diagnostics 和离线检索评测。

## 12. 验收标准

- 新用户不修改任何设置即可导入和检索知识库；
- 没有语义模型时 Auto 自动使用 Lite；
- 语义能力就绪后 Auto 自动使用 Balanced；
- 单个文档缺少向量时仍可通过关键词检索；
- Quality 不对精确查询强制生成查询变体；
- 资源紧张时能够自动降级且不导致请求失败；
- UI 不要求普通用户理解向量、RRF 或环境变量；
- API 和 diagnostics 能准确说明请求档位、实际档位和降级原因；
- 启用或关闭语义能力不影响原有关键词索引；
- 不自动下载模型，不调用云端检索服务，继续符合本地私有 AI 服务器定位。

## 13. 最终原则

```text
普通用户只需要选择“自动”。
系统负责能力探测、档位选择和安全降级。
开发者仍可通过 API、诊断信息和环境变量精确控制。
```

该调整不会改变 Lite、Balanced、Quality 的长期架构价值，只是在产品层增加一个稳定、低门槛的默认入口。
