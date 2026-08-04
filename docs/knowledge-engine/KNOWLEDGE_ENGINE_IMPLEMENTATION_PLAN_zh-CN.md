# Orynode AI Knowledge Engine 架构符合性审计与整改实施计划

> 文档状态：开发执行基线（Implementation Baseline）  
> 审计日期：2026-08-03  
> 适用代码：当前工作区的 Knowledge Engine、Chat、Agent、Connector、Data Service 与 Platform 改造  
> 上位设计：[AI Knowledge Engine 长期架构](KNOWLEDGE_ENGINE_ARCHITECTURE_zh-CN.md)  
> 当前实现说明：[Orynode Local AI 架构文档](../ARCHITECTURE_zh-CN.md)

本文把长期架构转换成可以直接开发、评审和验收的整改任务。当前代码已经建立了大部分正确的模块边界，但若以长期架构的语义而不是文件名和接口数量衡量，仍有若干关键闭环没有完成。

本文中的“必须”表示合并到相应阶段前不可缺少；“建议”表示可以在不破坏兼容性的前提下延后。若实现与本文冲突，以长期架构中的产品核心、ADR 和安全边界为最终依据。

---

## 1. 审计结论

### 1.1 总结

当前实现可以定义为：**长期架构方向正确，Phase 0 基本完成，Phase 1～3 部分完成，Phase 4～5 已有接口骨架，但尚未达到完整架构闭环。**

可以继续在现有代码上渐进调整，不需要推倒重写。当前最重要的工作不是继续增加 Connector 或模型，而是先完成以下四个事实边界：

1. 所有 Search、Open、Citation、ListSources 都执行同一套服务端 Scope 授权；
2. Source 更新或删除后，旧内容不能继续出现在活动检索结果中；
3. 新旧索引必须真实共存，激活切换必须原子化并可回滚；
4. Job、资源协调、备份和安全防护必须在中断、并发和恶意输入下成立。

在这四项完成前，项目可以作为架构开发版本继续演进，但不应宣称“完整 RAG 架构已经落地”。

> **执行进度（2026-08-03 续 · OCR Mac 落地）**  
> - **P0～P3 首批**已落地（Scope / packing / SSE / ProcessingBuild / sync Job / ModelRuntime / pairing / v1 API）。  
> - **扫尾**：Settings LAN 配对 UI；`garbage_collect` Job；文档/CI 对齐。  
> - **审查加固**：全量敏感 API `lanDeniedResponse`；配对管理迁至 loopback `/lan-auth/pairing`（禁用 Host 豁免）；`processingBuildId` 禁 IndexBuild 冒充；Agent space 权威源收敛；删除 `services/inference` 死代码。  
> - **OCR（KE-026～033）**：Mac 闭环已落地。**KE-034 Windows**：契约 + artifact 元数据 + `OCR_UNAVAILABLE` stub 已预留，不实现推理。  
> - 仍缺：CredentialStore、完整 lint/build CI 矩阵、§14 全勾（与 OCR 无关）。

### 1.2 已经正确落地的能力

| 能力 | 当前状态 | 代码入口 | 结论 |
|---|---|---|---|
| Knowledge Engine 应用边界 | 已落地 | `services/knowledge/ports/knowledge-engine.ts`、`application/engine.ts` | Chat 已通过 Engine 调用检索与上下文，不再自己实现检索算法 |
| Keyword 基础能力 | 已落地 | `scripts/data-service/fts-index.mjs`、`adapters/keyword-fts5.ts` | FTS5 是默认能力，并保留降级路径 |
| 中文轻量检索 | 已落地 | `retrieval/search-text.ts`、data-service search text | bigram/search_text 路线符合本地轻量目标 |
| 结构化 Citation | 基本落地 | `context/*`、Chat SSE、消息引用迁移、前端来源展示 | 已区分 provided/referenced，但定位精度与预算一致性仍需完善 |
| 持久化 Job | 基本落地 | migration 004、`jobs.mjs`、`worker.mjs` | embed / sync_source / garbage_collect |
| 向量索引 | Index adapter 边界已落地 | `adapters/index-*`、`ports/indexes.ts` | **生产固定 blob_scan**；sqlite-vec 仅占位。大量数据且评测证明瓶颈后再评估 |
| Web/GitHub Connector | 基本可用 | `connectors/*`、`application/sync-source.ts` | Job 化同步 + generation 删除检测；截断树不误删 |
| Host Runtime 抽象 | 已落地 | `services/platform/*` | Chat/Status 经 ModelRuntime；Windows 诚实 stub |
| Local-only 默认 | 已落地 | `services/platform/access.ts`、`lan-auth.ts` | Trusted-LAN 配对/session；UNSAFE 为预览 |
| 导入导出 | 基本落地 | `export-package.mjs`、import 模块 | WAL-safe VACUUM + Manifest v2 hash 校验 |
| OCR | Mac 闭环 + Windows 预留 | `ocr/*`、`apple-vision-ocr.ts`、`windows/ocr-reserved.ts`、artifact JSON | KE-034 实现未开始；已标记 reserved |

### 1.3 阶段完成度

| 阶段 | 判定 | 主要缺口 |
|---|---|---|
| Phase 0：基线与边界 | 基本完成 | lint/全量回归门禁仍可加强 |
| Phase 1：检索与引用 | 基本完成（首批） | 评测 CI 阈值仍可加强 |
| Phase 2：可靠索引 | 基本完成（首批） | 其余 Job 类型、GitHub 分目录完整枚举 |
| Phase 3：多来源 | 基本完成（首批） | CredentialStore、更细 Source Revision；OCR Mac 已闭环，Windows OCR 仍缺 |
| Phase 4：Agent/质量档位 | 部分完成 | Agent 规划器未落地；质量策略需评测驱动 |
| Phase 5：跨平台/生态 | 部分完成（首批） | Windows 真实后端、发行制品完整 CI |

---

## 2. 必须保持不变的产品与架构约束

所有整改都必须继续服务于一个核心：**Orynode 把用户自己的 Mac 变成本地私有 AI 服务器，并为未来 Windows 本地主机预留适配边界。**

开发中不得出现以下偏移：

- 不得为了 RAG 默认引入云 Embedding、云向量库、云数据库或云推理依赖；
- 不得让浏览器或局域网客户端成为知识数据事实来源；
- 不得让 Data Service、模型 Runtime 或内部管理端口监听非回环地址；
- 不得在 `services/knowledge/core`、`application` 中直接依赖 TurboFieldfare、Apple Vision、shell 或 macOS 绝对路径；
- 不得以“当前单用户”为理由跳过 conversation/agent scope 校验；
- 不得把模型输出中的引用文本当成引用事实，引用事实必须来自检索结果快照；
- 不得把 Revision、ProcessingBuild、ChunkSet、IndexBuild 合并回单一 `status` 或单一 embedding 字段；
- Windows 支持应通过 Host/Model/OCR/Credential/Process adapter 接入，而不是在 Knowledge Engine 内增加 OS 分支。

---

## 3. 目标运行链路

完成本计划后，主链路应固定为：

```text
Browser / LAN Client
        │
        ▼
Orynode Web/API Gateway
        │  统一 AccessContext + ScopePolicy
        ├─────────────── Chat ───────────────┐
        ├────────────── Agent ───────────────┤
        └────── Knowledge Workspace ─────────┤
                                             ▼
                                  KnowledgeApplicationService
                                  search/retrieve/open/citation
                                             │
                      ┌──────────────────────┼──────────────────────┐
                      ▼                      ▼                      ▼
               Storage Ports         Index Registry          Job Repository
                      │              FTS5 / Vector                  │
                      ▼                      │                       ▼
             SQLite + local files           └────────────── Index/Sync Worker

Chat → ModelRuntime port → macOS TurboFieldfare adapter
                         → future Windows runtime adapter
```

任何上层入口都不能直接读取 chunk 表、Source 表或文件路径。Data Service 可以执行底层查询，但必须接收已经标准化且可验证的 Scope，或只暴露给 Knowledge application 的内部端点。

---

## 4. P0：发布前必须修复的正确性与安全问题

P0 按依赖顺序执行。建议每一项单独提交，先补失败测试，再改实现。

### KE-P0-01：统一 ScopePolicy，封闭 Agent 与 Chunk API 越权路径

**当前问题**

- `knowledgeSearch()` 使用 `ctx.scope`，但 `knowledgeOpen()` 忽略 `_ctx`，直接按 chunk id 读取；
- `knowledgeCitation()` 没有 Scope 参数；
- `knowledgeListSources()` 返回整个资料库与全部 Source；
- Chunk/Citation HTTP API 若只按 id 查询，也存在同类绕过；
- Agent 先得到或猜到一个 chunk id 后，可以脱离原检索范围读取内容。

**目标设计**

新增统一的服务端访问上下文和策略接口，所有知识读操作必须使用：

```ts
type KnowledgeAccessContext = {
  actor: { kind: "local-user" | "lan-session" | "agent"; id: string };
  conversationId?: string;
  agentSpaceId?: string;
};

interface ScopePolicy {
  resolve(requested: RetrievalScope, access: KnowledgeAccessContext): Promise<ResolvedScope>;
  canReadDocument(documentId: string, scope: ResolvedScope): Promise<boolean>;
  canReadChunk(chunkId: string, scope: ResolvedScope): Promise<boolean>;
  listVisibleSources(scope: ResolvedScope, cursor?: string): Promise<SourcePage>;
}
```

`KnowledgeEngine` 的公开方法应调整为：

- `search(request, access)`；
- `retrieve(request, access)`；
- `openChunk({ chunkId, scope }, access)`；
- `resolveCitation({ chunkId, scope }, access)`；
- `listSources({ scope, cursor, limit }, access)`。

Chunk id 只作为定位符，不能作为授权凭据。conversation chunk 必须同时验证 `conversationId` 与 file ownership；agent space 必须验证 owner、TTL、配额和 binding；library all 也必须是服务端允许的显式 scope。

**实施位置**

- 新增 `services/knowledge/application/scope-policy.ts`；
- 扩展 `ports/knowledge-engine.ts` 与 `application/engine.ts`；
- 改造 `application/open-chunk.ts`，禁止导出无 Scope 的公共读函数；
- 改造 `services/agent/knowledge-tools.ts`；
- 改造 `app/api/knowledge/chunks/*`、`citations/*`、`search/*` 和 v1 routes；
- Data Service 的按 id 端点保留为 loopback 内部端点时，也应要求 namespace/owner 组合条件，避免误用。

**验收标准**

- Agent 在 scope A 搜到的 chunk 可以打开；scope B 或无 scope 打开同一 chunk 返回稳定错误 `CHUNK_NOT_IN_SCOPE`；
- conversation A 的 chunk 不能由 conversation B 打开或解析 citation；
- `listSources` 只返回当前 space/binding 可见来源，且使用 cursor 分页；
- API 错误不泄露 chunk 是否真实存在；不存在与无权访问对外均可返回 404；
- 单元、API contract 和数据层测试覆盖 library/conversation/agent 三种 scope。

### KE-P0-02：引入活动 Binding/Revision，防止旧 Connector 内容继续被检索

**当前问题**

`syncSource()` 在条目更新时把新内容作为新 library document 入库，再把 `source_items.document_id` 指向新文档。旧 document/chunks/FTS 行仍在 library all 查询中。删除检测只把 SourceItem 标记为 tombstone，FTS 查询没有基于活动 SourceItem 或 Binding 过滤，因此更新前和已删除的网页/GitHub 内容仍可能进入 RAG。

**目标设计**

必须补齐长期模型中的 `knowledge_spaces`、`space_document_bindings`、`documents`、`document_revisions` 和 `processing_builds`。

SourceItem 代表外部条目的稳定身份：

- 内容未变：保留 active revision；
- 内容变化：同一 Document 创建新 Revision，处理完成后原子更新 active revision；
- 外部删除：SourceItem tombstone，并停用对应 Binding；
- 历史 Revision 可以保留用于旧 Citation，但默认 Search 只读取活动 Binding + active Revision；
- 同内容去重不能合并 SourceItem/Binding 的显示名、生命周期和删除语义。

**建议最小 Schema**

```sql
CREATE TABLE knowledge_spaces (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  owner_ref TEXT,
  lifecycle TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  canonical_content_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE space_document_bindings (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  source_item_id TEXT,
  display_name TEXT NOT NULL,
  active_revision_id TEXT,
  status TEXT NOT NULL,
  tombstone INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

具体外键可在 expand 阶段延后创建，但唯一约束和查询索引必须同步设计。FTS/Vector 查询不再以 `knowledge_documents.status` 作为活动可见的唯一依据，候选集合必须先由 ResolvedScope 得到 binding/revision 集合，再查询对应 active ChunkSet/IndexBuild。

**验收标准**

- Web 页面从内容 v1 更新到 v2 后，默认搜索只能命中 v2；
- tombstone 后，默认搜索不再命中该 SourceItem；
- 已保存消息中的 v1 Citation 仍能按保留策略打开只读快照；
- 同一 Document 同时绑定 library 与 conversation 时，删除 conversation binding 不影响 library；
- 同一内容来自两个 Source 时，删除一个 Source 不影响另一个活动 binding。

### KE-P0-03：实现真实版本化向量条目与原子 IndexBuild 切换

**当前问题**

当前 migration 已有 `index_builds` 元数据，但向量仍覆盖写入 legacy chunk 的单一 `embedding` 字段。`writeVectors()` 先清空并覆盖现有向量，Worker 随后再单独激活 build。若写入成功、激活失败，旧 active build 的元数据会指向已经被替换的向量；新旧 build 无法真正共存，也无法回滚。

**目标 Schema**

```sql
CREATE TABLE vector_entries (
  index_build_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  embedding BLOB NOT NULL,
  PRIMARY KEY (index_build_id, chunk_id),
  FOREIGN KEY (index_build_id) REFERENCES index_builds(id) ON DELETE CASCADE
);

CREATE INDEX idx_vector_entries_chunk ON vector_entries(chunk_id);
```

关键词索引也应能够通过 `index_build_id` 或 active ChunkSet 明确版本。若 FTS5 暂时无法低成本保存双版本，可以创建 build-specific content table，或用 `chunk_set_id` 作为 FTS unindexed column 并在查询中限制 active build。

**构建协议**

1. 创建 queued IndexBuild，旧 active 不变；
2. 将新向量批量写入 `vector_entries(index_build_id, chunk_id)`；
3. 校验条目数、维度、非有限值、抽样可检索性；
4. 在一个 SQLite 事务内把旧 build 设为 superseded、新 build 设为 ready + active；
5. 查询永远先解析 active build id，再读取对应 entries；
6. 新 build 失败只删除或保留失败 entries，不修改旧 active；
7. 清理策略至少保留当前 active 与上一成功 build。

**兼容迁移**

- 创建 legacy Vector IndexBuild；
- 把现有 chunk.embedding 回填到 legacy build；
- 切换 VectorIndex adapter 读取 `vector_entries`；
- 确认回填和读取稳定后，停止写 legacy embedding；
- legacy 字段最后才 contract，且不在当前阶段删除。

**验收标准**

- build B 构建期间搜索仍使用 build A；
- B 激活后新请求只使用 B；
- 在向量写入、校验、激活三个故障点注入异常，A 始终可用；
- 可以显式回滚到上一成功 build；
- 进程中断重启后，running/queued build 和 Job 状态可恢复，不产生“元数据 active 但 entries 不完整”。

### KE-P0-04：修复 ResourceCoordinator 与 Worker 并发模型

**当前问题**

- 固定 `WORKER_ID` 可以重复获取同一 heavy lock；
- `setInterval(() => void tick())` 没有运行中保护，tick 可能重叠；
- 一个 Chat 的 `markChatIdle()` 会清除其他并发 Chat 的活跃状态；
- lock 没有 lease token/过期语义，错误 release 可能释放不属于本任务的资源。

**目标设计**

- 每个 Job attempt 使用唯一 lease id，如 `${workerId}:${jobId}:${attempt}`；
- 同一 owner 也不能重入，除非显式实现引用计数且有测试；
- Worker 使用串行调度：当前 tick 完成后再 `setTimeout(nextTick)`，或增加 `running` guard；
- Chat 使用 request token 集合/引用计数，而不是单个 `chatActiveUntil`；
- `release(leaseId)` 只释放匹配 lease；
- 重型任务获取顺序为 Chat > 显式交互 Rerank > OCR/Embedding；
- 进程内协调器是当前默认实现，未来若 Worker 拆进程，则迁移为 SQLite lease/IPC，不改变调用接口。

**验收标准**

- 100 个快速 tick 下同一时刻最多一个 embedding job 进入执行区；
- 两个并发 Chat 中一个结束，另一个仍能阻止后台重型任务；
- 错误 leaseId 无法释放锁；
- Worker stop 后不再领取新任务，正在执行任务按约定完成或归还 lease；
- fake clock 测试覆盖 TTL、heartbeat、异常退出和 lease 过期。

### KE-P0-05：完成 Connector 网络与凭据安全

#### Web SSRF 与 DNS rebinding

当前逻辑先 DNS lookup 校验，再把原 hostname 交给普通 fetch；连接时会再次解析，攻击者可在两次解析间切换到私网地址。

必须实现：

- 请求实际连接到已校验 IP，TLS SNI/Host 保持原 hostname；或使用支持受控 lookup 的 dispatcher；
- 每次 redirect 都重新执行 scheme、hostname、端口、解析地址校验；
- 限制 redirect 次数、响应体大小、连接/首字节/总时长；
- 拒绝非 80/443 默认端口，或维护明确 allow policy；
- 完整覆盖 IPv4、IPv6、IPv4-mapped IPv6、整数/混合表示法；
- 错误与日志不返回内部地址细节。

#### GitHub token

当前 token 被拼到 clone URL 参数中，可能进入进程列表、错误字符串和临时仓库配置。

必须改为：

- 优先使用 Octokit Contents/Blob API 获取文件；
- 必须使用 git 时，通过临时 `GIT_ASKPASS`、credential helper 或安全 header 注入，禁止出现在 argv/URL；
- 临时凭据文件权限为仅当前用户可读，finally 清理；
- 日志和异常统一 redaction；
- Source config 不明文持久化 token，使用 `CredentialStore` 保存引用 key。

**验收标准**

- DNS rebinding、redirect 到 localhost/私网、IPv6 link-local、超大响应均被拒绝；
- GitHub 私库同步期间，进程 argv、错误日志、SQLite config、export manifest、临时 `.git/config` 均不出现 token；
- Connector 断网或凭据失效只影响对应 Job，不影响本地既有可用索引。

### KE-P0-06：可靠 SQLite 快照、Manifest hash 与恢复协议

**当前问题**

导出在 `VACUUM INTO` 失败后直接复制主数据库文件。WAL 模式下直接复制可能遗漏尚未 checkpoint 的提交。Manifest 也没有数据库/文件 hash，导入无法验证完整性；当前 apply 更接近 staging 而不是真正恢复。

**目标设计**

- 只允许 SQLite backup API、`VACUUM INTO` 成功结果，或在受控写暂停 + checkpoint 后复制；禁止静默降级为不安全 raw copy；
- 导出到临时目录，所有文件完成并计算 SHA-256 后，原子 rename 为最终包；
- Manifest 包含 format/schema/app version、备份级别、相对路径、size、sha256、必要 index/model 元数据；
- 路径必须是相对路径，导入时防止 zip slip/path traversal；
- 恢复先验证 manifest 和全部 hash，在临时 data root 执行 migrations 与一致性检查，再原子切换；
- 失败不修改当前 `.orynode`；成功后保留可配置的上一状态回滚点；
- 实现三档：仅用户原始资料、资料+会话、完整本地状态；凭据和模型权重默认不导出。

**验收标准**

- 导出期间持续写入消息，恢复后数据库通过 `PRAGMA integrity_check` 且不存在半事务；
- 任一文件被篡改、缺失或 size 不匹配时导入在切换前失败；
- Mac 导出的路径不含绝对路径和反斜杠假设，可被 Windows fixture 解析；
- apply 失败后原数据目录不变。

---

## 5. P1：完成 RAG 质量与协议闭环

### KE-P1-01：以 token 为单位构建 ContextPackage

当前做法先拼完整 Prompt，再按字符截断，可能截断 `[S#]` 标记、正文边界和指令区；返回 citations 仍包含已被截掉的来源。Chat 调用也没有为知识上下文传入独立预算。

**目标算法**

1. 从模型 max context 中扣除 system 固定开销、历史消息预算、用户问题、输出保留和安全余量；
2. 得到独立 `knowledgeBudgetTokens`；
3. 对 hits 进行 document/source 多样性约束；
4. 可选加入相邻 chunk，但必须来自同 Revision/ChunkSet；
5. 逐个完整打包 Citation + chunk，只有完整项可以进入；
6. 单 chunk 过长时在正文内部安全截断，并保留 locator 与明确省略标志；
7. 最终 citations 只包含真正进入 text 的项；
8. tokenEstimate 使用 ModelRuntime 提供 tokenizer，缺失时使用保守估算并在 capabilities 标记 approximate。

建议新增：

```ts
type ContextBudget = {
  modelContextTokens: number;
  outputReserveTokens: number;
  historyBudgetTokens: number;
  knowledgeBudgetTokens: number;
  safetyMarginTokens: number;
};
```

**验收标准**

- 任意预算下 Prompt 指令头、Citation 边界与 `[S#]` 不被截断；
- `citations.length` 与 Prompt 中来源集合一致；
- 知识上下文、历史、输出 reserve 总和不超过模型窗口；
- 中英文、长单段、多 PDF 页、多个相邻 chunk 有 fixture 测试。

### KE-P1-02：统一 Orynode SSE v1 包络

当前 metadata/done 使用自定义对象，但 delta 仍透传 OpenAI SSE bytes，前端依赖 `choices[0].delta.content`。这会让未来 Windows ModelRuntime 或非 OpenAI 后端影响前端协议。

目标协议：

```text
event: metadata
data: {"version":1,"traceId":"...","providedCitations":[],"capabilities":{}}

event: delta
data: {"version":1,"text":"..."}

event: usage
data: {"version":1,"inputTokens":0,"outputTokens":0,"durationMs":0}

event: error
data: {"version":1,"code":"MODEL_UNAVAILABLE","recoverable":true}

event: done
data: {"version":1,"referencedCitationIds":[],"finishReason":"stop"}
```

Model adapter 负责把后端流转换成内部 `ModelStreamEvent`；Chat route 只把内部事件编码为 Orynode SSE。前端只解析 Orynode v1，不解析 OpenAI choices。

**验收标准**

- 用 fake OpenAI backend 和 fake Windows backend 运行同一前端 contract 测试；
- upstream 断流、超时、取消均产生稳定 error/done 语义；
- metadata 永远先于 delta；done 最多一次；
- referenced citation 只允许来自 provided 集合。

### KE-P1-03：提升 Citation 精确定位

- PDF：page + 可选 block/character range；
- Markdown：heading path + line range；
- Web：canonical URL + heading/text fragment；
- GitHub：repo + commit SHA + path + 精确 chunk line range；
- Citation snapshot 保存 title/locator/excerpt/revision id，Source 后续改名不改变历史消息展示；
- 不向模型暴露服务器绝对路径、token、内部 storage key。

验收时必须验证点击引用能打开对应 Revision 的局部原文，而不只是打开整个文档。

### KE-P1-04：补齐 Retrieval Pipeline 与评测门禁

按以下稳定顺序实现并分别记录 diagnostics：

```text
normalize → scope resolve → keyword/vector candidate recall
→ rank normalization → RRF/fusion → dedupe
→ diversity → optional neighbor expansion → threshold → context packing
```

建立最小中英 fixture，记录 Recall@K、MRR/nDCG、无答案拒答率、P50/P95 延迟、峰值 RSS、索引耗时。任何 tokenizer、embedding、RRF 权重、threshold、chunk 策略修改都必须跑基准并写结果，不凭主观判断升级默认值。

---

## 6. P2：完成领域模型、Job 与 Connector 生命周期

### KE-P2-01：补齐 ProcessingBuild

`Revision` 只表示原始内容变化；Parser/OCR/Normalizer 改变属于 ProcessingBuild。当前把 keyword build id 或 legacy 常量当 processing build，语义不成立。

建议字段：

```text
processing_builds
  id, revision_id
  parser_name, parser_version
  ocr_engine, ocr_version
  normalizer_version, config_hash
  status, is_active, error
  created_at, activated_at
```

`document_blocks` 和 `chunk_sets` 必须关联 processing_build。解析重建时不创建伪 Revision；新 ProcessingBuild 完成后再切 active。Citation 固定 revision + processing build，避免解析升级后历史定位漂移。

### KE-P2-02：所有长任务进入持久化 Job

当前 Job 主要处理 `embed_document`，Source 同步仍发生在 HTTP 请求生命周期。目标 Job 类型至少包括：

- `ingest_revision`；
- `parse_revision`；
- `build_chunk_set`；
- `build_keyword_index`；
- `build_vector_index`；
- `sync_source`；
- `reconcile_storage`；
- `garbage_collect`；
- `restore_package`。

每类 Job 必须定义 idempotency key、payload version、lease、heartbeat、retry policy、cancel safe point、progress schema 和失败清理。HTTP 写接口返回 receipt/job id，不等待完整同步。

### KE-P2-03：可靠 Connector checkpoint 与删除检测

- `list()` 必须支持分页 checkpoint，而不是每次全量内存枚举；
- checkpoint 只在本页数据与后续 Job 安全持久化后推进；
- GitHub recursive tree 返回 `truncated` 时不得把未看到的旧条目 tombstone；必须分页、分目录遍历或切换 clone manifest；
- 删除检测使用“完成一次完整可证明枚举”的 generation 标记；同步中断不能误删；
- commit SHA 固定到 Source sync run，list/fetch/citation 使用同一 commit；
- Web 条目保存 ETag/Last-Modified，支持条件请求，但内容 hash 仍是最终判断。

### KE-P2-04：文件与数据库一致性协议

补齐暂存文件、staging Revision、同卷原子 rename 和启动 reconciliation。需要覆盖：写文件后数据库失败、数据库 staging 后进程退出、rename 后 ready 前退出、删除中断、孤儿临时文件。任何异常都不得删除仍被 binding/revision/citation 引用的内容寻址文件。

---

## 7. P3：平台、访问控制与可扩展性

### KE-P3-01：让 Chat 真正依赖 ModelRuntime

当前 Chat route 仍直接导入 TurboFieldfare `inferenceService`。应新增 platform composition root：

```ts
type RuntimeServices = {
  host: HostRuntime;
  model: ModelRuntime;
  ocr: OcrEngine | null;
};

export function createRuntimeServices(): RuntimeServices;
```

Chat 只调用 `runtime.model.chat()`；status/model list 也使用同一实例。macOS adapter 封装 TurboFieldfare 的 OpenAI 兼容协议，Windows stub 返回诚实的 `CAPABILITY_UNAVAILABLE`。核心 contract 测试不得依赖 macOS shell。

### KE-P3-02：Trusted-LAN 配对、Session 与撤销

Local-only 继续为默认。Trusted-LAN 正式可用前至少实现：

- 首次在服务器屏幕显示一次性 pairing code；
- 客户端换取有过期时间的 session；
- HttpOnly/SameSite cookie 或等价 token；
- CSRF/Origin 检查；
- 服务器端查看并撤销已配对设备；
- 知识、会话、设置、导入、Source、Job 管理统一走认证中间件；
- 内部 loopback Data Service 不通过 LAN 暴露。

`ORYNODE_TRUSTED_LAN_UNSAFE=1` 只能作为开发预览开关，README 必须明确标识；正式发布不得把它描述为安全共享模式。

### KE-P3-03：Agent space 持久化

当前 Agent space 使用进程内 Map，重启丢失，无法成为可靠生命周期/配额机制。应迁移到 knowledge_spaces/bindings，保存 owner、TTL、quota、状态；过期通过 GC Job tombstone binding，且仍遵循 Revision/Citation 保留策略。

### KE-P3-04：稳定 v1 API

补齐长期架构定义的：

```text
POST /api/knowledge/v1/ingestions
GET  /api/knowledge/v1/jobs/:id
POST /api/knowledge/v1/search
POST /api/knowledge/v1/retrieve
GET  /api/knowledge/v1/citations/:id
GET  /api/knowledge/v1/capabilities
```

所有 DTO 使用 Zod 或等价 schema 校验，带版本、幂等键、cursor、稳定错误码、AbortSignal。旧 route 作为兼容 facade 调用 v1 application use case，不复制业务逻辑，并设置明确弃用周期。

### KE-P3-05：运行时依赖与打包检查

Data Service 运行时动态加载 TypeScript 时依赖 `tsx/esm/api`，但 `tsx` 当前位于 devDependencies。开发需二选一：

- 构建时把 data-service/application 编译为可直接运行的 JS；这是推荐方案；
- 或把 `tsx` 作为明确 runtime dependency，并接受启动成本与分发体积。

增加 `npm ci --omit=dev` 或真实发行包 smoke test，确保源码安装版、未来 DMG 和 Windows 包不会只在开发环境可运行。

---

## 8. 数据迁移实施顺序

禁止一次性替换全部 legacy 表。采用 expand → backfill → dual write → shadow read → cutover → contract：

### Migration 006：Space、Document、Binding、ProcessingBuild、VectorEntry

- 只新增表、索引和 schema version；
- 不修改当前读写；
- migration 必须可重复执行且有空库/legacy fixture 测试。

### Backfill 任务

1. 创建固定 library space；
2. 每个 conversation 创建 conversation space；
3. `knowledge_documents` 映射 Document + library Binding；
4. `conversation_files` 映射 Document + conversation Binding；
5. 用真实 content hash 创建/补齐 Revision，禁止使用 `conversation:${fileId}` 伪 hash；
6. 为现有解析配置建立 legacy ProcessingBuild；
7. 为现有 chunks 建立 legacy ChunkSet 映射；
8. 为现有 embedding 建立 legacy IndexBuild + vector_entries；
9. 记录 backfill watermark，支持中断续跑。

### Dual write

- 新上传/同步同时写 legacy facade 与新模型；
- dual write 必须在同一事务或使用 outbox/reconciliation；
- 记录 mismatch metric，但不记录正文；
- 失败时以不破坏 legacy 可用链路为先。

### Shadow read

- 同一请求分别执行 legacy/new scope 和候选解析；
- 仅本地记录 document/chunk id 差异与耗时，不改变用户结果；
- 达到既定样本量且没有越权/活动版本差异后再切读。

### Cutover

- 先切 Open/Citation 的授权路径；
- 再切 Keyword；
- 再切 Vector；
- 最后切 UI 列表和 Source 管理；
- 每步有 feature flag 与回滚说明。

### Contract

至少跨一个稳定版本后才考虑删除 legacy embedding/status/表。删除前必须有备份恢复测试和真实升级 fixture。用户原件不因 contract 自动删除。

---

## 9. 推荐代码边界

```text
services/
  knowledge/
    core/                 # 纯领域类型、错误、状态机；无 fetch/fs/process/OS
    application/          # use cases、ScopePolicy、事务编排
    ports/                # storage/index/model/job/connector/clock/tokenizer
    adapters/
      storage-sqlite/
      index-fts5/
      index-vector-blob/
      connectors/
    context/              # token packing、citation package
    retrieval/            # 召回、融合、多样性、阈值
  platform/
    composition-root.ts   # 依赖装配唯一入口
    macos/
    windows/
  agent/                  # 受控工具 facade，不访问 storage adapter
  chat/                   # Chat use case 与 Orynode stream events

scripts/data-service/
  migrations/
  repositories/           # SQLite repositories
  workers/                # 持久化 Job handlers
```

约束检查建议加入 ESLint/import rule：

- `knowledge/core` 不导入 Node built-in、Next、platform、inference；
- `knowledge/application` 不导入具体 SQLite、TurboFieldfare；
- `agent` 不导入 data-service URL 或 `fetchChunkById`；
- API route 不导入具体 index/repository；
- 只有 platform composition root 创建具体 ModelRuntime/HostRuntime。

现阶段不要求为了目录美观大规模移动文件；先用依赖方向测试锁住边界，再逐步整理。

---

## 10. 测试与质量门禁

### 10.1 当前基线

本次审计时的验证结果：

- `npm run test:unit`：75 项通过，0 失败；
- `npm run build`：通过；
- `tsc --noEmit`：通过；
- `npm run lint`：未通过，存在 5 个 error 与 19 个 warning；
- `node --test tests/rendered-html.test.mjs`：1/2 失败，品牌文字断言与新增 `examples/` 目录约束已和当前项目不一致。

因此当前完整 `npm test` 不能作为绿色发布基线。开发首先应判断 UI effect lint 是调整实现还是精确豁免，并更新 rendered HTML 回归测试的真实产品契约。不能简单删除测试来获得绿色。

### 10.2 必须新增的测试层级

| 层级 | 必测内容 |
|---|---|
| Domain unit | 状态机、ScopePolicy、budget packing、Citation locator、Job retry |
| Repository integration | migrations、事务、active build、binding tombstone、WAL snapshot |
| API contract | v1 DTO、错误码、cursor、idempotency、取消、SSE 顺序 |
| Security | Agent 越权、conversation 越权、SSRF、redirect、token redaction、path traversal |
| Failure injection | 写向量中断、激活失败、同步中断、恢复失败、磁盘满、进程重启 |
| Retrieval evaluation | 中英 Recall@K/MRR、拒答、延迟、内存、索引时间 |
| Platform contract | macOS adapter、Windows stub、路径/文件名/SQLite/导出包跨平台 |
| Packaging smoke | `npm ci --omit=dev` 或发行制品启动、空库初始化、升级旧 fixture |

### 10.3 合并门禁

每个整改 PR 至少满足：

```bash
npm run lint
npm run test:unit
npm run test:contracts
npm run build
node --test tests/rendered-html.test.mjs
```

涉及 Schema/Job/备份的 PR 还必须运行 migration fixture、failure injection 与 `PRAGMA integrity_check`。涉及 Retrieval 的 PR 必须附评测前后数据。涉及平台 adapter 的 PR 必须运行无 TurboFieldfare 的 fake runtime contract。

---

## 11. 推荐开发批次与提交拆分

### Batch A：安全与事实边界

1. `test: add scope authorization matrix`；
2. `feat: enforce scope for open citation and source listing`；
3. `test: prove tombstoned and superseded source items are hidden`；
4. `feat: add space bindings and active revision filtering`；
5. `fix: harden web fetch and github credentials`。

**完成定义**：不存在已知越权读取，Connector 旧内容不进入活动检索，token/SSRF 测试通过。

### Batch B：可靠索引与资源

1. Migration 006 新表；
2. legacy vector backfill；
3. VectorIndex adapter 切 `vector_entries`；
4. atomic active build；
5. Worker 串行与唯一 lease；
6. concurrent Chat resource tokens。

**完成定义**：索引可双建、切换、回滚；中断不破坏旧索引；本地交互优先成立。

### Batch C：Context、Citation 与 SSE

1. 独立知识 token budget；
2. 完整项 packing、多样性、邻块；
3. 精确 locator；
4. ModelStreamEvent；
5. Orynode SSE v1；
6. 前端切换与旧协议短期兼容。

**完成定义**：上下文与引用一致，前端不依赖具体模型后端协议。

### Batch D：持久化摄取与恢复

1. `sync_source`/parse/index Job handlers；
2. checkpoint/generation 删除检测；
3. staging file + reconciliation；
4. 安全 SQLite snapshot；
5. hash manifest；
6. staged restore + atomic switch。

**完成定义**：长任务中断可恢复；同步不会误删；备份可验证、可恢复、不损坏当前数据。

### Batch E：平台与发布契约

1. composition root；
2. TurboFieldfareModelRuntime adapter；
3. Chat/Status 使用 ModelRuntime；
4. Windows stub contract；
5. runtime dependency 打包修复；
6. Trusted-LAN pairing/session；
7. 发布 smoke tests。

**完成定义**：替换 ModelRuntime 不修改 Chat/RAG；Windows 后端未来只需 adapter；LAN 模式有真实访问控制。

---

## 12. Issue 拆分清单

可直接将以下条目建立为开发 Issue：

| ID | 优先级 | Issue | 依赖 | 估计规模 |
|---|---:|---|---|---|
| KE-001 | P0 | ScopePolicy 与 AccessContext | 无 | L |
| KE-002 | P0 | Agent open/citation/listSources 强制 Scope | KE-001 | M |
| KE-003 | P0 | Chunk/Citation API 授权矩阵 | KE-001 | M |
| KE-004 | P0 | knowledge_spaces 与 bindings migration | 无 | L |
| KE-005 | P0 | SourceItem active Revision 与 tombstone 切读 | KE-004 | L |
| KE-006 | P0 | vector_entries 与 legacy backfill | 无 | L |
| KE-007 | P0 | IndexBuild 原子激活与回滚 | KE-006 | L |
| KE-008 | P0 | Worker 防重入和资源 lease token | 无 | M |
| KE-009 | P0 | 并发 Chat 活跃引用计数 | KE-008 | M |
| KE-010 | P0 | Web Connector DNS pinning/redirect policy | 无 | L |
| KE-011 | P0 | GitHub 凭据存储与日志脱敏 | 无 | M |
| KE-012 | P0 | WAL-safe snapshot 与 hash manifest | 无 | L |
| KE-013 | P1 | Context token packing | 无 | L |
| KE-014 | P1 | Citation 精确 locator | KE-005 | L |
| KE-015 | P1 | Orynode SSE v1 | 无 | L |
| KE-016 | P1 | Retrieval 离线评测与性能门禁 | 无 | M |
| KE-017 | P2 | ProcessingBuild/domain backfill | KE-004 | L |
| KE-018 | P2 | Source sync 持久化 Job | KE-005 | L |
| KE-019 | P2 | Connector checkpoint/generation | KE-018 | L |
| KE-020 | P2 | Storage staging/reconciliation | KE-017 | L |
| KE-021 | P3 | Platform composition root/ModelRuntime | 无 | M |
| KE-022 | P3 | Agent space 持久化 | KE-004 | M |
| KE-023 | P3 | Knowledge v1 API 补齐 | KE-001, KE-018 | L |
| KE-024 | P3 | Trusted-LAN pairing/session/revoke | 无 | XL |
| KE-025 | P3 | 发行制品 runtime smoke | KE-021 | M |
| KE-026 | P1 | OCR contract、block/bbox DTO 与 fake adapter | 无 | M |
| KE-027 | P1 | PDF 页面文本质量检测与按页 OCR 路由 | KE-026 | M |
| KE-028 | P1 | Apple Vision Swift helper 与 macOS adapter | KE-026 | L |
| KE-029 | P1 | `process_revision` OCR Job 与 ResourceCoordinator 接入 | KE-027, KE-028 | L |
| KE-030 | P1 | DocumentBlock/Chunk locator migration 010 | KE-026 | L |
| KE-031 | P1 | 扫描 PDF、混合 PDF 与 OCR Citation 闭环 | KE-029, KE-030 | L |
| KE-032 | P1 | OCR capability、状态与 UI 降级说明 | KE-028, KE-029 | M |
| KE-033 | P1 | Mac OCR 资源/质量/故障基准 | KE-031 | M |
| KE-034 | P3 | PP-OCR mobile Windows adapter（**预留**：artifact + stub，实现未开始） | KE-026 | M |

规模仅表示相对复杂度，不表示时间承诺。KE-001～012 是正确性和安全链路，应优先于新增格式、reranker、sqlite-vec 或 Windows 实际后端。

---

## 13. 明确延后、不阻塞当前整改的事项

以下内容继续保留 adapter/port，不应现在仓促选型：

- Windows 的具体本地推理后端；
- 默认 reranker 模型；
- sqlite-vec 或外部向量数据库（**仅大量数据瓶颈场景**；默认仍为 blob_scan）；
- Windows 的 PP-OCR mobile/ONNX 实际 adapter（统一 `OcrEngine` 契约在当前阶段完成）；
- 多租户 ACL；
- 云同步、云 Embedding 或远程模型；
- Connector 第三方插件市场。

重新评估条件仍按长期架构执行：由 Windows prototype、真实性能瓶颈、离线评测收益和明确产品需求触发。延后不代表忽略跨平台：所有新 Schema、相对路径、文件名、API DTO 和核心 TypeScript 必须持续通过 Windows contract fixture。

---

## 14. 架构完成判定

只有同时满足以下条件，才可以把“完整 RAG 长期架构基础”标记为完成：

- [ ] Chat、Agent、Workspace 的 search/open/citation 使用同一 Knowledge application 与 ScopePolicy；
- [ ] conversation/agent/library scope 的授权测试全部通过；
- [x] Source 更新、删除、失败恢复不会让旧内容进入活动检索；
- [x] Revision、ProcessingBuild、ChunkSet、IndexBuild 可以独立表达和切换；
- [x] keyword/vector 新旧索引能真实共存并原子激活、回滚；
- [ ] 所有长任务持久化、幂等、可取消、可恢复；
- [x] Context 按 token 完整打包，Citation 与实际注入内容一致；
- [x] Orynode SSE 不依赖具体模型后端；
- [x] Web/GitHub Connector 通过 SSRF、redirect、凭据泄漏测试；
- [x] 备份是 WAL-safe 快照，导入先校验 hash，再 staging 恢复；
- [x] Chat 通过 ModelRuntime port，TurboFieldfare 只存在于 macOS adapter；
- [x] Local-only 默认安全，Trusted-LAN 若启用则具备认证、配对和撤销；
- [x] Mac 扫描 PDF 可通过系统 OCR 本地处理，混合 PDF 只 OCR 必要页面，Citation 可回到页/区域；
- [x] 默认安装不下载 OCR-VLM，OCR 失败不破坏原件、旧 ProcessingBuild 或既有索引；
- [ ] lint、unit、contract、build、rendered HTML、migration、security 测试全部通过；
- [ ] 检索质量与本地资源基准没有超过既定退化阈值；
- [x] README、当前架构文档、长期架构文档与实际能力描述一致。

---

## 15. 开发执行原则

1. **先测试证明缺口，再修改实现**：尤其是 Scope、活动版本、原子索引和备份；
2. **每次只切一个事实源**：保留兼容 facade 和 feature flag，不做一次性重写；
3. **不把“表存在”视为“语义完成”**：必须证明查询、失败恢复和回滚真实使用新模型；
4. **安全默认失败关闭**：授权不明、DNS 结果异常、Manifest 不完整、build 校验失败时都不得继续；
5. **用户原始数据优先**：索引可重建，原件和仍被引用的 Revision 不可因迁移或 GC 丢失；
6. **本地资源有上限**：所有批处理可分页、可暂停、可恢复，Chat 交互优先；
7. **跨平台靠契约而不是条件分支**：Mac 当前完整实现，Windows 保持诚实 stub 和持续 contract 测试；
8. **成熟库放在 adapter 后**：可以使用稳定第三方解析、GitHub、Tokenizer、SQLite 扩展，但不能让领域接口绑定具体产品；
9. **每个阶段更新文档**：Issue 完成时同步更新本文完成状态与当前架构文档，不只更新长期目标文档。

完成 KE-P0-01～06 后，项目才具备继续扩展 RAG 数据源和 Agent 能力的可靠基础；完成 P1 后形成用户可验证的完整 RAG 闭环；完成 P2/P3 后，才达到长期架构所要求的可恢复、可迁移、可跨平台演进的本地私有 AI 服务器基础。

---

## 16. OCR 专项复检与轻量落地方案

### 16.1 专项结论

2026-08-03 OCR Mac（KE-026～033）已落地：**扫描/混合 PDF 可经 Apple Vision 进入 FTS + Citation；按页 checkpoint/续跑；helper 文档级复用；`ocr:bench` 可重复 micro-bench（无硬件不写虚假档位结论）。** Windows 仍诚实 `OCR_UNAVAILABLE`（KE-034）。

本专项冻结以下产品决策：

1. OCR 的核心目标仅为让扫描 PDF 能进入现有 RAG，并提供可验证引用；
2. macOS 默认使用系统 Apple Vision，不下载额外 OCR 模型；
3. 第一阶段不接受图片上传、不承诺表格重建、公式转 LaTeX、高保真 Markdown 或票据字段抽取；
4. Windows 继续使用相同 `OcrEngine` 契约，实际实现优先验证 PP-OCR mobile + ONNX；
5. OvisOCR2 等 OCR-VLM 不进入默认安装，只能作为未来显式安装的高级插件；
6. OCR 是 Processing adapter，不改变 Document、Revision、Chunk、Retrieval、Citation 和 Chat/Agent API；
7. OCR 全程在本地服务器设备执行，默认没有网络数据出口。

这样补齐的是“扫描 PDF 文本可用性”，不是为项目新增一套文档智能产品线。

### 16.2 落地对照（KE-026～032 后）

| 检查点 | 当前证据 | 判定 |
|---|---|---|
| OCR port | `recognizePage` + bbox/block/capability；Fake adapter | 已落地 |
| 生产装配 | macOS helper 可用时装配；否则 `null`；Windows `null` | 已落地 |
| Host / Knowledge capability | helper `--capabilities` 探测 Vision；`ocrDetail` 对象 | 已落地 |
| PageTextQuality + 按页路由 | `page-quality.ts` / `analyze-pdf.ts` | 已落地 |
| Ingest 分流 | 同步 native；异步 `process_revision` + `jobId` | 已落地 |
| Job / ResourceCoordinator | `process_revision` + OCR lease；Chat 优先 | 已落地 |
| ProcessingBuild | begin/run/activate/fail；**成功后才 activate**；fail 清 `is_active` | 已落地 |
| DocumentBlock | migration 010；OCR + 同步 native 均写 blocks/refs | 已落地 |
| Citation bbox | FTS 附带 locatorHint；分散区域 degraded | 已落地 |
| Tests | contract / page-quality / fixtures / process_revision 集成 / ocr:bench | 已落地（多机 8/16GB 档位需本机跑 bench） |

以下为整改前历史缺陷表（归档，勿再当作当前状态）：

| 检查点 | 整改前证据 | 当时判定 |
|---|---|---|
| OCR port | 仅整包 `recognize` | 占位 |
| 生产装配 | composition root `ocr: null` | 未实现 |
| Ingest | 零 chunk 直接 422「扫描版暂不支持」 | 无接入点 |

### 16.3 技术选型与体积边界

| 层级 | 实现 | 是否默认安装 | 用途 |
|---|---|---:|---|
| macOS Core | Apple Vision `RecognizeTextRequest` | 是，使用系统能力 | 扫描 PDF 中英文文本、confidence、bbox |
| Windows Future | PP-OCRv5 mobile/ONNX | 否，Windows 实现时按需安装 | 跨平台轻量文字识别 |
| 极低资源实验 | PP-OCRv6 tiny/ONNX | 否 | 体积极小但准确率较低的 fallback |
| 成熟 fallback | Tesseract `tessdata_fast` | 否 | 普通印刷文本、特定语言包 |
| Advanced Plugin | OvisOCR2 或后续文档 VLM | 否 | 表格、公式、复杂布局转 Markdown，不属于核心 OCR |

PaddleOCR 官方当前列出的存储大小可作为 Windows 技术验证参考：PP-OCRv5 mobile 检测约 4.7 MB、识别约 16 MB；PP-OCRv6 tiny 检测约 1.9 MB、识别约 4.4 MB。模型权重小不等于完整 Runtime 体积小，ONNX Runtime、语言字典和打包体积必须单独测量。

参考资料：

- Apple Vision RecognizeTextRequest：<https://developer.apple.com/documentation/vision/recognizetextrequest>
- PaddleOCR 轻量模型列表：<https://www.paddleocr.ai/main/en/version3.x/pipeline_usage/OCR.html>
- RapidOCR ONNX 部署：<https://github.com/RapidAI/RapidOCR>
- Tesseract fast 数据：<https://tesseract-ocr.github.io/tessdoc/Data-Files-in-tessdata_fast.html>

不得因为某个高级模型榜单更高，就把 Python、vLLM、额外模型下载或常驻视觉模型变成 Orynode 基础安装依赖。

### 16.4 稳定 OCR 契约

当前 `OcrEngine` 一次接收任意 bytes 并返回整份 pages，无法表达逐页资源限制、精确引用和取消。目标接口建议为：

```ts
export type NormalizedBoundingBox = {
  x: number;      // 0..1，左上角坐标系
  y: number;      // 0..1
  width: number;  // 0..1
  height: number; // 0..1
};

export type OcrBlock = {
  text: string;
  bbox: NormalizedBoundingBox;
  confidence?: number;
  readingOrder: number;
  language?: string;
};

export type OcrPageInput = {
  pageNumber: number;
  imageBytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  languages?: string[];
  recognitionLevel: "fast" | "accurate";
};

export type OcrPageResult = {
  pageNumber: number;
  text: string;
  blocks: OcrBlock[];
  engine: string;
  engineVersion: string;
  warnings: string[];
};

export type OcrCapability = {
  available: boolean;
  engine: string | null;
  engineVersion: string | null;
  languages: string[];
  boundingBoxes: boolean;
  reason?: string;
};

export interface OcrEngine {
  capabilities(): Promise<OcrCapability>;
  recognizePage(
    input: OcrPageInput,
    signal?: AbortSignal,
  ): Promise<OcrPageResult>;
}
```

契约约束：

- 一次只处理一页，Worker 可以安全 checkpoint、暂停和限制峰值内存；
- bbox 一律保存为左上角原点的 `0..1` 归一化坐标，adapter 负责转换 Apple Vision 坐标系；
- blocks 按确定的 readingOrder 排序；相同输入、引擎版本和配置应产生可重复的顺序；
- `text` 由 blocks 按阅读顺序合并，不允许另生成一份无法映射到 bbox 的文本；
- 业务层不识别 `AppleVision`、`PP-OCR` 名称，只读取 capability 和结构化结果；
- AbortSignal 必须能够终止 helper/子进程并释放临时图片；
- helper stderr 只能记录状态和稳定错误码，不记录识别正文。

### 16.5 PDF 页面判断与按需 OCR

禁止所有 PDF 无条件 OCR。目标流程为：

```text
PDF Revision
  → pdfjs 逐页读取 native text items
  → 计算 PageTextQuality
      ├── usable：保留原生文字与文本定位
      ├── blank：保持空页，不调用 OCR
      └── suspected_scan：渲染当前页 → OcrEngine
  → native/OCR blocks 合并为同一 DocumentBlock 序列
```

`PageTextQuality` 至少记录：

```ts
type PageTextQuality = {
  pageNumber: number;
  extractedCharacters: number;
  meaningfulCharacters: number;
  replacementCharacterRatio: number;
  hasLargeRasterImage: boolean;
  decision: "native" | "blank" | "ocr";
  reason: string;
};
```

首版采用集中配置的保守阈值，不能散落 magic number：

- `minMeaningfulCharacters = 24`；
- `maxReplacementCharacterRatio = 0.30`；
- `renderDpi = 144`；
- `maxRenderedLongEdge = 2400`；
- `maxRenderedPixels = 16_000_000`；
- `maxOcrPagesPerDocument = 100`；
- `ocrPageConcurrency = 1`；
- `ocrPageTimeoutMs = 30_000`。

这些是首版安全上限，不是长期质量结论。真实 M1/M2 8 GB、16 GB 基准完成后可以调整并记录 ADR。混合 PDF 只 OCR 被判定为扫描的页面；已有可靠文本层的页面绝不重复 OCR，避免速度下降和正文重复。

空白页不能因为字符为零就自动 OCR。只有检测到显著栅格内容或文字候选时才进入 OCR；否则保持空页。对于超过 100 个扫描页的文档，第一版返回稳定的 `OCR_PAGE_LIMIT_EXCEEDED` 并保留原件，不能静默只索引前 100 页。

### 16.6 摄取、Job 与状态流

OCR 接入依赖把 PDF 处理移出 HTTP 生命周期。第一阶段使用一个可恢复的 `process_revision` Job 编排内部阶段，不必立即拆出多个微型 Job：

```text
POST ingestion
  → validate type/size
  → staging + 原子保存原件
  → 创建 Document/Revision(status=stored)
  → enqueue process_revision
  → HTTP 202 + documentId/jobId

process_revision
  → ProcessingBuild queued → running
  → analyze native pages
  → for each OCR page:
       acquire ResourceCoordinator(kind=ocr)
       render one page
       recognizePage
       persist blocks + page checkpoint
       release lease
  → build chunks + locator refs
  → commit FTS5
  → ProcessingBuild ready + atomic activate
  → document ready
  → enqueue embed_document（若启用）
```

Job payload 必须版本化并保持小型：

```ts
type ProcessRevisionJobV1 = {
  version: 1;
  namespace: "library" | "conversation";
  documentId: string;
  revisionId: string;
  processingBuildId: string;
  ocrMode: "auto" | "disabled";
};
```

进度格式：

```ts
type ProcessRevisionProgress = {
  phase: "analyzing" | "ocr" | "normalizing" | "chunking" | "keyword_index";
  page?: number;
  totalPages?: number;
  ocrPagesCompleted?: number;
  ocrPagesTotal?: number;
};
```

第一阶段不要增加 `native/quality/Ovis` 用户档位。OCR 是摄取能力，不应与 Lite/Balanced/Quality 检索档位耦合。设置只保留：

```text
扫描 PDF 文字识别：自动（默认）/关闭
```

高级文档解析插件未来使用单独 capability 和安装流程。

### 16.7 ProcessingBuild 激活与失败语义

当前 `createProcessingBuildStore.createAndActivate()` 创建时就标记 ready 并替换旧 active，不适合 OCR。应拆为：

```ts
beginBuild(config): ProcessingBuild        // queued，不影响旧 active
markRunning(buildId): void
activateReady(buildId): void               // 单事务切换 active
markFailed(buildId, stableError): void      // 旧 active 保持不变
```

规则：

- OCR/parse/chunk/FTS 全部成功后才允许激活；
- 任一必须 OCR 的页面失败，整个新 build 不激活，避免用户在不知道的情况下检索到残缺文档；
- 原件始终保留，UI 显示失败原因并允许重试；
- 已有旧 active build 时继续可检索旧版；首次摄取失败时文档状态为 `processing_error`，不可假装 ready；
- 取消只停止新页面处理，清理未激活 blocks/chunks，不影响旧 active；
- retry 使用相同 revision，可新建 processing build 或安全续跑同一 build，但不得创建伪 Revision；
-错误持久化稳定码，如 `OCR_UNAVAILABLE`、`OCR_TIMEOUT`、`OCR_PAGE_LIMIT_EXCEEDED`、`OCR_HELPER_PROTOCOL_ERROR`，UI 不解析自然语言。

### 16.8 Migration 010：DocumentBlock 与引用映射

建议新增 migration `010_ocr_document_blocks`：

```sql
CREATE TABLE document_blocks (
  id TEXT PRIMARY KEY,
  processing_build_id TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  block_type TEXT NOT NULL DEFAULT 'text',
  reading_order INTEGER NOT NULL,
  text TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('native_text', 'ocr')),
  bbox_json TEXT,
  confidence REAL,
  language TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (processing_build_id)
    REFERENCES processing_builds(id) ON DELETE CASCADE,
  UNIQUE(processing_build_id, page_number, reading_order)
);

CREATE INDEX idx_document_blocks_build_page
  ON document_blocks(processing_build_id, page_number, reading_order);

CREATE TABLE chunk_block_refs (
  namespace TEXT NOT NULL CHECK (namespace IN ('library', 'conversation')),
  chunk_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  start_offset INTEGER,
  end_offset INTEGER,
  PRIMARY KEY (namespace, chunk_id, block_id),
  FOREIGN KEY (block_id) REFERENCES document_blocks(id) ON DELETE CASCADE
);
```

`bbox_json` 写入前必须用 Zod/手工 schema 验证四个有限数值均在 `0..1`，不得直接信任 helper JSON。Chunk 可以关联多个 block；Citation 默认使用覆盖命中文本的最小 block bbox 集合。若一个 chunk 跨多个分散区域，第一版可降级为 page locator，并在 diagnostics 标记 `bbox_degraded`，不能伪造一个不准确的大框。

Native text 也应规范化为 DocumentBlock，使普通 PDF 与 OCR PDF 从 block 以后共享完全相同的 chunk/index/citation 管线。

### 16.9 macOS Apple Vision helper

建议目录：

```text
native/macos/orynode-ocr/
  Package.swift
  Sources/OrynodeOCR/main.swift
  Tests/OrynodeOCRTests/

services/platform/macos/
  apple-vision-ocr.ts
  ocr-helper-protocol.ts
```

实施约束：

- 使用小型 Swift CLI/helper 调用 Vision，不在 Node 层绑定原生 framework；
- 源码安装版在 `setup` 阶段编译，未来 DMG 预编译并签名；
- Node 使用 `spawn` 参数数组，不经过 shell；
- helper 实现 `--capabilities`/`--version` 和 JSON Lines 协议；
- 页面图片只写入 Orynode 生成的同机临时目录，权限仅当前用户，处理后 finally 清理；
- helper 输出必须包含 protocolVersion、requestId、pageNumber、blocks 或稳定错误码；
- adapter 验证 requestId/pageNumber/协议版本，拒绝额外未知的大型字段；
- 单次 helper 进程按一个 document 或有限页面批次复用，不能每个文字框启动进程；
- helper 崩溃、超时或输出畸形时终止进程树并释放 ResourceLease；
- 日志不写页面图像、识别正文、用户绝对文件路径；
- `doctor` 检查 helper 存在、可执行、协议匹配和最小识别 smoke fixture。

生产 capability 只有在以下条件全部满足时才返回可用：

```text
platform = macos
helper executable exists
helper protocol compatible
Vision request available
health smoke test succeeds
```

不得因为运行在 macOS 就把 `ocr: true` 写死。

### 16.10 Windows 预留方式

Windows 当前**只做架构预留，不实现推理**，不阻塞 Mac OCR。

已落地的预留标记（勿删）：

| 项 | 路径 |
|---|---|
| 说明 | `services/platform/windows/OCR_RESERVED.md` |
| Artifact 元数据约定 | `services/platform/windows/artifacts/pp-ocr-v5-mobile-onnx.artifact.json` |
| Runtime stub | `services/platform/windows/ocr-reserved.ts` → `createWindowsOcrReservedStub()` |
| 装配 | `composition-root` 在 `platform=windows` 时注入 stub（非 `null`） |
| Capability | `available: false`，`engine: pp-ocr-v5-mobile-onnx`，`reason: OCR_UNAVAILABLE`，`reservation: "planned"` |

Artifact 字段约定（安装实现时再填 path/sha256/version）：

```text
engine id: pp-ocr-v5-mobile-onnx
detector / recognizer / dictionary / runtime artifacts
sha256 / license / source
```

开始 Windows prototype 后，再验证 RapidOCR/ONNX Runtime 的：

- 完整安装体积而非只看模型权重；
- CPU 延迟和峰值内存；
- 简繁中文、英文、旋转文本；
- Windows 路径、DLL 加载和签名；
- Apache 2.0 代码与模型许可证清单；
- 与 Apple Vision 相同的 bbox、readingOrder、错误码和 fixture contract。

如果 PP-OCR adapter 未安装，Windows capability 明确返回 `OCR_UNAVAILABLE`；不能自动调用云 OCR。

### 16.11 UI、API 与可观测性

Capabilities 应从单一平台事实源返回：

```json
{
  "ocr": {
    "available": true,
    "engine": "apple-vision",
    "engineVersion": "...",
    "mode": "auto",
    "boundingBoxes": true,
    "degradedReason": null
  }
}
```

兼容期可以保留顶层 `ocr: boolean`，但其值必须从上述对象派生。`getKnowledgeCapabilities()` 不得继续硬编码 `platform: "macos"` 和 `ocr: false`。

文档状态建议：

```text
stored → processing → ready → embedding → indexed
                  └→ processing_error
```

UI 至少显示：

- “正在分析 PDF”；
- “正在识别扫描页 3/12”；
- “已完成，可关键词检索”；
- “OCR 不可用，原文件已保留”；
- 稳定错误对应的重试/关闭 OCR 操作。

本地 diagnostics 可以记录引擎版本、总页数、OCR 页数、每页耗时、失败码和峰值 RSS；不得记录正文、图片或敏感路径。API 返回 job receipt，禁止让上传请求等待几十页 OCR 完成。

### 16.12 安全与资源上限

- 上传仍受 150 MB 总限制；解析另设最大页数、最大渲染像素和 OCR 页数；
- PDF.js 渲染和 Swift helper 都必须有超时、取消和进程退出清理；
- 一次只在内存中保留当前页面位图和有限结果，持久化后立即释放；
- OCR 页面申请 `ResourceCoordinator(kind="ocr")`，Chat 活跃时延迟；
- 禁止自动下载模型、调用外网、执行 PDF 内脚本或加载外部资源；
- 临时路径只能由 Storage adapter 生成，拒绝用户提供的输出路径和符号链接逃逸；
- helper/模型 artifact 必须记录版本、hash、来源和许可证；
- 恶意或异常 bbox、NaN、无限值、超长 text block 必须在 adapter 边界拒绝；
- 单 block 和单页文本设上限，避免 helper 输出导致 SQLite/Prompt 资源耗尽；
- OCR 输出仍是不可信文档内容，继续受 Prompt Injection 边界约束。

### 16.13 测试与验收矩阵

必须新增可提交仓库的小型 fixture：

| Fixture | 验证点 |
|---|---|
| native-text.pdf | 不调用 OCR，原生文字可检索 |
| scanned-zh-en.pdf | 调用 OCR，中英文可关键词召回 |
| mixed-native-scan.pdf | 只 OCR 扫描页，不重复原生正文 |
| rotated-scan.pdf | 旋转页面识别和 bbox 坐标转换 |
| blank-and-image.pdf | 真空白页不 OCR，含文字图片页 OCR |
| malformed.pdf | 稳定失败、无残留 active build |
| many-pages.pdf（生成 fixture） | 页数/OCR 页数上限、取消和恢复 |
| fake-helper-invalid-json | helper 协议错误和进程清理 |
| fake-helper-timeout | timeout、lease 释放、Job retry |

测试层级：

1. `OcrEngine` contract：Apple fake 与 Windows fake 复用同一套结果校验；
2. Parser unit：native/blank/ocr 页面决策；
3. Adapter unit：Vision 坐标转左上角归一化 bbox；
4. Repository integration：ProcessingBuild 不提前激活，blocks/refs 随失败 build 清理；
5. Worker integration：按页 progress、heartbeat、cancel、retry、Chat 优先；
6. End-to-end：上传扫描 PDF → job ready → FTS 命中 → Citation page/bbox；
7. Security：畸形 helper 输出、路径穿越、超大页面、超长 block；
8. Packaging：源码 setup、doctor、未来 DMG helper 签名与启动；
9. Real Mac benchmark：至少覆盖 Apple Silicon 8 GB 与 16 GB 能力档位；无对应硬件时不得虚构结论。

首版完成标准：

- 普通 PDF 行为与当前基线一致，且不加载/调用 OCR；
- Mac 默认安装不增加第三方 OCR 模型下载；
- 扫描 PDF 能在断网状态完成处理和 FTS5 检索；
- 混合 PDF 只处理必要页面；
- Citation 至少准确到页，block 映射可用时准确到 bbox；
- OCR 期间 Chat 可用，后台工作遵守单重型任务限制；
- helper/Worker 中断后任务可重试，旧 active build 和原件不受损；
- capability、状态、错误和 UI 与实际能力一致；
- OCR 测试加入 `npm run test:unit` 和 platform contract 门禁。

### 16.14 推荐开发顺序

1. **KE-026**：先扩展 DTO/port，加入 fake adapter、bbox schema 和 contract test；不接真实 Vision。
2. **KE-027**：实现 PDF PageTextQuality、混合 PDF 按页路由和渲染上限测试。
3. **KE-030**：migration 010、DocumentBlock repository、chunk-block locator 映射。
4. **KE-028**：实现 Swift helper、macOS adapter、capability/doctor 探测。
5. **KE-029**：增加 `process_revision` Job，调整 ingestion 为“先存原件、返回 receipt、后台处理”。
6. **KE-031**：打通 scanned/mixed PDF → FTS → Citation 端到端。
7. **KE-032**：更新 API capability、文档状态、UI 进度和稳定错误展示。
8. **KE-033**：完成真实 Mac 基准、资源阈值和故障注入，决定首版默认阈值。
9. **KE-034**：Windows PP-OCR — **预留已标记**（artifact + stub）；实现不阻塞 Mac 发布。

在 KE-026～033 完成前，不添加 OvisOCR2、表格模型、公式模型、版面模型或 Python OCR Runtime。若未来用户需求证明复杂文档解析值得支持，应作为独立 Advanced Document Parser plugin 立项，继续复用本节的 ProcessingBuild、Job、DocumentBlock 和 Citation 契约。
