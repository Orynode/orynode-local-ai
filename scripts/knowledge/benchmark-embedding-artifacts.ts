/**
 * Embedding artifact registry 基准脚本（ML-009 雏形）
 *
 * CI 可用 --dry-run：只打印 registry，不加载模型。
 * 本地：node --import tsx scripts/knowledge/benchmark-embedding-artifacts.ts --artifact bge-small-zh-v1.5
 */

import {
  EMBEDDING_ARTIFACTS,
  resolveEmbeddingArtifact,
  embeddingConfigFingerprint,
} from "../../config/embedding-artifacts";

const dryRun = process.argv.includes("--dry-run");
const artifactFlag = process.argv.indexOf("--artifact");
const artifactId =
  artifactFlag >= 0 ? process.argv[artifactFlag + 1] : undefined;

console.log("# Embedding Artifact Registry\n");
for (const a of EMBEDDING_ARTIFACTS) {
  console.log(`- ${a.id} (${a.role}) dim=${a.dimension} model=${a.xenovaModelId}`);
  console.log(`  fingerprint=${embeddingConfigFingerprint(a)}`);
  if (a.queryTemplate) console.log(`  queryTemplate=${a.queryTemplate}`);
  if (a.passageTemplate) console.log(`  passageTemplate=${a.passageTemplate}`);
}

const resolved = resolveEmbeddingArtifact(artifactId);
console.log(
  `\nactive: ${resolved.artifact.id}${resolved.fallback ? " (fallback)" : ""}`,
);

if (dryRun) {
  console.log("\n--dry-run: skip model load");
  process.exit(0);
}

console.log(
  "\n提示：真实 embed 延迟/内存基准请开启 ORYNODE_SEMANTIC_SEARCH=1 后通过 data-service /knowledge/embed 探测。",
);
console.log("本脚本默认不下载模型，避免 CI 拉取大权重。");
