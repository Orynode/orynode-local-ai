/**
 * ResourceCoordinator：Chat 优先于 embedding/OCR 等重活
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createResourceCoordinator } from "../../scripts/data-service/resource-coordinator.mjs";

test("Chat active 时 tryAcquire(embedding) 返回 chat_priority", () => {
  const rc = createResourceCoordinator();
  const token = rc.markChatActive(60_000);
  assert.equal(rc.snapshot().chatActive, true);

  const acquire = rc.tryAcquire({
    kind: "embedding",
    owner: "embed-job-1",
  });
  assert.equal(acquire.ok, false);
  assert.equal(acquire.reason, "chat_priority");
  assert.equal(rc.shouldDeferHeavyWork(), true);

  rc.markChatIdle(token);
  assert.equal(rc.snapshot().chatActive, false);

  const after = rc.tryAcquire({
    kind: "embedding",
    owner: "embed-job-1",
  });
  assert.equal(after.ok, true);
  rc.release(after.leaseId);
});

test("Chat token 引用计数：单个 idle 不误清并发会话", () => {
  const rc = createResourceCoordinator();
  const a = rc.markChatActive(60_000);
  const b = rc.markChatActive(60_000);
  assert.equal(rc.snapshot().chatTokenCount, 2);
  rc.markChatIdle(a);
  assert.equal(rc.snapshot().chatActive, true);
  rc.markChatIdle(b);
  assert.equal(rc.snapshot().chatActive, false);
});

/**
 * 与 embedTexts 守卫同语义：chatActive → 抛 EMBED_DEFERRED_CHAT
 */
test("embed 守卫语义：chatActive 时推迟向量", () => {
  const rc = createResourceCoordinator();
  function guardEmbed() {
    if (rc.snapshot().chatActive) {
      const error = new Error("EMBED_DEFERRED_CHAT");
      Object.assign(error, { code: "EMBED_DEFERRED_CHAT" });
      throw error;
    }
  }

  const token = rc.markChatActive(30_000);
  assert.throws(guardEmbed, /EMBED_DEFERRED_CHAT/);
  rc.markChatIdle(token);
  assert.doesNotThrow(guardEmbed);
});
