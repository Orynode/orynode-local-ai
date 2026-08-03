/**
 * Agent space 持久化 facade（KE-P3-03）
 *
 * Data Service 为权威源；内存 Map 仅作缓存 / data-service 不可达时的降级。
 * 生产路径请用 ensureAgentSpace / assertAgentDocumentQuota（async）。
 */

import {
  AGENT_SPACE_DEFAULTS,
  HTTP_TIMEOUT,
  ORYNODE_DATA_URL,
} from "../../config/defaults";
import type { KnowledgeSpace } from "../knowledge/core/types";

export type AgentSpaceState = KnowledgeSpace & {
  createdAt: string;
  expiresAt: string;
  documentIds: string[];
  maxDocuments: number;
  maxOpenChunks: number;
};

const memory = new Map<string, AgentSpaceState>();

function fromApi(space: AgentSpaceState): AgentSpaceState {
  memory.set(space.id, space);
  return space;
}

async function apiGetByOwner(ownerRef: string): Promise<AgentSpaceState | null> {
  try {
    const response = await fetch(
      `${ORYNODE_DATA_URL}/agent-spaces?ownerRef=${encodeURIComponent(ownerRef)}`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
      },
    );
    if (response.status === 404) return null;
    if (!response.ok) return null;
    const body = (await response.json()) as { space?: AgentSpaceState };
    return body.space ? fromApi(body.space) : null;
  } catch {
    return null;
  }
}

async function apiCreate(input: {
  ownerRef: string;
  maxDocuments?: number;
  ttlHours?: number;
}): Promise<AgentSpaceState | null> {
  try {
    const response = await fetch(`${ORYNODE_DATA_URL}/agent-spaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ownerRef: input.ownerRef,
        maxDocuments: input.maxDocuments ?? AGENT_SPACE_DEFAULTS.maxDocuments,
        maxOpenChunks: AGENT_SPACE_DEFAULTS.maxOpenChunks,
        ttlHours: input.ttlHours ?? AGENT_SPACE_DEFAULTS.ttlHours,
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { space?: AgentSpaceState };
    return body.space ? fromApi(body.space) : null;
  } catch {
    return null;
  }
}

async function apiBind(
  spaceId: string,
  documentId: string,
): Promise<AgentSpaceState | null> {
  try {
    const response = await fetch(
      `${ORYNODE_DATA_URL}/agent-spaces/${encodeURIComponent(spaceId)}/documents`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ documentId }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
      },
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (body.error) throw new Error(body.error);
      return null;
    }
    const body = (await response.json()) as { space?: AgentSpaceState };
    return body.space ? fromApi(body.space) : null;
  } catch (error) {
    if (error instanceof Error && /上限/.test(error.message)) throw error;
    return null;
  }
}

function createMemorySpace(input: {
  ownerRef: string;
  maxDocuments?: number;
  ttlHours?: number;
}): AgentSpaceState {
  const now = Date.now();
  const ttlHours = input.ttlHours ?? AGENT_SPACE_DEFAULTS.ttlHours;
  const space: AgentSpaceState = {
    id: `agent:${input.ownerRef}`,
    kind: "agent",
    ownerRef: input.ownerRef,
    lifecycle: "scoped",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlHours * 3600_000).toISOString(),
    documentIds: [],
    maxDocuments: input.maxDocuments ?? AGENT_SPACE_DEFAULTS.maxDocuments,
    maxOpenChunks: AGENT_SPACE_DEFAULTS.maxOpenChunks,
  };
  memory.set(space.id, space);
  return space;
}

/**
 * 仅内存创建（单测 / data-service 不可达降级）。
 * 生产请用 ensureAgentSpace，避免与 DB 双写漂移。
 */
export function createAgentSpace(input: {
  ownerRef: string;
  maxDocuments?: number;
  ttlHours?: number;
}): AgentSpaceState {
  return createMemorySpace(input);
}

/** 同步读缓存；未命中返回 null（不 fire-and-forget 回填） */
export function getAgentSpace(ownerRef: string): AgentSpaceState | null {
  const id = `agent:${ownerRef}`;
  const space = memory.get(id);
  if (!space) return null;
  if (Date.parse(space.expiresAt) < Date.now()) {
    memory.delete(id);
    return null;
  }
  return space;
}

/** 异步确保 space：先 API，再缓存，最后内存降级 */
export async function ensureAgentSpace(input: {
  ownerRef: string;
  maxDocuments?: number;
  ttlHours?: number;
}): Promise<AgentSpaceState> {
  const cached = getAgentSpace(input.ownerRef);
  if (cached) return cached;
  const fromApiRow = await apiGetByOwner(input.ownerRef);
  if (fromApiRow) return fromApiRow;
  const created = await apiCreate(input);
  if (created) return created;
  return createMemorySpace(input);
}

/** 配额校验并以 Data Service 绑定为准 */
export async function assertAgentDocumentQuota(
  ownerRef: string,
  nextDocumentId: string,
): Promise<AgentSpaceState> {
  const space = await ensureAgentSpace({ ownerRef });
  if (space.documentIds.includes(nextDocumentId)) return space;
  if (space.documentIds.length >= space.maxDocuments) {
    throw new Error(
      `Agent space 已达文档上限（${space.maxDocuments}）；请缩小范围或新建会话`,
    );
  }
  const bound = await apiBind(space.id, nextDocumentId);
  if (bound) return bound;

  // data-service 不可达：仅更新内存降级副本
  space.documentIds.push(nextDocumentId);
  memory.set(space.id, space);
  return space;
}

/** 测试辅助：清空内存缓存 */
export function resetAgentSpaceMemoryForTests(): void {
  memory.clear();
}
