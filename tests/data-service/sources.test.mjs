import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "../../scripts/data-service/migrations/index.mjs";
import { createSourcesRepository } from "../../scripts/data-service/sources.mjs";

function withTempDb(run) {
  const dir = mkdtempSync(join(tmpdir(), "orynode-sources-"));
  const dbPath = join(dir, "test.db");
  try {
    return run(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("sources: 创建/同步条目/tombstone；config 不含 token", () => {
  withTempDb((dbPath) => {
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    const sources = createSourcesRepository(database);

    const source = sources.create({
      type: "web",
      name: "Example",
      config: { url: "https://example.com", token: "secret" },
    });
    assert.equal(source.config.token, undefined);
    assert.equal(source.config.url, "https://example.com");

    sources.upsertItem(source.id, {
      externalId: "https://example.com",
      uri: "https://example.com",
      title: "Example",
      contentHash: "abc",
      documentId: "doc-1",
      metadata: {
        locatorHint: { kind: "web", url: "https://example.com" },
      },
    });

    const item = sources.getItem(source.id, "https://example.com");
    assert.equal(item.documentId, "doc-1");
    assert.equal(item.metadata.locatorHint.kind, "web");

    sources.upsertItem(source.id, {
      externalId: "https://example.com",
      tombstone: true,
    });
    assert.equal(sources.getItem(source.id, "https://example.com").tombstone, true);

    assert.equal(sources.getByDocument("doc-1")?.externalId, "https://example.com");

    const excluded = database
      .prepare(
        `SELECT reason FROM library_search_exclusions WHERE document_id = ?`,
      )
      .get("doc-1");
    assert.equal(excluded?.reason, "source_tombstone");
    database.close();
  });
});

test("sources: 内容更新后旧 document 从活动检索排除", () => {
  withTempDb((dbPath) => {
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    const sources = createSourcesRepository(database);
    const source = sources.create({
      type: "web",
      name: "Page",
      config: { url: "https://example.com/a" },
    });

    sources.upsertItem(source.id, {
      externalId: "page",
      uri: "https://example.com/a",
      title: "v1",
      contentHash: "h1",
      documentId: "doc-v1",
    });
    sources.upsertItem(source.id, {
      externalId: "page",
      uri: "https://example.com/a",
      title: "v2",
      contentHash: "h2",
      documentId: "doc-v2",
      tombstone: false,
    });

    const oldExcluded = database
      .prepare(
        `SELECT reason FROM library_search_exclusions WHERE document_id = ?`,
      )
      .get("doc-v1");
    const newExcluded = database
      .prepare(
        `SELECT 1 AS ok FROM library_search_exclusions WHERE document_id = ?`,
      )
      .get("doc-v2");
    assert.equal(oldExcluded?.reason, "source_superseded");
    assert.equal(newExcluded, undefined);
    database.close();
  });
});

test("sources: 共享 document 时删除一个 Source 不影响另一活动 binding", () => {
  withTempDb((dbPath) => {
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    const sources = createSourcesRepository(database);
    const a = sources.create({
      type: "web",
      name: "A",
      config: { url: "https://example.com/a" },
    });
    const b = sources.create({
      type: "web",
      name: "B",
      config: { url: "https://example.com/b" },
    });

    sources.upsertItem(a.id, {
      externalId: "shared",
      uri: "https://example.com/shared",
      title: "Shared",
      documentId: "doc-shared",
      contentHash: "x",
    });
    sources.upsertItem(b.id, {
      externalId: "shared-b",
      uri: "https://example.com/shared",
      title: "Shared B",
      documentId: "doc-shared",
      contentHash: "x",
    });

    sources.upsertItem(a.id, {
      externalId: "shared",
      tombstone: true,
    });

    const excluded = database
      .prepare(
        `SELECT 1 AS ok FROM library_search_exclusions WHERE document_id = ?`,
      )
      .get("doc-shared");
    assert.equal(excluded, undefined);
    database.close();
  });
});
