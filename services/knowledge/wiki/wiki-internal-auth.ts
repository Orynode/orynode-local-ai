/**
 * Node worker 调 data-service /wiki 时附带 HMAC（能读到 token 文件时）。
 * vinext Worker 读不到文件，会发无头请求；服务端回环放行。
 * 与 scripts/data-service/internal-auth.mjs 使用同一签名串。
 */

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

function canonicalizeHmacPath(pathname: string): string {
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

function tokenCandidates(): string[] {
  const fromPath = String(process.env.ORYNODE_DATA_INTERNAL_TOKEN_PATH || "").trim();
  const found: string[] = [];
  if (fromPath) found.push(fromPath);
  const db = String(process.env.ORYNODE_DATABASE_PATH || "").trim();
  if (db) found.push(join(dirname(db), "..", "data-internal.token"));
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    found.push(join(dir, ".orynode", "data-internal.token"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

function readInternalToken(): string {
  const fromEnv = String(process.env.ORYNODE_DATA_INTERNAL_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  for (const path of tokenCandidates()) {
    try {
      const token = readFileSync(path, "utf8").trim();
      if (token) return token;
    } catch {
      // try next
    }
  }
  return "";
}

export function signWikiInternalMac(
  secret: string,
  method: string,
  pathname: string,
  timestamp: string,
): string {
  return createHmac("sha256", secret)
    .update(`${method.toUpperCase()}\n${canonicalizeHmacPath(pathname)}\n${timestamp}`)
    .digest("hex");
}

export function wikiInternalHeaders(
  method: string,
  pathname: string,
): Record<string, string> {
  const secret = readInternalToken();
  if (!secret) return {};
  const timestamp = String(Date.now());
  return {
    "x-orynode-ts": timestamp,
    "x-orynode-mac": signWikiInternalMac(secret, method, pathname, timestamp),
  };
}
