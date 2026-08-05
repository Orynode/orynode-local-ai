# RAG 8GB 冒烟清单（RU-001）

> 目标机型：**8GB 统一内存 MacBook Air**（或等价余量）。  
> 自动门禁（CI / 开发机）：`npm run test:smoke-rag`  
> 下列步骤须在 **真机** 上勾选；未过则不得宣称「完整 Hybrid RAG 已交付」。

## A. 默认路径（语义关闭）

推荐环境：

```bash
# .env.local 建议
# ORYNODE_SEMANTIC_SEARCH 保持 unset 或 0
# knowledgeTier = auto 或 lite
```

| # | 步骤 | 期望 | ☐ |
|---|------|------|---|
| A1 | `npm run local`（或等价）冷启动成功 | 页面可开，无 OOM 杀进程 | ☐ |
| A2 | 观察空闲余量（活动监视器 / `memory_pressure`） | 启动后仍有可用余量（文档估 ~2GB 级，以实测为准） | ☐ |
| A3 | 资料库上传一份中文 Markdown | 状态 ready，可搜 | ☐ |
| A4 | 资料库上传一份英文 TXT/MD | 可搜 | ☐ |
| A5 | 工作台关键词检索中文问句 | 有命中；diagnostics 为 keyword（无假 vector/RRF） | ☐ |
| A6 | 工作台关键词检索英文问句 | 有命中 | ☐ |
| A7 | 新对话勾选资料后提问 | 模型作答；可展开引用 / 预览原文 | ☐ |
| A8 | Settings 选「省资源」 | 仍可检索；无额外模型加载 | ☐ |

## B. 可选 Hybrid（语义开，错峰）

仅在接受「与 Chat 错峰」时测：

```bash
ORYNODE_SEMANTIC_SEARCH=1
# ORYNODE_EMBEDDING_ARTIFACT=multilingual-e5-small
```

| # | 步骤 | 期望 | ☐ |
|---|------|------|---|
| B1 | 开启语义后补建向量（不在对话高峰） | 索引进度可见；失败可回退 keyword | ☐ |
| B2 | Balanced / Auto→balanced 检索 | diagnostics 可含 vector+rrf；失败则降级诚实 | ☐ |
| B3 | **对话生成中**触发 embed API / 后台补建 | `EMBED_DEFERRED_CHAT` / 503，对话不崩 | ☐ |
| B4 | Quality（词法重排）一问 | 文案/capability 为 lexical；**不**加载 CE | ☐ |

## C. 明确否决（任一项出现即失败）

| # | 现象 | ☐ 未出现 |
|---|------|----------|
| C1 | 查询路径加载 `bge-reranker` / Cross-Encoder | ☐ |
| C2 | 默认推荐「对话 + 语义 + 精排」同开 | ☐ |
| C3 | Settings 宣称 8GB「语义精排已就绪」 | ☐ |
| C4 | 默认 env 下对话中因检索 OOM / 重度换页不可用 | ☐ |

## D. 记录（签字用）

```text
机型 / macOS：
空闲余量（启动后）：
对话中 RSS 尖峰（可选）：
ORYNODE_SEMANTIC_SEARCH：
knowledgeTier：
日期 / 测试人：
自动门禁：npm run test:smoke-rag → pass / fail
```

相关：[`RAG_UPGRADE_CLOSED_LOOP_zh-CN.md`](./RAG_UPGRADE_CLOSED_LOOP_zh-CN.md) 附录 A–D。
