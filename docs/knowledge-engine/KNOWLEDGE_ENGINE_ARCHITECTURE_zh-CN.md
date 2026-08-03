# Orynode AI Knowledge Engine 长期架构

> 状态：目标架构（Target Architecture）  
> 适用范围：Orynode Local AI 的私有知识、RAG、Chat 与未来 Agent 能力  
> 设计原则：本地优先、渐进演进、接口稳定、资源可降级、结果可解释

本文不是当前功能清单，也不要求一次性重写项目。它描述 Orynode 在现有代码基础上的长期目标、稳定边界和分阶段迁移路线。当前实现细节见 [ARCHITECTURE_zh-CN.md](../ARCHITECTURE_zh-CN.md)，当前代码与目标架构的差距、整改顺序和验收标准见 [架构符合性审计与整改实施计划](KNOWLEDGE_ENGINE_IMPLEMENTATION_PLAN_zh-CN.md)。

## 0. 不可偏离的产品核心

**Orynode 的核心定位是：把用户自己的设备变成一台本地、私有、可长期运行的 AI 服务器。当前首发和主要支持平台是 Apple Silicon Mac，长期架构预留 Windows 本地主机。** AI Knowledge Engine、RAG、Chat 和 Agent 都是在这台私有 AI 服务器上运行的能力，而不是把用户数据导向云端服务的中间层。

后续架构和实现必须遵守以下硬约束：

1. **计算在本机**：LLM 推理、文档解析、分块、Embedding、Rerank、检索、上下文构建和 Agent 知识工具默认全部在本地服务器设备上执行。
2. **数据在本机**：原始文件、解析文本、chunks、向量、索引、会话、引用和任务状态默认只保存在本地服务器设备；不得因启用 RAG 或 Agent 自动上传云端。
3. **本地设备是服务端**：当前是 Apple Silicon Mac，未来可以是 Windows PC；浏览器、手机和同一可信局域网内的其他设备只是客户端，知识数据与模型能力以服务器设备为唯一事实来源。
4. **本机端口隔离**：模型运行时、数据服务、索引 Worker 和管理接口只监听 `127.0.0.1`；只有经过 Orynode Web/API 网关的用户入口可以按配置开放给可信局域网。
5. **离线可用**：安装和首次下载完成后，文件导入、索引、检索和对话的核心链路必须能够断网运行。
6. **外部连接显式授权**：网页和 GitHub Connector 仅在用户主动配置和触发时访问外部来源；它们把内容取回本机处理，不把本地知识发送给来源网站。
7. **云能力只能可选**：未来即使支持远程模型、云 Embedding 或同步，也必须是明确开启、清楚标识的数据出口；不能成为默认路径或基础功能依赖。
8. **用户可控制**：用户能够查看数据保存位置、索引状态和外部连接，能够删除资料、索引与会话，并能通过本地备份或导出迁移数据。

任何新功能如果与这些约束冲突，应视为另一种部署产品或可选适配器，不能改变 Orynode Local AI 的默认架构。

### 0.1 当前物理部署真相

```text
可信局域网客户端
Browser / Phone / Other Computer
              │
              │ HTTP（唯一可选的局域网入口）
              ▼
┌──────────────── 用户的 Apple Silicon Mac ────────────────┐
│ Orynode Web/API (:3000，可配置 localhost / LAN)           │
│              │                                            │
│              ├── AI Knowledge Engine                      │
│              ├── Index Worker                             │
│              ├── Local Data Service (:4318, localhost)    │
│              ├── Model Runtime (:8080, localhost)         │
│              └── .orynode/（文件、SQLite、模型、索引）      │
└───────────────────────────────────────────────────────────┘
```

默认不存在云端控制面、云数据库、云向量库或云推理依赖。

### 0.2 长期平台模型

```text
                    Orynode Platform-Neutral Core
       Chat / Agent / Knowledge Engine / SQLite Schema / Web UI
                                  │
                         Host Runtime Abstraction
                    ┌─────────────┴─────────────┐
                    │                           │
             macOS Host Profile          Windows Host Profile
             TurboFieldfare              Future Runtime Adapter
             Apple Vision OCR            Windows OCR / Local OCR
             Keychain                    Credential Manager
             launchd / shell             Windows Service / process
```

Windows 是长期兼容目标，不是当前发布承诺。架构先稳定平台边界，等本地推理后端、安装方式和硬件基线明确后再实现 Windows Host Profile；不应为了尚未确定的后端阻塞 Mac 产品演进。

---

## 1. 背景与目标

Orynode 当前已经具备一条轻量 RAG 链路：本地文件解析、分块、SQLite 持久化、关键词检索、可选向量检索、RRF 融合以及对话上下文注入。随着网页、GitHub、更多文档格式和 Agent 能力加入，如果继续把能力直接堆在 Chat API 和文件表上，将出现以下问题：

- 数据来源、解析方式、索引模型和产品入口相互耦合；
- Chat 与 Agent 容易各自实现一套检索和上下文拼装；
- 文档更新、索引重建、失败恢复和模型迁移难以表达；
- 引用只能依赖模型输出文本，无法稳定定位原文；
- 数据量增加后，全量扫描 chunks 和向量无法持续扩展；
- 缺少可重复的检索评测，升级模型或策略时无法判断效果是否退化。

长期目标是将现有 `services/knowledge` 演进为独立、可嵌入的 **AI Knowledge Engine**。Chat、Agent 和知识工作台是上层消费者；RAG 是 Knowledge Engine 提供的一条核心能力，而不是与 Chat、Agent 并列的独立应用。

### 1.1 产品关系

```text
                         Orynode Local AI
                                │
          ┌─────────────────────┼─────────────────────┐
          │                     │                     │
        Chat                  Agent          Knowledge Workspace
          │                     │                     │
          └─────────────────────┼─────────────────────┘
                                │
                     AI Knowledge Engine
           ┌────────────────────┼────────────────────┐
           │                    │                    │
        Ingestion            Retrieval           Context
           │                    │                 & Citation
           └────────────────────┼────────────────────┘
                                │
                        用户私有数据与索引
        ┌──────────┬──────────┬──────────┬──────────┬──────────┐
       PDF       Markdown     网页       GitHub     其他文档
```

### 1.2 架构目标

1. 当前 Apple Silicon Mac 始终是私有 AI 服务器和数据事实来源；长期允许 Windows PC 承担相同角色，核心链路离线可运行。
2. 所有数据源进入统一文档模型，同一套处理和检索流水线可以复用。
3. Chat 和 Agent 只通过公开接口使用知识能力，不感知 SQLite、向量模型和分块细节。
4. 原始资料、解析结果、chunks 与索引版本解耦，允许独立更新和回滚。
5. 每个答案引用都能定位到确定的数据源、版本和原文位置。
6. 默认配置适合低内存 Apple Silicon；高级能力可以按需开启并优雅降级。
7. 单机单进程可以起步，数据规模增长后可替换本地索引实现或拆出本机 Worker，而不改变上层调用。
8. 检索质量、性能和资源消耗能够被测试和度量。
9. Knowledge Engine 核心保持平台中立，操作系统差异只能通过 Host Runtime adapters 进入。

### 1.3 非目标

- 当前阶段不引入分布式微服务、外部账号系统或云端强依赖；
- 不建设依赖厂商账号的云端控制面，不要求用户把私有数据托管给 Orynode；
- 不要求所有来源都实时同步；
- 不把向量数据库作为安装必需项；
- 不让 Knowledge Engine 承担 Agent 规划、工具授权或模型对话状态；
- 不用大规模重写替代可渐进迁移的现有模块。

---

## 2. 总体架构

```text
┌────────────────────────── Applications ──────────────────────────┐
│ Chat UI / Chat API     Agent Runtime     Knowledge Workspace     │
└───────────────────────────────┬───────────────────────────────────┘
                                │ Knowledge API / TypeScript Ports
┌──────────────────────── AI Knowledge Engine ─────────────────────┐
│                                                                  │
│  Sources        Processing        Indexing        Retrieval      │
│  Connectors  →  Normalize/OCR  →  Index Jobs  →  Query Pipeline │
│                                                                  │
│  Scope & Policy       Context Builder       Citation Resolver    │
│                                                                  │
│  Evaluation & Diagnostics       Capability Registry              │
└──────────────┬───────────────────┬───────────────────┬────────────┘
               │                   │                   │
┌──────── Storage Ports ───────┐ ┌─ Model Ports ────┐ ┌─ Job Port ─┐
│ Source/Document/Chunk/Index  │ │ Embed / Rerank   │ │ enqueue    │
│ SQLite + files（默认实现）    │ │ LLM（上层使用）   │ │ lease/retry│
└──────────────────────────────┘ └──────────────────┘ └────────────┘
```

### 2.1 逻辑模块与职责

| 模块 | 职责 | 不负责 |
|---|---|---|
| Applications | 用户交互、会话状态、Agent 规划、选择检索范围 | 直接读写索引、拼接 RAG 上下文 |
| Connectors | 获取来源内容、增量同步、生成统一 `SourceItem` | 分块、Embedding、检索 |
| Processing | 类型识别、解析、OCR、清洗、结构提取、统一文档生成 | 来源鉴权、向量搜索 |
| Indexing | 分块、关键词/向量索引、版本管理、后台任务 | 生成最终回答 |
| Retrieval | 查询分析、候选召回、融合、过滤、重排、邻块扩展 | 对话历史管理 |
| Context | token 预算、上下文组装、引用编号、注入安全边界 | 资料摄取 |
| Evaluation | 离线评测、回归、性能指标 | 在线修改用户数据 |
| Storage Adapters | 原件、元数据、chunks、索引、任务的持久化 | 业务编排 |
| Model Adapters | Embedding、Reranker 等模型适配 | 数据权限与 scope 决策 |

### 2.2 部署原则

逻辑模块化不等于立即微服务化。默认部署仍保持：

```text
Browser (:3000)
  → Orynode Web/API
       → Knowledge Engine（TypeScript 领域层）
       → Local Data Service (:4318，仅 127.0.0.1)
       → TurboFieldfare (:8080，仅 127.0.0.1)
       → Index Worker（初期可与 data-service 同进程）
```

当索引耗时或数据规模增长后，只在本地服务器设备内拆出 Index Worker，或优先替换为更高效的本地 Search Adapter。上层接口保持不变。外部向量库只能作为用户显式选择的适配器，不属于默认部署。

### 2.3 跨平台边界

Knowledge Engine 的领域层和应用层不得直接依赖 TurboFieldfare、Apple Vision、macOS 路径、shell 脚本或 launchd。平台差异集中在 `services/platform` 与相应 adapters：

```ts
interface HostRuntime {
  readonly platform: "macos" | "windows";
  paths(): RuntimePaths;
  capabilities(): Promise<HostCapabilities>;
  credentials(): CredentialStore;
  processes(): ProcessSupervisor;
}

interface ModelRuntime {
  chat(messages: ChatMessage[], options: ChatOptions): Promise<ReadableStream>;
  listModels(): Promise<ModelInfo[]>;
  health(): Promise<RuntimeHealth>;
}

interface OcrEngine {
  recognize(input: OcrInput): Promise<OcrPage[]>;
}
```

平台选择使用 capability discovery 和配置装配，不允许在 Knowledge Engine 业务代码中散布 `process.platform === ...`：

| 能力 | macOS 当前实现 | Windows 预留实现 | 平台中立消费者 |
|---|---|---|---|
| LLM Runtime | `TurboFieldfareAdapter` | `WindowsModelRuntimeAdapter`（待选型） | Chat / Agent |
| Embedding/Rerank | 本地 Transformers.js 或 runtime adapter | 同接口的 Windows 本地实现 | Indexing / Retrieval |
| OCR | `AppleVisionOcrAdapter` | `WindowsOcrAdapter` 或跨平台 OCR | Processing |
| 凭据 | macOS Keychain adapter | Windows Credential Manager adapter | Connectors |
| 进程管理 | shell/launchd profile | PowerShell/Windows Service profile | Launcher |
| 数据目录 | `.orynode/` 的 macOS 解析 | `%LOCALAPPDATA%` 等 Windows 解析 | Storage repositories |
| 路径与文件锁 | macOS filesystem adapter | Windows filesystem adapter | Storage / Jobs |

跨平台兼容规则：

- SQLite schema、API DTO、Source/Document/Revision/Chunk/Citation 标识保持一致；
- 数据库中存相对存储 key 或标准 URI，不持久化只能在某个系统解析的绝对路径；
- 子进程使用参数数组启动，不拼接 shell 命令；业务层不依赖 `.sh` 或 PowerShell；
- 文件名、大小写、保留字符、路径长度和文件锁必须有 Windows fixture；
- 模型 runtime 对外统一为 OpenAI-compatible 能力并不代表内部必须使用同一程序；
- 启动时返回 capability matrix，UI 只展示当前主机实际支持的模型、OCR 和索引能力；
- 导出包使用平台无关清单与相对路径，使用户资料未来可从 Mac 迁移到 Windows；
- Windows 后端未确定前只定义接口与契约测试，不加入虚假的实现或产品承诺。

### 2.4 配置与 Capability

配置优先级固定为“内置安全默认值 < 本机持久设置 < 启动环境覆盖”，敏感凭据不进入普通配置。配置 schema 带版本并在启动时校验；未知字段告警，非法值不静默回退到危险配置。

Capability 是运行时探测结果，不等同于用户愿望。例如用户选择 Quality 档位但主机没有可用 reranker 时，系统返回明确降级原因。Capability 至少包含平台、模型 runtime、最大上下文、Embedding、Reranker、OCR、FTS tokenizer、可用内存档位和外部 Connector 状态。

---

## 3. 核心领域模型

当前 `knowledge_documents` 和 `conversation_files` 将“来源、文档、当前解析结果、当前索引状态”压在一条记录上。目标模型应分离以下概念。

```text
KnowledgeSpace ── SpaceDocumentBinding ── Document
      │                                      └── DocumentRevision
      └── Source                                  └── ProcessingBuild
           └── SourceItem ─────────────────────────────┤
                                                      ├── DocumentBlock
                                                      └── ChunkSet
                                                           ├── Chunk
                                                           └── IndexBuild
                                                                └── IndexEntry
```

### 3.1 实体定义

| 实体 | 含义 | 稳定身份 |
|---|---|---|
| `KnowledgeSpace` | 检索和生命周期边界，如资料库或某个会话 | `spaceId` |
| `SpaceDocumentBinding` | Document 在某个 Space 中的可见性、显示名、标签和生命周期关联 | `(spaceId, documentId)` |
| `Source` | 一个连接器实例，如文件导入、网站、GitHub 仓库 | `sourceId` |
| `SourceItem` | 来源中的可同步对象，并关联其当前 Document/Revision，如 URL、仓库文件、上传文件 | `(sourceId, externalId)` |
| `Document` | 用户可见的逻辑文档 | `documentId` |
| `DocumentRevision` | 某次不可变的原始内容快照，与 Parser 无关 | `revisionId + contentHash` |
| `ProcessingBuild` | 使用特定 Parser/OCR/Normalizer 处理 Revision 的一次不可变构建 | `processingBuildId + configHash` |
| `DocumentBlock` | 带结构与定位信息的解析单元 | `blockId` |
| `ChunkSet` | 由特定分块配置产生的一组 chunks | `chunkSetId + strategyVersion` |
| `Chunk` | 最小召回和引用单元 | `chunkId` |
| `IndexBuild` | 使用特定模型和配置构建的一版索引 | `indexBuildId` |
| `Citation` | 检索结果到原始内容位置的稳定引用 | `revisionId + locator` |

建议的核心类型：

```ts
type KnowledgeSpaceKind = "library" | "conversation" | "agent";

interface KnowledgeSpace {
  id: string;
  kind: KnowledgeSpaceKind;
  ownerRef?: string;       // conversationId / agentId；单用户版本可为空
  lifecycle: "persistent" | "scoped";
}

interface SpaceDocumentBinding {
  spaceId: string;
  documentId: string;
  displayName: string;
  tags: string[];
  createdAt: string;
}

interface SourceItem {
  id: string;
  sourceId: string;
  externalId: string;
  uri: string;
  title: string;
  mimeType?: string;
  metadata: Record<string, unknown>;
}

interface DocumentRevision {
  id: string;
  documentId: string;
  contentHash: string;
  createdAt: string;
}

interface ProcessingBuild {
  id: string;
  revisionId: string;
  parserVersion: string;
  ocrVersion?: string;
  normalizerVersion: string;
  configHash: string;
  status: "queued" | "running" | "ready" | "failed";
}

interface DocumentBlock {
  id: string;
  processingBuildId: string;
  revisionId: string;
  kind: "title" | "paragraph" | "list" | "table" | "code" | "image_text";
  text: string;
  order: number;
  locator: CitationLocator;
  metadata: Record<string, unknown>;
}

type CitationLocator =
  | { kind: "page"; page: number; bbox?: [number, number, number, number] }
  | { kind: "web"; url: string; headingPath?: string[]; selector?: string }
  | { kind: "code"; repo: string; path: string; commit: string; startLine: number; endLine: number }
  | { kind: "text"; startOffset: number; endOffset: number };
```

### 3.2 为什么必须保留 Revision

- 网页和 GitHub 文件会变化，旧答案的引用必须仍指向当时版本；
- 更换 Parser 不应覆盖原始内容或破坏旧引用；
- 重新分块和重新 Embedding 不应创建重复的逻辑文档；
- 索引失败可以回退到上一版可用索引。

`DocumentRevision` 只表达来源内容发生变化；同一份内容使用新 Parser/OCR 重新处理时创建新的 `ProcessingBuild`，不创建伪造的新 Revision。Citation 同时绑定 revision 与 processing build，保证重新解析后旧答案仍能还原当时引用的位置。

`Document` 与 `KnowledgeSpace` 是多对多关联。同一内容可被资料库、会话或多个 Connector 复用，显示名和标签属于 binding，而不是共享的内容实体。删除会话只删除其 binding；只有不存在其他 binding、保留 revision 或引用策略时，底层内容才可进入垃圾回收。这解决当前“资料库按内容去重、会话附件不全局去重”向统一模型迁移时的生命周期冲突。

### 3.3 Scope 与访问边界

当前双命名空间语义继续保留，但统一表达为 `KnowledgeSpace`：

```ts
interface RetrievalScope {
  spaces: Array<{
    spaceId: string;
    documentIds?: string[];
    sourceIds?: string[];
  }>;
  filters?: {
    sourceTypes?: string[];
    mimeTypes?: string[];
    updatedAfter?: string;
    tags?: string[];
  };
}
```

会话附件属于 `conversation` space，并由服务端根据 `conversationId` 解析 space，不能信任客户端直接声明归属。未来增加账号时，只需在 Space 层增加 owner/ACL，不需要改检索算法。

---

## 4. Connector 与摄取架构

所有来源通过统一 Connector 接口输出内容，不为 PDF、网页和 GitHub 各建一套 RAG。

```ts
interface SourceConnector {
  readonly type: string;
  test(config: unknown): Promise<ConnectorHealth>;
  discover(cursor?: string): Promise<DiscoverPage>;
  fetch(item: DiscoveredItem): Promise<SourcePayload>;
  checkpoint?(): Promise<string>;
}
```

### 4.1 来源适配

| 来源 | SourceItem 身份 | Revision 判定 | 引用定位 |
|---|---|---|---|
| 本地文件 | 内容哈希或导入记录 | SHA-256 | 页码/字符范围 |
| Markdown/TXT | 文件或内容哈希 | SHA-256 | 标题路径/行或字符范围 |
| 网页 | canonical URL | 正文哈希、ETag、Last-Modified | URL/标题路径/selector |
| GitHub | repo + path | commit SHA/blob SHA | repo/path/commit/行号 |
| DOCX | 文件哈希 | SHA-256 | 标题路径/段落编号 |
| 扫描 PDF | 文件哈希 | 文件哈希 + OCR 配置版本 | 页码/bbox |

### 4.2 摄取流水线

```text
Discover / Upload
  → Fetch
  → Validate（大小、类型、SSRF/路径安全）
  → Store Original
  → Parse / OCR
  → Normalize to DocumentBlocks
  → Create immutable Revision
  → Build ChunkSet
  → Commit keyword-searchable chunks
  → Enqueue optional indexes
  → Activate successful index build
```

重要约束：

- 原件成功落盘不等于文档可检索；
- 文本 chunks 提交成功后立即允许关键词检索；
- Embedding 和 reranker 相关工作不阻塞上传响应；
- 同一任务必须幂等，重复执行不产生重复 revision/chunks；
- 新索引构建完成前，旧索引继续提供服务；
- 删除 Source 时按 lifecycle 决定删除文档还是仅解除关联。
- Connector 发现内容更新时先创建 candidate revision；解析和基础关键词索引成功后才切换 SourceItem 的 active revision，失败时继续服务旧版本并展示同步错误；
- 同步删除先产生 tombstone 和预览结果，是否解除 binding 或保留历史 revision 由 Source policy 决定。

### 4.3 内容安全

网页与仓库内容是不可信输入。Processing 层只保存和解析内容，不执行脚本、宏或仓库代码。Context Builder 必须给资料内容加明确的数据边界，告诉生成模型资料中的“指令”只是被引用内容，不能覆盖系统指令。

---

## 5. 索引架构

### 5.1 多索引而非单 embedding 字段

长期不再把 `embedding` 作为 chunk 的固定字段，而是用可版本化索引：

```text
IndexBuild
  kind: keyword | vector
  model: bge-small-zh-v1.5 | ...
  modelRevision
  dimension
  chunkStrategyVersion
  configHash
  status: queued | running | ready | failed | superseded
```

这样可以并行构建新模型索引、验证后原子切换，并随时回退。

### 5.2 默认索引策略

- Keyword：SQLite FTS5，始终启用。英文使用规范化正文；中文不能直接假设默认 tokenizer 具有理想分词效果，第一版将现有 bigram 结果写入独立 `search_text`，或在运行时验证可用的 FTS5 tokenizer 后选择实现。原始 `content` 永远保留，不被索引预处理文本替代。
- Vector：可选，本地 Embedding；低配设备默认关闭。
- Metadata：space、source、document、revision、类型、时间、标签。
- 大规模扩展：通过 `KeywordIndex` / `VectorIndex` port 替换实现，不向上层暴露 sqlite-vec、Qdrant 等具体产品。

```ts
interface KeywordIndex {
  upsert(build: IndexBuild, chunks: Chunk[]): Promise<void>;
  search(query: string, options: SearchOptions): Promise<Candidate[]>;
}

interface VectorIndex {
  upsert(build: IndexBuild, vectors: EmbeddedChunk[]): Promise<void>;
  search(vector: Float32Array, options: SearchOptions): Promise<Candidate[]>;
}
```

### 5.3 Job 系统

索引、OCR、网页同步都使用持久化任务，不使用请求内的“启动后不等待 Promise”。最小 Job 模型：

```text
queued → running → succeeded
             └──→ retry_wait → running
             └──→ failed
running --lease timeout--> queued
```

任务记录包含 `type`、`payload`、`attempts`、`maxAttempts`、`availableAt`、`leaseOwner`、`leaseUntil`、`progress`、`error`。初期在 SQLite 中实现单 Worker；未来可替换队列。

Job 的可靠性约束：

- 每个任务包含业务幂等键，并由唯一约束阻止重复入队；
- Worker 只领取 capability 满足且资源预算允许的任务；
- 状态更新、active build 切换和任务完成尽量在同一 SQLite 事务中提交；
- 任务副作用采用临时文件/临时 build，成功后原子 rename 或切换 active pointer；
- 进程崩溃后过期 lease 可重新领取，重复执行必须安全；
- 取消任务只停止新工作，不删除仍被 active build 使用的数据。

### 5.4 本地资源协调

LLM、Embedding、Reranker、OCR 和索引任务共享同一台设备的内存、GPU/Metal 与 CPU。仅有 Job Queue 仍可能在聊天时加载多个模型导致内存峰值，因此需要本地 `ResourceCoordinator`：

```ts
interface ResourceCoordinator {
  acquire(request: ResourceRequest, signal?: AbortSignal): Promise<ResourceLease>;
  snapshot(): Promise<ResourceSnapshot>;
}
```

调度规则：

- 交互式 Chat/Agent 推理优先于后台索引；
- Lite/Balanced/Quality 档位声明可同时驻留的模型与内存预算；
- 内存不足时暂停/延迟 Embedding、Reranker 和 OCR，而不是让系统 swap 或崩溃；
- 模型加载、空闲卸载、并发数和批大小由 Host Capability 决定；
- Worker 进度必须允许暂停、恢复和取消；
- 无法精确获取系统资源时采用保守的单重型任务策略。

### 5.5 模型与本地 Artifact 生命周期

LLM、Embedding、Reranker、OCR helper 都属于本地 Artifact，由 Host Profile 的 Artifact Manager 管理：

- manifest 记录 artifact id、版本、来源、许可证、hash/signature、磁盘大小、平台/架构和兼容接口版本；
- 下载支持断点续传、校验、临时目录和成功后的原子激活；
- 更新不覆盖当前可用版本，健康检查通过后切换，失败自动回滚；
- 不自动下载或升级大型模型，必须由用户确认磁盘和网络消耗；
- 索引记录准确的 embedding/reranker artifact 版本，模型变更通过新 IndexBuild 迁移；
- 清理模型前检查 active runtime 和 index 依赖，避免产生不可解释的半可用状态。

---

## 6. Retrieval Pipeline

Knowledge Engine 对外提供 `search`（给 UI/Agent）与 `retrieve`（给 RAG）两个层级。`search` 返回可浏览结果；`retrieve` 在**同一召回与门禁**之后继续做邻块扩展与上下文装箱。

**硬约束（开源防双路径）：**

- 唯一召回实现是 `HybridRetriever`（经 `KnowledgeEngine`）；禁止 Web 工作台、Chat 前端或 Agent 工具直连 data-service 另算 FTS/向量。
- `search` 与 `retrieve` **共享** QueryPlan、关键词/向量召回、RRF、无答案门禁与 `highlightTerms` 生成；差异只在 retrieve 之后的 context / citation 阶段。
- 改阈值、融合权重、文件名命中或高亮词只改 Engine，一次对所有消费者生效。

```text
Query + Scope
  → Normalize / Language Detect
  → Optional Query Rewrite / Multi-query
  → Parallel Recall
       ├── Keyword Top-N
       ├── Vector Top-N（可选）
       └── Metadata/Exact Match
  → Fusion（RRF）
  → Permission & Metadata Filter
  → Deduplicate / Diversity
  → Optional Rerank
  → Relevance Threshold / 无答案门禁
  → 【search 在此返回 hits + diagnostics + highlightTerms】
  → Neighbor Expansion          【仅 retrieve 路径继续】
  → Context Selection by Token Budget
  → RetrievalResult + Citations + Diagnostics
```

### 6.0 消费者矩阵（正式契约）

| 消费者 | 调用 | 典型 scope | 返回重点 | 禁止 |
|---|---|---|---|---|
| 知识工作台 | `POST /api/knowledge/v1/search` | 常 `library: all` 或选中资料 | hits、diagnostics、highlightTerms | 本地另算召回；把预览结果冒充 RAG 上下文；新增 `/debug/search` |
| Agent `knowledge.search` | `engine.search` | Agent scope | 同上 | 绕过 ScopePolicy |
| Chat RAG | `buildChatKnowledgeContext` → `engine.retrieve` | 对话附件 + 选中资料 | citations、packed context | 以工作台 UI 状态为检索真相 |
| Agent `knowledge.retrieve` | `engine.retrieve` | Agent scope | RetrievalResponse | 与 search 维护两套打分/门禁逻辑 |

工作台是正式 **Search 预览面**，不是测试旁路。本阶段工作台不提供 Retrieve 预览开关；若以后需要对比装箱结果，另开 ADR 且只调 `v1/retrieve`。

### 6.1 稳定接口

```ts
interface KnowledgeEngine {
  ingest(command: IngestCommand): Promise<IngestReceipt>;
  search(request: SearchRequest): Promise<SearchResponse>;
  retrieve(request: RetrievalRequest): Promise<RetrievalResponse>;
  buildContext(request: ContextRequest): Promise<ContextPackage>;
  resolveCitation(id: string): Promise<ResolvedCitation>;
}
```

建议的返回结果：

```ts
interface SearchResponse {
  query: string;
  hits: RetrievalHit[];
  diagnostics: RetrievalDiagnostics;
  /** UI/Agent 高亮词（含简繁与跨语言提示）；一等字段，非前端私货 */
  highlightTerms?: string[];
}

interface RetrievalResponse {
  query: string;
  rewrittenQueries: string[];
  hits: RetrievalHit[];
  citations: Citation[];
  highlightTerms?: string[];
  diagnostics: {
    strategy: string[];
    candidateCount: number;
    elapsedMs: number;
    degradedCapabilities: string[];
  };
}
```

### 6.2 降级矩阵

| 可用能力 | 执行策略 |
|---|---|
| Keyword only | FTS/关键词召回 → 去重 → 阈值 → 上下文 |
| Keyword + Embedding | 两路召回 → RRF → 去重 → 上下文 |
| Keyword + Embedding + Reranker | 两路召回 → RRF → rerank → 上下文 |
| 任一高级模块失败 | 记录 diagnostics，降级到仍可用的前一层 |
| 无可靠命中 | 返回空上下文，由回答层明确“资料中未找到” |

### 6.3 资源档位

| 档位 | Keyword | Embedding | Reranker | 适用场景 |
|---|---:|---:|---:|---|
| Lite（默认） | 是 | 否 | 否 | 低内存、开箱即用 |
| Balanced | 是 | 是 | 否/轻量 | 常规本地知识库 |
| Quality | 是 | 是 | 是 | 更高质量、允许额外延迟和内存 |

模型名称、维度、最大批次与资源档位属于 Capability/Config，不应硬编码进业务接口。

---

## 7. Context 与 Citation

### 7.1 上下文预算

RAG 上下文与聊天历史必须共享统一 token 预算：

```text
maxContext
  ├── systemReserve
  ├── responseReserve
  ├── conversationBudget
  └── knowledgeBudget
```

Context Builder 按相关性和多样性装箱，而不是固定取 8 个完整 chunk。超长 chunk 可按句子裁剪，但必须保留 locator 映射；相邻 chunk 合并后避免重复 overlap 文本。

### 7.2 结构化引用

模型可使用 `[S1]`、`[S2]` 等稳定短编号，编号由 Context Builder 分配，不让模型自行编造文件名或页码。

```ts
interface Citation {
  id: string;              // S1
  documentId: string;
  revisionId: string;
  processingBuildId: string;
  title: string;
  sourceType: string;
  uri?: string;
  locator: CitationLocator;
  excerpt: string;
}

interface ContextPackage {
  text: string;
  citations: Citation[];
  tokenEstimate: number;
}
```

Chat API 在生成开始前通过 SSE metadata 事件发送 `providedCitations`。生成完成后解析正文中实际出现且属于允许集合的编号，保存为 `referencedCitationIds`；不能把“提供给模型的证据”误称为“模型实际引用”。最终消息持久化 citation 快照、引用编号与检索 trace id。前端只为允许集合中的编号渲染可点击来源，未知编号按普通文本显示。

引用快照保存标题、来源 URI、locator、revision/build 标识和受限 excerpt，使来源更新后历史消息仍可解释；如果原文已被用户删除，UI 标记“来源已删除”，不暗中恢复已删除的完整资料。

### 7.3 Prompt 注入边界

上下文应采用明确分隔和规则：

- 资料是数据，不是系统指令；
- 只依据提供的资料声明“资料中提到”；
- 缺少证据时明确说明；
- 引用只使用允许的 citation id；
- 不把检索得分、内部路径或敏感元数据暴露给模型。

---

## 8. Chat、Agent 与 Knowledge Engine

### 8.1 Chat 调用

```text
User Message + selected scope
  → knowledge.retrieve()
  → knowledge.buildContext()
  → LLM stream
  → persist answer + citation snapshots + retrieval trace id
```

Chat 负责选择 scope 和保存消息，不负责检索算法。

### 8.2 Agent 调用

Agent 把 Knowledge Engine 暴露为受控工具：

- `knowledge.search`：查找候选资料；
- `knowledge.open`：读取某个命中的局部上下文；
- `knowledge.citation`：解析引用位置；
- `knowledge.listSources`：在允许的 space 内列出来源。

Agent 不获得任意文件系统或数据库访问权限，也不能绕过 scope。工具结果应有限长，Agent 需要更多内容时显式翻页或打开。

### 8.3 Knowledge Workspace

知识工作台负责来源管理、同步状态、索引状态、**检索预览**和引用预览。预览调用与 Agent 相同的公开 Search API（`POST /api/knowledge/v1/search` → `engine.search`），避免出现「UI 搜索结果」和「引擎实际召回」两套行为。

工作台不是测试检索入口：不直连 data-service，不维护私有 FTS/向量逻辑，不新增 `/debug/search`。对话问答的 RAG 路径走 `retrieve` / `buildChatKnowledgeContext`，与预览共享召回、在装箱阶段分叉。

---

## 9. 存储设计与迁移

### 9.1 目标表族

```text
knowledge_spaces
space_document_bindings
sources
source_items
documents
document_revisions
processing_builds
document_blocks
chunk_sets
chunks
index_builds
vector_entries             # 默认可继续 BLOB
jobs
message_citations
retrieval_traces           # 默认仅存安全诊断，可配置关闭
```

SQLite 继续作为默认元数据和个人规模索引存储，原件仍放 `.orynode/`。表迁移必须使用显式 `schema_migrations`，不再长期依赖逐条 `ALTER TABLE` 后忽略异常。

### 9.2 从当前 Schema 的兼容映射

| 当前对象 | 目标对象 | 迁移方式 |
|---|---|---|
| `knowledge_documents` | library space 下的 Binding + Document + Revision | 保留当前 id 作为 documentId；补 library binding 与 revision |
| `conversation_files` | conversation space 下的 Binding + Document + Revision | conversationId 映射为 space ownerRef；补 binding |
| 当前解析结果 | legacy ProcessingBuild | 按现有 parser/config 建立兼容 build |
| `knowledge_chunks` | ProcessingBuild + ChunkSet + Chunk | 创建 legacy chunk strategy version |
| `conversation_file_chunks` | ProcessingBuild + ChunkSet + Chunk | 同上 |
| chunk 内 `embedding` | Vector IndexBuild + entry | 标记现有模型和维度后搬迁 |
| `status` | Revision/Job/IndexBuild 各自状态 | 迁移期提供聚合兼容字段 |
| `messages.attachments` | scope 快照 | 保留；新增 citations 与 trace id |

迁移采用 expand-and-contract：先加新表和双写，再回填、切读，最后才移除旧路径。每一步都允许回滚；用户原件永远不因索引迁移而删除。

### 9.3 数据生命周期

- Library space：显式删除前持续存在；同内容可去重，但来源关联独立保留。
- Conversation space：随会话删除；可通过显式操作复制到 Library。
- Agent space：必须声明生命周期和上限，不能默认形成无限长期记忆。
- Revision：保留最近版本和仍被消息引用的版本；清理策略可配置。
- IndexBuild：至少保留当前 active 与上一版成功构建。

### 9.4 文件与数据库一致性

SQLite 事务无法直接包含文件系统操作。Storage adapter 使用“暂存文件 + 数据库状态 + 原子 rename”的提交协议：

1. 将原件写入同一数据卷的临时路径，流式计算 hash，并执行 `fsync`/关闭；
2. 在事务中写入 `staging` revision 与最终 storage key；
3. 原子 rename 到内容寻址路径；
4. 在事务中将 revision 标记为 `ready` 并创建后续 Job；
5. 启动时 reconciliation 扫描过期 staging 记录和孤儿临时文件，安全恢复或清理。

删除先标记 tombstone，再取消关联任务并删除索引，最后清理原件；失败可重试。内容寻址文件只有在引用计数为零且无保留 revision/citation 策略时才允许删除。

### 9.5 备份、恢复与导出

- 使用 SQLite backup API 或受控 checkpoint 后的在线备份，不直接复制正在写入的 WAL 数据库；
- 备份清单包含 schema version、应用版本、文件 hash、相对 storage key、模型/索引元数据，但模型权重默认可选择不打包；
- 恢复先校验清单和 hash，再在临时数据目录执行 migration，成功后切换；
- 导出格式不包含平台绝对路径和系统凭据，可在 Mac 与未来 Windows 间迁移；
- 提供“仅用户原始资料”“资料+会话”“完整本地状态”三个备份级别；
- 删除、恢复和导入均写本地审计事件，但不记录资料正文。

---

## 10. API 边界与版本策略

对 Web/Agent 暴露版本化的应用 API，对内部 TypeScript 使用同构 DTO：

```text
POST /api/knowledge/v1/ingestions
GET  /api/knowledge/v1/jobs/:id
POST /api/knowledge/v1/search      # 正式 Search（工作台预览、兼容客户端）
POST /api/knowledge/v1/retrieve    # 正式 Retrieve（RAG / 需要 citations 时）
GET  /api/knowledge/v1/citations/:id
GET  /api/knowledge/v1/capabilities
```

兼容入口：

```text
POST /api/knowledge/search   # 薄转发至同一 Search 用例；带 Deprecation；不新增行为
```

**正式面只认 v1。** 工作台与新集成必须打 `v1/search` / `v1/retrieve`；legacy `/search` 不得演化出独立语义。

约束：

- API DTO 不泄漏 SQLite 列名和具体向量库类型；
- 写接口使用幂等键；
- 列表接口使用 cursor 分页；
- 搜索请求必须包含服务端可验证的 scope；
- 返回 `capabilities` 与 `degradedCapabilities`，不把降级伪装为完整成功；
- `highlightTerms` 属于 Search（及 Retrieve 可选透传）的一等响应字段；
- 公开类型使用版本号，内部实现类不作为长期兼容接口；
- **禁止双路径**：`app/components/knowledge` 等前端不得直连 `ORYNODE_DATA_URL` / `:4318` 做检索；不得新增平行于 Engine 的 debug 召回路由。

消费者与调用关系见 §6.0。

API 使用稳定错误码（如 `INVALID_SCOPE`、`SOURCE_UNAVAILABLE`、`INDEX_NOT_READY`、`CAPABILITY_UNAVAILABLE`），中文文案只用于展示，调用方不得解析错误字符串。长任务返回 receipt/job id 并支持取消；请求取消信号沿 application、model 和 connector ports 传播。

Chat 流采用 Orynode 自己版本化的事件包络，而不是把某个模型后端 SSE 原样暴露给前端：

```text
event: metadata   → traceId、providedCitations、capabilities
event: delta      → 生成文本
event: usage      → token/耗时（后端可用时）
event: error      → 稳定错误码和可恢复性
event: done       → referencedCitationIds、完成原因
```

不同 Model Runtime adapter 负责把各自协议归一化为内部生成事件，Windows 更换后端时前端协议不变。

---

## 11. 可观测性、隐私与安全

### 11.1 本地可观测性

每次检索生成 `traceId`，记录：

- 各阶段耗时、候选数和最终命中数；
- 启用/降级的策略；
- 模型与索引版本；
- token 预算使用；
- 错误类别，不记录不必要的完整私有正文。

默认仅保存在本机，可在设置中关闭或清理。日志不得上传。

### 11.2 安全边界

- data-service、模型服务和 Worker 继续只监听 `127.0.0.1`；
- Web Connector 阻止 localhost、内网地址和重定向绕过，防止 SSRF；
- GitHub token 等密钥使用系统凭据存储，不写入 SQLite 明文或日志；
- 文件路径由存储层生成，禁止使用用户输入拼接路径；
- Parser/OCR 设置大小、页数、时间和内存上限；
- 检索 scope 在服务端校验，不能依赖前端过滤；
- 外部内容按不可信数据处理，防止文档 Prompt Injection。

### 11.3 访问模式与局域网控制

“数据不出本机”不等于“局域网内任何人都可读”。当前 V1 的无账号可信局域网模式是已知限制，长期私有 AI 服务器必须明确两种模式：

| 模式 | 监听 | 访问要求 | 默认策略 |
|---|---|---|---|
| Local-only | loopback | 本机浏览器 | 安全默认，首次启动使用 |
| Trusted-LAN | 配置的 LAN interface | 设备配对/本地会话认证 | 用户显式开启 |

Trusted-LAN 最小安全闭环：

- 首次由服务器设备显示一次性配对码，换取可撤销的设备 session；
- session cookie 使用 `HttpOnly`、`SameSite`，写请求校验 Origin/CSRF；
- 登录、资料读取、搜索、导出和管理接口采用同一认证中间件；
- 默认不绑定所有网卡，UI 展示当前监听地址和已配对设备；
- 支持撤销单个设备、轮换服务密钥和“立即停止局域网共享”；
- TLS 在纯局域网部署中作为后续能力评估，但认证不能因暂未部署 TLS 而省略；
- 反向代理或公网暴露不属于默认支持范围，检测到危险配置时明确告警。

未来多用户能力只能在认证主体、Space owner/ACL 和审计模型完成后加入，不能把单用户的 `ownerRef` 直接当作可靠权限系统。

### 11.4 威胁模型与数据出口

至少覆盖以下威胁：恶意上传文件、网页 SSRF/DNS rebinding、压缩炸弹、Parser 漏洞、文档 Prompt Injection、未授权 LAN 客户端、Connector token 泄漏、路径穿越、符号链接、恶意仓库文件名、资源耗尽和被替换的模型文件。

所有可联网 adapter 必须声明数据出口清单：目标域、发送字段、凭据类型和触发动作。默认本地 adapter 的出口为空。模型、OCR、Embedding 或同步一旦选择远程实现，UI 必须在启用前展示会离开设备的数据类型。

下载的模型、helper 和外部二进制应固定来源与版本并校验 hash/signature；许可证和模型卡信息作为安装元数据保存在本机。

静态数据保护默认依赖操作系统磁盘加密（macOS FileVault、Windows BitLocker）和正确的本机账户权限，不自创数据库加密算法。Orynode 应在安全检查中展示磁盘加密状态；可移动备份若包含私有资料，应支持使用成熟加密格式和用户提供的恢复密钥。Connector 凭据始终进入系统凭据存储，不随普通备份导出。

---

## 12. 评测与质量门禁

完整 RAG 必须同时评测检索与回答，不能只观察“模型看起来答得不错”。

### 12.1 测试层级

| 层级 | 覆盖内容 |
|---|---|
| 单元测试 | parser、chunker、scope、RRF、去重、预算、citation locator |
| 契约测试 | Connector、Storage、Embedding、KeywordIndex、VectorIndex |
| 集成测试 | 上传 → job → 检索 → context → citation 完整链路 |
| 迁移测试 | 从已有 `.orynode` schema 升级且数据不丢失 |
| 离线评测 | Recall@K、MRR、nDCG、无答案准确率、引用正确率 |
| 性能测试 | 文档量/chunk 数、P50/P95 延迟、峰值内存、索引吞吐 |
| 故障测试 | Worker 崩溃、磁盘满、损坏文件、模型不可用、任务重放、恢复中断 |
| 平台测试 | macOS 主线；Windows CI 覆盖纯核心、路径、SQLite 与 adapter 契约 |

### 12.2 基准数据集

仓库维护一个不含隐私数据的小型中英双语 fixture，覆盖：精确术语、同义问法、跨段信息、无答案、重复内容、表格、代码、不同来源冲突。每次改变 chunk、Embedding、融合、rerank 或阈值时运行回归。

合并门禁至少包括：

- 现有单元和集成测试通过；
- 关键检索指标不低于约定基线；
- Lite 档位可在无模型下载情况下运行；
- 数据迁移可重复且有回滚验证；
- 文档与 capabilities 返回保持一致。

每个阶段在实现前记录可测的预算，而不是现在虚构固定数字：支持的 fixture 规模、检索 P95、导入峰值内存、聊天期间后台任务资源上限、冷启动时间和可接受的索引失败恢复时间。预算以目标硬件档位分别记录，并随 release 保存基线。

---

## 13. 代码目录目标

在不破坏现有导入路径的前提下，逐步形成：

```text
services/knowledge/
├── core/                    # 领域实体、错误、稳定 DTO
├── application/             # ingest/search/retrieve/buildContext 用例
├── connectors/
│   ├── file/
│   ├── web/
│   └── github/
├── processing/              # parser/normalizer/OCR/block/chunk
├── indexing/                # builds、jobs、embedding orchestration
├── retrieval/               # recall/fusion/rerank/filter/expand
├── context/                 # budget、assembly、citation
├── evaluation/
├── ports/                   # repository/index/model/job 接口
└── adapters/                # data-service、本地模型等客户端

scripts/data-service/
├── server.mjs
├── migrations/
├── repositories/
├── indexes/
└── workers/
```

迁移期间 `services/knowledge/index.ts` 继续作为唯一公开导出面，旧文件可转为新模块的兼容 facade，避免一次性修改所有调用方。

---

## 14. 第三方能力选型

### 14.1 选型原则

Orynode 应优先复用成熟库处理标准、复杂且容易出错的底层能力，但不把核心领域模型交给通用 AI 框架。

- 第三方库应能完全在本地运行，核心链路不得要求云端账号或 SaaS；
- 优先选择标准组织、平台厂商或长期维护项目；
- 通过 `ports/adapters` 隔离 Parser、Index、Model 和 Connector，避免库类型渗透到领域接口；
- 锁定精确版本并保留 fixture/契约测试，升级依赖前先跑 RAG 回归；
- 原生扩展必须提供纯本地降级路径，不能让低配 Mac 或源码安装失去基础能力；
- 能由 SQLite、Node.js 或 macOS 平台稳定提供的能力，不额外部署 Redis、PostgreSQL、Elasticsearch 等服务。

### 14.2 推荐依赖矩阵

| 能力 | 建议方案 | 决策 | 使用边界 |
|---|---|---|---|
| SQLite | 继续使用 `node:sqlite` | 保留 | 封装在 data-service repository；跟随项目固定的 Node 版本验证 |
| 关键词索引 | SQLite FTS5 | 采用 | 由 `KeywordIndex` adapter 封装；启动时检测 FTS5 capability |
| PDF 文本解析 | `pdfjs-dist` | 保留 | 当前实现继续使用；保存页码和未来 bbox locator |
| Markdown AST | `unified` + `remark-parse` | 采用 | 提取标题层级、段落、列表、代码块；不把 Markdown 先压平成纯文本 |
| 网页 DOM | `jsdom` | 采用 | 禁止执行脚本和加载子资源；只在 Connector/Processing Worker 使用 |
| 网页正文 | `@mozilla/readability` | 采用 | 适合文章正文；文档站需保留 DOM/标题结构的 fallback parser |
| HTML 清理 | `isomorphic-dompurify` 或服务端 DOMPurify | 条件采用 | 只有需要保存/展示 HTML 预览时使用；纯文本管线不必引入 |
| DOCX | `mammoth` | 采用 | 转语义 HTML 后进入统一 block normalizer；不承诺还原复杂排版 |
| OCR | macOS Vision Framework + `OcrEngine` port | 优先采用 | Mac 通过小型 Swift helper 调用；Windows 预留本地 adapter，Tesseract 可作跨平台备选 |
| GitHub API | `@octokit/rest` | 采用 | 元数据、私有仓库授权和增量 API；token 不写日志/数据库明文 |
| Git 内容 | 系统 `git` 命令 | 优先采用 | 本地 clone、commit/blob 身份和行号引用；参数化调用，不经过 shell 拼接 |
| Embedding | Transformers.js adapter | 保留并演进 | 当前 `@xenova/transformers` 先保留；未来迁移官方包必须经过模型兼容和索引重建测试 |
| Reranker | Transformers.js 可支持的本地模型 adapter | 后续采用 | Quality 档位可选；失败回退 hybrid，不阻塞基础 RAG |
| API 校验 | `zod` | 采用 | 仅用于 HTTP、Job payload、Connector 配置等不可信边界 |
| 日志 | `pino` | 可选采用 | 本地结构化日志；默认脱敏，不记录正文、token 或文件内容 |
| 测试 | `node:test` | 继续使用 | 现阶段足够稳定；无需仅为语法便利迁移测试框架 |
| Job Queue | SQLite jobs + lease | 自建小内核 | 业务语义很小且需零服务依赖；不引入 Redis/BullMQ |
| Schema Migration | 顺序 SQL migration runner | 自建小内核 | 每个迁移有版本、事务和测试；不必为简单 SQLite schema 引入 ORM |
| 向量索引 | 当前 **BLOB 扫描（blob_scan）**；`sqlite-vec` 仅 adapter 占位 | 不作默认；**仅资料量很大且评测证明扫描瓶颈时**再评估 | 个人/中小规模 JS 余弦足够；原生扩展不当开箱负担 |

### 14.3 不建议作为核心依赖

| 方案 | 原因 | 可接受用法 |
|---|---|---|
| LangChain / LlamaIndex | 抽象面大、版本变化快，容易让领域类型和调用链绑定框架 | 可做实验 adapter，不进入核心实体和公开 API |
| 云向量数据库 | 偏离默认私有本地服务器定位，并增加账号、网络和数据出口 | 仅作为用户显式开启的高级 adapter |
| Elasticsearch / OpenSearch | 对个人 Mac 部署过重 | 暂不采用；FTS5 达到瓶颈后再评估 |
| Redis / BullMQ | 为单机持久化任务增加额外守护进程和安装复杂度 | 未来多进程吞吐确有需求时再评估 |
| 通用 ORM | 难以表达 FTS5、BLOB、虚表与迁移细节，收益有限 | 领域层保持 repository port，存储层直接使用参数化 SQL |
| 云 OCR / 云 Embedding | 会产生默认数据出口 | 只能作为明确标识、明确授权的可选能力 |

### 14.4 建议安装节奏

不要一次安装全部依赖。按功能阶段加入：

1. **Phase 0/1**：`zod`、`unified`、`remark-parse`；FTS5 和 migrations 使用现有 SQLite/Node 能力。SQLite Job 到 Phase 2 再实现。
2. **Web Connector**：加入 `jsdom`、`@mozilla/readability`；需要 HTML 预览时再加 DOMPurify。
3. **DOCX Connector**：加入 `mammoth`。
4. **GitHub Connector**：加入 `@octokit/rest`，本地仓库内容优先调用系统 `git`。
5. **OCR**：实现 Apple Vision Swift helper，不给 Node 主进程增加大型 OCR 模型。
6. **质量档位**：先复用现有 Transformers.js adapter 验证 reranker；验证收益后才纳入可选安装。
7. **向量规模升级**：默认始终可用 `blob_scan`。**仅当资料量很大**、且评测确认 BLOB 扫描成为 P95/内存瓶颈时，再决定是否引入 `sqlite-vec`——不是“下一版默认换成 sqlite-vec”。

这套组合的关键不是依赖数量，而是每个库都被 adapter 隔离。即使未来替换 PDF parser、Embedding runtime 或向量索引，`DocumentRevision`、`Chunk`、`Citation`、`KnowledgeEngine` 和上层 Chat/Agent API 都不改变。

---

## 15. 分阶段升级路线

### Phase 0：基线与边界（当前版本之后的第一个里程碑）

- 为 parser、chunker、scope、retriever 建立单元测试；
- 建立最小中英检索评测集和性能基线；
- 定义 `KnowledgeEngine`、Storage/Index/Model ports；
- 将 `/api/chat` 中的检索与上下文拼装移到 application use case；
- 记录当前 schema 版本，建立正式 migrations。
- 固化现有 `.orynode` fixture、备份与恢复测试，迁移期间禁止丢失用户原件；
- 将平台中立核心与 macOS adapter 分界，CI 禁止核心目录直接依赖 shell、绝对路径和 TurboFieldfare；
- 定义 Local-only / Trusted-LAN 访问模式及统一认证中间件边界。

**完成标准**：行为基本不变，但 Chat 不再编排检索细节；迁移、隐私和跨平台边界可测试，后续修改有回归基线。

### Phase 1：检索与引用闭环

- SQLite FTS5 候选召回，避免把全部 chunks 拉到应用层；
- 候选池、RRF、阈值、去重、邻块扩展和 token budget；
- `ContextPackage` 与结构化 citations；
- SSE metadata、消息引用持久化、前端来源卡片；
- 检索 diagnostics 与本地调试视图。
- 将 Local-only 设为安全默认；若保留 Trusted-LAN，则资料与管理 API 必须经过统一访问控制。

**完成标准**：回答来源可验证，资料规模增长时查询成本不再线性传输全部正文。

### Phase 2：可靠索引与版本化

- SQLite 持久化 jobs、lease、重试和进度；
- 上传与 Embedding 解耦，关键词可用后立即返回；
- Revision、ChunkSet、IndexBuild 数据模型；
- 新旧索引双建、原子切换与回滚；
- 批量重建、取消和故障恢复。
- 加入 ResourceCoordinator，聊天期间后台重型任务可暂停和恢复。

**完成标准**：应用或机器中断后任务可恢复，更换模型不破坏已有可用索引。

### Phase 3：多来源 Connector

- 先落地 Web URL 和 GitHub repository；
- 支持同步 checkpoint、内容更新、删除检测；
- 引用支持 URL/标题路径和 repo/path/commit/line；
- 再按需求加入 DOCX、HTML 文件、OCR PDF。

**完成标准**：不同来源共享同一 Document/Revision/Chunk/Index/Retrieval 管线。

### Phase 4：质量档位与 Agent

- 可选 query rewrite、多查询召回和本地 reranker；
- Lite/Balanced/Quality 能力档位与资源检测；
- 提供 Agent `search/open/citation/listSources` 工具；
- 引入 Agent space 的生命周期、配额和策略。

**完成标准**：Chat、Agent、知识工作台复用同一检索事实和引用模型。

### Phase 5：可替换存储与生态接口

- 根据真实性能数据决定是否接入 sqlite-vec 或外部向量库；
- 稳定 Connector SDK、Index Adapter 和公开 API；
- 提供迁移、导入导出与插件扩展示例。
- 建立 Windows CI 契约测试，覆盖路径、SQLite schema、文件名和核心 Knowledge Engine；
- 在 Windows 推理后端确定后实现 `WindowsModelRuntimeAdapter` 与 Host Profile，不修改 Chat/RAG 领域接口。

**完成标准**：替换索引实现、新增来源或增加 Windows Host Profile 不需要修改 Chat/Agent 与 Knowledge Engine 核心。

---

## 16. 已决策与延后决策

架构完整不等于现在决定所有具体产品。以下延后项都有稳定 port 和触发条件，不阻塞 Phase 0/1：

| 事项 | 当前决策 | 重新评估触发条件 |
|---|---|---|
| Windows 推理后端 | 未选型，只稳定 `ModelRuntime` 契约 | 开始 Windows prototype，明确目标硬件与许可证时 |
| 向量索引 | 继续 BLOB 扫描（`blob_scan`），FTS5 优先 | **资料量很大**且评测证明向量扫描超过 P95/内存预算时，再评估 sqlite-vec |
| Reranker 模型 | 不作为默认能力 | hybrid 基线稳定且离线评测证明有显著收益时 |
| 多用户/ACL | 当前单用户服务器，不承诺多租户 | 产品明确需要不同用户隔离资料时 |
| LAN TLS | 认证与配对先落地，TLS 方案继续评估 | 支持非可信网络或正式远程访问前 |
| OCR fallback | Mac 优先 Apple Vision | Windows Host Profile 或跨平台发行进入实现时 |
| 云 adapter | 非默认、无核心依赖 | 用户明确需求且数据出口 UX/审计完成时 |

以下决策已经冻结，可直接指导落地：本地服务器是唯一事实来源；Knowledge Engine 平台中立；RAG 属于共享引擎；SQLite/文件是默认存储；Keyword 是基础能力；Revision、ProcessingBuild、ChunkSet、IndexBuild 分离；Citation 结构化；后台工作持久化；第三方实现位于 adapter 后。

---

## 17. 架构决策记录（ADR 摘要）

### ADR-001：RAG 属于 Knowledge Engine，不作为顶层应用

Chat、Agent 和搜索工作台都需要相同的知识能力。把 RAG 作为共享引擎内部流水线，可防止重复实现和结果不一致。

### ADR-002：逻辑模块化，物理部署保持本地单机

当前规模不需要微服务。先稳定 ports 和领域边界，只有索引任务或存储规模证明需要时才拆进程。

### ADR-003：原始内容、Revision、ChunkSet 与 IndexBuild 分离

解析、分块和模型会持续升级；不可变版本让引用、回滚和增量重建成为可能。

### ADR-004：关键词检索永远是基础能力

Embedding 是可选增强而非可用性的前提。Lite 档位无需下载额外模型，也能完成检索。

### ADR-005：结构化 Citation 是 API 数据，不只是 Prompt 格式

只有结构化引用才能可靠展示、持久化、跳转和评测；模型文本不是引用事实来源。

### ADR-006：后台工作必须使用持久化 Job

索引与同步时间长，不能依赖 HTTP 请求生命周期或内存 Promise。任务需要幂等、lease、重试和恢复。

### ADR-007：先以评测数据驱动，再引入更重的基础设施

是否使用 reranker、sqlite-vec 或外部向量库，应由准确率、延迟、内存和数据规模决定，而不是提前绑定技术产品。

### ADR-008：Mac 优先，但核心不绑定 macOS

当前产品继续围绕 Apple Silicon Mac 和 TurboFieldfare 打磨；Knowledge Engine、数据格式和应用 API 保持平台中立。Windows 通过未来的 Host Profile、Model Runtime、OCR、凭据和进程适配器接入，不为未知后端提前制造无效抽象，也不允许 macOS 细节进入领域核心。

### ADR-009：Revision 与 ProcessingBuild 分离

来源内容变化和解析算法变化是两种不同事件。Revision 只表示原始内容快照；Parser、OCR 和 Normalizer 的输出属于可重建、可切换的 ProcessingBuild。

### ADR-010：Space 与 Document 使用 binding 关联

同一内容可能来自多个 Connector 或同时出现在资料库与会话中。显示名、标签、可见性和生命周期属于 binding，避免去重导致跨空间误删或意外改名。

### ADR-011：本地重型能力接受统一资源协调

聊天、Embedding、Rerank 和 OCR 不能各自无限并发。ResourceCoordinator 以交互推理优先，后台任务可暂停恢复，确保本地服务器在有限内存下可用。

### ADR-012：LAN 共享是显式安全模式

Local-only 是安全默认。Trusted-LAN 必须有配对、session、统一认证和撤销能力；“数据留在服务器”不能替代客户端访问控制。

---

## 18. 落地就绪检查与下一步

### 18.1 就绪结论

进入 Phase 0 前应满足的架构检查：

- [x] 产品核心与本地/离线数据边界明确；
- [x] 当前 macOS 部署与未来 Windows Host Profile 分离；
- [x] Chat、Agent、Knowledge Engine 的职责和调用方向明确；
- [x] Source、Space、Document、Revision、ProcessingBuild、ChunkSet、IndexBuild 生命周期可表达；
- [x] 关键词、向量、重排与降级策略有稳定 ports；
- [x] Citation、上下文预算和流式事件协议有目标模型；
- [x] Job、资源协调、崩溃恢复和文件/数据库一致性有约束；
- [x] LAN 访问、Connector、凭据、Prompt Injection 与数据出口有安全边界；
- [x] Schema 迁移、备份恢复和跨平台导出有路线；
- [x] 评测、性能、故障和平台测试有质量门禁；
- [x] 未选型事项有延后理由和重新评估触发条件。

架构层面没有阻塞 Phase 0 的未决问题。具体阈值、模型、Windows runtime 和向量扩展应由实现阶段的 benchmark/ADR 决定，不应在缺少数据时写死。

### 18.2 下一步实施入口

建议从 Phase 0 开始，优先创建以下稳定边界：

1. `KnowledgeEngine.retrieve()` 与 `buildContext()`；
2. `KeywordIndex`、`VectorIndex`、`Embedder`、`JobRepository` ports；
3. `ContextPackage`、`Citation`、`RetrievalDiagnostics` 类型；
4. RAG fixture 与检索单元测试；
5. schema migration 基础设施。

这一步不改变产品功能，也不要求迁移所有数据，却能让后续 FTS5、引用、后台索引、网页和 GitHub Connector 都沿同一架构演进。

建议按可独立验证的提交顺序落地：

1. **Characterization tests**：先锁定当前上传、双 scope、keyword/hybrid、失败降级和对话行为；不改生产逻辑。
2. **Core DTO 与 ports**：加入稳定领域类型和 adapter 契约，由现有实现适配；不创建全部目标表。
3. **Retrieve use case**：把 `/api/chat` 的 scope 校验、retrieve 和 context 组装移入 application 层，保持响应行为兼容。
4. **Migration runner**：引入 `schema_migrations`、备份 fixture 和升级测试；第一批迁移只建立基础设施。
5. **KeywordIndex/FTS5 spike**：验证当前 Node/SQLite 的 FTS5 与中文 `search_text`，用离线评测对比现有关键词结果后再切读。
6. **Citation protocol**：实现 Orynode SSE envelope、provided/referenced citation 区分和消息持久化。
7. **安全与平台门禁**：核心目录平台依赖检查、Local-only 默认、Trusted-LAN 统一认证边界。

不要以“一次性创建所有目标表、移动全部目录、安装所有依赖”开始。每次只替换一个可观察行为，保留兼容 facade 和回滚路径。
