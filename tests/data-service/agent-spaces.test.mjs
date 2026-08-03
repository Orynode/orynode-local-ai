import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "../../scripts/data-service/migrations/index.mjs";
import { createAgentSpaceStore } from "../../scripts/data-service/agent-spaces.mjs";

test("agent space store: 持久化配额与过期 tombstone", () => {
  const dir = mkdtempSync(join(tmpdir(), "orynode-agent-"));
  const dbPath = join(dir, "t.db");
  try {
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    const store = createAgentSpaceStore(database);
    const space = store.create({
      ownerRef: "u1",
      maxDocuments: 1,
      ttlHours: 24,
    });
    assert.equal(space.kind, "agent");
    store.bindDocument(space.id, "doc-1");
    assert.throws(() => store.bindDocument(space.id, "doc-2"), /上限/);

    // 过期
    database
      .prepare(`UPDATE knowledge_spaces SET expires_at = ? WHERE id = ?`)
      .run("2000-01-01T00:00:00.000Z", space.id);
    assert.equal(store.get(space.id), null);
    database.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
