# Changelog

本项目在 `1.0.0` 之前遵循 [SemVer](https://semver.org/lang/zh-CN/) 的 `0.x` 约定：破坏性或用户可见行为变化可递增次版本（`0.Y.0`），纯修复递增修订号（`0.Y.Z`）。  
产品线「V1 源码安装版 / V2 签名安装包」见 README，与 npm `version` 不是同一套编号。

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
