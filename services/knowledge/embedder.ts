/**
 * Embedding 提供者
 *
 * vinext API 跑在 Workers，无法直接加载 @xenova/transformers（ONNX/原生）。
 * 因此 Embedder 通过本机 data-service（真实 Node）计算向量：
 *   GET  /knowledge/embed/status
 *   POST /knowledge/embed
 *
 * 默认关闭；开启 ORYNODE_SEMANTIC_SEARCH 且 data-service 能加载模型后可用。
 */

import type { Embedder } from "./types";
import {
  EMBEDDING_CONFIG,
  HTTP_TIMEOUT,
  ORYNODE_DATA_URL,
  SEARCH_CONFIG,
} from "../../config/defaults";

class DataServiceEmbedder implements Embedder {
  readonly dimension = EMBEDDING_CONFIG.dimension;
  readonly modelName = EMBEDDING_CONFIG.modelName;
  private readonly dataUrl: string;
  private lastError: string | null = null;

  constructor(dataUrl = ORYNODE_DATA_URL) {
    this.dataUrl = dataUrl;
  }

  getUnavailableReason(): string | null {
    return this.lastError;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.dataUrl}/knowledge/embed/status`, {
        cache: "no-store",
        signal: AbortSignal.timeout(HTTP_TIMEOUT.embeddingStatus),
      });
      if (!response.ok) {
        this.lastError =
          "本地数据服务不支持向量接口，请重启 npm run local（需较新的 data-service）";
        return false;
      }
      const result = (await response.json()) as {
        available?: boolean;
        reason?: string;
        model?: string;
        dimension?: number;
      };
      if (!result.available) {
        this.lastError =
          result.reason ||
          "向量模型不可用。请确认 data-service 已启动且能访问模型缓存";
        return false;
      }
      this.lastError = null;
      return true;
    } catch {
      this.lastError =
        "无法连接本地数据服务的向量接口（127.0.0.1:4318）。请确认 npm run local 已启动";
      return false;
    }
  }

  async embed(text: string): Promise<Float32Array> {
    const [vector] = await this.embedBatch([text]);
    return vector;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const batchSize = Math.max(1, EMBEDDING_CONFIG.batchSize);
    const output: Float32Array[] = [];

    for (let offset = 0; offset < texts.length; offset += batchSize) {
      const slice = texts.slice(offset, offset + batchSize);
      const response = await fetch(`${this.dataUrl}/knowledge/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ texts: slice }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT.embedding),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          (result as { error?: string }).error || "向量计算失败",
        );
      }
      const vectors = (result as { vectors?: number[][] }).vectors ?? [];
      if (vectors.length !== slice.length) {
        throw new Error("向量返回数量与文本不一致");
      }
      for (const vector of vectors) {
        output.push(new Float32Array(vector));
      }
    }

    return output;
  }
}

let cached: Embedder | undefined;
let cachedReason: string | null = null;
let negativeUntil = 0;

/**
 * 解析当前可用的 Embedder。
 * 成功结果缓存；失败短时退避后可重试（避免 data-service 晚启动后永久失效）。
 */
export async function resolveEmbedder(): Promise<Embedder | null> {
  if (!SEARCH_CONFIG.semanticSearchEnabled) {
    cachedReason = "未开启语义检索（ORYNODE_SEMANTIC_SEARCH）";
    return null;
  }
  if (cached) {
    return cached;
  }
  if (Date.now() < negativeUntil) {
    return null;
  }

  const embedder = new DataServiceEmbedder();
  const ok = await embedder.isAvailable();
  if (ok) {
    cached = embedder;
    cachedReason = null;
    negativeUntil = 0;
    return cached;
  }

  cachedReason = embedder.getUnavailableReason();
  negativeUntil = Date.now() + 15_000;
  return null;
}

/** 最近一次 resolveEmbedder 失败原因（供 reindex 提示） */
export function getEmbedderUnavailableReason(): string | null {
  return cachedReason;
}

/** 测试或切换 ORYNODE_SEMANTIC_SEARCH 后清空缓存 */
export function resetEmbedderCache(): void {
  cached = undefined;
  cachedReason = null;
  negativeUntil = 0;
}
