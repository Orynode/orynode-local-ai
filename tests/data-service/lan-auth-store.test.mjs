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
import { createLanAuthStore } from "../../scripts/data-service/lan-auth-store.mjs";

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "orynode-claimlock-mjs-"));
  let current = Date.now();
  const store = createLanAuthStore({
    statePath: join(dir, "lan-auth.json"),
    now: () => current,
  });
  return {
    store,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    advanceMs(ms) {
      current += ms;
    },
  };
}

test("data-service claim 锁定：连续失败后锁定，锁定结束后成功 claim", () => {
  const ctx = makeStore();
  try {
    const challenge = ctx.store.startPairing(5 * 60_000);

    for (let i = 0; i < 5; i++) {
      assert.equal(ctx.store.claimPairing({ code: "000000" }), null);
    }

    assert.equal(ctx.store.claimPairing({ code: challenge.code }), null);

    ctx.advanceMs(61_000);
    const claimed = ctx.store.claimPairing({ code: challenge.code });
    assert.ok(claimed);
    assert.ok(claimed.token.length > 10);

    // 成功后计数清零：新一轮失败不会立即锁定
    ctx.advanceMs(1_100);
    const again = ctx.store.startPairing(5 * 60_000);
    for (let i = 0; i < 4; i++) {
      ctx.store.claimPairing({ code: "777777" });
    }
    const ok = ctx.store.claimPairing({ code: again.code });
    assert.ok(ok);
  } finally {
    ctx.cleanup();
  }
});

test("data-service 锁定期内 startPairing 抛 PAIRING_LOCKED", () => {
  const ctx = makeStore();
  try {
    const challenge = ctx.store.startPairing(5 * 60_000);
    for (let i = 0; i < 5; i++) {
      ctx.store.claimPairing({ code: "000000" });
    }
    assert.throws(() => ctx.store.startPairing(5 * 60_000), /PAIRING_LOCKED/);
    assert.equal(ctx.store.claimPairing({ code: challenge.code }), null);
    ctx.advanceMs(61_000);
    const fresh = ctx.store.startPairing(5 * 60_000);
    assert.ok(ctx.store.claimPairing({ code: fresh.code }));
  } finally {
    ctx.cleanup();
  }
});

test("data-service 状态写入为原子替换（无 .tmp 残留，文件始终可解析）", () => {
  const ctx = makeStore();
  const dir = join(tmpdir(), "orynode-atomic-mjs-");
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
    // 文件内容始终是合法 JSON
    JSON.parse(readFileSync(statePath, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    ctx.cleanup();
  }
});

test("data-service validateToken 不再每次写盘；过期会话被顺带清理", () => {
  const dir = mkdtempSync(join(tmpdir(), "orynode-validate-mjs-"));
  try {
    const statePath = join(dir, "lan-auth.json");
    let current = Date.now();
    const store = createLanAuthStore({ statePath, now: () => current });

    const challenge = store.startPairing(5 * 60_000);
    const claimed = store.claimPairing({ code: challenge.code });
    assert.ok(claimed);

    current += 1_100;
    const mtimeBefore = statSync(statePath).mtimeMs;

    // 多次 validate：lastSeenAt 只更新内存，不触发落盘
    for (let i = 0; i < 5; i++) {
      current += 100;
      assert.ok(store.validateToken(claimed.token));
    }
    assert.equal(
      statSync(statePath).mtimeMs,
      mtimeBefore,
      "validate 成功路径不应写盘",
    );

    // 再配对第二台设备（短 TTL 会话），并推进到其过期之后
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

test("data-service 与 TS 版共享同一状态文件（token 可互验）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orynode-lan-shared-"));
  try {
    const statePath = join(dir, "lan-auth.json");
    let current = Date.now();
    const mjsStore = createLanAuthStore({
      statePath,
      now: () => current,
    });
    const challenge = mjsStore.startPairing(5 * 60_000);
    const claimed = mjsStore.claimPairing({ code: challenge.code });
    assert.ok(claimed);

    const { createLanAuthStore: createTsStore } = await import(
      "../../services/platform/lan-auth.ts"
    );
    const tsStore = createTsStore({
      statePath,
      now: () => current + 1000,
    });
    const session = tsStore.validateToken(claimed.token);
    assert.equal(session?.label, "LAN device");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
