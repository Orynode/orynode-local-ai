/**
 * Trusted-LAN pairing / Session / 撤销（KE-P3-02）
 *
 * - Local-only：不要求认证
 * - Trusted-LAN + UNSAFE：开发预览，跳过认证（须显式开关）
 * - Trusted-LAN 正式路径：一次性 pairing code → session cookie → 可撤销
 * - 所有模式统一：写方法校验 Origin（CSRF 第一道防线，local_only 也生效）
 *
 * 配对管理（start/list/revoke）应走 loopback Data Service `/lan-auth/pairing`，
 * 勿仅凭 Host 头判定本机（可伪造）。本模块的 allowLoopbackWithoutSession
 * 仅在能解析到真实 loopback 客户端地址时生效。
 */

import { createHash, randomBytes, randomInt } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

/** 原子写：先写临时文件再 rename，避免并发/崩溃留下半截 JSON */
function saveState(path: string, state: LanAuthState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // 清理失败不影响主流程
    }
    throw error;
  }
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

  /** 配对码连续失败锁定：防局域网暴力枚举（6 位码 + 5 分钟 TTL 可被穷举） */
  const MAX_CLAIM_FAILURES = 5;
  const CLAIM_LOCKOUT_MS = 60_000;
  /** start 动作限频：防止借高频 start 刷码或干扰 claim */
  const MIN_START_INTERVAL_MS = 1_000;
  let claimFailures: { count: number; lockedUntil: number } = {
    count: 0,
    lockedUntil: 0,
  };
  let lastStartAt = -Infinity;

  return {
    startPairing(ttlMs = 5 * 60_000): PairingChallenge {
      // 锁定期内拒绝生成新配对码：否则攻击者可借 start 重置失败计数绕过锁定
      if (now() < claimFailures.lockedUntil) {
        throw new Error("PAIRING_LOCKED");
      }
      if (now() - lastStartAt < MIN_START_INTERVAL_MS) {
        throw new Error("PAIRING_RATE_LIMITED");
      }
      lastStartAt = now();
      const state = loadState(statePath);
      const createdAt = new Date(now()).toISOString();
      const challenge: PairingChallenge = {
        code: generatePairingCode(),
        createdAt,
        expiresAt: new Date(now() + ttlMs).toISOString(),
      };
      state.pairing = challenge;
      saveState(statePath, state);
      // 日志不落全码：终端日志常被复制分享/收集，完整码仅经本机 Settings UI 展示
      console.info(
        `[lan-auth] Pairing code generated: ${challenge.code.slice(0, 2)}**** (expires ${challenge.expiresAt})`,
      );
      return challenge;
    },

    claimPairing(input: {
      code: string;
      label?: string;
      sessionTtlMs?: number;
    }): { token: string; session: LanSession } | null {
      if (now() < claimFailures.lockedUntil) return null;
      const state = loadState(statePath);
      const pairing = state.pairing;
      if (!pairing) return null;
      if (Date.parse(pairing.expiresAt) < now()) {
        state.pairing = null;
        saveState(statePath, state);
        return null;
      }
      if (String(input.code).trim() !== pairing.code) {
        claimFailures.count += 1;
        if (claimFailures.count >= MAX_CLAIM_FAILURES) {
          claimFailures.lockedUntil = now() + CLAIM_LOCKOUT_MS;
          claimFailures.count = 0;
        }
        return null;
      }

      claimFailures = { count: 0, lockedUntil: 0 };
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

      // lastSeenAt 仅内存更新：高频请求下每次全量写盘得不偿失；
      // 顺带清理已撤销/已过期会话（防 sessions 无限增长）时才落盘
      session.lastSeenAt = new Date(now()).toISOString();
      const before = state.sessions.length;
      state.sessions = state.sessions.filter(
        (s) => !s.revokedAt && Date.parse(s.expiresAt) >= now(),
      );
      if (state.sessions.length !== before) saveState(statePath, state);
      return session;
    },
  };
}

export type LanAccessResult =
  | { ok: true; mode: AccessMode; session: LanSession | null }
  | { ok: false; status: number; code: string; error: string };

/**
 * CSRF Origin 校验：所有访问模式共用（local_only 也生效）。
 * 写方法携带 Origin 时必须与 Host 一致，或是本机回环地址；
 * 无 Origin 的请求（同源 fetch / curl / 表单直发）不因此拒绝。
 */
function assertSameOrigin(request: Request): LanAccessResult | null {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return null;
  }
  const origin = request.headers.get("origin");
  if (!origin) return null;
  try {
    const originHost = new URL(origin).host;
    const host = request.headers.get("host");
    if ((host && originHost === host) || isLoopbackHost(originHost)) {
      return null;
    }
    return {
      ok: false,
      status: 403,
      code: "CSRF_ORIGIN_MISMATCH",
      error: "Origin 不被允许",
    };
  } catch {
    return {
      ok: false,
      status: 403,
      code: "CSRF_ORIGIN_INVALID",
      error: "Origin 无效",
    };
  }
}

/**
 * Host 必须是本机回环：阻断 DNS rebinding。
 * 浏览器解析到本机的恶意页面可借 rebinding 把 Host 换成攻击者域名，
 * 使跨源读取伪装成同源；回环绑定服务只应接受回环 Host。
 */
export function assertLoopbackHost(request: Request): LanAccessResult | null {
  const host = request.headers.get("host");
  if (!isLoopbackHost(host)) {
    return {
      ok: false,
      status: 403,
      code: "HOST_NOT_LOOPBACK",
      error: "Host 必须是 127.0.0.1 / localhost / [::1]",
    };
  }
  return null;
}

/**
 * API 网关统一访问检查。
 * - 所有模式：写方法先过 Origin 校验（CSRF）
 * - local_only：额外要求 Host 为本机回环——该模式无认证且仅绑回环，
 *   DNS rebinding 可把攻击者域名解析到 127.0.0.1 使跨源读取伪装成同源；
 *   反向代理场景可设 ORYNODE_TRUST_LOOPBACK_HOST=0 豁免
 * - trusted_lan：经 session 认证（cookie 按域隔离，rebinding 无凭据可用），
 *   合法的局域网直连 Host 不是回环，故不做此校验
 * - trusted_lan + UNSAFE：放行（预览）
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

  const csrfDenied = assertSameOrigin(request);
  if (csrfDenied) return csrfDenied;

  const mode = resolveAccessMode(env);

  if (mode === "local_only") {
    const hostCheckDisabled =
      env.ORYNODE_TRUST_LOOPBACK_HOST === "0" ||
      env.ORYNODE_TRUST_LOOPBACK_HOST === "false";
    if (!hostCheckDisabled) {
      const hostDenied = assertLoopbackHost(request);
      if (hostDenied) return hostDenied;
    }
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
