/**
 * Connector 同步编排：discover → fetch → ingestDocument（统一管线）
 *
 * - 内容更新：hash 变化才重建
 * - 删除检测：仅在完整可证明枚举（generation complete）后 tombstone
 * - truncated / 分页未完成时不误删
 * - token 等敏感字段不会写入 sources.config
 */

import { z } from "zod";
import { ingestDocument } from "../ingest";
import type { SourceConnector, SourcePayload } from "../ports/connectors";
import { getConnector } from "../connectors/registry";
import { registerBuiltinConnectors } from "../connectors/builtins";
import { webConnectorConfigSchema } from "../connectors/web";
import { githubConnectorConfigSchema } from "../connectors/github";
import {
  ORYNODE_DATA_URL,
  HTTP_TIMEOUT,
} from "../../../config/defaults";

registerBuiltinConnectors();

const dataUrl = ORYNODE_DATA_URL;

export type SyncSourceResult = {
  sourceId: string;
  imported: number;
  updated: number;
  unchanged: number;
  tombstoned: number;
  enumerationComplete: boolean;
  generation: number;
  errors: Array<{ externalId: string; error: string }>;
};

function stripSecrets(
  type: string,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const copy = { ...config };
  delete copy.token;
  delete copy.password;
  delete copy.secret;
  if (type === "web") {
    return webConnectorConfigSchema.parse(copy);
  }
  if (type === "github") {
    const parsed = githubConnectorConfigSchema.parse(copy);
    const { token: _t, ...rest } = parsed;
    return rest;
  }
  return copy;
}

function connectorFor(type: string): SourceConnector {
  return getConnector(type);
}

async function api<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${dataUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledgeImport),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `data-service 错误 ${response.status}`);
  }
  return body as T;
}

function fileNameForPayload(payload: SourcePayload): string {
  const base = payload.title.replace(/[/\\]/g, "_").slice(0, 120) || "source";
  if (base.endsWith(".md") || base.endsWith(".txt")) return base;
  return `${base}.md`;
}

async function ingestPayload(payload: SourcePayload) {
  const bytes = payload.body.buffer.slice(
    payload.body.byteOffset,
    payload.body.byteOffset + payload.body.byteLength,
  ) as ArrayBuffer;
  return ingestDocument({
    bytes,
    fileName: fileNameForPayload(payload),
    displayName: payload.title,
    contentType: payload.mimeType,
    target: { namespace: "library" },
  });
}

export async function createAndSyncWebSource(input: {
  url: string;
  name?: string;
}): Promise<SyncSourceResult> {
  const config = webConnectorConfigSchema.parse({ url: input.url });
  const created = await api<{ source: { id: string } }>("/sources", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "web",
      name: input.name || config.url,
      config: stripSecrets("web", config),
    }),
  });
  return syncSource(created.source.id, config);
}

export async function createAndSyncGitHubSource(input: {
  owner: string;
  repo: string;
  ref?: string;
  pathPrefix?: string;
  token?: string;
  name?: string;
}): Promise<SyncSourceResult> {
  const config = githubConnectorConfigSchema.parse(input);
  const created = await api<{ source: { id: string } }>("/sources", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "github",
      name: input.name || `${config.owner}/${config.repo}`,
      config: stripSecrets("github", config as unknown as Record<string, unknown>),
    }),
  });
  return syncSource(created.source.id, config);
}

export async function syncSource(
  sourceId: string,
  runtimeConfig?: unknown,
): Promise<SyncSourceResult> {
  const { source } = await api<{
    source: {
      id: string;
      type: string;
      config: Record<string, unknown>;
      checkpoint?: string | null;
    };
  }>(`/sources/${encodeURIComponent(sourceId)}`);

  const connector = connectorFor(source.type);
  const config = runtimeConfig
    ? { ...source.config, ...(runtimeConfig as object) }
    : source.config;

  const begun = await api<{ source: { syncGeneration: number } }>(
    `/sources/${encodeURIComponent(sourceId)}/sync-generation/begin`,
    { method: "POST" },
  );
  const generation = begun.source.syncGeneration;

  const result: SyncSourceResult = {
    sourceId,
    imported: 0,
    updated: 0,
    unchanged: 0,
    tombstoned: 0,
    enumerationComplete: false,
    generation,
    errors: [],
  };

  try {
    const health = await connector.test(config);
    if (!health.ok) {
      throw new Error(health.detail || "Connector 健康检查失败");
    }

    let cursor: string | undefined;
    let enumerationComplete = true;
    const seen = new Set<string>();

    do {
      const page = await connector.discover(config, cursor);
      if (page.truncated || page.enumerationComplete === false) {
        enumerationComplete = false;
      }
      for (const item of page.items) {
        seen.add(item.externalId);
        try {
          const existing = await api<{
            item: null | {
              contentHash?: string | null;
              documentId?: string | null;
              tombstone?: boolean;
            };
          }>(
            `/sources/${encodeURIComponent(sourceId)}/item?externalId=${encodeURIComponent(item.externalId)}`,
          );

          if (
            existing.item &&
            item.contentHashHint &&
            existing.item.contentHash === item.contentHashHint &&
            existing.item.documentId &&
            !existing.item.tombstone
          ) {
            result.unchanged += 1;
            await api(`/sources/${encodeURIComponent(sourceId)}/items`, {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                externalId: item.externalId,
                lastSeenGeneration: generation,
                tombstone: false,
              }),
            });
            continue;
          }

          const payload = await connector.fetch(config, item);
          if (
            existing.item?.contentHash &&
            existing.item.contentHash === payload.contentHash &&
            existing.item.documentId &&
            !existing.item.tombstone
          ) {
            result.unchanged += 1;
            await api(`/sources/${encodeURIComponent(sourceId)}/items`, {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                externalId: payload.externalId,
                uri: payload.uri,
                title: payload.title,
                mimeType: payload.mimeType,
                contentHash: payload.contentHash,
                documentId: existing.item.documentId,
                metadata: payload.metadata ?? {},
                tombstone: false,
                syncError: null,
                lastSeenGeneration: generation,
              }),
            });
            continue;
          }

          const ingested = await ingestPayload(payload);
          if (ingested.namespace !== "library") {
            throw new Error("入库结果异常");
          }
          const documentId = ingested.document.id;
          await api(`/sources/${encodeURIComponent(sourceId)}/items`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              externalId: payload.externalId,
              uri: payload.uri,
              title: payload.title,
              mimeType: payload.mimeType,
              contentHash: payload.contentHash,
              documentId,
              metadata: {
                ...(payload.metadata ?? {}),
                locatorHint: payload.locatorHint,
              },
              tombstone: false,
              syncError: null,
              lastSeenGeneration: generation,
            }),
          });
          if (existing.item?.documentId) {
            result.updated += 1;
          } else {
            result.imported += 1;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push({ externalId: item.externalId, error: message });
          try {
            await api(`/sources/${encodeURIComponent(sourceId)}/items`, {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                externalId: item.externalId,
                uri: item.uri,
                title: item.title,
                mimeType: item.mimeType,
                metadata: item.metadata ?? {},
                syncError: message,
                lastSeenGeneration: generation,
              }),
            });
          } catch {
            // ignore secondary failure
          }
        }
      }
      cursor = page.nextCursor;
      if (page.nextCursor) {
        // checkpoint 只在本页处理后推进（可恢复分页）
        await api(`/sources/${encodeURIComponent(sourceId)}/status`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            status: "syncing",
            checkpoint: page.nextCursor,
          }),
        });
      }
    } while (cursor);

    result.enumerationComplete = enumerationComplete;

    // 删除检测：仅完整枚举后 tombstone
    if (enumerationComplete) {
      const stale = await api<{ externalIds: string[] }>(
        `/sources/${encodeURIComponent(sourceId)}/items/stale?generation=${generation}`,
      );
      for (const externalId of stale.externalIds) {
        if (seen.has(externalId)) continue;
        await api(`/sources/${encodeURIComponent(sourceId)}/items`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            externalId,
            tombstone: true,
          }),
        });
        result.tombstoned += 1;
      }
      await api(
        `/sources/${encodeURIComponent(sourceId)}/sync-generation/complete`,
        { method: "POST" },
      );
    }

    let checkpoint: string | null = null;
    if (connector.checkpoint) {
      checkpoint = await connector.checkpoint(config);
    }

    await api(`/sources/${encodeURIComponent(sourceId)}/status`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: result.errors.length ? "error" : "ready",
        checkpoint,
        lastError:
          result.errors.length > 0
            ? `${result.errors.length} 个条目同步失败`
            : enumerationComplete
              ? null
              : "枚举未完整（例如 GitHub tree truncated），已跳过删除检测",
      }),
    });

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await api(`/sources/${encodeURIComponent(sourceId)}/status`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "error", lastError: message }),
    });
    throw error;
  }
}

export const createWebSourceBodySchema = z.object({
  url: z.string().url(),
  name: z.string().optional(),
});

export const createGitHubSourceBodySchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  ref: z.string().optional(),
  pathPrefix: z.string().optional(),
  token: z.string().optional(),
  name: z.string().optional(),
});
