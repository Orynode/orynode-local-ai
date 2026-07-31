/**
 * 语义感知的文本分块器
 * 优先级：段落 → 句子 → 短语 → 固定长度
 */

import type { ChunkerConfig, ParsedPage } from "./types";
import { CHUNK_CONFIG } from "../../config/defaults";

export interface ChunkResult {
  pageNumber: number;
  position: number;
  content: string;
}

/**
 * 创建分块器
 */
export function createChunker(config: Partial<ChunkerConfig> = {}) {
  const cfg: ChunkerConfig = { ...CHUNK_CONFIG, ...config };
  return new TextChunker(cfg);
}

class TextChunker {
  constructor(private config: ChunkerConfig) {}

  /**
   * 将解析后的文档按页分块
   */
  chunkDocument(pages: ParsedPage[]): ChunkResult[] {
    const results: ChunkResult[] = [];

    for (const page of pages) {
      const chunks = this.chunkText(page.text);
      chunks.forEach((content, position) => {
        results.push({
          pageNumber: page.pageNumber,
          position,
          content,
        });
      });
    }

    return results;
  }

  /**
   * 对单段文本进行语义感知分块
   */
  private chunkText(text: string): string[] {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) return [];
    if (normalized.length <= this.config.maxChunkSize) return [normalized];

    return this.splitBySeparators(normalized);
  }

  /**
   * 按分隔符优先级递归切分
   */
  private splitBySeparators(
    text: string,
    separatorIndex = 0,
  ): string[] {
    const { separators, maxChunkSize, minChunkSize } = this.config;

    // 已尝试所有分隔符，降级为固定长度切分
    if (separatorIndex >= separators.length) {
      return this.splitByFixedSize(text);
    }

    const separator = separators[separatorIndex];
    const segments = text.split(separator);

    // 如果切分后只有一个片段，尝试下一个分隔符
    if (segments.length <= 1) {
      return this.splitBySeparators(text, separatorIndex + 1);
    }

    const chunks: string[] = [];
    let current = "";

    for (const segment of segments) {
      const trimmed = segment.trim();
      if (!trimmed) continue;

      const candidate = current
        ? `${current}${separator}${trimmed}`
        : trimmed;

      if (candidate.length <= maxChunkSize) {
        current = candidate;
      } else {
        // 当前累积内容先保存
        if (current.length >= minChunkSize) {
          chunks.push(current);
          current = trimmed;
        } else if (current) {
          // 太短，尝试与下一个合并，或使用更深层的分隔符
          const subChunks = this.splitBySeparators(
            candidate,
            separatorIndex + 1,
          );
          chunks.push(...subChunks.slice(0, -1));
          current = subChunks[subChunks.length - 1] ?? "";
        } else {
          // 单个片段就超过 maxChunkSize，使用更深层分隔符
          const subChunks = this.splitBySeparators(
            trimmed,
            separatorIndex + 1,
          );
          chunks.push(...subChunks.slice(0, -1));
          current = subChunks[subChunks.length - 1] ?? "";
        }
      }
    }

    if (current.length >= minChunkSize) {
      chunks.push(current);
    } else if (current && chunks.length > 0) {
      // 剩余太短，合并到最后一个 chunk
      chunks[chunks.length - 1] += separator + current;
    } else if (current) {
      chunks.push(current);
    }

    return chunks;
  }

  /**
   * 固定长度滑动窗口切分（最终降级方案）
   */
  private splitByFixedSize(text: string): string[] {
    const { maxChunkSize, overlapSize, minChunkSize } = this.config;
    const chunks: string[] = [];
    const step = maxChunkSize - overlapSize;

    for (let start = 0; start < text.length; start += step) {
      const chunk = text.slice(start, start + maxChunkSize);
      if (chunk.length >= minChunkSize) {
        chunks.push(chunk);
      }
      if (start + maxChunkSize >= text.length) break;
    }

    return chunks;
  }
}
