/**
 * Agent 工具面（Phase 4）
 *
 * 规划器 / Runtime 尚未落地；知识工具先稳定契约，供后续 Agent 循环调用。
 */

export {
  knowledgeSearch,
  knowledgeOpen,
  knowledgeCitation,
  knowledgeListSources,
  knowledgeRetrieve,
  createAgentSpace,
  ensureAgentSpace,
  getAgentSpace,
  assertAgentDocumentQuota,
  resetAgentSpaceMemoryForTests,
} from "./knowledge-tools";
export type { KnowledgeToolContext, AgentSpaceState } from "./knowledge-tools";
