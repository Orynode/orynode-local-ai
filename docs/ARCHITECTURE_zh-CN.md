# Orynode Local AI 架构文档

[简体中文](ARCHITECTURE_zh-CN.md) | [English](ARCHITECTURE.md)

本文档详细描述 Orynode Local AI 的**服务架构、数据流、模块分层、扩展接口**以及**知识库/RAG 系统**设计。

本文以**当前实现**为准，面向想要理解内部实现、复用模块或扩展功能的开发者。发布变更见根目录 [CHANGELOG](../CHANGELOG.md)。

---

## 目录

- [整体架构](#整体架构)
- [服务分层](#服务分层)
- [数据流](#数据流)
- [目录结构](#目录结构)
- [模型与技术](#模型与技术)
- [知识库 / RAG 系统](#知识库--rag-系统)
  - [解析 (Parser)](#1-解析-parser)
  - [分块 (Chunker)](#2-分块-chunker)
  - [向量化 (Embedder)](#3-向量化-embedder)
  - [向量存储 (VectorStore)](#4-向量存储-vectorstore)
  - [检索 (Retriever)](#5-检索-retriever)
- [扩展接口](#扩展接口)
  - [替换 Embedder](#替换-embedder)
  - [替换 VectorStore](#替换-vectorstore)
  - [替换推理后端](#替换推理后端)
- [配置管理](#配置管理)
- [低配 Mac 的内存策略](#低配-mac-的内存策略)
- [本地数据服务 API](#本地数据服务-api)
- [Windows 兼容预留](#windows-兼容预留)

---

## 整体架构

```
┌──────────────────────────────────────────────────────────┐
│              浏览器 (localhost:3000 或 局域网IP)           │
│           Next.js + React (app/page.tsx)                  │
│           ┌──────────┬──────────┬──────────┐             │
│           │ hooks/   │ components/│ context │             │
│           │ useChat  │  ChatView│          │             │
│           │ useKnow  │  KnowView│          │             │
│           │ useConv  │  Sidebar │          │             │
│           │ useSett  │  Settings│          │             │
│           └──────────┴──────────┴──────────┘             │
└──────────────────────┬───────────────────────────────────┘
                       │ HTTP (fetch to localhost:3000/api/)
                       ▼
┌──────────────────────────────────────────────────────────┐
│             Next.js API 路由 (app/api/)                    │
│  /api/chat  /api/conversations  /api/knowledge(/v1)       │
│  /api/status  /api/settings  /api/lan                     │
│                                                           │
│  → services/platform (ModelRuntime)                       │
│  → services/knowledge (KnowledgeEngine / ingest / OCR)    │
└──────────┬──────────────────────┬────────────────────────┘
           │                      │
    ① ModelRuntime.chat      ② Data Service / Jobs
           │                      │
           ▼                      ▼
┌──────────────────┐   ┌──────────────────────────────────┐
│ TurboFieldfare   │   │  Orynode 本地数据服务 (:4318)      │
│ (:8080/v1)       │   │  SQLite + FTS5 + Jobs + 可选 ONNX │
│ Swift + Metal    │   │  · 对话 / 资料 / chunks / vectors │
│ Gemma 4 26B      │   │  · process_revision / embed       │
│                  │   │  · LAN pairing store              │
│ 仅 127.0.0.1     │   │  仅 127.0.0.1                     │
└──────────────────┘   └──────────────────────────────────┘
         ▲
         │ macOS OCR helper（可选）
┌──────────────────┐
│ orynode-ocr      │  Apple Vision → DocumentBlock
│ .orynode/bin/    │
└──────────────────┘
```

**安全设计原则**：

- 只有 Web 入口 (:3000) 可按模式绑局域网；TurboFieldfare (:8080) 和数据服务 (:4318) 始终 `127.0.0.1`
- Chat / Status 经 `ModelRuntime`；TurboFieldfare 仅存在于 **macOS adapter**
- Trusted-LAN：配对码 + 可撤销 session；配对管理走 loopback Data Service
- Knowledge Engine **不写 OS 分支**；Windows 通过 stub adapter 预留

---

## 服务分层

项目采用**五层清晰分层**：

```
表现层 (Presentation)
  app/page.tsx + components/ + hooks/
     ↓
API 网关层 (Gateway)
  app/api/*/route.ts
     ↓
业务服务层 (Services)
  services/
  ├── chat/        - Prompt、SSE、上下文预算
  ├── platform/   - Host / ModelRuntime / LAN 认证 / composition root
  ├── knowledge/   - 解析、分块、向量化、检索（唯一智能）
  ├── agent/       - 受控知识工具与 Agent space
  └── settings/    - 运行时设置读写
     ↓
数据持久层 (Persistence)
  本地数据服务 (:4318) + SQLite (.orynode/data/orynode.db)

配置层 (Config)
  config/defaults.ts - 所有默认值集中定义
```

**关键设计原则**：

1. **数据服务保持薄**：`scripts/local-data-service.mjs` 负责 SQLite CRUD、文件存储，以及 **解释** Planner 下发的 FTS 阶梯（MATCH 执行）。**不解析 PDF、不切块、不发明检索策略**（词类判定 / 阶梯构造只在 `services/knowledge/query`）
2. **服务层是唯一智能**：解析 / 分块 / Embedder / Retriever / QueryPlanner 只存在于 `services/knowledge`
3. **Embedder 可缺省**：默认无向量模型；Keyword 是 Retriever 策略，不是假 Embedder
4. **检索唯一入口**：`KnowledgeEngine.retrieve|search`（内部 `resolveQueryRewrite` → `planQuery` → `HybridRetriever`）；chat 不得旁路查库
5. **不做 sqlite-vec 硬依赖 / 默认路径**：向量以 BLOB 存 SQLite，JS 余弦扫描即可；**仅当资料量很大、评测证明扫描成为瓶颈时**再考虑 ANN（如 sqlite-vec adapter），不作开箱默认
6. **双命名空间**：会话附件（`conversation_files`）与持久资料库（`knowledge_documents`）分表分目录；共享 `ingestDocument`，禁止上传时隐式串库

---

## 数据流

### 对话流程

```
Composer 草稿 draftAttachments（仅下一轮；发送后清空）
  → page.tsx 交给 useChat.sendMessage(attachments)
      → 写入本条 message.attachments（落库，气泡展示）
      → scopeFromAttachments → RetrievalScope（sources: library + conversationFiles）
      → POST /api/chat
          → normalizeRetrievalScope（兼容旧 knowledgeScope）
          → KnowledgeEngine.retrieve（rewrite → plan → HybridRetriever）
          → buildSystemPrompt + TurboFieldfare SSE
```

**产品语义**：

- **资料库**是持久仓库；`useKnowledge` 只做 CRUD / 上传 / 索引
- **会话附件**绑 `conversationId`（`.orynode/attachments/`）；删会话级联清理
- `draftAttachments` 只表示**本条消息**检索范围；发送后清空选中；打开历史会加载该会话的文件列表供再选，但不会自动恢复上次草稿
- 对话拖拽 /「附到本对话」→ 会话附件；需要持久保存时由用户显式「导入资料库」（不提供会话附件一键提升）

### 摄取流程（共享管线，双目标）

```
ingestDocument({ bytes, displayName?, target })
  → library：
        contentHash = sha256(bytes)
        GET :4318/knowledge/by-hash/:hash → 命中则返回已有文档（deduplicated）
        未命中 → parse/chunk → POST :4318/knowledge（写入 hash + name + original_name）
                 → commit chunks → index embeddings
  → conversation：不做全局去重；parse/chunk → conversation-files …
```

**资料库身份与显示名**：

- 身份 = `content_hash`（UNIQUE），与文件名/显示名无关
- `name` = 显示名（导入可选初值；`PATCH /knowledge/:id` 可改，不触发重解析）
- `original_name` = 原始文件名（溯源）
- 去重命中默认**不**改已有显示名；用户可再点「重命名」

### 检索流程

```
query + RetrievalScope + knowledgeTier
  → resolveQueryRewrite（术语库命中跳过 LLM；未命中 → LLM → 写入 terminology_entries）
  → planQuery（只消费注入的 StructuredQueryRewrite；产出 lexicalLadder + variants）
  → HybridRetriever / FTS5
        ├── 词法阶梯：phrase → all → minimum_should_match（禁止无条件 OR）
        ├── term_expansion：同义完整短语只走词法，不再次向量化
        └──（可选）vector + RRF；phrase 已命中时可短路向量防噪声
  → applyRewriteExcludes（containsTerm）→ 高亮（hansHantVariants + synonyms）
  → Context packing + Citations → LLM（Chat）或预览（Search）
```

---

## 目录结构

```
orynode-local-ai/
├── app/                              # Next.js 前端 (App Router)
│   ├── page.tsx                      # 入口（编排 + draftAttachments）
│   ├── layout.tsx                    # 根布局
│   ├── globals.css                   # 全局样式
│   ├── lib/
│   │   └── attachments.ts            #   附件 ↔ RetrievalScope
│   ├── components/                   # UI 组件
│   │   ├── chat/                     #   对话视图
│   │   │   ├── ChatView.tsx          #     消息列表容器
│   │   │   ├── MessageBubble.tsx     #     气泡（含本条 attachments）
│   │   │   ├── Composer.tsx          #     输入框 + 本轮草稿附件
│   │   │   └── WelcomeScreen.tsx     #     欢迎页
│   │   ├── knowledge/                #   知识库视图
│   │   │   ├── KnowledgeView.tsx     #     列表；「用于对话」→ 草稿
│   │   │   ├── KnowledgeJobsPanel.tsx#     顶栏处理队列
│   │   │   └── DocumentCard.tsx      #     资料卡片
│   │   ├── sidebar/                  #   侧边栏
│   │   │   ├── Sidebar.tsx           #     导航 + 状态
│   │   │   └── HistoryList.tsx       #     历史对话列表
│   │   ├── settings/                 #   设置
│   │   │   └── SettingsPanel.tsx     #     模型参数 + 安装引导
│   │   └── ui/                       #   通用组件
│   │       ├── Icon.tsx              #     SVG 图标
│   │       └── Modal.tsx             #     模态框
│   ├── hooks/                        # 自定义 Hooks
│   │   ├── useChat.ts                #   流式聊天；本轮 attachments→scope
│   │   ├── useConversations.ts       #   对话历史 CRUD
│   │   ├── useConversationFiles.ts   #   会话附件 CRUD
│   │   ├── useKnowledge.ts           #   资料仓库 CRUD（无跨轮选中）
│   │   ├── useKnowledgeJobs.ts       #   处理队列轮询
│   │   └── useSettings.ts            #   设置读写
│   └── api/                          # API 路由 (Next.js 约定)
│       ├── chat/route.ts             #   POST 对话代理
│       ├── status/route.ts           #   GET 模型连接状态
│       ├── conversations/
│       │   ├── route.ts              #   对话列表/创建
│       │   └── [id]/
│       │       ├── route.ts          #   对话详情/更新/删除
│       │       └── files/            #   会话附件
│       ├── knowledge/
│       │   ├── route.ts              #   文档列表/上传
│       │   ├── reindex/route.ts      #   批量重建向量
│       │   └── [id]/
│       │       ├── route.ts          #   文档删除
│       │       └── reindex/route.ts  #   单文档重建向量
│       └── settings/route.ts         #   设置读写
│
├── services/                         # 核心业务逻辑 (纯 TypeScript)
│   ├── types.ts                      #   全局共享类型
│   ├── chat/                         #   Prompt / Context / SSE
│   ├── platform/                     #   Host / ModelRuntime / LAN 认证 / composition root
│   ├── agent/                        #   受控知识工具与 Agent space
│   ├── knowledge/                    #   知识库（唯一智能层）
│   │   ├── application/engine.ts     #     KnowledgeEngine 入口
│   │   ├── query/                    #     planner / rewrite / lexical-coverage / latin-stopwords
│   │   ├── retrieval/                #     profile / highlight / keyword 抽取（诚实词表）
│   │   ├── retriever.ts              #     HybridRetriever（执行，不发明阶梯）
│   │   └── index.ts                  #     对外导出（仅接线符号）
│   └── settings/                     #   运行时设置
│
├── config/defaults.ts                # 集中配置
├── scripts/
│   ├── start-local.mjs
│   ├── local-data-service.mjs        # 薄存储 :4318；FTS 只解释下发的 lexicalLadder
│   └── ...
├── worker/                           # vinext 本地运行时入口（非云业务）
├── db/README.md                      # 说明：业务库在 .orynode/data/orynode.db
│
├── .orynode/                         # 运行时数据 (gitignore)
│   ├── data/orynode.db
│   ├── knowledge/files/              #   资料库原件
│   ├── attachments/{conversationId}/ #   会话附件原件
│   └── models/
│
├── .env.example
├── package.json
└── docs/
    ├── ARCHITECTURE_zh-CN.md
    ├── ARCHITECTURE.md
    └── …
```

---

## 模型与技术

| 类别 | 技术 | 角色 |
|------|------|------|
| 对话 LLM | Gemma 4 26B A4B IT（4-bit） | 本机生成 |
| 推理运行时 | TurboFieldfare（Swift/Metal，OpenAI 兼容 `:8080/v1`） | 仅 macOS ModelRuntime adapter |
| 默认检索 | SQLite FTS5 词法阶梯 + search_text | 开箱关键词；可选 e5 hybrid |
| 可选向量后端 | **blob_scan**（生产固定） | sqlite-vec 仅占位；**大量数据且评测证明瓶颈时**再评估 |
| 可选 Embedding | multilingual-e5-small（384 维，默认推荐） | 语义召回；`@xenova/transformers` ONNX |
| Embedding 兼容 | bge-small-zh-v1.5（512 维） | 旧索引 / 对照；勿与 E5 混用 |
| Embedding 实验 | bge-m3（1024 维） | 非默认 |
| OCR（生产） | Apple Vision via `orynode-ocr` | 扫描 PDF → DocumentBlock |
| OCR（预留） | PP-OCR mobile + ONNX artifact 元数据 | Windows stub，`OCR_UNAVAILABLE` |
| PDF 文本 | pdfjs-dist | 原生文本页 |
| 融合策略 | RRF、lexical rerank（Quality 档） | Lite / Balanced / Quality / Auto |
| Query Rewrite | 术语库 + 可选本地 LLM 晋升 | `resolveQueryRewrite`；`ORYNODE_QUERY_REWRITE_LLM` |
| 存储 / 任务 | SQLite + Job Worker + terminology_entries | Data Service `:4318` |
| 前端 | Next.js + React + vinext | `/api` 网关 |

登记与切换规则见 `config/embedding-artifacts.ts`；发布清单见根目录 [CHANGELOG 1.2.0](../CHANGELOG.md#120--2026-08-05)。

## 知识库 / RAG 系统

> **1.2.0**：在 1.1.0 Knowledge Engine 上闭合检索升级——可学习 Rewrite、词法阶梯、处理队列与诚实 diagnostics。工作台走 **Search**；Chat 走 **Retrieve + buildContext**；共用 `HybridRetriever`。细节见下文与 [CHANGELOG 1.2.0](../CHANGELOG.md#120--2026-08-05)。

```
上传 PDF / TXT / MD（或 Web/GitHub Connector）
  → ingest（detect → 可选 OCR process_revision → parse → chunk）
  → ProcessingBuild activate → data-service 存原件 / chunks / blocks
  →（可选）embed Job → vector_entries
对话 / 工作台
  → resolveQueryRewrite → planQuery → KnowledgeEngine.retrieve|search
  → HybridRetriever（FTS 词法阶梯 和/或 vector + RRF）
  → exclude + Context packing + Citations → LLM（Chat）或预览 UI（Search）
```

| 模块 | 职责 |
|------|------|
| `application/engine` | KnowledgeEngine：search / retrieve / buildContext |
| `query/resolve-rewrite` | 术语库 → LLM 晋升；唯一开放世界同义入口 |
| `query/planner` + `lexical-coverage` + `latin-stopwords` | 只消费注入 rewrite；形态分类 + 阶梯；功能词不作抽取硬删 |
| `ingest` / `processing/*` | 摄取；PDF OCR 路由；ProcessingBuild |
| `formats` / `parser` / `chunker` | 种类识别、解析、标题感知分块 |
| `retrieval/*` + `retriever` | 诚实词抽取 / FTS·hybrid 执行 / tier / highlight / diagnostics |
| `embedder` + `vector-store` | 可选语义；BLOB / vector_entries |
| `connectors/*` | Web / GitHub + SSRF |
| `context/*` | token packing、citation 定位 |

### Embedder（诚实模型）

- **默认**：无 Embedder，检索 = FTS 关键词（开箱零额外 RAM）
- **可选**：`ORYNODE_SEMANTIC_SEARCH=1` → data-service 加载 ONNX（默认 **`multilingual-e5-small`**，384 维）
- **兼容基线**：`bge-small-zh-v1.5`（512 维）；**实验**：`bge-m3`；切换须重建 IndexBuild，禁止混用
- **禁止**：把 keyword 伪装成 Embedder

### Scope

```ts
type RetrievalScope =
  | { mode: "none" }
  | {
      mode: "sources";
      library?: { documentIds: string[] } | "all";
      conversationFiles?: { fileIds: string[] };
    };

type MessageAttachment =
  | { kind: "library"; id: string; name: string }
  | { kind: "library_all"; id: "all"; name: string }
  | { kind: "conversation_file"; id: string; name: string };
```

兼容：旧 `knowledgeScope` / `knowledgeDocumentId`；旧附件 kind `document`→`library`、`all`→`library_all`。

前端来源：`scopeFromAttachments(draftAttachments)` → `retrievalScope`；附件快照写入 `message.attachments`。  
未附带资料时为 `none`；**不会**从历史气泡自动拼出下轮 scope。

### 向量存储

- SQLite `knowledge_chunks.embedding BLOB` / `vector_entries` + 文档级 `embedding_model` / `embedding_dim`
- **生产向量后端固定 `blob_scan`**（JS 余弦）；**不加 sqlite-vec 必装依赖，也不作默认**
- **sqlite-vec**：仅 `VectorIndex` port 占位；**资料量很大且基准/评测证明 BLOB 扫描成为 P95/内存瓶颈时**再评估接入
- status：`awaiting_chunks` → `ready` → `embedding` → `indexed`（或 `error`）
- `embedding` 超过约 20 分钟未结束：列表时自动降为 `error`（可重建索引；keyword 仍可用）

### 1. 解析 (Parser)

**文件**: `services/knowledge/parser.ts`、`formats.ts`

- PDF：`pdfjs-dist` 逐页提取；校验魔数（`%PDF-`）
- TXT / Markdown：UTF-8 解码；按标题或分段映射为「页」
- 下游统一为 `ParsedDocument`（页码 + 文本）

```typescript
import { parseDocument, detectKnowledgeKind } from "./services/knowledge";

const kind = detectKnowledgeKind({ fileName, contentType, buffer });
const doc = await parseDocument(buffer, kind!);
// → { pageCount: number, pages: [{ pageNumber, text }] }
```

### 2. 分块 (Chunker)

**文件**: `services/knowledge/chunker.ts`

采用**优先级分隔符降级策略**，避免在句子中间切断：

| 优先级 | 分隔符 | 示例 |
|--------|--------|------|
| 1 | `\n\n`, `\n` | 段落边界 |
| 2 | `。`, `！`, `？`, `.`, `!`, `?` | 句子边界 |
| 3 | `，`, `;`, `" "` | 短语边界 |
| 4（降级） | 固定长度 | 1800 字符滑动窗口 |

配置可调整：

```typescript
// config/defaults.ts
export const CHUNK_CONFIG = {
  maxChunkSize: 1800,
  minChunkSize: 200,
  overlapSize: 200,
};
```

使用：

```typescript
import { createChunker } from "./services/knowledge";

const chunker = createChunker();
const chunks = chunker.chunkDocument(doc.pages);
// → [{ pageNumber, position, content }]
```

### 3. 向量化 (Embedder)

**文件**: `services/knowledge/embedder.ts`、`config/embedding-artifacts.ts`

- `resolveEmbedder()`：未开启或不满足依赖时返回 `null`
- 开启：`ORYNODE_SEMANTIC_SEARCH=1`；artifact 由 `ORYNODE_EMBEDDING_ARTIFACT` 选择（默认 `multilingual-e5-small`）
- 由本地 data-service 计算（vinext Workers 无法直接加载 ONNX）
- Keyword **不是** Embedder

### 4. 向量存储 (VectorStore)

**文件**: `services/knowledge/vector-store.ts`

- SQLite BLOB + JS 余弦；`search` 接受 `RetrievalScope`（双命名空间）
- 生产固定 `blob_scan`；不加 sqlite-vec 必装/默认依赖（大量数据瓶颈时再评估）

### 5. 检索 (Retriever)

**文件**: `services/knowledge/application/engine.ts`、`query/*`、`retriever.ts`

- 生产编排入口：`KnowledgeEngine.retrieve`（先 `resolveQueryRewrite` 再 `planQuery`）
- `HybridRetriever.retrieve(query, scope, options)` 执行 FTS / hybrid；**词法阶梯由 `keywordQuery.lexicalLadder` 下发**，Index 不得自行改写策略
- `keywordQuery.terms`（`plan.searchTerms`）是诚实抽取结果，供诊断 / 高亮；**MATCH 以 ladder 各步的 `terms` 为准**
- scope：`RetrievalScope`；前端由本轮附件推导，**不会**从历史消息自动拼 scope
- keyword 始终可用；向量索引就绪且档位允许时走 hybrid + RRF；**phrase 已命中可短路向量**
- 降级原因只来自 capabilities/profile；phrase 短路不得误标 `VECTOR_INDEX_NOT_READY`
- `error` 文档会清空向量 BLOB，仅 keyword；`awaiting_chunks` 不参与检索


```typescript
import { createKnowledgeEngine } from "./services/knowledge";

const engine = createKnowledgeEngine();
const response = await engine.retrieve({
  query: "如何提高性能？",
  scope: { mode: "sources", library: { documentIds: [documentId] } },
  knowledgeTier: "auto",
});
// → { hits, citations, diagnostics: { strategy, rewriteSource, fusion, ... } }
```

### 状态机

| status | 含义 |
|--------|------|
| `awaiting_chunks` | 原件已存，分块未提交（不可检索） |
| `ready` | 可 keyword 检索 |
| `embedding` | 正在写向量（keyword 仍可用） |
| `indexed` | keyword + 语义 |
| `error` | 向量失败；keyword 仍可用；可 `POST /api/knowledge/:id/reindex` |

开启 `ORYNODE_SEMANTIC_SEARCH` 后，对旧文档执行 `POST /api/knowledge/reindex` 批量补齐。

**词法召回契约**（`services/knowledge/query` 为唯一策略源）：

| 产物 | 所有者 | 含义 |
|------|--------|------|
| `searchTerms` | `extractSearchTerms`（retrieval）+ exact 合并 | **诚实词表**：保留拉丁功能词；供高亮 / 诊断 / 多消费者 |
| `phrase` / `queryClass` | `inferPhraseIntent` + `classifyQuery` | **形态分类**：短实体 / 技术式 / 自然语言问句 |
| `lexicalLadder` | `buildLexicalLadder` | **可执行阶梯**：`phrase` → `all` → `minimum_should_match`（禁止默认全词 OR） |

分层约束（贡献者勿再偏移）：

- **拉丁功能词**（`query/latin-stopwords.ts`）只做两件事：① 形态信号（自然语言不进 `short_entity` / strict `technical`）；② `general` 阶梯的 MATCH 词清洗。  
- **禁止**在 `extractSearchTerms` / `scripts/data-service/search-text.mjs` 硬删功能词（与中文「低信息 bigram 只降权不硬删」对称）。  
- data-service 的 `lexical-coverage.mjs` 是 **parity 镜像**，不是第二套 SoT；改策略先改 TS，再对齐 JS。  
- 文件名判定（`detectQueryKind`）须像路径/单名（无空白或含 `/` `\\`）；**禁止**因句尾 `.js` 把 `how to install node.js` 整句当成 filename。  
- 功能词作内容词时（如工业术语 `can bus`）可能被 general 阶梯丢掉；需要整词保留时用引号短语。

同义与高亮：完整短语 variant；高亮与 exclude 共用 `hansHantVariants` / `containsTerm`。

---

## 扩展接口

### 替换 Embedder

如果你的推理后端支持 `/v1/embeddings`（如 Ollama、vLLM），可以轻松实现：

```typescript
// services/knowledge/my-embedder.ts
class RemoteEmbedder implements Embedder {
  readonly dimension = 768;
  readonly modelName = "nomic-embed-text";

  async isAvailable() {
    return true;
  }

  async embed(text: string): Promise<Float32Array> {
    const res = await fetch("http://localhost:11434/api/embeddings", {
      method: "POST",
      body: JSON.stringify({ model: this.modelName, prompt: text }),
    });
    const { embedding } = await res.json();
    return new Float32Array(embedding);
  }

  async embedBatch(texts: string[]) {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}
```

### 替换 VectorStore

如需换用 Qdrant、Chroma 等外部向量数据库：

```typescript
// services/knowledge/qdrant-store.ts
class QdrantVectorStore implements VectorStore {
  async insert(vectors: VectorDocument[]) { /* ... */ }
  async search(queryVector: Float32Array, options) { /* ... */ }
}

// 在调用方注入（构造参数：embedder?, vectorStore?）:
const retriever = new HybridRetriever(await resolveEmbedder(), new QdrantVectorStore());
```

### 替换推理后端

推理通过 `services/platform` 的 `ModelRuntime` port 接入（`createRuntimeServices()`），Chat / Status 不得直接依赖具体后端：

```typescript
interface ModelRuntime {
  chat(messages, options): Promise<ReadableStream<Uint8Array>>;
  listModels(): Promise<ModelInfo[]>;
  health(): Promise<RuntimeHealth>;
}
```

要接入 Ollama、vLLM 或其他后端：在对应 Host Profile 下新增 adapter，并在 `composition-root.ts` 装配；不要恢复已删除的 `services/inference` 直连路径。

---

## 配置管理

**文件**: `config/defaults.ts`

所有可配置项集中在一个文件中：

```typescript
// 服务地址
export const TURBO_FIELDFARE_URL = process.env.TURBO_FIELDFARE_URL ?? "http://127.0.0.1:8080/v1";
export const ORYNODE_DATA_URL = process.env.ORYNODE_DATA_URL ?? "http://127.0.0.1:4318";

// 知识库参数
export const CHUNK_CONFIG = { maxChunkSize: 1800, minChunkSize: 200, overlapSize: 200 };
export const SEARCH_CONFIG = { topK: 8, semanticSearchEnabled: false };
export const EMBEDDING_CONFIG = { /* artifactId / dimension 见 embedding-artifacts */ };
// ORYNODE_QUERY_REWRITE_LLM：可学习改写，默认开

// 运行时默认值
export const DEFAULT_RUNTIME_SETTINGS = { temperature: 0.2, topP: 0.95, topK: 64, maxContext: 16384, maxTokens: 0 };
```

默认值与允许的 `maxContext` 列表集中在 `config/runtime-defaults.json`，供 TypeScript、`local-data-service`、`start-turbo.sh` 共用。

**上下文长度闭环**：

1. 设置页保存 → `.orynode/runtime-settings.json`
2. `scripts/start-turbo.sh` 读取该文件，以 `--max-context` 启动模型，并写入 `.orynode/turbo-applied.json`
3. 设置 API 对比「已保存」与「进程已应用」；不一致时提示 `npm run turbo:restart`

温度 / Top P / Top K / maxTokens 经 `/api/chat` 每次请求生效，无需重启。  
`/api/chat` 会按 `maxContext` 从旧到新裁剪历史（为 system 与回复预留额度），避免长对话顶满窗口。

通过 `.env.local` 覆盖：

```env
TURBO_FIELDFARE_URL=http://127.0.0.1:11434/v1    # 切换到 Ollama
ORYNODE_DATA_URL=http://127.0.0.1:4318
ORYNODE_SEMANTIC_SEARCH=1                        # 可选语义向量；包已依赖，设 1 后重启 npm run local
# ORYNODE_QUERY_REWRITE_LLM=0                    # 关闭可学习 Query Rewrite（仅术语库种子）
```

应用层补索引：

- `POST /api/knowledge/:id/reindex` — 单文档
- `POST /api/knowledge/reindex` — 全部文档

---

## 低配 Mac 的内存策略

项目以 **8GB 统一内存** 为否决基线（必须能跑完「检索 + 对话」且占得下），**16GB / 32GB+** 走同一管道、更高档更少打断。不是两套产品。

### 设计原则

| 原则 | 说明 |
|------|------|
| **占用小是否决项** | 正式档不加查询时 CE；默认可不加载 embedding |
| **完整 RAG 次之** | 摄取→召回→融合→装箱→LLM→引用可降级不断链 |
| **同一管道分档** | `hostMemoryClass` 驱动推荐与封顶，不硬锁「只能 8GB」 |
| **扩展既有协调器** | 不另建 MemoryGovernor；信号进 `ResourceCoordinator` → `CapabilitySnapshot` → `resolveKnowledgeTier` |

### 信号词汇（勿混用）

| 信号 | 含义 | 来源 |
|------|------|------|
| `hostMemoryClass` | 物理机档 low / medium / high（≤10GiB / ≤18GiB / 更大） | `os.totalmem` |
| `memoryPressure` | 瞬时压力 normal / critical（chat 或 OCR/embed lease） | ResourceCoordinator |
| `resourcePressure` | normal / high（供检索档位） | 由 memoryPressure 映射 |
| `memoryTier` | 检索执行封顶 lite / balanced / quality | Host + 语义能力 |
| `embedResident` | e5 是否驻留（仅观测；不单独永久抬压） | embed-lifecycle |

### 闭环时序（必须成立）

```text
Host classifyHostMemory
  → ResourceCoordinator（hostMemoryClass / memoryPressure / preset）
  → GET /resources → probeCapabilitySnapshot.resourcePressure
  → resolveKnowledgeTier（high → 强制 lite + RESOURCE_PRESSURE）
  → Retriever（lite 不跑 query embed）

/api/chat：
  1. markChatResourceActive   ← 先抬压（并在 low 主机卸载 e5）
  2. buildChatKnowledgeContext / retrieve  ← 此时必见 resourcePressure=high
  3. ModelRuntime.chat（Gemma）
  4. markChatResourceIdle（流结束 / 失败）
```

对话路径若先 RAG 再 markChat，则 `RESOURCE_PRESSURE` 对 Chat 内检索不生效——**已定为缺陷并修复**。

### 控制层

| 策略 | 说明 |
|------|------|
| **零额外开销（默认）** | 无 Embedder，仅 FTS5；`knowledgeTier=auto` 常落在 lite |
| **按需加载** | `ORYNODE_SEMANTIC_SEARCH=1` 后才加载 e5；status **不**预热加载 |
| **Chat / 重活 defer embed** | `chatActive` → `EMBED_DEFERRED_CHAT`；`heavyKind=ocr|embedding` → `EMBED_DEFERRED_HEAVY` |
| **e5 生命周期** | 空闲卸载（默认 90s，`ORYNODE_EMBED_IDLE_UNLOAD_MS`）；low 主机对话开始卸载 |
| **blob_scan 收窄** | hybrid 的 FTS 命中足够强（≥ `vectorScanNarrowMinDocs` 文档；minimum_match 弱命中翻倍）才只扫命中文档；弱命中保持原 scope，成本由 `maxVectorScanChunks` 软顶兜底 |
| **OCR 超页截断** | 前 `maxOcrPagesPerDocument` 页入检索（`OCR_PAGE_TRUNCATED`），不再整本失败 |
| **不加查询时 CE** | Quality = 多查询 + **词法**重排 |
| **不加 sqlite-vec 默认** | 大量数据且评测证明瓶颈后再评估 |

### 本机配置初始化

| 场景 | 行为 |
|------|------|
| 首次无 `runtime-settings.json` | 按内存档写入推荐（8GB→8K，16GB→16K，32GB+→32K；`knowledgeTier=auto`） |
| 已有用户文件 | **绝不覆盖** |
| 文件损坏无法解析 | 内存回退推荐，**不写盘覆盖** |
| Settings UI | 「恢复默认」= 产品全局默认；「套用本机推荐」= 当前机器档预设后再保存 |

空闲时 16GB+ 可 hybrid；对话中一律关键词优先（压力降档）。可用 `npm run test:smoke-rag` 做离线冒烟。

---

## 本地数据服务 API

`scripts/local-data-service.mjs` 监听 `127.0.0.1:4318`：持久化 +（可选）本机 ONNX 向量计算。
检索编排仍在 `services/knowledge`，不在此进程。

### 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET/PUT | `/settings` | 运行时设置 |
| GET/POST | `/conversations` | 对话列表 / 创建 |
| GET/PUT/DELETE | `/conversations/:id` | 对话详情 |
| GET/POST | `/conversation-files` | 会话附件列表 / 上传（须已有 conversationId） |
| GET/DELETE | `/conversation-files/:id` | 会话附件元数据 / 删除 |
| PUT | `/conversation-files/:id/chunks` | 写入会话附件 chunks |
| PUT | `/conversation-files/:id/status` | 更新会话附件索引状态 |
| POST | `/conversation-files/vectors` | 批量写入会话附件 embedding |
| GET | `/knowledge` | 文档列表（含 status） |
| POST | `/knowledge` | **只存原件**（PDF/TXT/MD，status=`awaiting_chunks`） |
| GET | `/knowledge/by-hash/:hash` | 按内容哈希查找资料库文档 |
| PATCH | `/knowledge/:id` | 仅改显示名（不重解析） |
| PUT | `/knowledge/:id/chunks` | **写入服务层已切好的 chunks** |
| PUT | `/knowledge/:id/status` | 更新索引状态 / embedding 元数据 |
| POST | `/retrieval/chunks/query` | 统一导出 chunks（library + conversationFiles，可选向量） |
| POST | `/knowledge/chunks/query` | 旧版仅资料库导出（兼容保留） |
| GET | `/knowledge/:id/chunks` | 单文档 chunks |
| POST | `/knowledge/vectors` | 批量写入 embedding BLOB |
| GET | `/knowledge/embed/status` | 向量是否**可加载**（不预热权重）；`ready`/`resident` 表示已驻留 |
| POST | `/knowledge/embed` | 文本批量向量化（Node/ONNX）；Chat/重活时 503 |
| POST | `/knowledge/embed/unload` | 主动卸载 e5 pipeline |
| GET | `/resources` | ResourceCoordinator 快照（chatActive / memoryPressure / hostMemoryClass / preset） |
| POST | `/resources/chat` | 标记 Chat 活跃 / 空闲（抬压与低配卸载 e5） |
| GET | `/knowledge/vector-coverage` | 向量索引覆盖率（indexed/total） |
| GET/POST | `/terminology/entries` | 可学习术语表 list / upsert |
| POST | `/terminology/entries/hit` | 术语命中计数 |
| GET | `/jobs`（及摘要） | 处理队列（embed / process_revision 等） |
| DELETE | `/knowledge/:id` | 删除文档 |

检索业务**不在**数据服务；应用层另有 `POST /api/conversations/:id/files/:fileId/reindex` 重建会话附件向量。

### 数据库 Schema（对话消息附件）

消息表含可选 `attachments TEXT`（JSON），记录**该条用户消息**附带的资料展示信息（`kind: library | library_all | conversation_file`；兼容旧 `document | all`）。  
仅用于历史气泡与落库真相；下一轮检索仍以当次请求的 `retrievalScope` + `conversationId` 为准。

### 数据库 Schema（双命名空间）

```sql
CREATE TABLE knowledge_documents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  original_name TEXT,
  content_hash TEXT UNIQUE,
  stored_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  page_count INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  embedding_model TEXT,
  embedding_dim INTEGER,
  error_message TEXT
);

CREATE TABLE knowledge_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  position INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding BLOB,
  FOREIGN KEY (document_id)
    REFERENCES knowledge_documents(id) ON DELETE CASCADE
);

CREATE TABLE conversation_files (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  name TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  page_count INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  embedding_model TEXT,
  embedding_dim INTEGER,
  error_message TEXT,
  FOREIGN KEY (conversation_id)
    REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE conversation_file_chunks (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  position INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding BLOB,
  FOREIGN KEY (file_id)
    REFERENCES conversation_files(id) ON DELETE CASCADE
);

-- 1.2.0：可学习术语库（LLM Rewrite 晋升缓存）
CREATE TABLE terminology_entries (
  id TEXT PRIMARY KEY,
  domain TEXT,
  terms_json TEXT NOT NULL,
  exclude_json TEXT NOT NULL,
  source TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### SQLite 优化

- `PRAGMA journal_mode = WAL` — 提高并发读写性能
- `PRAGMA foreign_keys = ON` — 保证数据完整性
- `PRAGMA busy_timeout = 5000` — 避免并发锁冲突

---

## Windows 兼容预留

当前**完整体验仅 Apple Silicon Mac**。跨平台边界在 `services/platform`：

- **ModelRuntime**：Windows stub 返回诚实 `CAPABILITY_UNAVAILABLE`；Chat/SSE 契约不绑定 TurboFieldfare
- **OCR**：同一 `OcrEngine` 契约；Windows 为 `OCR_UNAVAILABLE` + PP-OCR/ONNX artifact 元数据（KE-034，本版不跑推理）
- **Knowledge Engine**：无 `if (windows)` 业务分支；未来换 adapter 即可
- **路径 / 导出**：相对路径与跨平台 fixture，避免 Mac 绝对路径假设

详见 [CHANGELOG](../CHANGELOG.md#120--2026-08-05)（Windows 预留与平台边界说明）。

