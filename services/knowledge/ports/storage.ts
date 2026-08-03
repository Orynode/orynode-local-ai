/**
 * 存储端口占位（Phase 0）；具体 repository 仍由 data-service HTTP 适配
 */

export interface StorageHealth {
  ok: boolean;
  databasePath?: string;
  detail?: string;
}

export interface KnowledgeStoragePort {
  health(): Promise<StorageHealth>;
}
