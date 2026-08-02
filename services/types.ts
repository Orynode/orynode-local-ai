/**
 * 全局共享类型 — 仅保留实际被前后端引用的定义
 */

export type MessageRole = "user" | "assistant";

/** 用户消息上展示的附件引用（资料库或本会话文件） */
export type MessageAttachment =
  | { kind: "library"; id: string; name: string }
  | { kind: "library_all"; id: "all"; name: string }
  | { kind: "conversation_file"; id: string; name: string };

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  durationMs?: number;
  attachments?: MessageAttachment[];
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
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
