/**
 * Host Runtime 抽象（平台差异唯一入口）
 *
 * Knowledge Engine 核心不得直接依赖 TurboFieldfare、Apple Vision、shell 或绝对路径。
 */

export type HostPlatform = "macos" | "windows";

export interface RuntimePaths {
  /** 相对或经 adapter 解析后的数据根（如 .orynode） */
  dataRoot: string;
  knowledgeFiles: string;
  attachments: string;
  database: string;
  settings: string;
}

export interface HostCapabilities {
  platform: HostPlatform;
  modelRuntime: boolean;
  embedding: boolean;
  reranker: boolean;
  ocr: boolean;
  ftsTokenizer: string | null;
  memoryTier: "lite" | "balanced" | "quality";
  externalConnectors: {
    web: boolean;
    github: boolean;
  };
}

export interface CredentialStore {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, secret: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
}

export interface ProcessSupervisor {
  isRunning(name: string): Promise<boolean>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
}

export interface HostRuntime {
  readonly platform: HostPlatform;
  paths(): RuntimePaths;
  capabilities(): Promise<HostCapabilities>;
  credentials(): CredentialStore;
  processes(): ProcessSupervisor;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ModelInfo {
  id: string;
  displayName?: string;
}

export interface RuntimeHealth {
  ok: boolean;
  detail?: string;
}

export interface ModelRuntime {
  chat(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): Promise<ReadableStream<Uint8Array>>;
  listModels(): Promise<ModelInfo[]>;
  health(): Promise<RuntimeHealth>;
}

/** 归一化 bbox：左上角原点，坐标 0..1 */
export type NormalizedBoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type OcrBlock = {
  text: string;
  bbox: NormalizedBoundingBox;
  confidence?: number;
  readingOrder: number;
  language?: string;
};

export type OcrPageInput = {
  pageNumber: number;
  imageBytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  languages?: string[];
  recognitionLevel: "fast" | "accurate";
  /** Node adapter 可直接传已写好的临时路径，避免二次落盘 */
  imagePath?: string;
};

export type OcrPageResult = {
  pageNumber: number;
  text: string;
  blocks: OcrBlock[];
  engine: string;
  engineVersion: string;
  warnings: string[];
};

export type OcrCapability = {
  available: boolean;
  engine: string | null;
  engineVersion: string | null;
  languages: string[];
  boundingBoxes: boolean;
  reason?: string;
};

export interface OcrEngine {
  capabilities(): Promise<OcrCapability>;
  recognizePage(
    input: OcrPageInput,
    signal?: AbortSignal,
  ): Promise<OcrPageResult>;
  /** 文档级会话：复用 helper 进程；缺省实现可省略 */
  beginSession?(): Promise<void>;
  endSession?(): Promise<void>;
}

/** @deprecated 使用 OcrPageInput / recognizePage */
export interface OcrInput {
  bytes: Uint8Array;
  mimeType?: string;
  pageHint?: number;
}

/** @deprecated 使用 OcrPageResult */
export interface OcrPage {
  pageNumber: number;
  text: string;
  confidence?: number;
}

/** 访问模式：Local-only 为安全默认；Trusted-LAN 需统一认证 */
export type AccessMode = "local_only" | "trusted_lan";
