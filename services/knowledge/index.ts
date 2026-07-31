/**
 * 知识库服务入口（仅服务端 / API 使用）
 *
 * 客户端组件不要从本文件 import 运行时符号：
 * - UI 状态文案：`./status`
 * - 类型：`./types`（含 KnowledgeScope）
 * 否则会把 embedder/pdfjs 等打进浏览器包。
 *
 * Embedder / VectorStore 接口仅在 types.ts；实现见对应文件。
 */

export { parsePdf, parsePlainText, parseDocument } from "./parser";
export { isPdfMagic } from "./formats";
export {
  detectKnowledgeKind,
  detectBrowserFileKind,
  kindFromFileName,
  mimeForKind,
  extensionForKind,
} from "./formats";
export type { KnowledgeFileKind } from "./formats";
export { createChunker } from "./chunker";
export {
  HybridRetriever,
  normalizeKnowledgeScope,
} from "./retriever";
export {
  assignChunkIds,
  commitDocumentChunks,
  indexDocumentEmbeddings,
  reindexDocument,
  reindexAllDocuments,
} from "./indexer";
