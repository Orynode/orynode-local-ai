/**
 * SourceConnector 端口与 DTO（Phase 3）
 */

export type ConnectorType = "file" | "web" | "github";

export interface ConnectorHealth {
  ok: boolean;
  detail?: string;
}

export interface DiscoveredItem {
  externalId: string;
  uri: string;
  title: string;
  mimeType?: string;
  contentHashHint?: string;
  metadata?: Record<string, unknown>;
}

export interface DiscoverPage {
  items: DiscoveredItem[];
  nextCursor?: string;
  deletedExternalIds?: string[];
  /**
   * false = 本次未完整枚举（如 GitHub truncated tree），调用方不得 tombstone 未见条目
   * 缺省：无 nextCursor 时视为 true
   */
  enumerationComplete?: boolean;
  truncated?: boolean;
}

export interface SourcePayload {
  externalId: string;
  uri: string;
  title: string;
  mimeType: string;
  /** UTF-8 文本或原始字节；入库前统一为可解析 buffer */
  body: Uint8Array;
  contentHash: string;
  metadata?: Record<string, unknown>;
  /** 供 Citation 使用的定位提示 */
  locatorHint?:
    | { kind: "web"; url: string; headingPath?: string[] }
    | {
        kind: "code";
        repo: string;
        path: string;
        commit: string;
        startLine?: number;
        endLine?: number;
      }
    | { kind: "page"; page: number }
    | { kind: "text"; startOffset: number; endOffset: number };
}

export interface SourceConnector {
  readonly type: ConnectorType;
  test(config: unknown): Promise<ConnectorHealth>;
  discover(config: unknown, cursor?: string): Promise<DiscoverPage>;
  fetch(config: unknown, item: DiscoveredItem): Promise<SourcePayload>;
  checkpoint?(config: unknown): Promise<string | null>;
}
