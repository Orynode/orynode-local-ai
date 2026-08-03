/**
 * Trusted-LAN pairing store（与 services/platform/lan-auth.ts 共享 .orynode/lan-auth.json）
 *
 * 仅由 loopback Data Service 暴露管理面（start/list/revoke），避免 Web Host 头伪造。
 */

import { createHash, randomBytes, randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * @param {{ projectRoot?: string, statePath?: string, now?: () => number }} [options]
 */
export function createLanAuthStore(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const statePath =
    options.statePath ?? resolve(projectRoot, ".orynode/lan-auth.json");
  const now = options.now ?? (() => Date.now());

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

  function saveState(state) {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  function hashToken(token) {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }

  return {
    startPairing(ttlMs = 5 * 60_000) {
      const state = loadState();
      const createdAt = new Date(now()).toISOString();
      const challenge = {
        code: String(randomInt(0, 1_000_000)).padStart(6, "0"),
        createdAt,
        expiresAt: new Date(now() + ttlMs).toISOString(),
      };
      state.pairing = challenge;
      saveState(state);
      console.info(
        `[lan-auth] Pairing code: ${challenge.code} (expires ${challenge.expiresAt})`,
      );
      return challenge;
    },

    claimPairing(input) {
      const state = loadState();
      const pairing = state.pairing;
      if (!pairing) return null;
      if (Date.parse(pairing.expiresAt) < now()) {
        state.pairing = null;
        saveState(state);
        return null;
      }
      if (String(input.code).trim() !== pairing.code) return null;

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
      session.lastSeenAt = new Date(now()).toISOString();
      saveState(state);
      return session;
    },
  };
}
