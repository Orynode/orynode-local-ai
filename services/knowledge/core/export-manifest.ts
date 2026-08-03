/**
 * 知识库导出清单 schema（平台无关）
 *
 * 不含绝对路径、凭据、模型权重。
 * formatVersion 2：文件清单含 size + sha256（KE-P0-06）。
 */

import { z } from "zod";

export const EXPORT_FORMAT_VERSION = 2 as const;

const fileEntrySchema = z.object({
  relativePath: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: z.string().min(64).max(64),
});

export const knowledgeExportManifestSchema = z.object({
  formatVersion: z.union([z.literal(1), z.literal(2)]),
  exportedAt: z.string(),
  appVersion: z.string().optional(),
  indexBackend: z.string().optional(),
  /** knowledge | knowledge_and_conversations | full */
  backupLevel: z
    .enum(["knowledge", "knowledge_and_conversations", "full"])
    .optional()
    .default("knowledge"),
  schemaMigrations: z.array(z.string()).optional(),
  documents: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      contentHash: z.string().optional(),
      originalName: z.string().optional(),
      /** 相对 storage key，如 files/<hash>.pdf */
      storageKey: z.string(),
      status: z.string().optional(),
    }),
  ),
  sources: z
    .array(
      z.object({
        id: z.string(),
        type: z.string(),
        name: z.string(),
        /** 已剥离 secret 的配置 */
        config: z.record(z.unknown()).optional(),
      }),
    )
    .optional(),
  database: z.object({
    /** 相对路径，如 database/orynode.db */
    relativePath: z.string(),
    note: z.string().optional(),
    size: z.number().int().nonnegative().optional(),
    sha256: z.string().optional(),
  }),
  /** formatVersion>=2：包内全部文件的完整性清单 */
  files: z.array(fileEntrySchema).optional(),
});

export type KnowledgeExportManifest = z.infer<
  typeof knowledgeExportManifestSchema
>;

export function parseExportManifest(input: unknown): KnowledgeExportManifest {
  return knowledgeExportManifestSchema.parse(input);
}

/** 拒绝绝对路径、盘符、.. 穿越 */
export function assertSafeRelativePath(relativePath: string): string {
  const key = String(relativePath || "").replace(/\\/g, "/");
  if (!key || key.startsWith("/") || key.includes("..") || /^[A-Za-z]:/.test(key)) {
    throw new Error(`非法相对路径: ${relativePath}`);
  }
  return key;
}
