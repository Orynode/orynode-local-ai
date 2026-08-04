# Changelog

本项目自 `1.x` 起遵循 [SemVer](https://semver.org/lang/zh-CN/)：破坏性变更递增主版本，功能新增递增次版本，纯修复递增修订号。  
`0.x` 期间破坏性或用户可见行为变化可递增次版本（`0.Y.0`）。  
产品线「V1 源码安装版 / V2 签名安装包」见 README，与 npm `version` 不是同一套编号。

## 1.1.1 — 2026-08-04

1.1.0 后的修订：统一 Chat 引用协议与胶囊 UI、**原件预览**（引用跳页 / OCR 框高亮），并修 PDF/OCR 摄取若干硬故障。

### Added / 新增

#### 原件预览（Document Preview）

- 统一 Intent：`DocumentPreviewProvider` + `openPreview`；资料库卡片 / 检索命中 / 引用胶囊「查看原文」共用
- 侧栏 Shell：HEAD 探测 MIME / 体积；PDF（pdf.js legacy + 共用 `pdfjs-load`）、文本 `<pre>`、未知格式下载降级
- Next API：`GET/HEAD /api/knowledge/[id]/file`、`/api/conversations/[id]/files/[fileId]/content`；鉴权与 RAG Scope 脱钩（资料存在性 / 会话附件 `conversationId` 归属）
- data-service：`/bytes` 流式输出 + loopback 守卫；`x-file-name` / 魔数友好 MIME
- 引用定位：页码跳转；Markdown / 代码 `startLine`；文本与 PDF `startOffset`/`endOffset`；**OCR 归一化 bbox 框高亮**（优先于字符偏移）
- 翻页仅在引用页绘制高亮；单页按可视区宽高适配缩放；失败可重试 / 下载原件

### Changed / 变更

#### Citation Protocol（Chat 引用）

- 新增单一协议模块 `services/chat/citation-protocol.ts`：解析 / 行末落点 / 同行合并；Prompt 规则同源
- 展示适配 `app/lib/citation-markdown.ts`：放行 `citation:`（规避 react-markdown 清空未知协议），行末合并为单胶囊
- **写库真相**：仅 `useChat.finalizeAnswer` 写入规范正文 + `referencedCitationIds`；SSE `done` 只用 `extractReferencedCitationIds` 下发 ids
- 行内胶囊：文档短名 + 点击弹层（多来源列表、贴底翻转、可滚动）；**「查看原文」** 打开原件预览
- `S#` 仅作模型/协议内部编号，用户界面展示文档名

#### OCR / 上传默认

- macOS Vision OCR 默认 `accurate`（`fast` 对中文扫描页易乱码）
- 单文件上传上限 **50 MB → 150 MB**（文案走 `MAX_KNOWLEDGE_FILE_SIZE_LABEL`）

### Fixed / 修复

- PDF OCR 渲染：Node 侧用 `@napi-rs/canvas` 的 `Path2D`/`DOMMatrix` 覆盖 polyfill stub，避免 `path.moveTo is not a function`
- OCR bbox：Vision 浮点越界改为钳位，不再因 `OCR_INVALID_BBOX` 整页失败；helper 输出同步钳位
- 胶囊 `citation:` 锚点稳定组件类型，修复点击无响应（Markdown 重挂载导致 `useId` 错位）
- 无扩展名 PDF / `octet-stream`：客户端魔数 + 单次 GET 流 peek，避免误判为「不支持内嵌预览」
- 设置「关于」补充本版模型 / TurboFieldfare / Knowledge Engine 技术点（读 `package.json` version）

### Docs / 工程

- 引用协议职责与字段语义写在模块头与 `Message` 类型注释，避免贡献者误用双写路径
- 单测：`tests/chat/citation-protocol.test.ts`、`citation-markdown.test.ts`；OCR bbox / Path2D 相关回归
- 预览：`document-preview.test.ts`、`preview-mime` / `preview-errors`、`preview-file-auth`、`preview-integration`、PDF 高亮与行偏移；`citation-excerpt`

## 1.1.0 — 2026-08-03

**本版核心：RAG 全面更新**（相对 `0.3.0` 的知识检索 / 摄取 / 引用 / 索引链路重整）。

从「路由内拼检索」升级为本地 **Knowledge Engine**：统一 Scope 授权、Hybrid 检索（关键词 + 可选语义 + RRF）、结构化 Citation、ProcessingBuild / Job、OCR 进索引、Search/Retrieve 职责分离，以及 Chat SSE v1 引用协议。同步落地 macOS OCR、**Windows 跨平台适配预留**、Trusted-LAN、ModelRuntime 与对话·附件状态机闭环。

> **范围说明（与 `docs/knowledge-engine` 一致）**  
> 这是一次 **RAG 主链路的全面升级与可用发布**，对应实施计划 **Phase 0～3 首批**；**不是**宣称「完整 RAG 长期架构已全部闭环」。  
> 当前首发与完整体验仍是 **Apple Silicon Mac**；Windows 走 adapter 预留，**本版不提供可用的 Windows 推理/OCR 产品体验**。  
> 仍缺 / 仅骨架：CredentialStore、Agent 规划器 UI、Windows 真实 OCR/推理后端、评测 CI 全矩阵等。  
> 向量索引：**本版生产固定 `blob_scan`（SQLite BLOB + JS 余弦）**；`sqlite-vec` 仅 adapter 占位，**未启用**。仅当资料量很大、评测证明 BLOB 扫描成为延迟/内存瓶颈时，才考虑接入。详见 [整改实施计划 §1](docs/knowledge-engine/KNOWLEDGE_ENGINE_IMPLEMENTATION_PLAN_zh-CN.md)。

### Added / 新增

#### RAG / Knowledge Engine（本版主线，代码已落地）

相对旧版「上传 → 简单关键词召回 → 塞进 prompt」：

| 维度 | 本版 |
|---|---|
| 编排 | Chat 只调 `KnowledgeEngine`（`retrieve` / `buildContext`），不在 API 路由内自写检索 |
| 授权 | `ScopePolicy`：Search / Open / Citation 统一服务端 Scope；会话附件强制归属 |
| 召回 | FTS5 + 中文 bigram；可选向量 + RRF；planner / exact-terms / term expansion |
| 档位 | Lite · Balanced · Quality · Auto，带降级 diagnostics |
| 上下文 | token packing；provided / referenced 引用分离；SSE metadata 带 citations |
| 摄取 | ProcessingBuild + DocumentBlock；PDF `process_revision`；成功后才 activate |
| 异步 | Job Worker：`embed` / `sync_source` / `process_revision` / `garbage_collect` |
| 入口 | 工作台 Search vs Chat Retrieve 分离；Knowledge v1 API；旧 search 仅兼容 |
| 来源 | Web / GitHub Connector（SSRF、generation 删除检测） |
| 数据 | `vector_entries`、WAL 备份导出；向量检索生产路径 = **`blob_scan`**（`sqlite-vec` 仅占位，大量数据瓶颈时再评估） |

#### 模型与技术（本版引入 / 明确接入）

| 类别 | 名称 | 用途 | 说明 |
|---|---|---|---|
| 对话 LLM | **Gemma 4 26B A4B IT**（4-bit） | 本机对话生成 | 经 **TurboFieldfare**（Swift/Metal，`:8080/v1` OpenAI 兼容） |
| 推理运行时 | TurboFieldfare | 本地 LLM 服务 | 仅 macOS adapter；Chat 经 `ModelRuntime`，不直连 |
| 可选 Embedding（默认推荐） | **multilingual-e5-small**（384 维，ONNX / Xenova） | 语义向量召回 | 需 `ORYNODE_SEMANTIC_SEARCH=1`；中英资料库默认 |
| Embedding 兼容基线 | **bge-small-zh-v1.5**（512 维） | 旧索引 / 中文对照 / 回滚 | 勿与 E5 向量混用；切换须重建 IndexBuild |
| Embedding 实验 | **bge-m3**（1024 维） | 质量上限参考 | 非默认，内存开销大 |
| Embedding 运行时 | `@xenova/transformers` | 本机加载 ONNX | 仅 data-service 进程加载，不进浏览器包 |
| 关键词索引 | **SQLite FTS5** + 中文 bigram / search_text | 默认检索 | 开箱可用，不加载向量模型 |
| 可选向量检索 | **blob_scan**（BLOB + JS 余弦） | 语义召回后端 | 生产固定；**sqlite-vec 仅占位**，大量数据瓶颈时再评估 |
| 融合 / 档位 | RRF、lexical rerank（Quality）、Lite·Balanced·Quality·Auto | 检索策略 | 主机开关 × 用户档位共同决定是否走 hybrid |
| OCR（macOS） | **Apple Vision**（`orynode-ocr` Swift helper） | 扫描/混合 PDF 识字 | `npm run ocr:install` → `.orynode/bin/orynode-ocr` |
| OCR（Windows 预留） | PP-OCR mobile + ONNX（artifact 元数据） | 未来 Windows 识字 | 本版仅 stub / `OCR_UNAVAILABLE`，不跑推理 |
| PDF | pdfjs-dist | 原生文本页提取 | 与 OCR 按页质量路由配合 |
| 存储 | SQLite（`node:sqlite`）+ Job Worker | 对话 / chunks / vectors / jobs | Data Service `:4318`，仅 `127.0.0.1` |
| 前端 / 网关 | Next.js + React + vinext | UI 与 `/api` | Trusted-LAN 可绑局域网；推理与 DB 仍回环 |

#### OCR（Mac 闭环 · Windows 预留）

- macOS Apple Vision helper（`native/macos/orynode-ocr`）→ `.orynode/bin/orynode-ocr`
- 扫描/混合 PDF：按页质量路由、checkpoint / 续跑、helper 文档级复用
- `npm run ocr:install` / `ocr:bench`

#### Windows 兼容方案（架构预留，非本版产品交付）

本版把跨平台边界收成 **Host / ModelRuntime / OCR adapter**，Knowledge Engine **不写 OS 分支**；未来 Windows 主机只需换 adapter，不必改 RAG 主链路。

| 预留项 | 本版状态 | 说明 |
|---|---|---|
| ModelRuntime | Windows **诚实 stub**（`CAPABILITY_UNAVAILABLE`） | Chat/Status 已只依赖统一契约；换 Windows 推理后端不改前端 SSE |
| OCR | `OCR_UNAVAILABLE` stub + PP-OCR mobile/ONNX **artifact 元数据** | 契约与 Mac 相同（`recognizePage`）；**不实现** Windows 推理（KE-034） |
| 路径 / 导出 / Schema | 相对路径、跨平台 fixture、无 Mac 绝对路径假设 | 便于日后 Windows 解析 Mac 导出包 |
| Contract 测试 | fake Windows backend 与 OpenAI backend 共用前端协议测试 | 保证协议不绑死 TurboFieldfare |

详见实施计划 [§16.10 Windows 预留](docs/knowledge-engine/KNOWLEDGE_ENGINE_IMPLEMENTATION_PLAN_zh-CN.md) 与长期架构跨平台边界。

#### Platform / 访问控制

- `services/platform`：ModelRuntime composition root；Chat / Status 不再直连 TurboFieldfare
- Trusted-LAN 配对会话、设备列表、撤销；敏感 Web API 统一 `lanDeniedResponse`
- 配对管理仅本机 loopback Data Service（`/lan-auth/pairing`），防 Host 伪造

#### 产品 UI / 体验

- 设置页：采样参数、知识档位（自动 / 省资源 / 更高质量）、OCR 模式、Trusted-LAN
- 知识工作台：检索预览（v1 search）、高亮、来源卡片、reprocess
- 会话附件：上传返回 `jobId`，轮询识别/索引进度；发送前拦截未就绪附件
- Agent space：**服务层 + Data Service 已有**，工作台 UI **未接**（内部预览）

#### 工程

- `scripts/data-service/` 模块化（migrations、FTS、jobs、worker、OCR blocks、LAN store…）
- CI workflow（`.github/workflows/ci.yml`）、检索评测脚本、connector 示例、`doctor` / `smoke-runtime` 增强

### Changed / 变更

- **Search vs Retrieve**：工作台 = Search 预览；Chat = Retrieve + 上下文；共用唯一 `HybridRetriever`（见长期架构 §6.0 / §8.3 / §10）
- Trusted-LAN 默认需配对；`ORYNODE_TRUSTED_LAN_UNSAFE=1` 为不安全预览
- `processingBuildId` 禁止回退冒充 IndexBuild id；Agent space 以 Data Service 为权威源
- 移除 `services/inference` 与未使用 `ACCESS_MODE` 常量
- 默认知识档位 `auto`；OCR 默认 `auto`

### Docs / 文档

统一归档至 [`docs/knowledge-engine/`](docs/knowledge-engine/README.md)（与本版代码对照阅读）：

| 文档 | 性质 | 与本版关系 |
|---|---|---|
| [长期架构](docs/knowledge-engine/KNOWLEDGE_ENGINE_ARCHITECTURE_zh-CN.md) | 目标架构 | 指导边界；本版按 Phase 0～3 首批落地 |
| [整改实施计划](docs/knowledge-engine/KNOWLEDGE_ENGINE_IMPLEMENTATION_PLAN_zh-CN.md) | 执行基线 + 完成度 | §1.2 / OCR §16 对照「已落地」表；**仍列未闭环项** |
| [多语言检索架构](docs/knowledge-engine/MULTILINGUAL_RETRIEVAL_ARCHITECTURE_zh-CN.md) | 实施方案 | 词法 / planner / expansion 等已部分进代码；完整跨语言评测门禁仍在推进 |
| [查询语义标准](docs/knowledge-engine/KNOWLEDGE_QUERY_SEMANTICS_STANDARD_zh-CN.md) | 语义规范 | 实施基线；约束 phrase / exact-terms / 禁止虚假凑 topK |
| [检索档位 UX](docs/knowledge-engine/KNOWLEDGE_RETRIEVAL_TIER_UX_ADJUSTMENT_PLAN_zh-CN.md) | UX 方案 | 设置页 Auto / Lite / Quality 文案与降级语义已对齐 |

另有 [`docs/README.md`](docs/README.md) 总索引；当前实现总览仍在 [`docs/ARCHITECTURE_zh-CN.md`](docs/ARCHITECTURE_zh-CN.md)。

### Fixed / 修复（对话 · 附件状态机闭环）

- 首条消息失败在欢迎页显示错误
- 发送前拦截识别中 / 失败 / 状态未知的附件与资料；`library_all` 遇 pending/failed 提示
- 检索 0 命中注入诚实 system 文案；无 citation 仍可看检索诊断
- 生成中切历史 / 新对话 / 删当前会话：作废过期流（`runId`），避免 UI 冲回或误落库
- 切会话停止旧附件轮询；取消上传用 generation token，避免草稿错挂
- 「新对话」仅删真正空壳；草稿仍挂会话附件或上传中不误删
- 资料删除失败不从草稿摘掉；设置保存失败在面板与对话页可见
- 流 `error` 无输出时回滚；有输出保留错误提示
- 清理零引用导出：`encodeSseData`、`trimChatHistory`、`MAX_PDF_SIZE`、`resolveCitationByChunkId`

### Not in this release / 本版明确不做（对齐实施计划缺口）

- 宣称「完整 RAG 长期架构已闭环」
- **Windows 作为可安装/可用的本地 AI 服务器产品**（本版仅 adapter 预留与诚实 stub）
- Agent 工作台 / 规划器产品化
- **启用 sqlite-vec 作生产向量索引**（本版固定 `blob_scan`；`SqliteVecVectorIndex` 仅占位。**设计意图**：个人/中小规模用 BLOB 扫描即可；**资料量很大且评测证明扫描成为瓶颈时**再考虑 sqlite-vec，不作默认）
- Windows OCR 实际推理（PP-OCR/ONNX）与 Windows ModelRuntime 真后端
- CredentialStore、完整评测 CI 门禁矩阵

## 0.3.0 — 2026-08-02

### Breaking / 破坏性变更

- 对话中选择本地文件默认走**会话附件**（绑当前对话），**不再**写入本地资料库
- 「导入资料库」成功后**不再**自动挂到本轮草稿；资料库与对话引用入口拆分

### Added / 新增

- 双命名空间：`conversation_files`（会话附件）与 `knowledge_documents`（持久资料库）
- 共享摄取管线 `services/knowledge/ingest.ts`（library / conversation 双目标）
- `RetrievalScope`：本轮可同时检索资料库文档与会话附件
- API：`/api/conversations/:id/files`（上传 / 列表 / 删除）
- Composer：附到本对话 / 导入资料库 / 选择检索范围（会话附件不提供一键入库）
- 资料库**内容哈希去重**（SHA-256）：相同字节只保留一份，与显示名无关；命中时弹窗提示
- 显示名：导入时可选手填；入库后可重命名（`PATCH /api/knowledge/:id`，不触发重解析）

### Changed / 变更

- `MessageAttachment` kind：`library` | `library_all` | `conversation_file`（兼容旧 `document` / `all`）
- 删对话时级联清理会话附件原件与索引（`.orynode/attachments/`）
- 架构文档补充双命名空间与数据流
- `KnowledgeDocument` 增加 `contentHash` / `originalName`；身份=哈希，名字=元数据
- 资料库「去对话」始终**新开空对话**再挂本轮草稿，不再回到当前历史会话

### Fixed / 修复与架构闭环

- 对话点击停止生成时正确处理流 abort，避免 `BodyStreamBuffer was aborted` 未捕获拒绝；`/api/chat` 转发 `request.signal` 以取消上游推理
- PUT 会话未带 `messages` 时只更新标题，不再误清空消息
- 文件 API 校验附件归属会话；会话附件同样做 embedding 超时恢复
- 「附到本对话」不再被「全部资料」草稿挡住
- 会话附件不展示「入库」；需持久保存时由用户自行「导入资料库」
- 资料库哈希去重仅复用已分块完成的文档；半成品（`awaiting_chunks`）会清理后重新摄取，避免永久锁死
- 推理失败不再预写用户消息到 SQLite，与 UI 回滚一致，不留下幽灵气泡
- 会话附件检索强制 `conversationId` 归属过滤；RAG 文案区分资料库 / 本对话附件
- Composer 可删除会话附件并重建其向量（`POST .../files/:fileId/reindex`）
- 上传会话附件或 PUT 更新已删对话时返回 404，不再用旧 id 复活空壳对话

## 0.2.0 — 2026-08-01

### Changed / 变更

- 资料附件改为**按条消息**：草稿仅作用于下次发送，成功发送后清空；新对话、打开历史、删除当前会话不会恢复输入框旁附件
- 检索范围由本轮附件推导；历史气泡上的附件仅展示，不会自动带入后续轮次的检索
- `useKnowledge` 只负责资料库 CRUD / 上传 / 索引，不再跨轮粘性保存选中

### Fixed / 修复

- PDF 解析与落盘：避免 pdfjs transfer 掏空 `ArrayBuffer` 导致入库空文件
- vinext / Vite 下 pdfjs worker 加载（主线程 fake worker）
- PDF 魔数检测容忍文件头前少量前缀噪声
- 发送失败时回滚输入与草稿；用户消息仅在推理成功或用户停止后落库，不留下孤儿用户气泡
- 删除资料时同步清理草稿中的对应附件

### Docs / 文档

- README（中/英）与架构文档补充「按条附件」产品语义与数据流说明

## 0.1.0 — 2026-07

- 初始公开：V1 源码安装版（对话、本地资料、TurboFieldfare + Gemma 4）
