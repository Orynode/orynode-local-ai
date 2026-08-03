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

export type OpenChunkParams = {
  chunkId: string;
  scope: RetrievalScope | unknown;
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
}
