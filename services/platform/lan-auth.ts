/**
 * Trusted-LAN pairing / Session / 撤销（KE-P3-02）
 *
 * - Local-only：不要求认证
 * - Trusted-LAN + UNSAFE：开发预览，跳过认证（须显式开关）
 * - Trusted-LAN 正式路径：一次性 pairing code → session cookie → 可撤销
 *
 * 配对管理（start/list/revoke）应走 loopback Data Service `/lan-auth/pairing`，
 * 勿仅凭 Host 头判定本机（可伪造）。本模块的 allowLoopbackWithoutSession
 * 仅在能解析到真实 loopback 客户端地址时生效。
 */

import { createHash, randomBytes, randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  resolveAccessMode,
  trustedLanUnsafeAllowed,
  type AccessMode,
} from "./access";

export const LAN_SESSION_COOKIE = "orynode_lan_session";

export type PairingChallenge = {
  code: string;
  expiresAt: string;
  createdAt: string;
};

export type LanSession = {
  id: string;
  tokenHash: string;
  label: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string | null;
  lastSeenAt?: string | null;
};

type LanAuthState = {
  pairing: PairingChallenge | null;
  sessions: LanSession[];
};

function defaultStatePath(projectRoot: string): string {
  return resolve(projectRoot, ".orynode/lan-auth.json");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function generatePairingCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

function loadState(path: string): LanAuthState {
  if (!existsSync(path)) return { pairing: null, sessions: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<LanAuthState>;
    return {
      pairing: raw.pairing ?? null,
      sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
    };
  } catch {
    return { pairing: null, sessions: [] };
  }
}

function saveState(path: string, state: LanAuthState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function parseCookieHeader(header: string | null): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    out[key] = decodeURIComponent(value);
  }
  return out;
}

function isLoopbackHost(host: string | null): boolean {
  if (!host) return false;
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

/** 规范化后判断是否为本机回环地址（禁止仅用 Host 头） */
export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  let value = address.trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) {
    value = value.slice(1, -1);
  }
  if (value.includes("%")) value = value.split("%")[0]!;
  return (
    value === "127.0.0.1" ||
    value === "::1" ||
    value === "::ffff:127.0.0.1" ||
    value === "localhost"
  );
}

/**
 * 解析客户端地址。默认不信任 X-Forwarded-*（可伪造）；
 * 仅当 ORYNODE_TRUST_PROXY=1 时读取转发头。
 * 测试可注入 options.clientAddress。
 */
export function resolveClientAddress(
  request: Request,
  options?: {
    clientAddress?: string | null;
    env?: NodeJS.ProcessEnv;
  },
): string | null {
  if (options?.clientAddress != null && options.clientAddress !== "") {
    return options.clientAddress;
  }

  const withIp = request as Request & { ip?: string };
  if (typeof withIp.ip === "string" && withIp.ip.trim()) {
    return withIp.ip.trim();
  }

  const env = options?.env ?? process.env;
  const trustProxy =
    env.ORYNODE_TRUST_PROXY === "1" || env.ORYNODE_TRUST_PROXY === "true";
  if (trustProxy) {
    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded) {
      const first = forwarded.split(",")[0]?.trim();
      if (first) return first;
    }
    const realIp = request.headers.get("x-real-ip")?.trim();
    if (realIp) return realIp;
  }

  return null;
}

export function createLanAuthStore(options?: {
  projectRoot?: string;
  statePath?: string;
  now?: () => number;
}) {
  const projectRoot = options?.projectRoot ?? process.cwd();
  const statePath = options?.statePath ?? defaultStatePath(projectRoot);
  const now = options?.now ?? (() => Date.now());

  return {
    startPairing(ttlMs = 5 * 60_000): PairingChallenge {
      const state = loadState(statePath);
      const createdAt = new Date(now()).toISOString();
      const challenge: PairingChallenge = {
        code: generatePairingCode(),
        createdAt,
        expiresAt: new Date(now() + ttlMs).toISOString(),
      };
      state.pairing = challenge;
      saveState(statePath, state);
      console.info(
        `[lan-auth] Pairing code: ${challenge.code} (expires ${challenge.expiresAt})`,
      );
      return challenge;
    },

    claimPairing(input: {
      code: string;
      label?: string;
      sessionTtlMs?: number;
    }): { token: string; session: LanSession } | null {
      const state = loadState(statePath);
      const pairing = state.pairing;
      if (!pairing) return null;
      if (Date.parse(pairing.expiresAt) < now()) {
        state.pairing = null;
        saveState(statePath, state);
        return null;
      }
      if (String(input.code).trim() !== pairing.code) return null;

      const token = generateSessionToken();
      const createdAt = new Date(now()).toISOString();
      const session: LanSession = {
        id: randomBytes(8).toString("hex"),
        tokenHash: hashToken(token),
        label: (input.label || "LAN device").slice(0, 80),
        createdAt,
        expiresAt: new Date(
          now() + (input.sessionTtlMs ?? 30 * 24 * 3600_000),
        ).toISOString(),
        revokedAt: null,
        lastSeenAt: createdAt,
      };
      state.sessions.push(session);
      state.pairing = null;
      saveState(statePath, state);
      return { token, session };
    },

    listSessions(): LanSession[] {
      const state = loadState(statePath);
      return state.sessions.map((s) => ({
        ...s,
        tokenHash: s.tokenHash.slice(0, 8) + "…",
      }));
    },

    revokeSession(sessionId: string): boolean {
      const state = loadState(statePath);
      const row = state.sessions.find((s) => s.id === sessionId);
      if (!row || row.revokedAt) return false;
      row.revokedAt = new Date(now()).toISOString();
      saveState(statePath, state);
      return true;
    },

    validateToken(token: string | null | undefined): LanSession | null {
      if (!token) return null;
      const state = loadState(statePath);
      const hash = hashToken(token);
      const session = state.sessions.find(
        (s) => s.tokenHash === hash && !s.revokedAt,
      );
      if (!session) return null;
      if (Date.parse(session.expiresAt) < now()) return null;
      session.lastSeenAt = new Date(now()).toISOString();
      saveState(statePath, state);
      return session;
    },
  };
}

export type LanAccessResult =
  | { ok: true; mode: AccessMode; session: LanSession | null }
  | { ok: false; status: number; code: string; error: string };

/**
 * API 网关统一访问检查。
 * - local_only：放行
 * - trusted_lan + UNSAFE：放行（预览）
 * - trusted_lan：要求有效 session
 * - allowLoopbackWithoutSession：仅当 clientAddress 为回环时豁免（不用 Host）
 */
export function requireLanAccess(
  request: Request,
  options?: {
    env?: NodeJS.ProcessEnv;
    store?: ReturnType<typeof createLanAuthStore>;
    /** 允许无 session 的本机操作（须能解析到 loopback 客户端地址） */
    allowLoopbackWithoutSession?: boolean;
    /** 测试或上游注入的真实客户端地址 */
    clientAddress?: string | null;
  },
): LanAccessResult {
  const env = options?.env ?? process.env;
  const mode = resolveAccessMode(env);

  if (mode === "local_only") {
    return { ok: true, mode, session: null };
  }

  if (trustedLanUnsafeAllowed(env)) {
    return { ok: true, mode, session: null };
  }

  const clientAddress = resolveClientAddress(request, {
    clientAddress: options?.clientAddress,
    env,
  });
  if (
    options?.allowLoopbackWithoutSession &&
    isLoopbackAddress(clientAddress)
  ) {
    return { ok: true, mode, session: null };
  }

  const host = request.headers.get("host");
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    const origin = request.headers.get("origin");
    if (origin) {
      try {
        const originHost = new URL(origin).host;
        if (host && originHost !== host && !isLoopbackHost(originHost)) {
          return {
            ok: false,
            status: 403,
            code: "CSRF_ORIGIN_MISMATCH",
            error: "Origin 不被允许",
          };
        }
      } catch {
        return {
          ok: false,
          status: 403,
          code: "CSRF_ORIGIN_INVALID",
          error: "Origin 无效",
        };
      }
    }
  }

  const store = options?.store ?? createLanAuthStore();
  const cookies = parseCookieHeader(request.headers.get("cookie"));
  const bearer = request.headers.get("authorization");
  const token =
    cookies[LAN_SESSION_COOKIE] ||
    (bearer?.toLowerCase().startsWith("bearer ")
      ? bearer.slice(7).trim()
      : null);

  const session = store.validateToken(token);
  if (!session) {
    return {
      ok: false,
      status: 401,
      code: "LAN_AUTH_REQUIRED",
      error: "Trusted-LAN 需要配对会话；请在服务器本机完成 pairing",
    };
  }
  return { ok: true, mode, session };
}

export function sessionCookieHeader(
  token: string,
  maxAgeSec = 30 * 24 * 3600,
): string {
  return `${LAN_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
}
