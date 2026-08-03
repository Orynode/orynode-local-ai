/**
 * Web URL Connector
 *
 * - SSRF + DNS pinning 后拉取 HTML（KE-P0-05）
 * - jsdom 禁用脚本与子资源
 * - @mozilla/readability 提取正文；失败则退回标题+纯文本
 */

import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { z } from "zod";
import type {
  ConnectorHealth,
  DiscoveredItem,
  DiscoverPage,
  SourceConnector,
  SourcePayload,
} from "../ports/connectors";
import { assertSafeHttpUrl, safeFetch } from "./ssrf";

const MAX_HTML_BYTES = 2 * 1024 * 1024;

export const webConnectorConfigSchema = z.object({
  url: z.string().url(),
});

export type WebConnectorConfig = z.infer<typeof webConnectorConfigSchema>;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function htmlToMarkdownish(title: string, text: string, url: string): string {
  const body = text.replace(/\r\n/g, "\n").trim();
  return `# ${title}\n\n来源: ${url}\n\n${body}\n`;
}

export class WebUrlConnector implements SourceConnector {
  readonly type = "web" as const;

  async test(config: unknown): Promise<ConnectorHealth> {
    const parsed = webConnectorConfigSchema.safeParse(config);
    if (!parsed.success) {
      return { ok: false, detail: "需要合法的 url 字段" };
    }
    try {
      await assertSafeHttpUrl(parsed.data.url);
      return { ok: true, detail: "URL 通过安全检查" };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : "URL 不安全",
      };
    }
  }

  async discover(config: unknown): Promise<DiscoverPage> {
    const parsed = webConnectorConfigSchema.parse(config);
    const url = await assertSafeHttpUrl(parsed.url);
    const canonical = url.toString();
    return {
      items: [
        {
          externalId: canonical,
          uri: canonical,
          title: canonical,
          mimeType: "text/html",
          metadata: { sourceType: "web" },
        },
      ],
    };
  }

  async fetch(
    config: unknown,
    item: DiscoveredItem,
  ): Promise<SourcePayload> {
    const parsed = webConnectorConfigSchema.parse(config);
    await assertSafeHttpUrl(item.uri || parsed.url);

    const current = await safeFetch(item.uri || parsed.url, {
      headers: {
        "user-agent": "OrynodeLocalAI/0.3 (+local knowledge connector)",
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      },
      timeoutMs: 20_000,
      maxBytes: MAX_HTML_BYTES,
      maxRedirects: 3,
    });

    if (current.status < 200 || current.status >= 300) {
      throw new Error(`网页抓取失败: HTTP ${current.status}`);
    }
    const contentType = current.headers.get("content-type") || "text/html";
    if (!/html|xml|text\/plain/i.test(contentType)) {
      throw new Error(`不支持的网页类型: ${contentType}`);
    }

    const buffer = current.body;
    const finalUrl = current.url;
    const html = new TextDecoder("utf-8").decode(buffer);

    const dom = new JSDOM(html, {
      url: finalUrl.toString(),
      pretendToBeVisual: false,
    });
    const document = dom.window.document;
    for (const el of [...document.querySelectorAll("script, iframe, object, embed")]) {
      el.remove();
    }

    const reader = new Readability(document);
    const article = reader.parse();
    const title =
      article?.title?.trim() ||
      document.title?.trim() ||
      finalUrl.hostname;
    const text =
      article?.textContent?.trim() ||
      document.body?.textContent?.replace(/\s+/g, " ").trim() ||
      "";
    if (!text) {
      throw new Error("未能从网页提取正文");
    }

    const markdown = htmlToMarkdownish(title, text, finalUrl.toString());
    const body = new TextEncoder().encode(markdown);
    const etag = current.headers.get("etag") || undefined;
    const lastModified = current.headers.get("last-modified") || undefined;

    return {
      externalId: finalUrl.toString(),
      uri: finalUrl.toString(),
      title,
      mimeType: "text/markdown",
      body,
      contentHash: sha256(body),
      metadata: {
        sourceType: "web",
        etag,
        lastModified,
        extractedBy: article ? "readability" : "dom-text",
      },
      locatorHint: {
        kind: "web",
        url: finalUrl.toString(),
        headingPath: title ? [title] : undefined,
      },
    };
  }
}

export const webUrlConnector = new WebUrlConnector();
