/**
 * Knowledge Engine 领域错误
 */

export type KnowledgeErrorCode =
  | "invalid_scope"
  | "retrieval_failed"
  | "ingest_failed"
  | "not_implemented"
  | "citation_not_found"
  | "chunk_not_in_scope"
  | "chunk_not_found"
  | "connector_not_found"
  | "index_backend_unavailable"
  | "export_failed"
  | "import_failed"
  | "index_not_ready";

export class KnowledgeError extends Error {
  readonly code: KnowledgeErrorCode;
  readonly cause?: unknown;

  constructor(
    code: KnowledgeErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = "KnowledgeError";
    this.code = code;
    this.cause = options?.cause;
  }
}
