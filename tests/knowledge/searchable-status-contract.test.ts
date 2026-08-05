import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SEARCHABLE_DOCUMENT_STATUSES as fromScripts } from "../../scripts/data-service/searchable-document-statuses.mjs";
import { SEARCHABLE_DOCUMENT_STATUSES as fromTs } from "../../services/knowledge/status";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("searchable status: TS 与 data-service 白名单一致", () => {
  assert.deepEqual([...fromTs], [...fromScripts]);
});

test("searchable status: SQL 层使用共享 helper，无手写字面量白名单", () => {
  const fts = readFileSync(
    join(root, "scripts/data-service/fts-index.mjs"),
    "utf8",
  );
  const dataService = readFileSync(
    join(root, "scripts/local-data-service.mjs"),
    "utf8",
  );

  assert.match(fts, /sqlInSearchableStatuses/);
  assert.match(dataService, /sqlInSearchableStatuses/);
  assert.doesNotMatch(
    fts,
    /status IN \('ready', 'embedding', 'indexed', 'error'\)/,
  );
  assert.doesNotMatch(
    dataService,
    /status IN \('ready', 'embedding', 'indexed', 'error'\)/,
  );

  for (const status of fromScripts) {
    assert.ok(
      fromTs.includes(status as (typeof fromTs)[number]),
      `TS 缺少 ${status}`,
    );
  }
});
