/**
 * /api/chat — 知识能力只经 KnowledgeEngine；推理经 ModelRuntime port
 */

import { randomUUID } from "node:crypto";
import {
  EXPECTED_MODEL_ID,
  HTTP_TIMEOUT,
  SEARCH_CONFIG,
  DEFAULT_RUNTIME_SETTINGS,
} from "../../../config/defaults";
import {
  buildSystemPrompt,
  extractReferencedCitationIds,
} from "../../../services/chat/prompt";
import { wrapChatStreamWithMetadata } from "../../../services/chat/sse";
import {
  estimateTokens,
  resolveContextBudget,
  trimChatHistoryToTokenBudget,
} from "../../../services/chat/context";
import {
  buildChatKnowledgeContext,
  createKnowledgeEngine,
} from "../../../services/knowledge";
import {
  markChatResourceActive,
  markChatResourceIdle,
  releaseEmbeddingBeforeGeneration,
} from "../../../services/knowledge/resource";
import { resolveQueryRewrite } from "../../../services/knowledge/query/resolve-rewrite";
import {
  createRuntimeServices,
  requireLanAccess,
} from "../../../services/platform";
import type { ChatMessage } from "../../../services/types";

function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export async function POST(request: Request) {
  try {
    const access = requireLanAccess(request);
    if (!access.ok) {
      return Response.json(
        { error: access.error, code: access.code },
        { status: access.status },
      );
    }

    const body = await request.json();
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return Response.json({ error: "消息不能为空" }, { status: 400 });
    }

    const temperature = Number(
      clampNumber(body.temperature, 0, 2, 0.2).toFixed(2),
    );
    const topP = Number(clampNumber(body.topP, 0.01, 1, 0.95).toFixed(2));
    const topK = Math.round(clampNumber(body.topK, 0, 256, 64));
    const maxTokens = Math.round(clampNumber(body.maxTokens, 0, 65536, 0));
    const maxContext = Math.round(
      clampNumber(
        body.maxContext,
        1024,
        131072,
        DEFAULT_RUNTIME_SETTINGS.maxContext,
      ),
    );

    const conversationId =
      typeof body.conversationId === "string" && body.conversationId.trim()
        ? body.conversationId.trim()
        : null;

    let knowledgeTier =
      body.knowledgeTier === "auto" ||
      body.knowledgeTier === "balanced" ||
      body.knowledgeTier === "quality" ||
      body.knowledgeTier === "lite"
        ? body.knowledgeTier
        : undefined;
    if (!knowledgeTier) {
      const { readKnowledgeTierSetting } = await import(
        "../../../services/knowledge/application/capabilities"
      );
      knowledgeTier = await readKnowledgeTierSetting();
    }
    // Chat 检索阶段禁止额外调用生成模型做 query rewrite，确保 embedding
    // 与 Gemma 不会因改写任务同时驻留。
    const engine = createKnowledgeEngine({
      resolveRewrite: (query) => resolveQueryRewrite(query, { skipLlm: true }),
    });

    const history = (body.messages as ChatMessage[]).map((message) => ({
      role: message.role,
      content: String(message.content ?? ""),
    }));
    const systemBase = buildSystemPrompt("");
    const outputReserve =
      maxTokens > 0
        ? Math.min(maxTokens, Math.floor(maxContext * 0.4))
        : Math.max(512, Math.floor(maxContext * 0.15));
    const budget = resolveContextBudget({
      modelContextTokens: maxContext,
      systemBaseTokens: estimateTokens(systemBase) + 8,
      outputReserveTokens: outputReserve,
    });
    const trimmedHistory = trimChatHistoryToTokenBudget(
      history,
      budget.historyBudgetTokens,
    );

    const built = await buildChatKnowledgeContext(engine, {
      messages: body.messages,
      retrievalScope: body.retrievalScope,
      knowledgeScope: body.knowledgeScope,
      knowledgeDocumentId: body.knowledgeDocumentId,
      conversationId,
      topK: SEARCH_CONFIG.topK,
      knowledgeTier,
      knowledgeBudgetTokens: budget.knowledgeBudgetTokens,
    });
    const { knowledgePrompt, retrieval, context } = built;

    // 阶段化调度：先在空闲资源态完成混合检索，再释放 embedding，
    // 最后标记生成阶段，让 Gemma 与后台重任务互斥。
    await releaseEmbeddingBeforeGeneration();
    const chatResourceToken = await markChatResourceActive(HTTP_TIMEOUT.chat);

    const systemContent = buildSystemPrompt(knowledgePrompt);

    const messages: ChatMessage[] = [
      { role: "system", content: systemContent },
      ...trimmedHistory,
    ];

    // 客户端停止生成 → request.signal；同时保留超时上限
    const signal =
      typeof AbortSignal.any === "function"
        ? AbortSignal.any([
            request.signal,
            AbortSignal.timeout(HTTP_TIMEOUT.chat),
          ])
        : request.signal.aborted
          ? request.signal
          : AbortSignal.timeout(HTTP_TIMEOUT.chat);

    const runtime = createRuntimeServices();
    let upstream: ReadableStream<Uint8Array>;
    try {
      upstream = await runtime.model.chat(messages, {
        temperature,
        topP,
        topK,
        maxTokens,
        signal,
      });
    } catch (error) {
      await markChatResourceIdle(chatResourceToken);
      throw error;
    }

    const providedCitations = context?.citations ?? [];
    const retrievalTraceId = randomUUID();
    const stream = wrapChatStreamWithMetadata(
      upstream,
      {
        type: "metadata",
        providedCitations,
        retrievalTraceId,
        diagnostics: retrieval?.diagnostics ?? null,
        capabilities: {
          approximateTokens: context?.approximateTokens !== false,
          knowledgeBudgetTokens: budget.knowledgeBudgetTokens,
          sseVersion: 1,
        },
      },
      {
        // 只抽取 ids（不改正文）。正文规范化与落库仅由客户端 finalizeAnswer 负责。
        onComplete: (fullText) => ({
          type: "done",
          referencedCitationIds: extractReferencedCitationIds(
            fullText,
            providedCitations.map((item) => item.id),
          ),
        }),
        onFinally: () => {
          void markChatResourceIdle(chatResourceToken);
        },
      },
    );

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    // 错误脱敏：只回传语义化文案，不透出内部堆栈/路径/URL 细节
    const isAbort =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    const message = isAbort
      ? "本地模型响应超时"
      : error instanceof Error
        ? error.message
        : "无法连接TurboFieldfare，请先启动本地推理服务";
    const sanitized =
      message.includes("无法连接") || message.includes("超时")
        ? "无法连接TurboFieldfare，请先启动本地推理服务或检查模型状态"
        : message;
    const status = isAbort ? 503 : 502;
    console.error("[chat] upstream error:", error);
    return Response.json(
      {
        error: sanitized,
        model: EXPECTED_MODEL_ID,
      },
      { status },
    );
  }
}
