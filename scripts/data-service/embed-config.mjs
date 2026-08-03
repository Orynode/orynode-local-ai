/**
 * Embedding artifact registry（与 config/embedding-artifacts.ts 对齐）
 *
 * 运行时只加载一个 active artifact；默认推荐 multilingual-e5-small。
 */

/** @typedef {{
 *  id: string,
 *  xenovaModelId: string,
 *  revision: string,
 *  dimension: number,
 *  pooling: "mean",
 *  normalization: boolean,
 *  queryTemplate: string | null,
 *  passageTemplate: string | null,
 *  maxInputChars: number,
 *  role: "default" | "compat_baseline" | "experimental",
 *  batchSize: number,
 *  notes?: string,
 * }} EmbeddingArtifact */

/** @type {readonly EmbeddingArtifact[]} */
export const EMBEDDING_ARTIFACTS = Object.freeze([
  {
    id: "multilingual-e5-small",
    xenovaModelId: "Xenova/multilingual-e5-small",
    revision: "main",
    dimension: 384,
    pooling: "mean",
    normalization: true,
    queryTemplate: "query: {text}",
    passageTemplate: "passage: {text}",
    maxInputChars: 8000,
    role: "default",
    batchSize: 8,
    notes:
      "中英资料库默认推荐；查询用 query:、文档用 passage:；切换后必须重建 Vector IndexBuild",
  },
  {
    id: "bge-small-zh-v1.5",
    xenovaModelId: "Xenova/bge-small-zh-v1.5",
    revision: "main",
    dimension: 512,
    pooling: "mean",
    normalization: true,
    queryTemplate: null,
    passageTemplate: null,
    maxInputChars: 8000,
    role: "compat_baseline",
    batchSize: 8,
    notes:
      "旧版兼容与中文对照基线；非稳定跨语言空间；勿与 E5 向量混用",
  },
  {
    id: "bge-m3",
    xenovaModelId: "Xenova/bge-m3",
    revision: "main",
    dimension: 1024,
    pooling: "mean",
    normalization: true,
    queryTemplate: null,
    passageTemplate: null,
    maxInputChars: 8000,
    role: "experimental",
    batchSize: 4,
    notes: "质量上限参考；内存开销大，不作为默认",
  },
]);

export const DEFAULT_EMBEDDING_ARTIFACT_ID = "multilingual-e5-small";
export const COMPAT_BASELINE_ARTIFACT_ID = "bge-small-zh-v1.5";

/**
 * @param {string} id
 */
export function getEmbeddingArtifact(id) {
  return EMBEDDING_ARTIFACTS.find((a) => a.id === id);
}

export function getRecommendedEmbeddingArtifact() {
  return getEmbeddingArtifact(DEFAULT_EMBEDDING_ARTIFACT_ID);
}

/**
 * @param {string | null | undefined} [requestedId]
 */
export function resolveEmbeddingArtifact(
  requestedId = process.env.ORYNODE_EMBEDDING_ARTIFACT,
) {
  const requested =
    typeof requestedId === "string" && requestedId.trim()
      ? requestedId.trim()
      : DEFAULT_EMBEDDING_ARTIFACT_ID;
  const found = getEmbeddingArtifact(requested);
  if (found) {
    return { artifact: found, requestedId: requested, fallback: false };
  }
  const recommended = getRecommendedEmbeddingArtifact();
  return {
    artifact: recommended,
    requestedId: requested,
    fallback: true,
  };
}

/**
 * @param {string | null | undefined} template
 * @param {string} text
 */
export function applyEmbeddingTemplate(template, text) {
  const raw = String(text ?? "");
  if (!template) return raw;
  return template.replaceAll("{text}", raw);
}

/**
 * @param {EmbeddingArtifact} artifact
 */
export function embeddingConfigFingerprint(artifact) {
  return [
    artifact.id,
    artifact.revision,
    String(artifact.dimension),
    artifact.pooling,
    artifact.normalization ? "1" : "0",
    artifact.queryTemplate ?? "",
    artifact.passageTemplate ?? "",
    String(artifact.maxInputChars),
  ].join("|");
}

/**
 * @param {EmbeddingArtifact} artifact
 * @param {{ model?: string | null, dimension?: number | null }} build
 */
export function isEmbeddingBuildCompatible(artifact, build) {
  if (!build) return false;
  if (
    typeof build.dimension === "number" &&
    build.dimension !== artifact.dimension
  ) {
    return false;
  }
  if (typeof build.model === "string" && build.model && build.model !== artifact.id) {
    return false;
  }
  return true;
}

const resolved = resolveEmbeddingArtifact();
if (resolved.fallback) {
  console.warn(
    `[embed-config] 未知 ORYNODE_EMBEDDING_ARTIFACT=${resolved.requestedId}，回落 ${resolved.artifact.id}`,
  );
}

/** 兼容旧调用：当前选中 artifact 的精简视图 */
export const EMBEDDING_CONFIG = {
  artifactId: resolved.artifact.id,
  modelName: resolved.artifact.id,
  xenovaModelId: resolved.artifact.xenovaModelId,
  modelRevision: resolved.artifact.revision,
  dimension: resolved.artifact.dimension,
  batchSize: resolved.artifact.batchSize,
  role: resolved.artifact.role,
  queryTemplate: resolved.artifact.queryTemplate,
  passageTemplate: resolved.artifact.passageTemplate,
  maxInputChars: resolved.artifact.maxInputChars,
  pooling: resolved.artifact.pooling,
  normalization: resolved.artifact.normalization,
  fingerprint: embeddingConfigFingerprint(resolved.artifact),
};

export function getActiveEmbeddingArtifact() {
  return resolveEmbeddingArtifact().artifact;
}
