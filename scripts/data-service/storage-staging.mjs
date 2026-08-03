/**
 * 知识文件 staging 写入 + 启动 reconciliation（KE-P2-04）
 *
 * 协议：写入 *.partial → rename 到最终路径 → 数据库 committed。
 * 启动时只清理未提交的 partial / staging 行；不删仍可能被引用的正式文件。
 */

import {
  existsSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * @param {import("node:sqlite").DatabaseSync} database
 */
export function createStorageStagingStore(database) {
  const insert = database.prepare(`
    INSERT INTO storage_staging (
      id, namespace, document_id, staging_path, final_path, content_hash,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'writing', ?, ?)
  `);
  const setStatus = database.prepare(`
    UPDATE storage_staging
    SET status = ?, document_id = COALESCE(?, document_id), updated_at = ?
    WHERE id = ?
  `);
  const listOpen = database.prepare(`
    SELECT
      id, namespace, document_id AS documentId, staging_path AS stagingPath,
      final_path AS finalPath, content_hash AS contentHash, status,
      created_at AS createdAt, updated_at AS updatedAt
    FROM storage_staging
    WHERE status IN ('writing', 'renamed')
  `);

  return {
    /**
     * 同卷原子写入：先 partial，再 rename。
     * @returns {{ stagingId: string, finalPath: string }}
     */
    writeAtomicFile({
      namespace,
      documentId = null,
      finalPath,
      buffer,
      contentHash = null,
    }) {
      const now = new Date().toISOString();
      const stagingId = randomUUID();
      const stagingPath = `${finalPath}.partial`;
      insert.run(
        stagingId,
        namespace,
        documentId,
        stagingPath,
        finalPath,
        contentHash,
        now,
        now,
      );
      try {
        writeFileSync(stagingPath, buffer, { flag: "wx" });
        renameSync(stagingPath, finalPath);
        setStatus.run("renamed", documentId, new Date().toISOString(), stagingId);
        return { stagingId, finalPath };
      } catch (error) {
        try {
          if (existsSync(stagingPath)) unlinkSync(stagingPath);
        } catch {
          // ignore
        }
        setStatus.run("aborted", documentId, new Date().toISOString(), stagingId);
        throw error;
      }
    },

    markCommitted(stagingId, documentId = null) {
      setStatus.run(
        "committed",
        documentId,
        new Date().toISOString(),
        stagingId,
      );
    },

    abort(stagingId) {
      const row = database
        .prepare(
          `SELECT staging_path AS stagingPath, final_path AS finalPath, status
           FROM storage_staging WHERE id = ?`,
        )
        .get(stagingId);
      if (!row) return;
      if (row.status === "writing" && existsSync(row.stagingPath)) {
        try {
          unlinkSync(row.stagingPath);
        } catch {
          // ignore
        }
      }
      // renamed 但未 committed：仅当最终文件不在文档表中才删除
      setStatus.run("aborted", null, new Date().toISOString(), stagingId);
    },

    /**
     * 启动时清理：删除残留 *.partial；aborted/writing staging 行。
     * 不删除已存在于 knowledge_documents / conversation_files 的正式文件。
     */
    reconcileOnStartup({ knowledgeFilesPath, attachmentFilesPath, log = console }) {
      const open = listOpen.all();
      let cleanedPartials = 0;
      let abortedRows = 0;

      for (const row of open) {
        if (row.status === "writing" && existsSync(row.stagingPath)) {
          try {
            unlinkSync(row.stagingPath);
            cleanedPartials += 1;
          } catch {
            // ignore
          }
        }
        if (row.status === "renamed" && row.finalPath) {
          const inLibrary = database
            .prepare(`SELECT 1 AS ok FROM knowledge_documents WHERE stored_path = ?`)
            .get(row.finalPath);
          const inConversation = database
            .prepare(`SELECT 1 AS ok FROM conversation_files WHERE stored_path = ?`)
            .get(row.finalPath);
          if (!inLibrary && !inConversation && existsSync(row.finalPath)) {
            // 写库失败留下的孤儿 final：安全删除（尚无引用）
            try {
              unlinkSync(row.finalPath);
            } catch {
              // ignore
            }
          }
        }
        setStatus.run("aborted", row.documentId, new Date().toISOString(), row.id);
        abortedRows += 1;
      }

      for (const dir of [knowledgeFilesPath, attachmentFilesPath].filter(Boolean)) {
        if (!existsSync(dir)) continue;
        for (const name of readdirSync(dir)) {
          if (!name.endsWith(".partial")) continue;
          try {
            unlinkSync(join(dir, name));
            cleanedPartials += 1;
          } catch {
            // ignore
          }
        }
      }

      if (cleanedPartials || abortedRows) {
        log.info?.(
          `[storage] reconcile: partials=${cleanedPartials} abortedRows=${abortedRows}`,
        );
      }
      return { cleanedPartials, abortedRows };
    },
  };
}

export function stagingBasename(finalPath) {
  return `${basename(finalPath)}.partial`;
}

export function stagingDir(finalPath) {
  return dirname(finalPath);
}
