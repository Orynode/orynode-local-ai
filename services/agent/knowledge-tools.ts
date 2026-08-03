/**
 * Agent 知识工具（Phase 4 + KE-P0-01 + KE-P3-03）
 *
 * 不实现 Agent 规划；只把 Knowledge Engine 暴露为受控工具。
 * open / citation / listSources 必须携带 Scope，禁止仅凭 chunk id 越权读取。
 */

import {
  HTTP_TIMEOUT,
  ORYNODE_DATA_URL,
  type KnowledgeTier,
} from "../../config/defaults";
import type {
  RetrievalResponse,
  ResolvedCitation,
  SearchResponse,
} from "../knowledge/core/types";
import { KnowledgeError } from "../knowledge/core/errors";
import type { RetrievalHit, RetrievalScope } from "../knowledge/types";
import {
  createKnowledgeEngine,
} from "../knowledge/application/engine";
import {
  defaultScopePolicy,
  type KnowledgeAccessContext,
} from "../knowledge/application/scope-policy";
import { readKnowledgeTierSetting } from "../knowledge/application/capabilities";
import {
  assertAgentDocumentQuota,
  createAgentSpace,
  ensureAgentSpace,
  getAgentSpace,
  resetAgentSpaceMemoryForTests,
  type AgentSpaceState,
} from "./agent-space";

export type { AgentSpaceState };
export {
  assertAgentDocumentQuota,
  createAgentSpace,
  ensureAgentSpace,
  getAgentSpace,
  resetAgentSpaceMemoryForTests,
};

export type KnowledgeToolContext = {
  scope: RetrievalScope;
  conversationId?: string | null;
  tier?: KnowledgeTier;
  topK?: number;
  ownerRef?: string;
};

function accessFrom(ctx: KnowledgeToolContext): KnowledgeAccessContext {
  return {
    actor: {
      kind: "agent",
      id: ctx.ownerRef ?? "anonymous-agent",
    },
    conversationId: ctx.conversationId,
    agentSpaceId: ctx.ownerRef ? `agent:${ctx.ownerRef}` : undefined,
  };
}

async function engineFor(tier: KnowledgeTier) {
  return createKnowledgeEngine({ knowledgeTier: tier });
}

/** knowledge.search */
export async function knowledgeSearch(
  query: string,
  ctx: KnowledgeToolContext,
): Promise<SearchResponse> {
  const tier = ctx.tier ?? (await readKnowledgeTierSetting());
  const engine = await engineFor(tier);
  return engine.search(
    {
      query,
      scope: ctx.scope,
      topK: ctx.topK,
      conversationId: ctx.conversationId,
      knowledgeTier: tier,
    },
    accessFrom(ctx),
  );
}

/** knowledge.open — 必须在 ctx.scope 内 */
export async function knowledgeOpen(
  chunkId: string,
  ctx: KnowledgeToolContext,
): Promise<RetrievalHit> {
  if (!ctx?.scope || ctx.scope.mode === "none") {
    throw new KnowledgeError(
      "chunk_not_in_scope",
      "CHUNK_NOT_IN_SCOPE",
    );
  }
  const engine = createKnowledgeEngine({ knowledgeTier: "lite" });
  return engine.openChunk(
    { chunkId, scope: ctx.scope },
    accessFrom(ctx),
  );
}

/** knowledge.citation — 必须在 ctx.scope 内 */
export async function knowledgeCitation(
  chunkId: string,
  ctx: KnowledgeToolContext,
): Promise<ResolvedCitation> {
  if (!ctx?.scope || ctx.scope.mode === "none") {
    return {
      citation: {
        id: chunkId,
        chunkId,
        documentId: "",
        revisionId: "legacy",
        processingBuildId: "legacy",
        title: "",
        sourceType: "unknown",
        locator: { kind: "text", startOffset: 0, endOffset: 0 },
        excerpt: "",
      },
      available: false,
      reason: "unavailable",
    };
  }
  const engine = createKnowledgeEngine({ knowledgeTier: "lite" });
  return engine.resolveCitation(
    { chunkId, scope: ctx.scope },
    accessFrom(ctx),
  );
}

/** knowledge.listSources — 仅返回当前 scope 可见文档/来源 */
export async function knowledgeListSources(
  ctx: KnowledgeToolContext,
  options: { includeConnectors?: boolean } = {},
): Promise<{
  documents: Array<{ id: string; name: string; status?: string }>;
  sources: Array<{ id: string; type: string; name: string; status: string }>;
}> {
  const access = accessFrom(ctx);
  const scope = await defaultScopePolicy.resolve(ctx.scope, access);
  if (scope.mode === "none") {
    return { documents: [], sources: [] };
  }

  const [docsRes, sourcesRes] = await Promise.all([
    fetch(`${ORYNODE_DATA_URL}/knowledge`, {
      cache: "no-store",
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
    }),
    options.includeConnectors === false
      ? Promise.resolve(null)
      : fetch(`${ORYNODE_DATA_URL}/sources`, {
          cache: "no-store",
          signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
        }),
  ]);

  const docsBody = docsRes.ok ? await docsRes.json() : { documents: [] };
  const sourcesBody =
    sourcesRes && sourcesRes.ok ? await sourcesRes.json() : { sources: [] };

  const allDocs = (docsBody.documents ?? []).map(
    (d: { id: string; name: string; status?: string }) => ({
      id: d.id,
      name: d.name,
      status: d.status,
    }),
  );

  return {
    documents: defaultScopePolicy.filterVisibleDocuments(allDocs, scope),
    // Connector Source 列表：library:all 才返回；文档级 scope 暂不暴露连接器全表
    sources:
      scope.library === "all"
        ? (sourcesBody.sources ?? []).map(
            (s: { id: string; type: string; name: string; status: string }) => ({
              id: s.id,
              type: s.type,
              name: s.name,
              status: s.status,
            }),
          )
        : [],
  };
}

/** 供评测：同一检索路径返回完整 RetrievalResponse */
export async function knowledgeRetrieve(
  query: string,
  ctx: KnowledgeToolContext,
): Promise<RetrievalResponse> {
  const tier = ctx.tier ?? (await readKnowledgeTierSetting());
  const engine = await engineFor(tier);
  return engine.retrieve(
    {
      query,
      scope: ctx.scope,
      topK: ctx.topK,
      conversationId: ctx.conversationId,
      knowledgeTier: tier,
    },
    accessFrom(ctx),
  );
}
