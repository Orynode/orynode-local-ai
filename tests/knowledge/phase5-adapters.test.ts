import assert from "node:assert/strict";
import test from "node:test";
import { resolveIndexBackend } from "../../services/knowledge/adapters/index-backend";
import {
  resolveIndexes,
  resetIndexRegistry,
  BlobScanVectorIndex,
  SqliteVecVectorIndex,
} from "../../services/knowledge/adapters/index-registry";
import {
  registerConnector,
  getConnector,
  listConnectorTypes,
  hasConnector,
} from "../../services/knowledge/connectors/registry";
import { parseExportManifest } from "../../services/knowledge/core/export-manifest";

test("resolveIndexBackend: 默认 fts5+blob", async () => {
  const decision = await resolveIndexBackend();
  assert.equal(decision.id, "fts5+blob");
  assert.equal(decision.vector, "blob_scan");
  assert.equal(decision.sqliteVecAvailable, false);
});

test("resolveIndexes: 返回 KeywordIndex + VectorIndex", async () => {
  resetIndexRegistry();
  const resolved = await resolveIndexes({ forceRefresh: true });
  assert.ok(resolved.keyword);
  assert.ok(resolved.vector);
  assert.equal(resolved.decision.id, "fts5+blob");
  assert.ok(resolved.vector instanceof BlobScanVectorIndex);
});

test("SqliteVecVectorIndex: 实现完成前恒不可用", async () => {
  const index = new SqliteVecVectorIndex();
  assert.equal(await index.isAvailable(), false);
});

test("resolveIndexBackend: 用户环境变量不能开启预留后端", async () => {
  process.env.ORYNODE_INDEX_BACKEND = "sqlite-vec";
  process.env.ORYNODE_FORCE_SQLITE_VEC = "1";
  try {
    const decision = await resolveIndexBackend();
    assert.equal(decision.id, "fts5+blob");
    assert.equal(decision.vector, "blob_scan");
  } finally {
    delete process.env.ORYNODE_INDEX_BACKEND;
    delete process.env.ORYNODE_FORCE_SQLITE_VEC;
  }
});

test("ConnectorRegistry: 内置类型清单 + 可注册插件", () => {
  assert.ok(listConnectorTypes().includes("web"));
  assert.ok(listConnectorTypes().includes("github"));
  registerConnector("markdown_folder_test", () => ({
    type: "file",
    async test() {
      return { ok: true };
    },
    async discover() {
      return { items: [] };
    },
    async fetch() {
      throw new Error("unused");
    },
  }));
  assert.equal(hasConnector("markdown_folder_test"), true);
  assert.equal(getConnector("markdown_folder_test").type, "file");
});

test("export manifest schema", () => {
  const manifest = parseExportManifest({
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    documents: [
      {
        id: "d1",
        name: "a.md",
        storageKey: "files/a.md",
      },
    ],
    database: { relativePath: "database/orynode.db" },
  });
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.documents[0].storageKey, "files/a.md");

  const v2 = parseExportManifest({
    formatVersion: 2,
    exportedAt: new Date().toISOString(),
    backupLevel: "knowledge",
    documents: [
      {
        id: "d1",
        name: "a.md",
        storageKey: "files/a.md",
      },
    ],
    database: {
      relativePath: "database/orynode.db",
      size: 10,
      sha256: "a".repeat(64),
    },
    files: [
      {
        relativePath: "database/orynode.db",
        size: 10,
        sha256: "a".repeat(64),
      },
    ],
  });
  assert.equal(v2.formatVersion, 2);
  assert.equal(v2.files?.length, 1);
});
