/**
 * 语义感知的文本分块器
 * 优先级：Markdown 标题 → 段落 → 句子 → 短语 → 固定长度
 */

import type { ChunkerConfig, ParsedPage } from "./types";
import { CHUNK_CONFIG } from "../../config/defaults";
import {
  contentLooksLikeMarkdown,
  parseMarkdownHeadingLine,
  pushHeadingPath,
  softNormalizeMarkdown,
  type HeadingStackEntry,
} from "./indexing/markdown-headings";

export interface ChunkResult {
  pageNumber: number;
  position: number;
  content: string;
  headingPath?: string[];
  startLine?: number;
  endLine?: number;
}

type TextSection = {
  text: string;
  headingPath?: string[];
  startLine?: number;
  endLine?: number;
};

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
      let position = 0;
      const sections = this.splitIntoHeadingSections(page);
      for (const section of sections) {
        const pieces = this.chunkText(section.text);
        for (const content of pieces) {
          results.push({
            pageNumber: page.pageNumber,
            position: position++,
            content,
            headingPath: section.headingPath,
            startLine: section.startLine,
            endLine: section.endLine,
          });
        }
      }
    }

    return results;
  }

  /**
   * 页内再按更细标题切开；无标题则整页一节。
   */
  private splitIntoHeadingSections(page: ParsedPage): TextSection[] {
    const text = softNormalizeMarkdown(page.text);
    if (!text) return [];

    const basePath = page.headingPath ? [...page.headingPath] : [];
    if (!contentLooksLikeMarkdown(text) && !/^#{1,6}\s/m.test(text)) {
      return [
        {
          text,
          headingPath: basePath.length > 0 ? basePath : undefined,
          startLine: page.startLine,
          endLine: page.endLine,
        },
      ];
    }

    const lines = text.split("\n");
    const pageStart = page.startLine ?? 1;
    /** 页已带路径时，用「伪层级」重建栈：末级为当前标题 */
    let stack: HeadingStackEntry[] = basePath.map((title, index) => ({
      level: index + 1,
      title,
    }));
    if (basePath.length > 0) {
      stack = stack.slice(0, -1);
    }
    const sections: TextSection[] = [];
    let currentLines: string[] = [];
    let currentPath = basePath.length > 0 ? [...basePath] : undefined;
    let sectionStartLine = pageStart;

    const flush = (endLine: number) => {
      const body = currentLines.join("\n").trim();
      if (!body) {
        currentLines = [];
        return;
      }
      sections.push({
        text: body,
        headingPath:
          currentPath && currentPath.length > 0 ? [...currentPath] : undefined,
        startLine: sectionStartLine,
        endLine,
      });
      currentLines = [];
    };

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      const absoluteLine = pageStart + i;
      const heading = parseMarkdownHeadingLine(line);
      const isPageLeadHeading =
        i === 0 &&
        heading &&
        basePath.length > 0 &&
        basePath[basePath.length - 1] === heading.title;

      if (heading && !isPageLeadHeading && currentLines.length > 0) {
        flush(absoluteLine - 1);
        const pushed = pushHeadingPath(stack, heading);
        stack = pushed.stack;
        currentPath = pushed.path;
        sectionStartLine = absoluteLine;
        currentLines = [line];
        continue;
      }

      if (heading && (currentLines.length === 0 || isPageLeadHeading)) {
        if (!isPageLeadHeading) {
          const pushed = pushHeadingPath(stack, heading);
          stack = pushed.stack;
          currentPath = pushed.path;
        } else {
          currentPath = [...basePath];
          stack = basePath.map((title, index) => ({
            level: index + 1,
            title,
          }));
        }
        sectionStartLine = absoluteLine;
      }

      currentLines.push(line);
    }

    flush(pageStart + lines.length - 1);

    return sections.length > 0
      ? sections
      : [
          {
            text,
            headingPath: basePath.length > 0 ? basePath : undefined,
            startLine: page.startLine,
            endLine: page.endLine,
          },
        ];
  }

  /**
   * 对单段文本进行语义感知分块（保留换行）
   */
  private chunkText(text: string): string[] {
    const normalized = softNormalizeMarkdown(text);
    if (!normalized) return [];
    if (normalized.length <= this.config.maxChunkSize) return [normalized];

    return this.splitBySeparators(normalized);
  }

  /**
   * 按分隔符优先级递归切分
   */
  private splitBySeparators(text: string, separatorIndex = 0): string[] {
    const { separators, maxChunkSize, minChunkSize } = this.config;

    if (separatorIndex >= separators.length) {
      return this.splitByFixedSize(text);
    }

    const separator = separators[separatorIndex]!;
    const segments = text.split(separator);

    if (segments.length <= 1) {
      return this.splitBySeparators(text, separatorIndex + 1);
    }

    const chunks: string[] = [];
    let current = "";

    for (const segment of segments) {
      const trimmed = segment.trim();
      if (!trimmed) continue;

      const candidate = current ? `${current}${separator}${trimmed}` : trimmed;

      if (candidate.length <= maxChunkSize) {
        current = candidate;
      } else if (current.length >= minChunkSize) {
        chunks.push(current);
        current = trimmed;
      } else if (current) {
        const subChunks = this.splitBySeparators(
          candidate,
          separatorIndex + 1,
        );
        chunks.push(...subChunks.slice(0, -1));
        current = subChunks[subChunks.length - 1] ?? "";
      } else {
        const subChunks = this.splitBySeparators(
          trimmed,
          separatorIndex + 1,
        );
        chunks.push(...subChunks.slice(0, -1));
        current = subChunks[subChunks.length - 1] ?? "";
      }
    }

    if (current.length >= minChunkSize) {
      chunks.push(current);
    } else if (current && chunks.length > 0) {
      chunks[chunks.length - 1] += separator + current;
    } else if (current) {
      chunks.push(current);
    }

    return chunks;
  }

  private splitByFixedSize(text: string): string[] {
    const { maxChunkSize, overlapSize, minChunkSize } = this.config;
    const chunks: string[] = [];
    const step = Math.max(1, maxChunkSize - overlapSize);

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
