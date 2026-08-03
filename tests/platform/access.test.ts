import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveAccessMode,
  trustedLanUnsafeAllowed,
  webBindHost,
} from "../../services/platform/access";
import {
  createLanAuthStore,
  requireLanAccess,
  sessionCookieHeader,
} from "../../services/platform/lan-auth";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("resolveAccessMode: 默认 local_only", () => {
  assert.equal(resolveAccessMode({}), "local_only");
  assert.equal(resolveAccessMode({ ORYNODE_ACCESS_MODE: "local_only" }), "local_only");
});

test("resolveAccessMode: trusted_lan 即使无 unsafe 也保持 trusted_lan（由 pairing 门禁）", () => {
  assert.equal(
    resolveAccessMode({ ORYNODE_ACCESS_MODE: "trusted_lan" }),
    "trusted_lan",
  );
  assert.equal(trustedLanUnsafeAllowed({}), false);
  assert.equal(
    webBindHost(resolveAccessMode({ ORYNODE_ACCESS_MODE: "trusted_lan" })),
    "0.0.0.0",
  );
});

test("resolveAccessMode: trusted_lan + UNSAFE=1 仍为 trusted_lan 预览", () => {
  assert.equal(
    resolveAccessMode({
      ORYNODE_ACCESS_MODE: "trusted_lan",
      ORYNODE_TRUSTED_LAN_UNSAFE: "1",
    }),
    "trusted_lan",
  );
});

test("lan-auth: pairing → claim → validate → revoke", () => {
  const dir = mkdtempSync(join(tmpdir(), "orynode-lan-"));
  try {
    const store = createLanAuthStore({
      statePath: join(dir, "lan-auth.json"),
      now: () => Date.parse("2026-08-03T00:00:00.000Z"),
    });
    const challenge = store.startPairing(60_000);
    assert.match(challenge.code, /^\d{6}$/);

    const claimed = store.claimPairing({ code: challenge.code, label: "phone" });
    assert.ok(claimed);
    assert.ok(claimed!.token.length > 10);

    const session = store.validateToken(claimed!.token);
    assert.equal(session?.label, "phone");
    assert.equal(store.claimPairing({ code: challenge.code }), null);

    assert.equal(store.revokeSession(claimed!.session.id), true);
    assert.equal(store.validateToken(claimed!.token), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("requireLanAccess: trusted_lan 无 session 拒绝；cookie 通过", () => {
  const dir = mkdtempSync(join(tmpdir(), "orynode-lan2-"));
  try {
    const store = createLanAuthStore({
      statePath: join(dir, "lan-auth.json"),
      now: () => Date.now(),
    });
    const challenge = store.startPairing();
    const claimed = store.claimPairing({ code: challenge.code })!;

    const denied = requireLanAccess(
      new Request("http://192.168.1.10:3000/api/chat", { method: "POST" }),
      {
        env: { ORYNODE_ACCESS_MODE: "trusted_lan" },
        store,
      },
    );
    assert.equal(denied.ok, false);

    const allowed = requireLanAccess(
      new Request("http://192.168.1.10:3000/api/chat", {
        method: "POST",
        headers: {
          cookie: sessionCookieHeader(claimed.token),
          origin: "http://192.168.1.10:3000",
          host: "192.168.1.10:3000",
        },
      }),
      {
        env: { ORYNODE_ACCESS_MODE: "trusted_lan" },
        store,
      },
    );
    assert.equal(allowed.ok, true);

    const unsafe = requireLanAccess(
      new Request("http://192.168.1.10:3000/api/chat", { method: "POST" }),
      {
        env: {
          ORYNODE_ACCESS_MODE: "trusted_lan",
          ORYNODE_TRUSTED_LAN_UNSAFE: "1",
        },
        store,
      },
    );
    assert.equal(unsafe.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("requireLanAccess: Host 伪造 127.0.0.1 不得豁免 pairing 管理", () => {
  const dir = mkdtempSync(join(tmpdir(), "orynode-lan3-"));
  try {
    const store = createLanAuthStore({
      statePath: join(dir, "lan-auth.json"),
      now: () => Date.now(),
    });
    const spoofed = requireLanAccess(
      new Request("http://192.168.1.10:3000/api/lan/pairing", {
        method: "GET",
        headers: { host: "127.0.0.1:3000" },
      }),
      {
        env: { ORYNODE_ACCESS_MODE: "trusted_lan" },
        store,
        allowLoopbackWithoutSession: true,
        clientAddress: "192.168.1.50",
      },
    );
    assert.equal(spoofed.ok, false);

    const local = requireLanAccess(
      new Request("http://127.0.0.1:3000/api/lan/pairing", {
        method: "GET",
        headers: { host: "127.0.0.1:3000" },
      }),
      {
        env: { ORYNODE_ACCESS_MODE: "trusted_lan" },
        store,
        allowLoopbackWithoutSession: true,
        clientAddress: "127.0.0.1",
      },
    );
    assert.equal(local.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
