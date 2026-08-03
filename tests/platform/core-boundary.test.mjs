/**
 * Phase 0 平台边界门禁：Knowledge Engine 核心不得直接依赖 macOS / TurboFieldfare / shell
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const projectRoot = new URL("../../", import.meta.url);
const coreRoots = [
  new URL("../../services/knowledge/core/", import.meta.url),
  new URL("../../services/knowledge/application/", import.meta.url),
  new URL("../../services/knowledge/ports/", import.meta.url),
  new URL("../../services/knowledge/context/", import.meta.url),
  new URL("../../services/knowledge/retrieval/", import.meta.url),
];

const forbiddenPatterns = [
  { name: "turbo-fieldfare", re: /turbo-fieldfare/i },
  { name: "process.platform", re: /process\.platform/ },
  { name: "shell script", re: /\.sh['"`]/ },
  { name: "launchd", re: /launchd/i },
  { name: "Apple Vision", re: /Vision\.framework|AppleVision/i },
  { name: "absolute macos home", re: /\/Users\/[A-Za-z]/ },
];

function walkFiles(dirUrl, acc = []) {
  const dirPath = dirUrl.pathname;
  for (const entry of readdirSync(dirPath)) {
    const full = join(dirPath, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkFiles(new URL(`${entry}/`, dirUrl), acc);
    } else if (/\.(ts|tsx|mjs|js)$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

test("Knowledge Engine 核心目录无平台硬依赖", () => {
  const violations = [];
  for (const root of coreRoots) {
    for (const file of walkFiles(root)) {
      const source = readFileSync(file, "utf8");
      for (const pattern of forbiddenPatterns) {
        if (pattern.re.test(source)) {
          violations.push(
            `${relative(projectRoot.pathname, file)} → ${pattern.name}`,
          );
        }
      }
    }
  }
  assert.deepEqual(violations, []);
});
