/**
 * 知识库导出（data-service 内部模块，供 HTTP 与 CLI 共用）
 *
 * KE-P0-06：
 * - 仅 VACUUM INTO / 受控 checkpoint 快照；禁止静默 raw copy
 * - 写到临时目录，算完 hash 后原子 rename
 * - Manifest v2 含相对路径 + size + sha256
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * @param {string} filePath
 */
export function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

/**
 * 安全 SQLite 快照：优先对已打开可写连接做 checkpoint + VACUUM INTO。
 * 失败时不得降级为 raw copy。
 *
 * @param {{ database?: import("node:sqlite").DatabaseSync, databasePath: string, backupPath: string }} options
 */
export function snapshotSqliteDatabase(options) {
  const { databasePath, backupPath } = options;
  mkdirSync(dirname(backupPath), { recursive: true });

  if (options.database) {
    try {
      options.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      try {
        options.database.exec("PRAGMA wal_checkpoint(FULL)");
      } catch {
        // checkpoint 尽力而为；VACUUM INTO 仍可产生一致快照
      }
    }
    options.database.prepare("VACUUM INTO ?").run(backupPath);
    return { method: "vacuum_into_live" };
  }

  // 无 live 连接：打开可写短连接做 checkpoint + VACUUM INTO
  if (!existsSync(databasePath)) {
    throw new Error(`数据库不存在: ${databasePath}`);
  }
  const db = new DatabaseSync(databasePath);
  try {
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      try {
        db.exec("PRAGMA wal_checkpoint(FULL)");
      } catch {
        // ignore
      }
    }
    db.prepare("VACUUM INTO ?").run(backupPath);
    return { method: "vacuum_into" };
  } catch (error) {
    throw new Error(
      `SQLite 安全快照失败（禁止 raw copy）: ${
        error instanceof Error ? error.message : error
      }`,
    );
  } finally {
    db.close();
  }
}

/**
 * @param {object} options
 * @param {string} options.projectRoot
 * @param {string} options.databasePath
 * @param {string} options.knowledgeFilesPath
 * @param {string} options.outDir
 * @param {"knowledge"|"knowledge_and_conversations"|"full"} [options.backupLevel]
 * @param {import("node:sqlite").DatabaseSync} [options.database]
 */
export function exportKnowledgePackage(options) {
  const {
    projectRoot,
    databasePath,
    knowledgeFilesPath,
    outDir,
    backupLevel = "knowledge",
  } = options;

  if (!existsSync(databasePath)) {
    throw new Error(`数据库不存在: ${databasePath}`);
  }

  const stagingDir = `${outDir}.staging-${process.pid}-${Date.now()}`;
  if (existsSync(stagingDir)) {
    rmSync(stagingDir, { recursive: true, force: true });
  }
  mkdirSync(join(stagingDir, "files"), { recursive: true });
  mkdirSync(join(stagingDir, "database"), { recursive: true });

  const ownDb = !options.database;
  const database =
    options.database ?? new DatabaseSync(databasePath);

  /** @type {Array<{ relativePath: string, size: number, sha256: string }>} */
  const fileEntries = [];

  try {
    const docs = database
      .prepare(
        `SELECT id, name, content_hash AS contentHash, original_name AS originalName,
                stored_path AS storedPath, status
         FROM knowledge_documents
         ORDER BY created_at DESC`,
      )
      .all();

    let sources = [];
    try {
      sources = database
        .prepare(
          `SELECT id, type, name, config_json AS configJson FROM sources ORDER BY created_at DESC`,
        )
        .all()
        .map((row) => {
          let config = {};
          try {
            config = JSON.parse(row.configJson || "{}");
          } catch {
            config = {};
          }
          delete config.token;
          delete config.password;
          delete config.secret;
          return { id: row.id, type: row.type, name: row.name, config };
        });
    } catch {
      sources = [];
    }

    let schemaMigrations = [];
    try {
      schemaMigrations = database
        .prepare(`SELECT id FROM schema_migrations ORDER BY id`)
        .all()
        .map((row) => row.id);
    } catch {
      schemaMigrations = [];
    }

    const documents = [];
    for (const doc of docs) {
      const candidates = [];
      if (doc.storedPath) {
        const p = String(doc.storedPath);
        candidates.push(p.startsWith("/") ? p : join(knowledgeFilesPath, p));
        candidates.push(join(knowledgeFilesPath, p.split(/[/\\]/).pop()));
      }
      if (doc.contentHash) {
        candidates.push(join(knowledgeFilesPath, doc.contentHash));
      }

      let copied = false;
      for (const candidate of candidates) {
        if (candidate && existsSync(candidate)) {
          const destName = candidate.split(/[/\\]/).pop();
          const rel = `files/${destName}`;
          const dest = join(stagingDir, "files", destName);
          copyFileSync(candidate, dest);
          const st = statSync(dest);
          const digest = sha256File(dest);
          fileEntries.push({
            relativePath: rel,
            size: st.size,
            sha256: digest,
          });
          documents.push({
            id: doc.id,
            name: doc.name,
            contentHash: doc.contentHash || undefined,
            originalName: doc.originalName || undefined,
            storageKey: rel,
            status: doc.status,
          });
          copied = true;
          break;
        }
      }
      if (!copied) {
        documents.push({
          id: doc.id,
          name: doc.name,
          contentHash: doc.contentHash || undefined,
          originalName: doc.originalName || undefined,
          storageKey: `files/${doc.id}.missing`,
          status: doc.status,
        });
      }
    }

    const backupPath = join(stagingDir, "database", "orynode.db");
    snapshotSqliteDatabase({
      database: options.database ?? database,
      databasePath,
      backupPath,
    });
    const dbStat = statSync(backupPath);
    const dbHash = sha256File(backupPath);
    fileEntries.push({
      relativePath: "database/orynode.db",
      size: dbStat.size,
      sha256: dbHash,
    });

    // 完整性自检
    const checkDb = new DatabaseSync(backupPath, { readOnly: true });
    try {
      const integrity = checkDb.prepare("PRAGMA integrity_check").get();
      const ok =
        integrity &&
        (integrity.integrity_check === "ok" ||
          Object.values(integrity)[0] === "ok");
      if (!ok) {
        throw new Error(`导出库 integrity_check 失败: ${JSON.stringify(integrity)}`);
      }
    } finally {
      checkDb.close();
    }

    let appVersion = "0.0.0";
    try {
      appVersion = JSON.parse(
        readFileSync(resolve(projectRoot, "package.json"), "utf8"),
      ).version;
    } catch {
      // ignore
    }

    const manifest = {
      formatVersion: 2,
      exportedAt: new Date().toISOString(),
      appVersion,
      indexBackend: "fts5+blob",
      backupLevel,
      schemaMigrations,
      documents,
      sources,
      database: {
        relativePath: "database/orynode.db",
        note: "VACUUM INTO 安全快照；导入时校验 hash 并跑 migrations",
        size: dbStat.size,
        sha256: dbHash,
      },
      files: fileEntries,
    };

    writeFileSync(
      join(stagingDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    // 原子切换到最终目录
    if (existsSync(outDir)) {
      rmSync(outDir, { recursive: true, force: true });
    }
    mkdirSync(dirname(outDir), { recursive: true });
    renameSync(stagingDir, outDir);

    return { outDir, documentCount: documents.length, manifest };
  } catch (error) {
    try {
      if (existsSync(stagingDir)) {
        rmSync(stagingDir, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup
    }
    throw error;
  } finally {
    if (ownDb) database.close();
  }
}
