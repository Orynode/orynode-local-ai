/**
 * 本地 LLM 结构化 Query Rewrite（TurboFieldfare非流式）
 */

import {
  EXPECTED_MODEL_ID,
  HTTP_TIMEOUT,
  TURBO_FIELDFARE_URL,
} from "../../../config/defaults";

export type LlmRewritePayload = {
  domain?: string;
  synonyms: string[];
  exclude: string[];
};

const SYSTEM = `你是检索查询改写器。只输出一个 JSON 对象，不要 markdown，不要解释。
字段：
- domain: 简短领域（可空字符串）
- synonyms: 字符串数组，与用户查询同义的完整短语（含中英对照），每项保持完整边界，禁止拆成单词
- exclude: 字符串数组，易混淆但应排除的完整短语
规则：
1. synonyms 不要重复用户原句
2. 不要输出单字；中文至少 2 字，英文至少 1 个完整词/短语
3. 「反向代理」与「代理/正向代理」不同；「钠离子电池」与「电池」不同
4. 最多 6 个 synonyms、4 个 exclude`;

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence?.[1]?.trim() || trimmed;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizePayload(raw: unknown): LlmRewritePayload | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const synonyms = Array.isArray(obj.synonyms)
    ? obj.synonyms
        .map((s) => String(s ?? "").replace(/\s+/g, " ").trim())
        .filter((s) => s.length >= 2)
    : [];
  const exclude = Array.isArray(obj.exclude)
    ? obj.exclude
        .map((s) => String(s ?? "").replace(/\s+/g, " ").trim())
        .filter((s) => s.length >= 2)
    : [];
  const domain =
    typeof obj.domain === "string" ? obj.domain.trim() || undefined : undefined;
  if (synonyms.length === 0 && exclude.length === 0) return null;
  return {
    domain,
    synonyms: [...new Set(synonyms)].slice(0, 6),
    exclude: [...new Set(exclude)].slice(0, 4),
  };
}

/**
 * 调用本地模型做一次非流式改写；失败返回 null。
 */
export async function rewriteQueryWithLlm(
  query: string,
  options: { signal?: AbortSignal; baseUrl?: string; modelId?: string } = {},
): Promise<LlmRewritePayload | null> {
  const trimmed = query.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;

  const baseUrl = options.baseUrl ?? TURBO_FIELDFARE_URL;
  const modelId = options.modelId ?? EXPECTED_MODEL_ID;

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: modelId,
        temperature: 0.1,
        max_completion_tokens: 256,
        stream: false,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: trimmed },
        ],
      }),
      signal:
        options.signal ?? AbortSignal.timeout(Math.min(HTTP_TIMEOUT.chat, 45_000)),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) return null;
    return normalizePayload(extractJsonObject(content));
  } catch {
    return null;
  }
}
