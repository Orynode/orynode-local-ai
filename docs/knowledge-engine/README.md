# Knowledge Engine 文档

本目录集中存放 **1.1.0** 起的 AI Knowledge Engine 设计、标准与实施记录；**1.2.0** 闭合可学习 Rewrite 与词法阶梯。  
产品级「当前实现」总览仍在上级目录的 [架构文档](../ARCHITECTURE_zh-CN.md)。  
发布说明见根目录 [CHANGELOG 1.2.0](../../CHANGELOG.md#120--2026-08-05)（历史基线：[1.1.0](../../CHANGELOG.md#110--2026-08-03)）。

| 文档 | 用途 | 与代码的关系 |
|---|---|---|
| [长期架构](KNOWLEDGE_ENGINE_ARCHITECTURE_zh-CN.md) | 目标架构、边界、ADR、分阶段路线 | 指导文档；1.1.0 按 Phase 0～3 首批落地 |
| [整改实施计划](KNOWLEDGE_ENGINE_IMPLEMENTATION_PLAN_zh-CN.md) | 符合性审计、整改任务与验收基线 | **权威完成度**：§1.2 已落地表、§1.3 阶段判定、§16 OCR |
| [多语言检索架构](MULTILINGUAL_RETRIEVAL_ARCHITECTURE_zh-CN.md) | 中英混合检索、FTS / 向量与 RRF | 1.2.0 对齐可学习术语库 |
| [查询语义标准](KNOWLEDGE_QUERY_SEMANTICS_STANDARD_zh-CN.md) | 查询解析与召回语义规范 | 词法阶梯 + resolveQueryRewrite |
| [检索档位 UX 调整计划](KNOWLEDGE_RETRIEVAL_TIER_UX_ADJUSTMENT_PLAN_zh-CN.md) | Lite / Balanced / Quality / Auto 体验 | 设置页档位与降级语义已对齐 |
| [RAG 升级完整闭环方案](RAG_UPGRADE_CLOSED_LOOP_zh-CN.md) | **架构终审 + 实现核对表** | 1.2.0 主交付对照 |
| [8GB 冒烟清单](RAG_8GB_SMOKE_CHECKLIST_zh-CN.md) | 真机勾选 + `npm run test:smoke-rag` | RU-001 |

阅读顺序建议：CHANGELOG 1.2.0 → RAG 升级闭环 → 查询语义标准 → 架构文档 →（按需）多语言 / 档位 UX / 实施计划。
