/**
 * Trusted-LAN pairing store（与 services/platform/lan-auth.ts 共享 .orynode/lan-auth.json）
 *
 * 仅由 loopback Data Service 暴露管理面（start/list/revoke），避免 Web Host 头伪造。
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

/**
 * @param {{ projectRoot?: string, statePath?: string, now?: () => number }} [options]
 */
export function createLanAuthStore(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const statePath =
    options.statePath ?? resolve(projectRoot, ".orynode/lan-auth.json");
  const now = options.now ?? (() => Date.now());

  /** 配对码连续失败锁定：防局域网暴力枚举（6 位码 + 5 分钟 TTL 可被穷举） */
  const MAX_CLAIM_FAILURES = 5;
  const CLAIM_LOCKOUT_MS = 60_000;
  /** start 动作限频：防止借高频 start 刷码或干扰 claim */
  const MIN_START_INTERVAL_MS = 1_000;

  /** @type {{ count: number, lockedUntil: number }} */
  let claimFailures = { count: 0, lockedUntil: 0 };
  let lastStartAt = -Infinity;

  function loadState() {
    if (!existsSync(statePath)) return { pairing: null, sessions: [] };
    try {
      const raw = JSON.parse(readFileSync(statePath, "utf8"));
      return {
        pairing: raw.pairing ?? null,
        sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
      };
    } catch {
      return { pairing: null, sessions: [] };
    }
  }

  /**
   * 原子写：先写临时文件再 rename，避免并发/崩溃留下半截 JSON。
   * @param {LanAuthState} state
   */
  function saveState(state) {
    mkdirSync(dirname(statePath), { recursive: true });
    const tmp = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
      renameSync(tmp, statePath);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        // 清理失败不影响主流程
      }
      throw error;
    }
  }

  function hashToken(token) {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }

  return {
    startPairing(ttlMs = 5 * 60_000) {
      // 锁定期内拒绝生成新配对码：否则攻击者可借 start 重置失败计数绕过锁定
      if (now() < claimFailures.lockedUntil) {
        throw new Error("PAIRING_LOCKED");
      }
      const since = now() - lastStartAt;
      if (since < MIN_START_INTERVAL_MS) {
        throw new Error("PAIRING_RATE_LIMITED");
      }
      lastStartAt = now();
      const state = loadState();
      const createdAt = new Date(now()).toISOString();
      const challenge = {
        code: String(randomInt(0, 1_000_000)).padStart(6, "0"),
        createdAt,
        expiresAt: new Date(now() + ttlMs).toISOString(),
      };
      state.pairing = challenge;
      saveState(state);
      // 日志不落全码：终端日志常被复制分享/收集，完整码仅经本机 Settings UI 展示
      console.info(
        `[lan-auth] Pairing code generated: ${challenge.code.slice(0, 2)}**** (expires ${challenge.expiresAt})`,
      );
      return challenge;
    },

    claimPairing(input) {
      if (now() < claimFailures.lockedUntil) return null;
      const state = loadState();
      const pairing = state.pairing;
      if (!pairing) return null;
      if (Date.parse(pairing.expiresAt) < now()) {
        state.pairing = null;
        saveState(state);
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
      const token = randomBytes(32).toString("base64url");
      const createdAt = new Date(now()).toISOString();
      const session = {
        id: randomBytes(8).toString("hex"),
        tokenHash: hashToken(token),
        label: String(input.label || "LAN device").slice(0, 80),
        createdAt,
        expiresAt: new Date(
          now() + (input.sessionTtlMs ?? 30 * 24 * 3600_000),
        ).toISOString(),
        revokedAt: null,
        lastSeenAt: createdAt,
      };
      state.sessions.push(session);
      state.pairing = null;
      saveState(state);
      return { token, session };
    },

    listSessions() {
      const state = loadState();
      return state.sessions.map((s) => ({
        ...s,
        tokenHash: `${s.tokenHash.slice(0, 8)}…`,
      }));
    },

    revokeSession(sessionId) {
      const state = loadState();
      const row = state.sessions.find((s) => s.id === sessionId);
      if (!row || row.revokedAt) return false;
      row.revokedAt = new Date(now()).toISOString();
      saveState(state);
      return true;
    },

    validateToken(token) {
      if (!token) return null;
      const state = loadState();
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
      if (state.sessions.length !== before) saveState(state);
      return session;
    },
  };
}
