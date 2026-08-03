import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "../../scripts/data-service/migrations/index.mjs";
import {
  exportKnowledgePackage,
  sha256File,
  snapshotSqliteDatabase,
} from "../../scripts/data-service/export-package.mjs";
import { verifyExportPackage } from "../../scripts/data-service/import-knowledge.mjs";

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "orynode-backup-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("snapshotSqliteDatabase: VACUUM INTO 成功且禁止依赖 raw copy", () => {
  withTempDir((dir) => {
    const dbPath = join(dir, "src.db");
    const backupPath = join(dir, "snap.db");
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    database.exec(`CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)`);
    database.prepare(`INSERT INTO t (v) VALUES (?)`).run("hello");
    database.close();

    snapshotSqliteDatabase({ databasePath: dbPath, backupPath });
    assert.ok(readFileSync(backupPath).length > 0);

    const snap = new DatabaseSync(backupPath, { readOnly: true });
    const row = snap.prepare(`SELECT v FROM t`).get();
    assert.equal(row.v, "hello");
    const integrity = snap.prepare("PRAGMA integrity_check").get();
    assert.equal(Object.values(integrity)[0], "ok");
    snap.close();
  });
});

test("export + verify: hash 篡改会在切换前失败", () => {
  withTempDir((dir) => {
    const dbPath = join(dir, "orynode.db");
    const filesDir = join(dir, "files");
    const outDir = join(dir, "out");
    mkdirSync(filesDir, { recursive: true });
    writeFileSync(join(filesDir, "abc123"), "hello export");

    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO knowledge_documents (
          id, name, original_name, content_hash, stored_path, size,
          page_count, chunk_count, created_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "doc-1",
        "hello.md",
        "hello.md",
        "abc123",
        join(filesDir, "abc123"),
        12,
        1,
        0,
        now,
        "ready",
      );
    database.close();

    const result = exportKnowledgePackage({
      projectRoot: dir,
      databasePath: dbPath,
      knowledgeFilesPath: filesDir,
      outDir,
    });
    assert.equal(result.manifest.formatVersion, 2);

    const ok = verifyExportPackage(outDir, result.manifest);
    assert.equal(ok.errors.length, 0);

    // 篡改文件
    writeFileSync(join(outDir, "files", "abc123"), "TAMPERED");
    const bad = verifyExportPackage(outDir, result.manifest);
    assert.ok(bad.errors.some((e) => e.includes("sha256")));
  });
});

test("export: 路径均为相对路径且含 sha256", () => {
  withTempDir((dir) => {
    const dbPath = join(dir, "orynode.db");
    const filesDir = join(dir, "files");
    const outDir = join(dir, "out");
    mkdirSync(filesDir, { recursive: true });
    writeFileSync(join(filesDir, "f1"), "x");
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    database
      .prepare(
        `INSERT INTO knowledge_documents (
          id, name, original_name, content_hash, stored_path, size,
          page_count, chunk_count, created_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("d1", "a.md", "a.md", "f1", "f1", 1, 1, 0, new Date().toISOString(), "ready");
    database.close();

    const { manifest } = exportKnowledgePackage({
      projectRoot: dir,
      databasePath: dbPath,
      knowledgeFilesPath: filesDir,
      outDir,
    });
    for (const f of manifest.files) {
      assert.equal(f.relativePath.includes(".."), false);
      assert.equal(f.relativePath.startsWith("/"), false);
      assert.equal(f.sha256, sha256File(join(outDir, f.relativePath)));
    }
  });
});
