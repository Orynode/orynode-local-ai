/**
 * 全局共享类型 — 仅保留实际被前后端引用的定义
 */

export type MessageRole = "user" | "assistant";

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  durationMs?: number;
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
