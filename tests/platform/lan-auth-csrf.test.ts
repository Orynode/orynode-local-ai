import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLanAuthStore,
  requireLanAccess,
  sessionCookieHeader,
} from "../../services/platform/lan-auth";

const LOCAL_ENV = { ORYNODE_ACCESS_MODE: "local_only" };

test("CSRF: local_only 下跨源 POST 被拒绝（此前直接放行）", () => {
  const denied = requireLanAccess(
    new Request("http://127.0.0.1:3000/api/knowledge", {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin: "http://evil.example",
      },
    }),
    { env: LOCAL_ENV },
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 403);
  if (!denied.ok) {
    assert.equal(denied.code, "CSRF_ORIGIN_MISMATCH");
  }
});

test("CSRF: local_only 下同源 POST 与回环 Origin 放行", () => {
  const sameOrigin = requireLanAccess(
    new Request("http://127.0.0.1:3000/api/chat", {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000",
      },
    }),
    { env: LOCAL_ENV },
  );
  assert.equal(sameOrigin.ok, true);

  const loopbackOrigin = requireLanAccess(
    new Request("http://127.0.0.1:4318/settings", {
      method: "PUT",
      headers: {
        host: "127.0.0.1:4318",
        origin: "http://localhost:3000",
      },
    }),
    { env: LOCAL_ENV },
  );
  assert.equal(loopbackOrigin.ok, true);
});

test("CSRF: 无 Origin 的写请求（curl/表单直发）不因此拒绝", () => {
  const result = requireLanAccess(
    new Request("http://127.0.0.1:3000/api/conversations", {
      method: "POST",
      headers: { host: "127.0.0.1:3000" },
    }),
    { env: LOCAL_ENV },
  );
  assert.equal(result.ok, true);
});

test("CSRF: 无效 Origin 返回 CSRF_ORIGIN_INVALID", () => {
  const result = requireLanAccess(
    new Request("http://127.0.0.1:3000/api/chat", {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin: "::not a url::",
      },
    }),
    { env: LOCAL_ENV },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "CSRF_ORIGIN_INVALID");
  }
});

test("CSRF: GET 请求不受 Origin 校验影响", () => {
  const result = requireLanAccess(
    new Request("http://127.0.0.1:3000/api/status", {
      method: "GET",
      headers: {
        host: "127.0.0.1:3000",
        origin: "http://evil.example",
      },
    }),
    { env: LOCAL_ENV },
  );
  assert.equal(result.ok, true);
});

// ===== Host 回环校验（DNS rebinding 防护，仅 local_only）=====

test("Host 校验: local_only 下非回环 Host 被拒绝（rebinding 场景）", () => {
  const denied = requireLanAccess(
    new Request("http://127.0.0.1:3000/api/conversations", {
      method: "GET",
      headers: {
        host: "evil.example",
      },
    }),
    { env: LOCAL_ENV },
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 403);
  if (!denied.ok) {
    assert.equal(denied.code, "HOST_NOT_LOOPBACK");
  }
});

test("Host 校验: local_only 下回环 Host 的各种形态放行", () => {
  for (const host of [
    "127.0.0.1:3000",
    "localhost:3000",
    "[::1]:3000",
    "LocalHost:3000",
  ]) {
    const result = requireLanAccess(
      new Request("http://127.0.0.1:3000/api/status", {
        method: "GET",
        headers: { host },
      }),
      { env: LOCAL_ENV },
    );
    assert.equal(result.ok, true, `host=${host} 应放行`);
  }
});

test("Host 校验: ORYNODE_TRUST_LOOPBACK_HOST=0 豁免（反向代理场景）", () => {
  const result = requireLanAccess(
    new Request("http://127.0.0.1:3000/api/status", {
      method: "GET",
      headers: { host: "proxy.internal" },
    }),
    { env: { ORYNODE_ACCESS_MODE: "local_only", ORYNODE_TRUST_LOOPBACK_HOST: "0" } },
  );
  assert.equal(result.ok, true);
});

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "orynode-claimlock-"));
  let current = Date.now();
  const store = createLanAuthStore({
    statePath: join(dir, "lan-auth.json"),
    now: () => current,
  });
  return {
    store,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    advanceMs(ms: number) {
      current += ms;
    },
  };
}

test("claim 锁定：连续失败后暂时锁定，即使猜中也不发 token", () => {
  const ctx = makeStore();
  try {
    const challenge = ctx.store.startPairing(5 * 60_000);

    for (let i = 0; i < 5; i++) {
      assert.equal(ctx.store.claimPairing({ code: "000000" }), null);
    }

    // 已进入锁定窗口：即便此时拿到正确配对码也拒绝
    assert.equal(ctx.store.claimPairing({ code: challenge.code }), null);

    // 锁定窗口过后可用
    ctx.advanceMs(61_000);
    const claimed = ctx.store.claimPairing({ code: challenge.code });
    assert.ok(claimed);
    assert.ok(claimed!.token.length > 10);
  } finally {
    ctx.cleanup();
  }
});

test("claim 锁定：锁定期内 startPairing 拒绝生成新码（防重置绕过）", () => {
  const ctx = makeStore();
  try {
    const challenge = ctx.store.startPairing(5 * 60_000);

    for (let i = 0; i < 5; i++) {
      assert.equal(ctx.store.claimPairing({ code: "000000" }), null);
    }

    // 锁定期内借 start 重置计数的攻击路径已被封死
    assert.throws(() => ctx.store.startPairing(5 * 60_000), /PAIRING_LOCKED/);
    // 锁定依然生效
    assert.equal(ctx.store.claimPairing({ code: challenge.code }), null);

    ctx.advanceMs(61_000);
    const fresh = ctx.store.startPairing(5 * 60_000);
    const claimed = ctx.store.claimPairing({ code: fresh.code });
    assert.ok(claimed);
  } finally {
    ctx.cleanup();
  }
});

test("start 动作限频：1 秒内连续生成配对码被拒绝", () => {
  const ctx = makeStore();
  try {
    ctx.store.startPairing(5 * 60_000);
    assert.throws(
      () => ctx.store.startPairing(5 * 60_000),
      /PAIRING_RATE_LIMITED/,
    );
    ctx.advanceMs(1_100);
    const ok = ctx.store.startPairing(5 * 60_000);
    assert.ok(ok);
  } finally {
    ctx.cleanup();
  }
});

test("claim 成功清零；成功后再失败不立即锁定", () => {
  const ctx = makeStore();
  try {
    const first = ctx.store.startPairing(5 * 60_000);
    const claimed = ctx.store.claimPairing({ code: first.code });
    assert.ok(claimed);

    // 成功后计数已清零：新一轮失败不会立即锁定
    ctx.advanceMs(1_100);
    const again = ctx.store.startPairing(5 * 60_000);
    for (let i = 0; i < 4; i++) {
      assert.equal(ctx.store.claimPairing({ code: "888888" }), null);
    }
    const ok = ctx.store.claimPairing({ code: again.code });
    assert.ok(ok);
  } finally {
    ctx.cleanup();
  }
});

test("trusted_lan 正式路径：Origin 校验先于 session 判定且行为不变", () => {
  const ctx = makeStore();
  try {
    const challenge = ctx.store.startPairing();
    const claimed = ctx.store.claimPairing({ code: challenge.code })!;

    const crossOrigin = requireLanAccess(
      new Request("http://192.168.1.10:3000/api/chat", {
        method: "POST",
        headers: {
          cookie: sessionCookieHeader(claimed.token),
          origin: "http://evil.example",
          host: "192.168.1.10:3000",
        },
      }),
      { env: { ORYNODE_ACCESS_MODE: "trusted_lan" }, store: ctx.store },
    );
    assert.equal(crossOrigin.ok, false);

    const validSession = requireLanAccess(
      new Request("http://192.168.1.10:3000/api/chat", {
        method: "POST",
        headers: {
          cookie: sessionCookieHeader(claimed.token),
          origin: "http://192.168.1.10:3000",
          host: "192.168.1.10:3000",
        },
      }),
      { env: { ORYNODE_ACCESS_MODE: "trusted_lan" }, store: ctx.store },
    );
    assert.equal(validSession.ok, true);
  } finally {
    ctx.cleanup();
  }
});

// ===== 状态持久化健壮性（与 data-service 版共享文件格式）=====

test("TS 版状态写入为原子替换（无 .tmp 残留，文件始终可解析）", () => {
  const dir = join(tmpdir(), "orynode-atomic-ts-");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    const statePath = join(dir, "lan-auth.json");
    let current = Date.now();
    const store = createLanAuthStore({ statePath, now: () => current });

    store.startPairing(5 * 60_000);
    current += 1_100;
    store.startPairing(5 * 60_000);

    const files = readdirSync(dir);
    assert.ok(files.includes("lan-auth.json"));
    assert.equal(
      files.some((f) => f.endsWith(".tmp")),
      false,
      "不应残留临时文件",
    );
    JSON.parse(readFileSync(statePath, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TS 版 validateToken 不再每次写盘；过期会话被顺带清理", () => {
  const dir = mkdtempSync(join(tmpdir(), "orynode-validate-ts-"));
  try {
    const statePath = join(dir, "lan-auth.json");
    let current = Date.now();
    const store = createLanAuthStore({ statePath, now: () => current });

    const challenge = store.startPairing(5 * 60_000);
    const claimed = store.claimPairing({ code: challenge.code });
    assert.ok(claimed);

    current += 1_100;
    const mtimeBefore = statSync(statePath).mtimeMs;
    for (let i = 0; i < 5; i++) {
      current += 100;
      assert.ok(store.validateToken(claimed.token));
    }
    assert.equal(
      statSync(statePath).mtimeMs,
      mtimeBefore,
      "validate 成功路径不应写盘",
    );

    // 第二台设备短 TTL 会话，推进到过期后由 validate 顺带清理
    current += 1_100;
    const challenge2 = store.startPairing(5 * 60_000);
    const claimed2 = store.claimPairing({
      code: challenge2.code,
      sessionTtlMs: 60_000,
    });
    assert.ok(claimed2);

    current = Date.parse(claimed2.session.expiresAt) + 1_000;
    assert.ok(store.validateToken(claimed.token));

    const raw = JSON.parse(readFileSync(statePath, "utf8"));
    assert.deepEqual(
      raw.sessions.map((s) => s.id),
      [claimed.session.id],
      "过期会话应已从磁盘清理",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
