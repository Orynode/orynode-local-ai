/**
 * 全局共享类型 — 仅保留实际被前后端引用的定义
 */

export type MessageRole = "user" | "assistant";

/** 用户消息上展示的资料附件（对话内可见，类似 ChatGPT） */
export interface MessageAttachment {
  id: string;
  name: string;
  /** document = 单篇资料；all = 全部资料库 */
  kind: "document" | "all";
}

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
