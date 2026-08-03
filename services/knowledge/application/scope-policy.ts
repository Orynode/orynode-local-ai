/**
 * ScopePolicy — 服务端知识读授权（KE-P0-01）
 *
 * chunk id 只是定位符，不能作为授权凭据。
 * 所有 open / citation / listSources 必须先 resolve scope，再校验可见性。
 */

import type { RetrievalScope } from "../types";
import { resolveChatRetrievalScope } from "./resolve-scope";

export type KnowledgeAccessActorKind = "local-user" | "lan-session" | "agent";

export type KnowledgeAccessContext = {
  actor: { kind: KnowledgeAccessActorKind; id: string };
  conversationId?: string | null;
  agentSpaceId?: string;
};

/** 服务端收紧后的检索范围 */
export type ResolvedScope = Exclude<RetrievalScope, { mode: "none" }> | {
  mode: "none";
};

export type ChunkAccessMeta = {
  chunkId: string;
  documentId: string;
  source: "library" | "conversation_file";
  /** conversation 片段必须带归属会话 */
  conversationId?: string | null;
};

export type SourceListItem = {
  id: string;
  name: string;
  status?: string;
  kind: "library" | "source";
};

export interface ScopePolicy {
  resolve(
    requested: RetrievalScope | unknown,
    access: KnowledgeAccessContext,
  ): Promise<ResolvedScope>;
  canReadDocument(documentId: string, scope: ResolvedScope): Promise<boolean>;
  canReadChunk(meta: ChunkAccessMeta, scope: ResolvedScope): Promise<boolean>;
  filterVisibleDocuments<T extends { id: string }>(
    documents: T[],
    scope: ResolvedScope,
  ): T[];
}

export function createScopePolicy(): ScopePolicy {
  return {
    async resolve(requested, access) {
      return resolveChatRetrievalScope({
        retrievalScope: requested,
        conversationId: access.conversationId,
      });
    },

    async canReadDocument(documentId, scope) {
      if (scope.mode === "none") return false;
      if (scope.library === "all") return true;
      if (
        scope.library &&
        typeof scope.library === "object" &&
        scope.library.documentIds.includes(documentId)
      ) {
        return true;
      }
      if (
        scope.conversationFiles &&
        scope.conversationFiles.fileIds.includes(documentId)
      ) {
        return true;
      }
      return false;
    },

    async canReadChunk(meta, scope) {
      if (scope.mode === "none") return false;

      if (meta.source === "library") {
        if (scope.library === "all") return true;
        if (
          scope.library &&
          typeof scope.library === "object" &&
          scope.library.documentIds.includes(meta.documentId)
        ) {
          return true;
        }
        return false;
      }

      // conversation_file：必须 scope 带会话附件，且 conversationId + fileId 双匹配
      const files = scope.conversationFiles;
      if (!files) return false;
      const expectedConversation =
        typeof meta.conversationId === "string" ? meta.conversationId.trim() : "";
      if (!expectedConversation) return false;
      if (files.conversationId !== expectedConversation) return false;
      return files.fileIds.includes(meta.documentId);
    },

    filterVisibleDocuments(documents, scope) {
      if (scope.mode === "none") return [];
      if (scope.library === "all") return documents;
      const allowed = new Set<string>();
      if (scope.library && typeof scope.library === "object") {
        for (const id of scope.library.documentIds) allowed.add(id);
      }
      if (scope.conversationFiles) {
        for (const id of scope.conversationFiles.fileIds) allowed.add(id);
      }
      return documents.filter((doc) => allowed.has(doc.id));
    },
  };
}

/** 默认单例（无状态，可共享） */
export const defaultScopePolicy = createScopePolicy();
