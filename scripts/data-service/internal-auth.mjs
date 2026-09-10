/**
 * data-service /wiki 可选 HMAC。
 *
 * vinext API 跑在 Worker 里，读不到 `.orynode/data-internal.token`，也拿不到
 * Node 进程里的 ORYNODE_DATA_INTERNAL_TOKEN。服务本身 bind 127.0.0.1，
 * 默认不强制 HMAC。ORYNODE_DATA_INTERNAL_AUTH=1 时：无头回环仍放行，
 * 带了 HMAC 头则校验（兼容 Node worker）。
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const DATA_INTERNAL_TOKEN_FILENAME = "data-internal.token";
export const DATA_INTERNAL_MAX_SKEW_MS = 5 * 60 * 1000;

export function internalAuthDisabled() {
  const flag = String(process.env.ORYNODE_DATA_INTERNAL_AUTH || "0").trim();
  return flag !== "1" && flag !== "true";
}

/**
 * @param {string} projectRoot
 * @returns {string}
 */
export function internalTokenPath(projectRoot) {
  const fromEnv = String(process.env.ORYNODE_DATA_INTERNAL_TOKEN_PATH || "").trim();
  if (fromEnv) return fromEnv;
  return resolve(projectRoot, ".orynode", DATA_INTERNAL_TOKEN_FILENAME);
}

/**
 * @param {string} projectRoot
 * @returns {string}
 */
export function loadOrCreateInternalToken(projectRoot) {
  const fromEnv = String(process.env.ORYNODE_DATA_INTERNAL_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  const path = internalTokenPath(projectRoot);
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) return existing;
  } catch {
    // create below
  }
  mkdirSync(dirname(path), { recursive: true });
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  return token;
}

/**
 * pageId 含冒号时，客户端 URL.pathname 可能仍是 %3A，服务端 request.url 也可能已解码。
 * 按段 decode，避免 HMAC 对同一页签出两种串。
 * @param {string} pathname
 */
export function canonicalizeHmacPath(pathname) {
  return String(pathname || "")
    .split("/")
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    })
    .join("/");
}

/**
 * @param {string} secret
 * @param {string} method
 * @param {string} pathname
 * @param {string} timestamp
 */
function hmacHex(secret, method, pathname, timestamp) {
  return createHmac("sha256", secret)
    .update(
      `${String(method || "GET").toUpperCase()}\n${pathname}\n${timestamp}`,
    )
    .digest("hex");
}

export function signInternalMac(secret, method, pathname, timestamp) {
  return hmacHex(secret, method, canonicalizeHmacPath(pathname), timestamp);
}

function hmacPathVariants(pathname) {
  const raw = String(pathname || "");
  const canonical = canonicalizeHmacPath(raw);
  const encodedColons = canonical
    .split("/")
    .map((part) => part.replaceAll(":", "%3A"))
    .join("/");
  return [...new Set([raw, canonical, encodedColons])];
}

/**
 * @param {string} left
 * @param {string} right
 */
export function safeEqualHex(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  if (!a || !b || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/**
 * @param {{
 *   secret: string,
 *   method: string,
 *   pathname: string,
 *   timestamp: string,
 *   mac: string,
 *   now?: number,
 * }} input
 */
export function verifyInternalMac(input) {
  const secret = String(input.secret || "").trim();
  const timestamp = String(input.timestamp || "").trim();
  const mac = String(input.mac || "").trim();
  if (!secret || !timestamp || !mac) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = input.now ?? Date.now();
  if (Math.abs(now - ts) > DATA_INTERNAL_MAX_SKEW_MS) return false;
  for (const pathname of hmacPathVariants(input.pathname)) {
    if (safeEqualHex(hmacHex(secret, input.method, pathname, timestamp), mac)) {
      return true;
    }
  }
  return false;
}

export function isLoopbackRemoteAddress(addr) {
  if (!addr || typeof addr !== "string") return false;
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1" ||
    addr.startsWith("127.")
  );
}

/**
 * @param {{
 *   disabled?: boolean,
 *   secret: string,
 *   method: string,
 *   pathname: string,
 *   timestamp: string,
 *   mac: string,
 *   remoteAddress?: string,
 *   now?: number,
 * }} input
 */
export function wikiInternalAuthOk(input) {
  if (input.disabled) return true;
  const timestamp = String(input.timestamp || "").trim();
  const mac = String(input.mac || "").trim();
  if (!timestamp && !mac && isLoopbackRemoteAddress(input.remoteAddress)) {
    return true;
  }
  return verifyInternalMac({
    secret: input.secret,
    method: input.method,
    pathname: input.pathname,
    timestamp,
    mac,
    now: input.now,
  });
}

export function tokenFileExists(projectRoot) {
  try {
    return existsSync(internalTokenPath(projectRoot));
  } catch {
    return false;
  }
}
