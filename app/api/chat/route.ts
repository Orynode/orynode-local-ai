/**
 * /api/chat — 知识检索唯一走 HybridRetriever；推理唯一走 inferenceService
 */

import {
  EXPECTED_MODEL_ID,
  HTTP_TIMEOUT,
  SEARCH_CONFIG,
  DEFAULT_RUNTIME_SETTINGS,
} from "../../../config/defaults";
import {
  buildSystemPrompt,
  buildKnowledgePrompt,
} from "../../../services/chat/prompt";
import { trimChatHistory } from "../../../services/chat/context";
import {
  HybridRetriever,
  normalizeKnowledgeScope,
} from "../../../services/knowledge";
import { inferenceService } from "../../../services/inference/turbo-fieldfare";
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

    let knowledgePrompt = "";
    const scope = normalizeKnowledgeScope(body);
    if (scope.mode !== "none") {
      try {
        const lastUserMessage = [...body.messages]
          .reverse()
          .find((message: { role: string }) => message?.role === "user");
        const query = lastUserMessage?.content ?? "";
        if (query) {
          const result = await new HybridRetriever().retrieve(query, scope, {
            topK: SEARCH_CONFIG.topK,
          });
          if (result.chunks.length > 0) {
            knowledgePrompt = buildKnowledgePrompt(
              result.chunks.map((chunk) => ({
                documentName: chunk.documentName,
                pageNumber: chunk.pageNumber,
                content: chunk.content,
              })),
            );
          }
        }
      } catch {
        // 选了资料却检索失败：诚实告知模型，勿假装已引用资料
        knowledgePrompt =
          "\n\n（系统：用户已选择本地资料，但本轮检索失败。请正常回答，并说明未能引用资料库。）\n";
      }
    }

    const systemContent = buildSystemPrompt(knowledgePrompt);
    const history = (body.messages as ChatMessage[]).map((message) => ({
      role: message.role,
      content: String(message.content ?? ""),
    }));
    const trimmedHistory = trimChatHistory(systemContent, history, maxContext, {
      maxTokens,
    });

    const messages: ChatMessage[] = [
      { role: "system", content: systemContent },
      ...trimmedHistory,
    ];

    const stream = await inferenceService.chatCompletions(messages, {
      temperature,
      topP,
      topK,
      maxTokens,
      signal: AbortSignal.timeout(HTTP_TIMEOUT.chat),
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    const message =
      error instanceof Error && error.name === "TimeoutError"
        ? "本地模型响应超时"
        : error instanceof Error
          ? error.message
          : "无法连接TurboFieldfare，请先启动本地推理服务";
    const status =
      message.includes("无法连接") || message.includes("超时") ? 503 : 502;
    return Response.json(
      {
        error:
          status === 503 && !message.includes("超时")
            ? "无法连接TurboFieldfare，请先启动本地推理服务"
            : message,
        model: EXPECTED_MODEL_ID,
      },
      { status },
    );
  }
}
