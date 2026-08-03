/**
 * 示例 Connector：本地 Markdown 文件夹（不进入默认产品，仅 SDK 演示）
 *
 * 注册：
 *   import { registerConnector } from "../../../services/knowledge/connectors/sdk";
 *   import { markdownFolderConnector } from "./connector";
 *   registerConnector("markdown_folder", () => markdownFolderConnector);
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type {
  ConnectorHealth,
  DiscoveredItem,
  DiscoverPage,
  SourceConnector,
  SourcePayload,
} from "../../../services/knowledge/ports/connectors";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export class MarkdownFolderConnector implements SourceConnector {
  readonly type = "file" as const;

  async test(config: unknown): Promise<ConnectorHealth> {
    const root = (config as { root?: string })?.root;
    if (!root || typeof root !== "string") {
      return { ok: false, detail: "需要 root 目录路径" };
    }
    try {
      if (!statSync(root).isDirectory()) {
        return { ok: false, detail: "root 不是目录" };
      }
      return { ok: true, detail: root };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : "无法访问目录",
      };
    }
  }

  async discover(config: unknown): Promise<DiscoverPage> {
    const root = String((config as { root: string }).root);
    const items: DiscoveredItem[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(md|markdown|txt)$/i.test(entry)) continue;
        const rel = relative(root, full).replace(/\\/g, "/");
        items.push({
          externalId: rel,
          uri: `file://${full}`,
          title: rel,
          mimeType: "text/markdown",
          metadata: { path: full, relativePath: rel },
        });
      }
    };
    walk(root);
    return { items };
  }

  async fetch(
    _config: unknown,
    item: DiscoveredItem,
  ): Promise<SourcePayload> {
    const path = String(item.metadata?.path || "");
    const text = readFileSync(path, "utf8");
    const body = new TextEncoder().encode(text);
    return {
      externalId: item.externalId,
      uri: item.uri,
      title: item.title,
      mimeType: "text/markdown",
      body,
      contentHash: sha256(text),
      metadata: item.metadata,
      locatorHint: {
        kind: "text",
        startOffset: 0,
        endOffset: text.length,
      },
    };
  }
}

export const markdownFolderConnector = new MarkdownFolderConnector();
