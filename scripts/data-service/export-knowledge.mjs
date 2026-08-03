/**
 * 导出本地知识库为可迁移包
 *
 * 用法: node scripts/data-service/export-knowledge.mjs [outDir]
 */

import { resolve } from "node:path";
import { exportKnowledgePackage } from "./export-package.mjs";

const projectRoot = resolve(new URL("../..", import.meta.url).pathname);
const databasePath =
  process.env.ORYNODE_DATABASE_PATH ??
  resolve(projectRoot, ".orynode/data/orynode.db");
const knowledgeFilesPath = resolve(projectRoot, ".orynode/knowledge/files");
const outDir =
  process.argv[2] ||
  resolve(projectRoot, `.orynode/exports/knowledge-${Date.now()}`);

try {
  const result = exportKnowledgePackage({
    projectRoot,
    databasePath,
    knowledgeFilesPath,
    outDir,
  });
  console.log(
    `Exported ${result.documentCount} documents → ${result.outDir}`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
