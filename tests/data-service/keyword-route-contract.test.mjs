import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

test("keyword HTTP DTO 端到端保留 phrase 字段", () => {
  const root = process.cwd();
  const adapter = readFileSync(
    join(root, "services/knowledge/adapters/keyword-fts5.ts"),
    "utf8",
  );
  const route = readFileSync(
    join(root, "scripts/local-data-service.mjs"),
    "utf8",
  );

  assert.match(adapter, /phrase:\s*keywordQuery\.phrase/);
  assert.match(adapter, /lexicalLadder:\s*keywordQuery\.lexicalLadder/);
  assert.match(
    route,
    /phrase:\s*typeof body\.phrase === "string" \? body\.phrase : undefined/,
  );
  assert.match(route, /lexicalLadder:\s*Array\.isArray\(body\.lexicalLadder\)/);
});
