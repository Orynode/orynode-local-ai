/**
 * 本机资源协调（Phase 2 + KE-P0-04 + 8GB memoryPressure）
 *
 * - Chat 使用引用计数；单个请求结束不会误清其它并发 Chat
 * - 重型任务使用唯一 leaseId；release 必须匹配，禁止误释放
 * - 同一 owner 不可重入占用 heavy lock
 * - 内存预算信号走 memoryPressure（勿再塞假 memoryTier 字符串）
 *
 * 不另建 MemoryGovernor 进程：预算裁决留在 CapabilitySnapshot.resolveKnowledgeTier。
 */

import { totalmem } from "node:os";
import {
  classifyHostMemory,
  recommendedMaxContext,
  recommendedRuntimePreset,
  resolveMemoryPressure,
  memoryPressureToResourcePressure,
} from "./host-memory.mjs";

/**
 * @typedef {'chat' | 'embedding' | 'ocr' | 'rerank'} ResourceKind
 */

export function createResourceCoordinator(options = {}) {
  const nowFn = typeof options.now === "function" ? options.now : () => Date.now();
  const totalBytes =
    typeof options.totalmemBytes === "number"
      ? options.totalmemBytes
      : totalmem();
  const hostClass =
    options.hostMemoryClass ?? classifyHostMemory(totalBytes);

  /** @type {Map<string, number>} token -> expiresAt */
  const chatTokens = new Map();
  let heavyLeaseId = null;
  let heavyKind = null;
  let heavyOwner = null;
  let embedResident = false;

  function pruneChat() {
    const t = nowFn();
    for (const [token, until] of chatTokens) {
      if (until <= t) chatTokens.delete(token);
    }
  }

  function isChatActive() {
    pruneChat();
    return chatTokens.size > 0;
  }

  function buildPressureSnapshot() {
    pruneChat();
    const memoryPressure = resolveMemoryPressure({
      hostClass,
      chatActive: isChatActive(),
      heavyKind,
      embedResident,
    });
    return {
      chatActive: isChatActive(),
      chatTokenCount: chatTokens.size,
      chatActiveUntil:
        chatTokens.size > 0 ? Math.max(...chatTokens.values()) : null,
      heavyOwner,
      heavyKind,
      heavyLeaseId,
      hostMemoryClass: hostClass,
      recommendedMaxContext: recommendedMaxContext(hostClass),
      memoryRecommendedPreset: recommendedRuntimePreset(hostClass),
      embedResident,
      memoryPressure,
      resourcePressure: memoryPressureToResourcePressure(memoryPressure),
    };
  }

  return {
    /**
     * 注册一次 Chat 活跃；返回 token，结束时 markChatIdle(token)
     * @returns {string} chatToken
     */
    markChatActive(ttlMs = 120_000) {
      const token = `chat:${nowFn()}:${Math.random().toString(36).slice(2, 10)}`;
      chatTokens.set(token, nowFn() + ttlMs);
      return token;
    },

    /** 心跳续期 */
    touchChat(token, ttlMs = 120_000) {
      if (!token || !chatTokens.has(token)) return false;
      chatTokens.set(token, nowFn() + ttlMs);
      return true;
    },

    /**
     * 释放单个 Chat token；无参时清除全部（兼容旧调用，仅测试/停机用）
     */
    markChatIdle(token) {
      if (token === undefined) {
        chatTokens.clear();
        return;
      }
      chatTokens.delete(token);
    },

    /** ONNX embed pipeline 已驻留进程时标记（卸载前保持 true） */
    setEmbedResident(resident) {
      embedResident = Boolean(resident);
    },

    snapshot() {
      return buildPressureSnapshot();
    },

    /**
     * @param {{ kind: ResourceKind, owner: string, attemptId?: string }} request
     * @returns {{ ok: true, leaseId: string } | { ok: false, reason: string }}
     */
    tryAcquire(request) {
      if (request.kind !== "chat" && isChatActive()) {
        return { ok: false, reason: "chat_priority" };
      }
      if (heavyLeaseId) {
        // 同一 owner 也不可重入
        return { ok: false, reason: "heavy_busy" };
      }
      const attempt =
        request.attemptId ||
        `${nowFn()}:${Math.random().toString(36).slice(2, 8)}`;
      const leaseId = `${request.kind}:${request.owner}:${attempt}`;
      heavyLeaseId = leaseId;
      heavyOwner = request.owner;
      heavyKind = request.kind;
      return { ok: true, leaseId };
    },

    /**
     * 仅释放匹配的 leaseId（错误 id 无效）
     * @param {string} leaseId
     */
    release(leaseId) {
      if (!leaseId || leaseId !== heavyLeaseId) {
        return false;
      }
      heavyLeaseId = null;
      heavyOwner = null;
      heavyKind = null;
      return true;
    },

    shouldDeferHeavyWork() {
      return isChatActive();
    },
  };
}
