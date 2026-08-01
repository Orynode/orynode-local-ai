# Orynode Local AI 架构文档

[简体中文](ARCHITECTURE_zh-CN.md) | [English](ARCHITECTURE.md)

本文档详细描述 Orynode Local AI 的**服务架构、数据流、模块分层、扩展接口**以及**知识库/RAG 系统**设计。

面向：想要理解内部实现、复用模块或扩展功能的开发者。

---

## 目录

- [整体架构](#整体架构)
- [服务分层](#服务分层)
- [数据流](#数据流)
- [目录结构](#目录结构)
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
│  /api/chat   /api/conversations   /api/knowledge          │
│  /api/status   /api/settings                              │
│                                                           │
│  对接 services/ 层进行业务逻辑处理                           │
└──────────┬──────────────────────┬────────────────────────┘
           │                      │
    ① 推理请求               ② 数据请求
           │                      │
           ▼                      ▼
┌──────────────────┐   ┌──────────────────────────────────┐
│ TurboFieldfare   │   │  Orynode 本地数据服务 (:4318)      │
│ (:8080/v1)       │   │  scripts/local-data-service.mjs  │
│                  │   │                                  │
│ Swift + Metal    │   │  SQLite + 纯 HTTP 薄层            │
│ Gemma 4 26B      │   │  · 对话 CRUD                     │
│ ~2GB 内存        │   │  · 资料原件存储（PDF/TXT/MD）    │
│                  │   │  · 文本 chunks 存储               │
│  接口:           │   │  · 向量 embedding 存储 (BLOB)     │
│  POST /chat/     │   │  · 文档状态（ready/indexed/...）  │
│  completions     │   │  · 设置读写                      │
│  GET /models     │   │                                  │
│  GET /health     │   │  仅监听 127.0.0.1                 │
│                  │   │  不做解析/分块/检索业务逻辑         │
│  仅监听 127.0.0.1│   │                                  │
└──────────────────┘   └──────────────────────────────────┘
```

**安全设计原则**：

- 只有 Web 入口 (:3000) 监听 `0.0.0.0`，支持局域网共享
- TurboFieldfare (:8080) 和数据服务 (:4318) 始终绑定 `127.0.0.1`
- 局域网设备通过浏览器使用本机 AI，但无法直接访问推理服务和数据库

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
  ├── chat/        - System prompt、对话上下文管理
  ├── inference/   - 推理后端适配器（TurboFieldfare 可替换）
  ├── knowledge/   - PDF解析、分块、向量化、检索（唯一智能）
  └── settings/    - 运行时设置读写
     ↓
数据持久层 (Persistence)
  本地数据服务 (:4318) + SQLite (.orynode/data/orynode.db)

配置层 (Config)
  config/defaults.ts - 所有默认值集中定义
```

**关键设计原则**：

1. **数据服务保持薄**：`scripts/local-data-service.mjs` 只负责 SQLite CRUD 和文件存储，**不解析 PDF、不切块、不检索**
2. **服务层是唯一智能**：解析 / 分块 / Embedder / Retriever 只存在于 `services/knowledge`
3. **Embedder 可缺省**：默认无向量模型；Keyword 是 Retriever 策略，不是假 Embedder
4. **检索唯一入口**：`HybridRetriever.retrieve(query, scope)`；chat 不得旁路查库
5. **不做 sqlite-vec 硬依赖**：向量以 BLOB 存 SQLite，JS 余弦即可；规模不够再考虑 ANN

---

## 数据流

### 对话流程

```
Composer 草稿 draftAttachments（仅下一轮；发送后清空）
  → page.tsx 交给 useChat.sendMessage(attachments)
      → 写入本条 message.attachments（落库，气泡展示）
      → scopeFromAttachments → knowledgeScope（none | documents[] | all）
      → POST /api/chat
          → normalizeKnowledgeScope
          → HybridRetriever.retrieve（唯一检索入口）
          → buildSystemPrompt + TurboFieldfare SSE
```

**产品语义（对齐「附件跟这条消息」）**：

- 资料库是仓库；`useKnowledge` 只做 CRUD / 上传 / 索引，**不**跨轮粘性保存选中
- `draftAttachments` 只活在输入框；新对话、打开历史会话都会清空草稿，**不会**从旧消息恢复到 Composer
- 后续轮次若要再检索 PDF，需再次附上；模型对旧内容的「记忆」主要来自对话文本，而非自动复用上一轮 scope

### 资料导入流程（单一管线）

```
用户上传 PDF / TXT / Markdown
  → POST /api/knowledge
      → detectKnowledgeKind + parseDocument（唯一解析）
      → chunker.chunkDocument（唯一分块）+ 分配 chunk id
      → POST :4318/knowledge          （只存原件，status=awaiting_chunks）
      → PUT  :4318/knowledge/:id/chunks（写入已切好的 chunks，status=ready）
      → await indexDocumentEmbeddings（Workers 下不可 fire-and-forget）
           Embedder 可用 → 写 BLOB，status=indexed
           未开语义 / Embedder 不可用 → skipped 或保持 ready（仅 keyword）
```

### 检索流程

```
query + KnowledgeScope
  → HybridRetriever
    ├── keyword：有命中才返回片段；无词命中则不灌上下文
    ├── semantic：Embedder.embed(query) + SQLite BLOB 余弦（可选）
    └── hybrid：两路按 chunk id 做 RRF 融合
  → topK excerpts → system prompt → 推理
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
│   │   └── attachments.ts            #   附件 ↔ KnowledgeScope
│   ├── components/                   # UI 组件
│   │   ├── chat/                     #   对话视图
│   │   │   ├── ChatView.tsx          #     消息列表容器
│   │   │   ├── MessageBubble.tsx     #     气泡（含本条 attachments）
│   │   │   ├── Composer.tsx          #     输入框 + 本轮草稿附件
│   │   │   └── WelcomeScreen.tsx     #     欢迎页
│   │   ├── knowledge/                #   知识库视图
│   │   │   ├── KnowledgeView.tsx     #     列表；「用于对话」→ 草稿
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
│   │   ├── useKnowledge.ts           #   资料仓库 CRUD（无跨轮选中）
│   │   └── useSettings.ts            #   设置读写
│   └── api/                          # API 路由 (Next.js 约定)
│       ├── chat/route.ts             #   POST 对话代理
│       ├── status/route.ts           #   GET 模型连接状态
│       ├── conversations/
│       │   ├── route.ts              #   对话列表/创建
│       │   └── [id]/route.ts         #   对话详情/更新/删除
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
│   ├── chat/prompt.ts                #   System prompt
│   ├── inference/                    #   推理（chat/status 共用）
│   │   ├── types.ts                  #     InferenceService 接口
│   │   └── turbo-fieldfare.ts        #     TurboFieldfare 适配器
│   ├── knowledge/                    #   知识库（唯一智能层）
│   │   ├── types.ts                  #     Embedder/VectorStore/Retriever
│   │   ├── parser.ts / chunker.ts
│   │   ├── embedder.ts               #     可选；resolveEmbedder() 可 null
│   │   ├── indexer.ts / status.ts
│   │   ├── vector-store.ts           #     insert + search（删除靠 CASCADE）
│   │   ├── retriever.ts              #     唯一检索入口
│   │   └── index.ts                  #     对外导出（仅接线符号）
│   └── settings/                     #   运行时设置
│
├── config/defaults.ts                # 集中配置
├── scripts/
│   ├── start-local.mjs
│   ├── local-data-service.mjs        # 薄存储 :4318（无检索逻辑）
│   └── ...
├── worker/                           # vinext 本地运行时入口（非云业务）
├── db/README.md                      # 说明：业务库在 .orynode/data/orynode.db
│
├── .orynode/                         # 运行时数据 (gitignore)
│   ├── data/orynode.db
│   ├── knowledge/files/
│   └── models/
│
├── .env.example
├── package.json
└── docs/ARCHITECTURE_zh-CN.md
```

---

## 知识库 / RAG 系统

```
上传 PDF / TXT / MD
  → parser → chunker →（分配 chunk id）
  → data-service 存原件 + chunks
  →（可选）Embedder → vector-store(BLOB)
对话
  → Retriever(scope) → keyword 和/或 hybrid → LLM
```

| 模块 | 职责 |
|------|------|
| `formats` / `parser` | 识别种类；PDF / TXT / MD → 统一文本页 |
| `chunker` | 唯一分块 |
| `embedder` | 可选语义向量；`resolveEmbedder()` 可能返回 `null` |
| `indexer` | 入库后异步写向量并更新 status |
| `vector-store` | insert + search（BLOB + JS 余弦）；删除靠 SQLite CASCADE |
| `retriever` | **唯一检索入口**；scope = none / documents / all |

### Embedder（诚实模型）

- **默认**：无 Embedder，检索 = keyword（开箱零额外依赖）
- **可选**：`.env.local` 设 `ORYNODE_SEMANTIC_SEARCH=1` 并重启 → data-service 加载 ONNX `bge-small-zh-v1.5`（`@xenova/transformers` 已在 package.json）
- **禁止**：把 keyword 伪装成 Embedder

### Scope

```ts
type KnowledgeScope =
  | { mode: "none" }
  | { mode: "documents"; documentIds: string[] }
  | { mode: "all" };
```

兼容旧字段：`knowledgeDocumentId` → `{ mode: "documents", documentIds: [id] }`。

前端来源：发送时用本轮草稿附件调用 `app/lib/attachments.ts` 的 `scopeFromAttachments`，得到当次 `knowledgeScope`；同时把附件快照写入该条 `message.attachments`（仅展示与落库）。  
未附带资料时为 `none`，本轮不检索；**不会**从会话历史里的旧附件自动拼出 scope。

### 向量存储

- SQLite `knowledge_chunks.embedding BLOB` + 文档级 `embedding_model` / `embedding_dim`
- **不加 sqlite-vec** 作为必装依赖；个人规模 JS 扫描足够
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

**文件**: `services/knowledge/embedder.ts`

- `resolveEmbedder()`：未开启或不满足依赖时返回 `null`
- 开启方式：`.env.local` 中 `ORYNODE_SEMANTIC_SEARCH=1`（包已依赖 `@xenova/transformers`）
- 模型：`Xenova/bge-small-zh-v1.5`（512 维；由本地 data-service 计算，因 vinext Workers 无法直接加载 ONNX）
- Keyword **不是** Embedder

### 4. 向量存储 (VectorStore)

**文件**: `services/knowledge/vector-store.ts`

- SQLite BLOB + JS 余弦；`search` 接受 scope（documents / all）
- 不加 sqlite-vec 必装依赖

### 5. 检索 (Retriever)

**文件**: `services/knowledge/retriever.ts`

- `retrieve(query, scope)` 为唯一入口
- scope：`none | documents[] | all`；前端由 `app/lib/attachments.ts` 的本轮附件推导，**不会**从历史消息自动拼 scope
- keyword 始终可用；存在非空 embedding 时走 hybrid + RRF（按排名与 chunk id）
- `error` 文档会清空向量 BLOB，仅 keyword；`awaiting_chunks` 不参与检索
- 兼容 `knowledgeDocumentId`


```typescript
import { HybridRetriever } from "./services/knowledge";

const retriever = new HybridRetriever();
const result = await retriever.retrieve(
  "如何提高性能？",
  { mode: "documents", documentIds: [documentId] }, // 或 { mode: "all" }
  { topK: 8 },
);
// → { chunks, strategy: "keyword" | "hybrid" }
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

**关键词提取策略**：

- 英文/数字：≥2 字符的 token
- 中文：bigram 组合 + 三字以上词组

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

`services/inference/` 提供了 `InferenceService` 接口：

```typescript
interface InferenceService {
  chatCompletions(messages, options): Promise<ReadableStream>;
  listModels(): Promise<string[]>;
}
```

要接入 Ollama、vLLM 或其他后端：

```typescript
// services/inference/ollama.ts
class OllamaService implements InferenceService {
  async chatCompletions(messages, options) {
    const res = await fetch("http://localhost:11434/v1/chat/completions", { ... });
    return res.body;
  }
}

// 在 API 路由中使用
const inference = new OllamaService();
```

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
export const EMBEDDING_CONFIG = { modelName: "bge-small-zh-v1.5", dimension: 512 };

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
```

应用层补索引：

- `POST /api/knowledge/:id/reindex` — 单文档
- `POST /api/knowledge/reindex` — 全部文档

---

## 低配 Mac 的内存策略

项目为 8GB MacBook Air 设计，有三层内存控制策略：

| 策略 | 说明 |
|------|------|
| **零额外开销（默认）** | 无 Embedder，仅 keyword |
| **按需加载** | 开启语义后才加载 ONNX；失败回退 keyword |
| **不加 sqlite-vec** | 避免原生扩展成为开源安装负担 |

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
| GET | `/knowledge` | 文档列表（含 status） |
| POST | `/knowledge` | **只存原件**（PDF/TXT/MD，status=`awaiting_chunks`） |
| PUT | `/knowledge/:id/chunks` | **写入服务层已切好的 chunks** |
| PUT | `/knowledge/:id/status` | 更新索引状态 / embedding 元数据 |
| POST | `/knowledge/chunks/query` | 按 scope 导出 chunks（可选向量） |
| GET | `/knowledge/:id/chunks` | 单文档 chunks |
| POST | `/knowledge/vectors` | 批量写入 embedding BLOB |
| GET | `/knowledge/embed/status` | 向量模型是否可用 |
| POST | `/knowledge/embed` | 文本批量向量化（Node/ONNX） |
| DELETE | `/knowledge/:id` | 删除文档 |

检索业务**不在**数据服务；已移除 `/knowledge/search`。

### 数据库 Schema（对话消息附件）

消息表含可选 `attachments TEXT`（JSON），记录**该条用户消息**附带的资料展示信息（`kind: document | all`）。  
仅用于历史气泡与落库真相；下一轮检索仍以当次请求的 `knowledgeScope` 为准。

### 数据库 Schema（知识库）

```sql
CREATE TABLE knowledge_documents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
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
```

### SQLite 优化

- `PRAGMA journal_mode = WAL` — 提高并发读写性能
- `PRAGMA foreign_keys = ON` — 保证数据完整性
- `PRAGMA busy_timeout = 5000` — 避免并发锁冲突
