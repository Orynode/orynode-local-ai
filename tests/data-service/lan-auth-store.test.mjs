import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
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
