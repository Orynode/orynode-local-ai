/**
 * SSRF 防护 + DNS pinning 拉取（KE-P0-05）
 *
 * - 仅公网 http/https，默认端口 80/443
 * - 解析后校验全部地址；连接钉死到已校验 IP，TLS SNI/Host 保持原 hostname
 * - 每次 redirect 重新校验；限制次数与响应体大小
 * - 错误信息不回传内部 IP / 解析细节
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import type { IncomingMessage } from "node:http";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.google",
]);

const ALLOWED_PORTS = new Set([80, 443]);
const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

const SAFE_REJECT = "目标地址不安全或不可达";

function normalizeIp(ip: string): string {
  const v = ip.toLowerCase().trim();
  // IPv4-mapped IPv6 → 提取 IPv4
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(v);
  if (mapped) return mapped[1];
  return v;
}

export function isPrivateIp(ip: string): boolean {
  const v = normalizeIp(ip);
  if (v === "::1" || v === "0.0.0.0" || v === "::") return true;
  if (v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80:")) {
    return true;
  }
  // IPv6 文档/未指定等
  if (v === "2001:db8::" || v.startsWith("2001:db8:")) return true;

  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) {
    // 其它 IPv6：仅允许全局单播粗检（非 fe80/fc/fd/::1 已覆盖一部分）
    if (v.includes(":")) {
      if (v.startsWith("::") && v !== "::1") {
        // ::ffff: 已 normalize；其它压缩本地
        return v === "::" || v.startsWith("::ffff:");
      }
      return false;
    }
    return true; // 无法识别的形式一律拒绝
  }
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

export type ResolvedSafeUrl = {
  url: URL;
  /** 已校验的公网地址；连接必须钉到这些 IP 之一 */
  addresses: string[];
};

function assertAllowedPort(url: URL): void {
  const port = url.port
    ? Number(url.port)
    : url.protocol === "https:"
      ? 443
      : 80;
  if (!ALLOWED_PORTS.has(port)) {
    throw new Error("仅允许默认端口 80/443");
  }
}

/**
 * 校验 URL 并解析安全地址列表（不发起连接）。
 */
export async function resolveSafeHttpUrl(raw: string): Promise<ResolvedSafeUrl> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("无效的 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("仅支持 http/https");
  }
  if (url.username || url.password) {
    throw new Error("URL 不能包含用户名或密码");
  }
  assertAllowedPort(url);

  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".localhost")) {
    throw new Error(SAFE_REJECT);
  }

  if (isIP(host)) {
    if (isPrivateIp(host)) {
      throw new Error(SAFE_REJECT);
    }
    return { url, addresses: [normalizeIp(host)] };
  }

  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookup(host, { all: true });
  } catch {
    throw new Error(SAFE_REJECT);
  }
  if (!records.length) {
    throw new Error(SAFE_REJECT);
  }
  const addresses: string[] = [];
  for (const record of records) {
    const addr = normalizeIp(record.address);
    if (isPrivateIp(addr)) {
      throw new Error(SAFE_REJECT);
    }
    addresses.push(addr);
  }
  return { url, addresses };
}

/** @deprecated 兼容旧名；等价 resolveSafeHttpUrl(...).url */
export async function assertSafeHttpUrl(raw: string): Promise<URL> {
  const resolved = await resolveSafeHttpUrl(raw);
  return resolved.url;
}

export type PinnedFetchResult = {
  status: number;
  headers: Headers;
  url: URL;
  body: Uint8Array;
};

function headersFromMessage(res: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(res.headers)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

function readBody(
  res: IncomingMessage,
  maxBytes: number,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    res.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        res.destroy();
        reject(new Error("响应体过大"));
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    res.on("error", () => reject(new Error(SAFE_REJECT)));
  });
}

/**
 * 钉死到已校验 IP 的单次请求（不自动跟随 redirect）。
 */
export async function pinnedRequest(
  resolved: ResolvedSafeUrl,
  options: {
    method?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    maxBytes?: number;
  } = {},
): Promise<PinnedFetchResult> {
  const { url, addresses } = resolved;
  const address = addresses[0];
  if (!address) throw new Error(SAFE_REJECT);

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const isHttps = url.protocol === "https:";
  const port = url.port
    ? Number(url.port)
    : isHttps
      ? 443
      : 80;

  const requestHeaders: Record<string, string> = {
    host: url.host,
    connection: "close",
    ...(options.headers ?? {}),
  };

  return new Promise((resolve, reject) => {
    const lib = isHttps ? https : http;
    const req = lib.request(
      {
        protocol: url.protocol,
        method: options.method ?? "GET",
        hostname: address,
        port,
        path: `${url.pathname}${url.search}`,
        headers: requestHeaders,
        servername: isHttps ? url.hostname : undefined,
        setHost: false,
        timeout: timeoutMs,
      },
      (res) => {
        readBody(res, maxBytes)
          .then((body) => {
            resolve({
              status: res.statusCode ?? 0,
              headers: headersFromMessage(res),
              url,
              body,
            });
          })
          .catch(reject);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("连接超时"));
    });
    req.on("error", () => reject(new Error(SAFE_REJECT)));
    req.end();
  });
}

/**
 * 安全拉取：DNS pinning + 手动 redirect 校验。
 */
export async function safeFetch(
  rawUrl: string,
  options: {
    headers?: Record<string, string>;
    timeoutMs?: number;
    maxBytes?: number;
    maxRedirects?: number;
  } = {},
): Promise<PinnedFetchResult> {
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  let current = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const resolved = await resolveSafeHttpUrl(current);
    const result = await pinnedRequest(resolved, {
      headers: options.headers,
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
    });

    if (![301, 302, 303, 307, 308].includes(result.status)) {
      return result;
    }
    if (hop === maxRedirects) {
      throw new Error("重定向次数过多");
    }
    const location = result.headers.get("location");
    if (!location) {
      throw new Error("重定向缺少 Location");
    }
    // 相对 Location 基于当前 URL；下一跳完整重新校验
    current = new URL(location, resolved.url).toString();
  }

  throw new Error("重定向次数过多");
}
