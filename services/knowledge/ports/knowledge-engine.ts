/**
 * Knowledge Engine 公开端口
 */

import type {
  ContextPackage,
  ContextRequest,
  IngestCommand,
  IngestReceipt,
  ResolvedCitation,
  RetrievalRequest,
  RetrievalResponse,
  SearchRequest,
  SearchResponse,
} from "../core/types";
import type { RetrievalHit, RetrievalScope } from "../types";
import type { KnowledgeAccessContext } from "../application/scope-policy";
import type { CompiledWikiPage } from "../wiki/compile-document-mirror";
import type { WikiLink, WikiLinkRel } from "../wiki/wiki-graph";

export type OpenChunkParams = {
  chunkId: string;
  scope: RetrievalScope | unknown;
};

export type OpenWikiPageParams = {
  pageId: string;
  scope: RetrievalScope | unknown;
};

export type WikiPageResult = {
  page: CompiledWikiPage;
  outgoing: WikiLink[];
  incoming: WikiLink[];
};

export interface KnowledgeEngine {
  ingest(command: IngestCommand): Promise<IngestReceipt>;
  search(
    request: SearchRequest,
    access?: KnowledgeAccessContext,
  ): Promise<SearchResponse>;
  retrieve(
    request: RetrievalRequest,
    access?: KnowledgeAccessContext,
  ): Promise<RetrievalResponse>;
  buildContext(request: ContextRequest): Promise<ContextPackage>;
  openChunk(
    params: OpenChunkParams,
    access: KnowledgeAccessContext,
  ): Promise<RetrievalHit>;
  resolveCitation(
    params: OpenChunkParams,
    access: KnowledgeAccessContext,
  ): Promise<ResolvedCitation>;
  searchPages(
    params: { query: string; scope: RetrievalScope | unknown; topK?: number },
    access: KnowledgeAccessContext,
  ): Promise<CompiledWikiPage[]>;
  openPage(
    params: OpenWikiPageParams,
    access: KnowledgeAccessContext,
  ): Promise<WikiPageResult>;
  listBacklinks(
    params: OpenWikiPageParams,
    access: KnowledgeAccessContext,
  ): Promise<CompiledWikiPage[]>;
  followLink(
    params: OpenWikiPageParams & { rel?: WikiLinkRel },
    access: KnowledgeAccessContext,
  ): Promise<CompiledWikiPage[]>;
}
