/**
 * Embedding pipeline 生命周期：按需加载、空闲卸载、Chat 优先
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createResourceCoordinator } from "../../scripts/data-service/resource-coordinator.mjs";
import { createEmbedLifecycle } from "../../scripts/data-service/embed-lifecycle.mjs";

function createFakeResources(hostMemoryClass = "low") {
  const rc = createResourceCoordinator({
    totalmemBytes: hostMemoryClass === "low" ? 8 * 1024 ** 3 : 32 * 1024 ** 3,
  });
  return rc;
}

test("embedLifecycle: resolve 标记 resident，unload 清除", async () => {
  const resources = createFakeResources("low");
  const life = createEmbedLifecycle({
    resourceCoordinator: resources,
    idleUnloadMs: 0,
  });
  let loads = 0;
  const extractor = await life.resolve(async () => {
    loads += 1;
    return { id: "pipe" };
  });
  assert.equal(extractor.id, "pipe");
  assert.equal(loads, 1);
  assert.equal(resources.snapshot().embedResident, true);
  assert.equal(life.snapshot().ready, true);

  await life.resolve(async () => {
    loads += 1;
    return { id: "other" };
  });
  assert.equal(loads, 1);

  assert.equal(life.unload("manual"), true);
  assert.equal(resources.snapshot().embedResident, false);
  assert.equal(life.snapshot().ready, false);
  assert.equal(life.snapshot().lastUnloadReason, "manual");
});

test("embedLifecycle: 低配机 Chat 触发卸载", async () => {
  const resources = createFakeResources("low");
  const life = createEmbedLifecycle({
    resourceCoordinator: resources,
    idleUnloadMs: 0,
    unloadOnChat: "low_only",
  });
  await life.resolve(async () => ({ id: "pipe" }));
  assert.equal(life.onChatActive(), true);
  assert.equal(life.snapshot().lastUnloadReason, "chat_priority");
  assert.equal(resources.snapshot().embedResident, false);
});

test("embedLifecycle: 高配机默认 Chat 不卸载", async () => {
  const resources = createFakeResources("high");
  const life = createEmbedLifecycle({
    resourceCoordinator: resources,
    idleUnloadMs: 0,
    unloadOnChat: "low_only",
  });
  await life.resolve(async () => ({ id: "pipe" }));
  assert.equal(life.onChatActive(), false);
  assert.equal(life.snapshot().ready, true);
});

test("embedLifecycle: 空闲定时卸载", async () => {
  const resources = createFakeResources("low");
  /** @type {Array<{ ms: number, fn: () => void }>} */
  const timers = [];
  let now = 1_000;
  const life = createEmbedLifecycle({
    resourceCoordinator: resources,
    idleUnloadMs: 50,
    now: () => now,
    setTimeoutFn: (fn, ms) => {
      const handle = { ms, fn };
      timers.push(handle);
      return handle;
    },
    clearTimeoutFn: (handle) => {
      const idx = timers.indexOf(handle);
      if (idx >= 0) timers.splice(idx, 1);
    },
    log: () => undefined,
  });
  await life.resolve(async () => ({ id: "pipe" }));
  assert.equal(timers.length, 1);
  timers[0].fn();
  assert.equal(life.snapshot().ready, false);
  assert.equal(life.snapshot().lastUnloadReason, "idle_timeout");
});
