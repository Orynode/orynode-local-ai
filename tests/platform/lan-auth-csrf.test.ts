import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
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

test("claim 锁定：startPairing 重置失败计数；成功 claim 清零", () => {
  const ctx = makeStore();
  try {
    for (let i = 0; i < 4; i++) {
      ctx.store.claimPairing({ code: "999999" });
    }

    // 重新生成配对码会重置计数，无需等待锁定
    const fresh = ctx.store.startPairing(5 * 60_000);
    const claimed = ctx.store.claimPairing({ code: fresh.code });
    assert.ok(claimed);

    // 成功后再失败不会立即触发锁定（计数已清零）
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
