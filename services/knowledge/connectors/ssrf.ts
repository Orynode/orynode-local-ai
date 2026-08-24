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

/** WHATWG URL 保留 IPv6 字面量的方括号（hostname === "[::1]"）；判定前必须剥离 */
function stripIpv6Brackets(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }
  return host;
}

function normalizeIp(ip: string): string {
  const v = ip.toLowerCase().trim();
  // IPv4-mapped IPv6 → 提取 IPv4
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(v);
  if (mapped) return mapped[1];
  return v;
}

/**
 * IPv6 → 16 字节。覆盖 WHATWG URL 序列化形态（如 ::ffff:7f00:1）、
 * IPv4-compatible（::7f00:1，Linux 内核仍按 IPv4 路由）与
 * NAT64（64:ff9b::/96，DNS64 网络中真实路由到内嵌 IPv4）。
 */
function ipv6ToBytes(ip: string): Uint8Array | null {
  const groups = ip.split("::");
  if (groups.length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (side === "") return [];
    const parts = side.split(":");
    const out: number[] = [];
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]!;
      // 内嵌 IPv4（点分形式只允许出现在最后一组）
      if (part.includes(".")) {
        if (i !== parts.length - 1) return null;
        const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(part);
        if (!m) return null;
        out.push(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]));
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      const value = parseInt(part, 16);
      out.push(value >> 8, value & 0xff);
    }
    return out;
  };
  let head: number[] | null;
  let tail: number[] | null;
  if (groups.length === 2) {
    head = parseSide(groups[0]!);
    tail = parseSide(groups[1]!);
  } else {
    const side = parseSide(groups[0]!);
    head = side;
    tail = side ? [] : null;
  }
  if (!head || !tail) return null;
  const total = head.length + tail.length;
  if (total > 16 || (groups.length === 2 && total === 16)) return null;
  const bytes = new Uint8Array(16);
  bytes.set(head, 0);
  bytes.set(tail, 16 - tail.length);
  return bytes;
}

function ipv4InPrivateRange(bytes: Uint8Array): boolean {
  const a = bytes[0]!;
  const b = bytes[1]!;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

/** IPv6 低 32 位是否内嵌私网 IPv4（mapped / compatible / NAT64 同判） */
function ipv6EmbedsPrivateV4(bytes: Uint8Array): boolean {
  const tail = bytes.slice(12);
  const allZeroPrefix = bytes.slice(0, 10).every((b) => b === 0);
  const isMappedOrCompatible =
    allZeroPrefix &&
    (bytes[10] === 0xff ? bytes[11] === 0xff : bytes[10] === 0 && bytes[11] === 0);
  const nat64 =
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((b) => b === 0);
  if (isMappedOrCompatible || nat64) {
    return ipv4InPrivateRange(tail);
  }
  return false;
}

export function isPrivateIp(ip: string): boolean {
  const bare = stripIpv6Brackets(normalizeIp(ip));
  if (bare === "::1" || bare === "0.0.0.0" || bare === "::") return true;

  const family = isIP(bare);
  if (family === 6) {
    const bytes = ipv6ToBytes(bare);
    if (!bytes) return true; // 解析失败一律拒绝
    // ULA fc00::/7、链路本地 fe80::/10、组播 ff00::/8、文档 2001:db8::/32
    if (bytes[0]! >= 0xfc && bytes[0]! <= 0xfd) return true;
    if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true;
    if (bytes[0] === 0xff) return true;
    if (
      bytes[0] === 0x20 &&
      bytes[1] === 0x01 &&
      bytes[2] === 0x0d &&
      bytes[3] === 0xb8
    ) {
      return true;
    }
    if (ipv6EmbedsPrivateV4(bytes)) return true;
    return false;
  }

  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(bare);
  if (!m) {
    return true; // 无法识别的形式一律拒绝
  }
  if (ipv4InPrivateRange(new Uint8Array([Number(m[1])!, Number(m[2])!, Number(m[3])!, Number(m[4])!]))) {
    return true;
  }
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

  // IPv6 字面量（含方括号形态）一律本地校验，绝不做 DNS lookup
  const bareHost = stripIpv6Brackets(host);
  if (isIP(bareHost)) {
    if (isPrivateIp(bareHost)) {
      throw new Error(SAFE_REJECT);
    }
    return { url, addresses: [normalizeIp(bareHost)] };
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
