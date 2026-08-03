/**
 * 运行时依赖 smoke（KE-P3-05）
 *
 * 验证 data-service 动态加载 TypeScript 所需的 tsx 在 production dependencies 中。
 * 用法：npm run test:smoke-runtime
 * 也可在 `npm ci --omit=dev` 后运行。
 */

import { createRequire } from "node:module";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const root = resolve(new URL("..", import.meta.url).pathname);
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

const failures = [];

if (!pkg.dependencies?.tsx) {
  failures.push("tsx 必须位于 dependencies（data-service 运行时加载 TS）");
}

try {
  const tsxPath = require.resolve("tsx/esm/api", { paths: [root] });
  if (!tsxPath) failures.push("无法 resolve tsx/esm/api");
} catch (error) {
  failures.push(
    `无法 resolve tsx/esm/api: ${error instanceof Error ? error.message : error}`,
  );
}

if (failures.length) {
  console.error("smoke-runtime FAILED:");
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}

console.log("smoke-runtime OK: tsx is a runtime dependency");
