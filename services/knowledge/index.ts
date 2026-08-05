/**
 * 知识库服务入口（仅服务端 / API 使用）
 *
 * 客户端组件不要从本文件 import 运行时符号：
 * - UI 状态文案：`./status`
 * - 类型：`./types`（含 RetrievalScope）
 * 否则会把 embedder/pdfjs 等打进浏览器包。
 *
 * Phase 0：本文件仍是唯一公开导出面；内部按 core/application/ports 演进。
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
  normalizeRetrievalScope,
} from "./retriever";
export {
  assignChunkIds,
  commitDocumentChunks,
  indexDocumentEmbeddings,
  reindexDocument,
  reindexAllDocuments,
  enqueuePendingVectorBackfill,
  ensurePendingVectorBackfill,
} from "./indexer";
export { ingestDocument } from "./ingest";
export type { IngestTarget, IngestResult } from "./ingest";
export {
  hashContent,
  resolveDisplayName,
} from "./hash";
export { isUsableLibraryDocument } from "./status";
export type { RetrievalScope, DocumentNamespace } from "./types";

export {
  createKnowledgeEngine,
  buildChatKnowledgeContext,
  RETRIEVAL_FAILURE_CONTEXT,
  RETRIEVAL_EMPTY_CONTEXT,
} from "./application/engine";
export { resolveChatRetrievalScope } from "./application/resolve-scope";
export {
  createScopePolicy,
  defaultScopePolicy,
} from "./application/scope-policy";
export type {
  KnowledgeAccessContext,
  ResolvedScope,
  ScopePolicy,
} from "./application/scope-policy";
export {
  getKnowledgeCapabilities,
  readKnowledgeTierSetting,
} from "./application/capabilities";
export {
  fetchChunkById,
  openChunkInScope,
  resolveCitationInScope,
} from "./application/open-chunk";
export {
  buildContextPackage,
  citationsFromHits,
  findCitation,
} from "./context/build-context";
export {
  resolveRetrievalProfile,
  resolveKnowledgeTier,
} from "./retrieval/profile";
export {
  formatDegradedReason,
  formatDegradedReasons,
  summarizeDegradedReasons,
} from "./retrieval/degraded-labels";
export { buildMultiQueries } from "./retrieval/multi-query";
export { planQuery, inferPhraseIntent } from "./query/planner";
export type {
  LexicalLadderStep,
  QueryClass,
  RetrievalQueryPlan,
} from "./query/planner";
export {
  buildLexicalLadder,
  classifyQuery,
  minimumShouldMatchForTermCount,
  minimumShouldMatchForZhBigrams,
} from "./query/lexical-coverage";

export { analyzeLanguage } from "./query/language-analyzer";
export { extractExactTerms } from "./query/exact-terms";
export {
  BUILTIN_TERMINOLOGY,
  TERMINOLOGY_VERSION,
} from "./query/terminology";
export type { TerminologyEntry } from "./query/terminology";
export { applyRewriteExcludes } from "./query/query-rewrite";
export type { StructuredQueryRewrite } from "./query/query-rewrite";
export { resolveQueryRewrite } from "./query/resolve-rewrite";
export {
  buildMultilingualFields,
  ANALYZER_VERSION,
  NORMALIZER_VERSION,
} from "./indexing/multilingual-normalizer";
export {
  runRetrievalEval,
  reportToJson,
  reportToMarkdown,
  compareReports,
} from "./evaluation";
export {
  extractSearchTerms,
  extractTechnicalTerms,
  keywordScore,
  rrfFusion,
  weightedRrfFusion,
} from "./retrieval/keyword";
export {
  buildSearchText,
  buildFtsMatchQuery,
} from "./retrieval/search-text";
export {
  LexicalReranker,
  applyLexicalBoost,
} from "./retrieval/rerank";

export type { KnowledgeEngine } from "./ports/knowledge-engine";
export type {
  Citation,
  CitationLocator,
  ContextBudget,
  ContextPackage,
  ContextRequest,
  IngestCommand,
  IngestReceipt,
  RetrievalDiagnostics,
  RetrievalRequest,
  RetrievalResponse,
  SearchRequest,
  SearchResponse,
} from "./core/types";
export { KnowledgeError } from "./core/errors";
export {
  EXPORT_FORMAT_VERSION,
  parseExportManifest,
  assertSafeRelativePath,
} from "./core/export-manifest";
export type { KnowledgeExportManifest } from "./core/export-manifest";
// Connector / sync / Index adapters 仅允许在 Node data-service 使用；
// 勿从本 barrel 再导出实现（jsdom / sqlite-vec 会拖垮 vinext Workers）。
export type { SourceConnector, SourcePayload } from "./ports/connectors";
export type { KnowledgeTier } from "../../config/defaults";
export type { IndexBackendDecision, IndexBackendId } from "./adapters/index-backend";
export { describeIndexBackend } from "./adapters/index-backend-info";
export { listConnectorTypes, BUILTIN_CONNECTOR_TYPES } from "./connectors/registry";
