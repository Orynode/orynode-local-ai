# RAG 升级完整闭环方案（8GB 收紧版）

> 状态：**架构终审判定已给出**（见 §终审）  
> 上级约束：`docs/ARCHITECTURE.md` 内存时间线 — 启动约 **5.7GB / 余约 2.3GB**  
> 原则：**整机必须能在 8GB 跑完「检索 + 对话」；会溢出的能力移出本轮主交付**  
> 优先级：**完整性优先于峰值质量** — 先保证闭环始终可跑、可降级、可观测，再谈加 CE 等尖端能力  
> 产品三角：**中英检索 × 完整 RAG × 占用小** — 三者同时满足时，以占用小为否决项

---

## 终审：架构师最终判定

### 判定结论

| 项 | 判定 |
|----|------|
| **总评** | **有条件通过（Conditional Pass）** |
| 目标架构形状 | **通过** — Query → (Vector ∥ BM25) → Fusion → Rerank → LLM |
| 中英检索 | **通过（能力选型正确）** — 词法 FTS 中英分列 + 可选 `multilingual-e5-small`；**评测门禁仍须钉死** |
| 完整 RAG | **通过（按完整性定义）** — 摄取→召回→融合→装箱→LLM→引用→预览；Rerank=词法 |
| 占用小 / 8GB | **通过（硬约束）** — 默认零额外模型；禁止查询时 CE/m3；e5 可选按需 |
| 若坚持查询时 m3 CE | **否决** — 与 Gemma 争 8GB 余量，破坏产品核心 |

**一句话签字意见：**  
采纳「并行 Hybrid + 词法 Rerank」作为 **8GB 正式架构**；`bge-reranker-v2-m3` 不得进入正式档。中英靠 **FTS（必达）+ e5（可选）**；完整靠 **闭环可跑可降级**；小占用靠 **默认 lite、不加 CE**。

### 三约束如何同时满足

```
              中英检索                    完整 RAG                     占用小
                 │                          │                           │
    ┌────────────┼────────────┐             │                           │
    ▼            ▼            ▼             ▼                           ▼
 FTS zh/en   e5 多语言     简繁/术语    摄取→检索→融合→词法Rerank    默认无 embed/CE
  bigram+     共享向量      （轻量）     →LLM→引用→预览              Chat 优先
  token      （可选）                    失败回 FTS                   余量≈2.3GB 不赌 CE
```

冲突时的优先级（否决序）：

1. **占用小**（8GB 能跑）— 否决一切查询时大精排  
2. **完整 RAG**（闭环不断）— 否决「为指标牺牲默认可用」  
3. **中英质量上限** — 在 1、2 满足后再用评测抠 FTS/e5/融合  

### 正式架构（签字版）

```
                         Query + Scope
                               │
                 ┌─────────────┴─────────────┐
                 ▼                           ▼
        Vector Search（可选）          BM25 Search（必达）
     multilingual-e5-small              FTS5 bm25
     + blob_scan                        zh / en / mixed 列
                 │                           │
                 └─────────────┬─────────────┘
                               ▼
                        Hybrid Fusion (RRF)
                               ▼
                     Rerank = Lexical boost
                      （正式档 ≠ Cross-Encoder）
                               ▼
                     Context pack + [S#] → LLM
                               ▼
                        引用 → 原件预览
```

| 档位 | 行为 | RAM |
|------|------|-----|
| lite（**默认/正式开箱**） | 仅 BM25 → LLM | +0 |
| balanced | BM25 ∥ e5 → RRF → LLM | +e5 按需 |
| quality | 多查询 + RRF + **词法** Rerank | +0 新模型 |
| high（非正式） | 可换 CE | **不进 8GB DoD** |

### 中英：正式能力边界（避免过度承诺）

| 场景 | 正式承诺 | 主要手段 |
|------|----------|----------|
| 中文 ↔ 中文 | ✅ | FTS zh bigram + bm25 |
| 英文 ↔ 英文 | ✅ | FTS en token + bm25 |
| 中英混合查询/文档 | ✅ | mixed 列 + planner |
| 简繁 | ✅ 尽力 | 归一/扩展（轻量，无大模型） |
| 跨语言语义（中文问英文库） | △ 可选 | 开 e5 时；**不开语义则不强承诺** |
| 查询时多语言 CE 精排 | ❌ 正式档不承诺 | 附录实验档 |

### 签字前必须闭环的条件（未完成则终审降为「方向通过、发布未通过」）

1. 默认 env 下 **8GB 冒烟**：启动→上传→中英各至少 1 问→对话→点引用预览  
2. `ORYNODE_SEMANTIC_SEARCH` 关时行为 = 纯 FTS，无假 hybrid/假 rerank 标签  
3. retrieval-eval：`keyword`（中/英/混合）主门禁绿  
4. Settings/文档：Quality =「多查询+词法」，**不写语义重排**  
5. Chat active 时不加载第二套检索大模型做精排  
6. 代码与文档写明：正式架构 Rerank = lexical  

### 结合现状的完善路线（形状已齐，欠在质量与诚实）

代码侧终审形状约 **75–80% 已落地**（Engine、HybridRetriever、FTS bm25、可选 e5、RRF、词法 Rerank、引用预览）。完善不是加 CE，而是按下面次序补洞：

| 优先级 | 做什么 | 现状缺口 |
|--------|--------|----------|
| **P0** ✅ | CI 接到 **真实 FTS5** 路径 | `tests/data-service/fts-multilingual-gate.test.mjs` 用 multilingual-p0 跑生产 `searchKeywordIndex` |
| **P0** ✅ | 收紧 MATCH：phrase → AND → **minimum_should_match** | `fts-index.mjs` 按 `lexicalLadder` 执行；**禁止**无条件 OR；短实体/中文短复合 AND 失败即空（交给语义） |
| **P0** ✅ | Chat 生成时推迟 **后台/API embed** | `embedTexts` 在 `chatActive` 时抛 `EMBED_DEFERRED_CHAT`（检索仍在 markChat 之前，hybrid 不受影响） |
| **P0/P1** ✅ | `languagePrimary` → zh/en/mixed 列路由 | data-service 已消费；v2 `{zh_text…}` / `{en_text…}` 收窄 |
| **P1** ✅ | diagnostics / Settings 只报实际策略 | `normalizeDiagnosticStrategies` 不按 profile 预填；Settings Quality=词法重排文案 |
| **P1** ✅ | 术语库 + 可学习 Rewrite | `terminology-v4-learned`：SQLite；**唯一入口** `resolveQueryRewrite`；Planner 只消费注入；`rewriteSource`；upsert 按主查询词合并；高亮共用 `hansHantVariants`；exclude 共用 `containsTerm` |
| **P2** ✅ | Markdown 标题感知分块 | parser/chunker 保留标题路径与换行；citation 优先 markdown locator |
| **P2** ✅ | Knowledge/Chat 展示降级原因 | 稳定码→中文；Settings / 资料库搜索 / 消息摘要 |
| **R0** ✅ | 8GB 冒烟脚本 + 真机清单 | `npm run test:smoke-rag`；`RAG_8GB_SMOKE_CHECKLIST_zh-CN.md` |

详细动作表见同目录实施任务 RU-001 / RU-012～017；禁止项见下文「明确否决项」。

### 明确否决项（再提也不采纳进正式档）

- 用 `bge-reranker-v2-m3`（或任意查询时 CE）填 Rerank 箱并默认/推荐给 8GB  
- 用 CE **替换** embedding  
- 默认强制下载 embedding/reranker  
- 未过 8GB 冒烟就宣称「完整 Hybrid RAG 已交付」  

---

## 0.0 「完整性」定义（不加 m3 时的目标）


不加 Cross-Encoder 时，**完整 RAG** 不指「论文级四段管线齐全」，而指下面这条链路 **端到端稳定闭合**：

```
摄取（parse→chunk→索引）
  → 检索（FTS 必达；e5 可选 hybrid）
  → 融合/装箱（RRF + token pack + [S#]）
  → LLM 生成
  → 引用规范化 → 原件预览
```

且满足：

| 完整性维度 | 含义 | 8GB 做法 |
|------------|------|----------|
| **功能闭合** | 上传→可搜→可答→可点开出处 | 主路径必测 |
| **默认可跑** | 未开语义也能用 | lite = FTS only |
| **失败可续** | embed/向量挂了仍能答 | 回退 keyword，不空崩 |
| **争用不炸** | 对话时不因检索 OOM | Chat 优先，跳过/延迟 e5 |
| **名实一致** | 不宣称未实现的 CE | Quality = 多查询+词法 |
| **可度量** | 回归有门禁 | keyword/hybrid/lexical eval |

**峰值质量（m3 精排）让位于上述完整性。** 先把「每次都能跑完」做硬，再考虑高配实验档。

### 对照：你画的架构如何落地（8GB）

你给的拓扑应理解为 **两路并行召回，再融合，再精排**（BM25 与 Vector 是兄弟，不是 Fusion 的下游）：

```
                    Query
                      │
          ┌───────────┴───────────┐
          ▼                       ▼
    Vector Search              BM25 Search
     (e5，可选)               (FTS5 bm25，必达)
          │                       │
          └───────────┬───────────┘
                      ▼
               Hybrid Fusion (RRF)
                      ▼
                   Rerank
                      ▼
                     LLM
```

| 图中节点 | 8GB 完整性落地 | 说明 |
|----------|----------------|------|
| Vector Search | `multilingual-e5-small` + blob_scan | **可选**；关语义或 Chat 占用则整路关掉 |
| BM25 Search | FTS5 `bm25()` | **主路径**；零额外模型 RAM |
| Hybrid Fusion | RRF / weighted RRF | 仅两路都有候选时融合；单路不宣称 hybrid |
| Rerank | **Lexical boost（词法）** | **不是** m3 Cross-Encoder；避免与 Gemma 争余量 |
| LLM | Gemma via TurboFieldfare | Chat 优先占用内存 |

按档位套到这张图上：

| 档位 | 图上实际亮哪些灯 |
|------|------------------|
| lite | 仅 BM25 →（跳过 Fusion/Rerank）→ LLM |
| balanced | Vector∥BM25 → Fusion →（跳过昂贵 Rerank）→ LLM |
| quality | Vector∥BM25（或偏 FTS 多查询）→ Fusion → **词法 Rerank** → LLM |
| ≥16GB 实验 | 同上，Rerank 可换成 CE（附录 D，非本轮） |

**结论：** 架构形状可以按你的图来；8GB 上「完整性」= 图跑通且可降级，Rerank 箱用词法实现，不接 m3。

---

## 0. 架构师裁决（收紧）

### 0.1 一锤定音

| 问题 | 裁决 |
|------|------|
| 经典图「FTS ∥ 向量 → 融合 → **CE** → LLM」能否作为 **8GB 产品主路径**？ | **不能** |
| 本轮主交付是否包含 `bge-reranker-v2-m3` / 任意查询时 Cross-Encoder？ | **否 — 移出 8GB 闭环；降为附录「≥16GB 实验档」** |
| 8GB 上还能做什么有价值的 RAG 升级？ | **强化 FTS、诚实 hybrid（可选 e5）、融合/词法/评测/资源协调 — 不新增常驻大模型** |
| 默认开箱体验 | **必须仍是：FTS → LLM（零额外模型 RAM）** |

### 0.2 预算账（为何必须砍 CE）

项目文档已给出 8GB 时间线：

```
Startup: Gemma(~2GB) + OS(~3GB) + Node/Browser(~0.7GB) ≈ 5.7GB
余量 ≈ 2.3GB（含尖峰、pdfjs、浏览器标签、索引峰值）

语义 embed（e5-small ONNX）文档估算 ~150MB → 仍可能塞进余量（按需、可回退）
bge-reranker-v2-m3：磁盘 0.55～2.2GB，运行时常驻显著更高
→ 与 Gemma 同机查询时精排 = 余量被吃光 → 换页/OOM → 违反产品核心
```

即便改用「更小 CE」：

- Cross-Encoder 仍是 **查询时** 额外权重；对话路径上 Gemma 已占 ~2GB。
- 「错峰加载」要么拖慢首 token，要么要求卸掉 Gemma（不可接受）。
- 因此：**凡查询时 CE，默认视为 8GB 不可行**，除非有实测证明「Gemma 常驻 + CE infer」在 8GB 不换页——本方案 **不赌这个假设**。

### 0.3 收紧后的产品形态

```
【8GB 主路径 — 本轮必须交付】

  lite（默认）:     问题 → FTS5 bm25 → pack → LLM
  balanced（可选）: 问题 → FTS ∥ e5 → RRF → pack → LLM
                    （e5 仅开关开启；Chat 优先；失败回 FTS）
  quality（8GB）:   问题 → FTS（可多查询）→ weighted RRF → 词法 boost → pack → LLM
                    （禁止加载 CE；UI 不得写「语义重排」）

【≥16GB 实验档 — 不进本轮 DoD / 不进主 CI】

  quality+CE:       … → RRF → Cross-Encoder → LLM
                    （另立 profile；可后续 RFC，默认关闭）
```

---

## 1. 本轮目标（完整性优先，不加 m3）

### 1.1 优先序（从上到下，未完成上层不做下层锦上添花）

1. **默认链路不断** — lite：FTS → pack → LLM → 引用 → 预览  
2. **降级诚实** — 语义关/失败/Chat 占用 → 仍走 FTS，diagnostics 说得清  
3. **可选 hybrid 可靠** — 开 e5 时：FTS ∥ 向量 → RRF → pack；与 Chat 争用让路  
4. **Quality 名实** — 多查询 + lexical boost；不叫语义重排  
5. **评测锁住** — 主 CI 门禁；8GB 冒烟  
6. **（非本轮）** 高配 CE — 附录 D  

### 1.2 要达成的「完整运行」形态

```
【完整性主路径 — 不加 m3】

  摄取就绪的文档
       │
       ├─ 任何时候：FTS5 bm25 可召回
       ├─ 可选：e5 + RRF（开关开且内存/Chat 允许）
       ├─ quality：多查询 + 词法精修（零新模型）
       ▼
  buildContext + [S#] → Gemma → canonicalize → 预览
```

在 **不增加查询时常驻大模型** 的前提下，把检索做成：

1. **更稳的 keyword 主路径**（评测门禁 + 诊断诚实）  
2. **可选、可回退的 hybrid**（e5 保持；与 Chat 争用时让路）  
3. **Quality = 多查询 + 词法精修**，名实相符  
4. **明确拒绝** 在 8GB 宣称「已对齐完整 Hybrid+CE 图」

**明确砍掉（本轮）：**

- `ORYNODE_RERANKER` / `bge-reranker-v2-m3` / 任意 CE 接入实现  
- 为 CE 写的 install 脚本、Settings「语义重排」开关  
- 主 CI 依赖 CE artifact  

**明确保留（以后高配附录）：** Port 接口可预留；实现与门禁不阻塞 8GB 发布。

---

## 2. 缺口重排（按 8GB）

| ID | 缺口 | 本轮？ | 说明 |
|----|------|--------|------|
| T1 | 评测基线弱 | ✅ | R0：keyword / hybrid 可对比 |
| T2 | diagnostics 可能谎报 vector/RRF/rerank | ✅ | 锁策略标签 |
| T3 | Quality 名不副实（lexical 冒充语义重排） | ✅ | UI/capability：8GB quality = 多查询+词法 |
| T4 | e5 与 Chat 争用 | ✅ | 强化 Coordinator；对话中延迟/跳过 embed |
| T5 | FTS / 融合 / 阈值可调优空间 | ✅ | 仅 CPU/算法，零模型 RAM |
| T6 | 上下文 packing / 去冗 | ✅ | 省 token，间接省压力 |
| T7 | 查询时 Cross-Encoder | ❌ 砍 | 溢出风险；附录 D |
| T8 | 换更大 embedding（bge-m3） | ❌ 砍 | 磁盘+RAM 双涨；非 8GB |
| T9 | ANN / sqlite-vec | ❌ 砍 | 非默认；无瓶颈证据不做 |

---

## 3. 目标架构（8GB）

```
                 ┌─ FTS5 bm25（始终）─────────┐
Query + Scope ───┤                            ├─→ RRF（仅两路都有结果）
                 └─ e5 blob_scan（可选开关）──┘         │
                                                        ▼
                                          quality? → 多查询融合 + Lexical boost
                                          （无 CE）
                                                        ▼
                                              buildContext + [S#] → LLM
```

### 3.1 档位（收紧契约）

| 档位 | 向量 | 融合 | 「精排」 | 额外 RAM |
|------|------|------|----------|----------|
| lite | 关 | — | 无 | **0** |
| balanced | 开（能力允许） | RRF | 无 | e5 按需 |
| quality | 同 balanced 策略或仅 FTS 多查询* | weighted RRF | **仅 lexical** | **0 新模型** |
| auto | → balanced 或 lite | 同左 | 无 CE | 同左 |

\* 若 `memoryTier`/压力高：quality 自动降为「多查询 FTS + lexical」，关闭向量，避免 e5+Gemma 尖峰。

---

## 4. 阶段（仅 8GB 主闭环）

### R0 — 基线与 8GB 冒烟

- 冻结 `keyword` / `hybrid_rrf` / `hybrid_rrf_lexical` 基线  
- **强制**：默认 env 下 8GB 机完成 启动→上传→检索→对话  
- 记录空闲余量；对话中 RSS 尖峰  

**验收：** 有数字；无行为变更。

### R1 — 零新增模型的检索加固（原 CE 阶段整体替换）

| 任务 | 内容 |
|------|------|
| R1.1 | diagnostics / strategy 标签审计（禁止假 RRF、假 semantic_rerank） |
| R1.2 | Quality 产品语义改为「多查询 + 词法精修」；Settings 文案同步 |
| R1.3 | `capabilities.rerankerType` 保持 `lexical`；**删除或永不露出**「语义重排已就绪」除非附录 D |
| R1.4 | Chat active：拒绝/延迟 `embed`；检索可降级 keyword-only |
| R1.5 | 可选：fusion 阈值、`minVectorCosineSolo`、packing/MMR 小步调参（评测驱动） |
| R1.6 | 单测 + retrieval-eval 门禁（主策略） |

**验收：** 主 CI 绿；8GB 冒烟仍过；**进程内不出现 CE 模型加载**。

### R2 — 文档与期望管理

- ARCHITECTURE / CHANGELOG：写明 8GB = 无查询时 CE  
- 经典 Hybrid 图标注「完整 CE 需 ≥16GB 实验档」  
- 故障手册：内存压力时关语义、用 lite  

### R3 — 仅当 R0/R1 指标仍差且 **不增模型** 时

- FTS 词项/短语策略微调  
- chunk 参数小步实验  
- **仍禁止** CE / bge-m3 embedding / 默认 ANN  

---

## 5. 任务拆分（收紧）

| ID | 任务 | 阶段 |
|----|------|------|
| RU-001 | eval 基线 + 8GB 冒烟脚本/清单 | R0 ✅ `test:smoke-rag` + 冒烟清单 |
| RU-012 | diagnostics 诚实化 + 单测 | R1 ✅ |
| RU-013 | Quality/Settings 文案与 capability 对齐（无 CE） | R1 ✅ |
| RU-014 | Chat vs embed 资源硬约束加固 | R1 ✅ `EMBED_DEFERRED_CHAT` + coordinator 单测 |
| RU-015 | 融合/阈值/packing 评测驱动小改（可选） | R1 |
| RU-016 | 主 CI 门禁（keyword/hybrid/lexical） | R1 ✅ `test:retrieval-eval` + `test:smoke-rag` |
| RU-017 | 文档：8GB 边界 + 附录 D 指针 | R2 ✅ ARCHITECTURE / 冒烟清单 |
| RU-090 | （非本轮）≥16GB CE RFC | 附录 D |

原 `RU-000/002～010` 的 CE 实现 **整表冻结**，不进入本轮 sprint。

---

## 6. 评测门禁

| 策略 | 8GB 主门禁 |
|------|------------|
| `keyword` | ✅ 必须 |
| `hybrid_rrf` | ✅ 语义开时；失败则关语义仍可合并 |
| `hybrid_rrf_lexical` | ✅ quality 形态 |
| `hybrid_rrf_ce` | ❌ 本轮不设；不进 DoD |

**合并红线：** 默认配置下 8GB 冒烟失败 → 不合并。

---

## 7. 非目标（加严）

- 任何查询时 Cross-Encoder（含 m3 / base / INT8）作为本轮交付  
- 默认或推荐用户在 8GB 上同时开「对话 + 语义 + 精排」  
- 用更大 embedding 换指标  
- 牺牲可运行性换「架构图对齐感」  

---

## 8. 完成定义（8GB）

1. 默认：FTS → LLM，零额外模型  
2. 可选：FTS ∥ e5 → RRF → LLM，可关、可回退  
3. Quality：多查询 + lexical；**文案不称语义重排**  
4. 8GB 冒烟通过；对话中不加载第二套大模型做精排  
5. 评测主门禁绿  
6. 引用预览回归通过  
7. 文档写清：完整 CE Hybrid ≠ 8GB 产品承诺  

---

## 附录 A — 环境（8GB 推荐）

```bash
# 默认建议（最稳）
# ORYNODE_SEMANTIC_SEARCH 保持 unset/0
# knowledgeTier=lite 或 auto→lite

# 需要 hybrid 时再开（接受与 Chat 错峰）
# ORYNODE_SEMANTIC_SEARCH=1
# ORYNODE_EMBEDDING_ARTIFACT=multilingual-e5-small

# 本轮不要增加：
# ORYNODE_RERANKER=*
```

## 附录 B — 签字条件

- [ ] 8GB 默认路径可完整使用产品（真机清单 A）
- [x] 代码路径无 CE 加载入口（或死代码未接线且默认不可达）— `test:smoke-rag` 扫描
- [x] Settings/文档无「8GB 语义重排」误导 — Quality = 词法重排
- [x] Chat active 时 embed 让路有测试 — `resource-coordinator.test.mjs`
- [x] 主 CI 不下载 reranker 权重 — `test:retrieval-eval` / `test:smoke-rag`

## 附录 C — 与旧稿关系

上一版「接入 bge-reranker-v2-m3」在 **整机 8GB 硬顶** 下判定为 **会造成溢出风险的主路径膨胀**，故整体降级：

- 主闭环 = 本文 R0–R2（无 CE）  
- CE = 附录 D，不计入本轮完成  

## 附录 D — ≥16GB 实验档（非承诺）

仅当产品明确提供「高内存档」且用户机实测余量充足时，另立 RFC：

- 独立 profile：`ORYNODE_MEMORY_PROFILE=high`  
- 查询时 CE 与 Gemma **禁止双常驻**；须证明 unload 或分时策略  
- 主 CI / 8GB DoD **永不依赖** 该档  

在 8GB 主产品未稳定前，**不启动**该 RFC 实现。
