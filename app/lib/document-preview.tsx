"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { MessageCitation } from "../../services/types";

export type DocumentPreviewSource = "library" | "conversation_file";

/** 打开原件预览的统一意图（资料库 / 胶囊 / 检索命中共用） */
export type DocumentPreviewIntent = {
  documentId: string;
  sourceType: DocumentPreviewSource;
  conversationId?: string | null;
  title?: string;
  /** PDF 等分页文档的目标页（1-based） */
  page?: number;
  /** Markdown / 代码行号（1-based） */
  startLine?: number;
  /** 纯文本或 PDF 页内字符偏移（与 chunk 抽取对齐） */
  startOffset?: number;
  endOffset?: number;
  /**
   * OCR 归一化 bbox：[x, y, width, height]，左上角原点，0..1。
   * 有 bbox 时预览优先用框高亮（扫描件无可靠字符偏移）。
   */
  bbox?: [number, number, number, number];
  /**
   * 引用快照 revision；预览始终取当前入库原件。
   * 仅用于 UI 提示「页码可能偏差」，不请求历史 revision。
   */
  revisionId?: string;
};

type DocumentPreviewContextValue = {
  intent: DocumentPreviewIntent | null;
  openPreview: (intent: DocumentPreviewIntent) => void;
  closePreview: () => void;
};

const DocumentPreviewContext =
  createContext<DocumentPreviewContextValue | null>(null);

export function DocumentPreviewProvider({ children }: { children: ReactNode }) {
  const [intent, setIntent] = useState<DocumentPreviewIntent | null>(null);
  const openPreview = useCallback((next: DocumentPreviewIntent) => {
    setIntent(next);
  }, []);
  const closePreview = useCallback(() => setIntent(null), []);
  const value = useMemo(
    () => ({ intent, openPreview, closePreview }),
    [intent, openPreview, closePreview],
  );
  return (
    <DocumentPreviewContext.Provider value={value}>
      {children}
    </DocumentPreviewContext.Provider>
  );
}

export function useDocumentPreview() {
  const ctx = useContext(DocumentPreviewContext);
  if (!ctx) {
    throw new Error("useDocumentPreview 需在 DocumentPreviewProvider 内使用");
  }
  return ctx;
}

export function previewIntentFromCitation(
  citation: MessageCitation,
  conversationId?: string | null,
): DocumentPreviewIntent | null {
  if (!citation.documentId) return null;
  if (citation.sourceType === "web") {
    const locator = citation.locator;
    if (
      locator &&
      typeof locator === "object" &&
      "kind" in locator &&
      locator.kind === "web" &&
      typeof locator.url === "string" &&
      locator.url
    ) {
      return null;
    }
  }

  const sourceType: DocumentPreviewSource =
    citation.sourceType === "conversation_file"
      ? "conversation_file"
      : "library";

  const locator = citation.locator;
  let page: number | undefined;
  let startLine: number | undefined;
  let startOffset: number | undefined;
  let endOffset: number | undefined;
  let bbox: [number, number, number, number] | undefined;
  if (locator && typeof locator === "object" && "kind" in locator) {
    if (locator.kind === "page") {
      const pageLoc = locator as {
        page?: unknown;
        startOffset?: unknown;
        endOffset?: unknown;
        bbox?: unknown;
      };
      if (typeof pageLoc.page === "number") page = pageLoc.page;
      if (typeof pageLoc.startOffset === "number") {
        startOffset = pageLoc.startOffset;
      }
      if (typeof pageLoc.endOffset === "number") {
        endOffset = pageLoc.endOffset;
      }
      if (Array.isArray(pageLoc.bbox) && pageLoc.bbox.length === 4) {
        const [x, y, w, h] = pageLoc.bbox;
        if (
          typeof x === "number" &&
          typeof y === "number" &&
          typeof w === "number" &&
          typeof h === "number"
        ) {
          bbox = [x, y, w, h];
        }
      }
    }
    if (
      (locator.kind === "markdown" || locator.kind === "code") &&
      typeof (locator as { startLine?: unknown }).startLine === "number"
    ) {
      startLine = (locator as { startLine: number }).startLine;
    }
    if (locator.kind === "text") {
      const textLoc = locator as {
        startOffset?: unknown;
        endOffset?: unknown;
      };
      if (typeof textLoc.startOffset === "number") {
        startOffset = textLoc.startOffset;
      }
      if (typeof textLoc.endOffset === "number") {
        endOffset = textLoc.endOffset;
      }
    }
  }

  return {
    documentId: citation.documentId,
    sourceType,
    conversationId:
      sourceType === "conversation_file" ? conversationId : undefined,
    title: citation.title,
    page,
    startLine,
    startOffset,
    endOffset,
    bbox,
    revisionId: citation.revisionId,
  };
}

/** 原件 URL（鉴权在服务端按归属/存在性完成，不再依赖客户端 scope） */
export function buildPreviewFileUrl(intent: DocumentPreviewIntent): string {
  if (intent.sourceType === "conversation_file") {
    const conversationId = intent.conversationId?.trim();
    if (!conversationId) {
      throw new Error("会话附件预览需要 conversationId");
    }
    return `/api/conversations/${encodeURIComponent(conversationId)}/files/${encodeURIComponent(intent.documentId)}/content`;
  }
  return `/api/knowledge/${encodeURIComponent(intent.documentId)}/file`;
}

export function webUrlFromCitation(citation: MessageCitation): string | null {
  const locator = citation.locator;
  if (
    locator &&
    typeof locator === "object" &&
    "kind" in locator &&
    locator.kind === "web" &&
    typeof (locator as { url?: unknown }).url === "string"
  ) {
    const url = (locator as { url: string }).url.trim();
    if (!url) return null;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return null;
      }
      return parsed.toString();
    } catch {
      return null;
    }
  }
  return null;
}
