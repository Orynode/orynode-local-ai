import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "../../scripts/data-service/migrations/index.mjs";
import { createTerminologyRepository } from "../../scripts/data-service/terminology.mjs";

test("terminology repo: 主查询词已存在则合并，仅同义重叠不合并", () => {
  const dir = mkdtempSync(join(tmpdir(), "orynode-term-"));
  const database = new DatabaseSync(join(dir, "t.db"));
  migrateDatabase(database);
  const repo = createTerminologyRepository(database);

  const first = repo.upsertLearned({
    domain: "网络代理",
    terms: ["反向代理", "reverse proxy"],
    exclude: ["forward proxy"],
    source: "learned",
  });
  assert.ok(first?.id);
  assert.equal(first?.terms.includes("反向代理"), true);

  // 主词 reverse proxy 已在 first.terms → 合并
  const second = repo.upsertLearned({
    terms: ["reverse proxy", "nginx reverse proxy"],
    exclude: ["正向代理"],
    source: "learned",
  });
  assert.equal(second?.id, first?.id);
  assert.ok(second?.terms.includes("nginx reverse proxy"));
  assert.ok(second?.exclude.includes("forward proxy"));
  assert.ok(second?.exclude.includes("正向代理"));

  // 主词「界面」不在已有条目 → 新建，不因偶然同义绑死
  const third = repo.upsertLearned({
    terms: ["界面", "SEI"],
    source: "learned",
  });
  assert.ok(third?.id);
  assert.notEqual(third?.id, first?.id);

  repo.recordHit(first.id);
  const again = repo.getById(first.id);
  assert.equal(again?.hitCount, 1);

  database.close();
  rmSync(dir, { recursive: true, force: true });
});
