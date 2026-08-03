/**
 * 校验 / 恢复知识导出包（KE-P0-06）
 *
 * 用法:
 *   node scripts/data-service/import-knowledge.mjs <exportDir>
 *   node scripts/data-service/import-knowledge.mjs <exportDir> --apply
 *   node scripts/data-service/import-knowledge.mjs <exportDir> --apply --switch
 */

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
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "./migrations/index.mjs";
import { sha256File } from "./export-package.mjs";

/**
 * @param {string} relativePath
 */
export function assertSafeRelativePath(relativePath) {
  const key = String(relativePath || "").replace(/\\/g, "/");
  if (
    !key ||
    key.startsWith("/") ||
    key.includes("..") ||
    /^[A-Za-z]:/.test(key)
  ) {
    throw new Error(`非法相对路径: ${relativePath}`);
  }
  return key;
}

/**
 * @param {string} root
 * @param {object} manifest
 */
export function verifyExportPackage(root, manifest) {
  if (manifest.formatVersion !== 1 && manifest.formatVersion !== 2) {
    throw new Error(`不支持的 formatVersion: ${manifest.formatVersion}`);
  }

  const dbRel = assertSafeRelativePath(
    manifest.database?.relativePath || "database/orynode.db",
  );
  const dbPath = join(root, dbRel);
  if (!existsSync(dbPath)) {
    throw new Error(`缺少数据库快照: ${dbRel}`);
  }

  /** @type {string[]} */
  const errors = [];

  if (Array.isArray(manifest.files) && manifest.files.length > 0) {
    for (const entry of manifest.files) {
      const rel = assertSafeRelativePath(entry.relativePath);
      const abs = join(root, rel);
      if (!existsSync(abs)) {
        errors.push(`缺失文件: ${rel}`);
        continue;
      }
      const size = statSync(abs).size;
      if (typeof entry.size === "number" && size !== entry.size) {
        errors.push(`size 不匹配: ${rel} (got ${size}, expected ${entry.size})`);
      }
      if (entry.sha256) {
        const digest = sha256File(abs);
        if (digest !== entry.sha256) {
          errors.push(`sha256 不匹配: ${rel}`);
        }
      }
    }
  } else {
    for (const doc of manifest.documents || []) {
      const key = assertSafeRelativePath(doc.storageKey || "");
      if (key.endsWith(".missing")) continue;
      if (!existsSync(join(root, key))) {
        errors.push(`缺失文件: ${key}`);
      }
    }
    if (manifest.database?.sha256) {
      const digest = sha256File(dbPath);
      if (digest !== manifest.database.sha256) {
        errors.push("database sha256 不匹配");
      }
    }
  }

  const stagingDb = join(root, `.import-check-${process.pid}.db`);
  copyFileSync(dbPath, stagingDb);
  const database = new DatabaseSync(stagingDb);
  let applied = [];
  try {
    const integrity = database.prepare("PRAGMA integrity_check").get();
    const ok =
      integrity &&
      (integrity.integrity_check === "ok" ||
        Object.values(integrity)[0] === "ok");
    if (!ok) {
      errors.push(`integrity_check 失败: ${JSON.stringify(integrity)}`);
    }
    const result = migrateDatabase(database);
    applied = result.applied;
  } finally {
    database.close();
    try {
      rmSync(stagingDb, { force: true });
    } catch {
      // ignore
    }
  }

  return { errors, applied, dbRel };
}

function runCli() {
  const projectRoot = resolve(new URL("../..", import.meta.url).pathname);
  const exportDir = process.argv[2];
  const apply = process.argv.includes("--apply");
  const doSwitch = process.argv.includes("--switch");

  if (!exportDir) {
    console.error(
      "用法: node scripts/data-service/import-knowledge.mjs <exportDir> [--apply] [--switch]",
    );
    process.exit(1);
  }

  const root = resolve(exportDir);
  const manifestPath = join(root, "manifest.json");
  if (!existsSync(manifestPath)) {
    console.error("缺少 manifest.json");
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  let verified;
  try {
    verified = verifyExportPackage(root, manifest);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }

  console.log(`manifest OK: ${manifest.documents?.length ?? 0} documents`);
  console.log(`formatVersion: ${manifest.formatVersion}`);
  console.log(`exportedAt: ${manifest.exportedAt}`);
  console.log(
    `migrations on snapshot: ${verified.applied.join(", ") || "(none)"}`,
  );

  if (verified.errors.length) {
    console.error("校验失败:");
    for (const err of verified.errors.slice(0, 20)) {
      console.error(`  - ${err}`);
    }
    process.exit(2);
  }

  if (!apply) {
    console.log(
      "dry-run 通过。加 --apply 写入暂存；再加 --switch 原子切换生产数据。",
    );
    process.exit(0);
  }

  const destRoot = resolve(
    projectRoot,
    `.orynode/imports/import-${Date.now()}`,
  );
  mkdirSync(join(destRoot, "files"), { recursive: true });
  mkdirSync(join(destRoot, "database"), { recursive: true });

  const dbPath = join(root, verified.dbRel);
  copyFileSync(dbPath, join(destRoot, "database", "orynode.db"));
  copyFileSync(manifestPath, join(destRoot, "manifest.json"));
  for (const doc of manifest.documents || []) {
    const key = assertSafeRelativePath(doc.storageKey || "");
    const src = join(root, key);
    if (!existsSync(src) || key.endsWith(".missing")) continue;
    const name = key.split("/").pop();
    copyFileSync(src, join(destRoot, "files", name));
  }
  writeFileSync(
    join(destRoot, "IMPORT_NOTES.txt"),
    "暂存区。使用 --switch 才会替换 .orynode/data 与 knowledge/files。\n",
  );
  console.log(`已写入暂存: ${destRoot}`);

  if (!doSwitch) {
    console.log("未指定 --switch，生产目录未修改。");
    process.exit(0);
  }

  const dataDir = resolve(projectRoot, ".orynode/data");
  const filesDir = resolve(projectRoot, ".orynode/knowledge/files");
  const rollbackRoot = resolve(
    projectRoot,
    `.orynode/rollback/rollback-${Date.now()}`,
  );
  mkdirSync(rollbackRoot, { recursive: true });

  if (existsSync(dataDir)) {
    renameSync(dataDir, join(rollbackRoot, "data"));
  }
  if (existsSync(filesDir)) {
    renameSync(filesDir, join(rollbackRoot, "files"));
  }

  try {
    mkdirSync(dirname(dataDir), { recursive: true });
    mkdirSync(dirname(filesDir), { recursive: true });
    renameSync(join(destRoot, "database"), dataDir);
    renameSync(join(destRoot, "files"), filesDir);
    writeFileSync(
      join(rollbackRoot, "ROLLBACK_NOTES.txt"),
      `切换成功。回滚：将本目录 data/files 换回 .orynode/data 与 .orynode/knowledge/files。\n`,
    );
    console.log(`已切换生产数据。回滚点: ${rollbackRoot}`);
  } catch (error) {
    console.error("切换失败，尝试恢复原数据…");
    try {
      if (existsSync(join(rollbackRoot, "data")) && !existsSync(dataDir)) {
        renameSync(join(rollbackRoot, "data"), dataDir);
      }
      if (existsSync(join(rollbackRoot, "files")) && !existsSync(filesDir)) {
        renameSync(join(rollbackRoot, "files"), filesDir);
      }
    } catch (restoreError) {
      console.error("自动恢复失败，请手动从 rollback 目录还原:", restoreError);
    }
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  runCli();
}
