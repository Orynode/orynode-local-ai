/**
 * 全局共享类型 — 仅保留实际被前后端引用的定义
 */

export type MessageRole = "user" | "assistant";

/** 用户消息上展示的附件引用（资料库或本会话文件） */
export type MessageAttachment =
  | { kind: "library"; id: string; name: string }
  | { kind: "library_all"; id: "all"; name: string }
  | { kind: "conversation_file"; id: string; name: string };

/** 持久化到消息的引用快照（与 KnowledgeEngine Citation 对齐的子集） */
export type MessageCitation = {
  /** Prompt / UI 中的 [S#] */
  id: string;
  /** 稳定 chunk 主键；缺省时（旧消息）可用 id 若碰巧是 chunk id */
  chunkId?: string;
  documentId: string;
  revisionId: string;
  processingBuildId: string;
  title: string;
  sourceType: string;
  locator:
    | {
        kind: "page";
        page: number;
        startOffset?: number;
        endOffset?: number;
        /** OCR 归一化框：[x, y, width, height]，左上角原点，0..1 */
        bbox?: [number, number, number, number];
      }
    | {
        kind: "markdown";
        headingPath?: string[];
        startLine?: number;
        endLine?: number;
      }
    | {
        kind: "web";
        url?: string;
        headingPath?: string[];
        textFragment?: string;
      }
    | {
        kind: "code";
        repo?: string;
        path?: string;
        commit?: string;
        startLine?: number;
        endLine?: number;
      }
    | { kind: "text"; startOffset: number; endOffset: number }
    | Record<string, unknown>;
  excerpt: string;
};

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  durationMs?: number;
  attachments?: MessageAttachment[];
  /** 本轮提供给模型的引用（provided），不等于模型实际引用 */
  /** 本轮提供给模型的引用快照（provided）；胶囊 popover lookup 依赖此字段 */
  citations?: MessageCitation[];
  /** 正文实际引用的 id（落库字段；由 useChat.finalizeAnswer 写入） */
  referencedCitationIds?: string[];
  retrievalTraceId?: string;
  /** 检索诊断（可选；历史消息可能没有） */
  retrievalDiagnostics?: {
    strategy: string[];
    candidateCount: number;
    elapsedMs: number;
    degradedCapabilities: string[];
    degradedReasons?: string[];
    requestedTier?: string;
    effectiveTier?: string;
  };
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export type KnowledgeDocumentStatus =
  | "awaiting_chunks"
  | "stored"
  | "processing"
  | "processing_error"
  | "ready"
  | "embedding"
  | "indexed"
  | "error";

export interface KnowledgeDocument {
  id: string;
  /** 显示名（可改，不参与去重） */
  name: string;
  /** 原始文件名（只读溯源） */
  originalName?: string;
  /** 内容身份 SHA-256 hex；资料库全局唯一 */
  contentHash?: string;
  size: number;
  pageCount: number;
  chunkCount: number;
  createdAt: string;
  status?: KnowledgeDocumentStatus;
  embeddingModel?: string | null;
  embeddingDim?: number | null;
  errorMessage?: string | null;
}

/** 绑会话的临时附件；持久保存请走资料库导入 */
export interface ConversationFile {
  id: string;
  conversationId: string;
  name: string;
  size: number;
  pageCount: number;
  chunkCount: number;
  createdAt: string;
  status?: KnowledgeDocumentStatus;
  embeddingModel?: string | null;
  embeddingDim?: number | null;
  errorMessage?: string | null;
}

export interface KnowledgeChunk {
  id: string;
  documentId: string;
  pageNumber: number;
  position: number;
  content: string;
  embedding?: Float32Array | number[];
}

export interface RuntimeSettings {
  temperature: number;
  topP: number;
  topK: number;
  maxContext: number;
  maxTokens: number;
  /** 知识检索：auto / lite（省资源）/ balanced / quality（更高质量） */
  knowledgeTier: "auto" | "lite" | "balanced" | "quality";
  /** 扫描 PDF OCR：自动（默认）/ 关闭 */
  ocrMode: "auto" | "disabled";
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
