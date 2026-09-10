/**
 * Agent 工具面（Phase 4）
 *
 * Wiki 读工具已由 Next `/api/knowledge/wiki/pages` 调用（openPage / links / follow）。
 * 规划器仍未落地；Chat 检索走 Engine.retrieve，不经工具循环。
 */

export {
  knowledgeSearch,
  knowledgeOpen,
  knowledgeCitation,
  knowledgeListSources,
  knowledgeRetrieve,
  knowledgeOpenPage,
  knowledgeListBacklinks,
  knowledgeFollowLink,
  knowledgeSearchPages,
  createAgentSpace,
  ensureAgentSpace,
  getAgentSpace,
  assertAgentDocumentQuota,
  resetAgentSpaceMemoryForTests,
} from "./knowledge-tools";
export type { KnowledgeToolContext, AgentSpaceState } from "./knowledge-tools";
