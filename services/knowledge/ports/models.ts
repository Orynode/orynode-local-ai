/**
 * 模型端口（Embedding / Rerank）；LLM 由上层 Chat/Agent 通过 Host ModelRuntime 使用
 */

export interface EmbedderPort {
  readonly dimension: number;
  readonly modelName: string;
  isAvailable(): Promise<boolean>;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

export interface RerankItem {
  id: string;
  text: string;
}

export interface RerankerPort {
  readonly modelName: string;
  isAvailable(): Promise<boolean>;
  rerank(
    query: string,
    items: RerankItem[],
    topK: number,
  ): Promise<Array<{ id: string; score: number }>>;
}
