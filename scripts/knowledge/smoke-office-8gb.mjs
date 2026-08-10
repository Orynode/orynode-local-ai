/**
 * Office 8GB 资源互斥冒烟：office_convert lease 与 Chat / OCR 互斥。
 * 不依赖真实 Office 文件；验证 ResourceCoordinator 契约。
 *
 * 用法：node scripts/knowledge/smoke-office-8gb.mjs
 */

import { createResourceCoordinator } from "../data-service/resource-coordinator.mjs";
import { resolveMemoryPressure } from "../data-service/host-memory.mjs";

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

const rc = createResourceCoordinator({
  totalmemBytes: 8 * 1024 ** 3,
});

const idle = rc.snapshot();
assert(idle.hostMemoryClass === "low", "8GB 应为 low");
assert(idle.memoryPressure === "normal", "空闲应为 normal");

const chatToken = rc.markChatActive(10_000);
assert(rc.snapshot().memoryPressure === "critical", "Chat 应抬压");
const blocked = rc.tryAcquire({
  kind: "office_convert",
  owner: "smoke",
  attemptId: "1",
});
assert(!blocked.ok, "Chat 活跃时 office_convert 应 defer");
assert(blocked.reason === "chat_priority", "拒绝原因应为 chat_priority");
rc.markChatIdle(chatToken);

const office = rc.tryAcquire({
  kind: "office_convert",
  owner: "smoke",
  attemptId: "2",
});
assert(office.ok, "空闲应能拿到 office_convert");
assert(
  resolveMemoryPressure({
    hostClass: "low",
    heavyKind: "office_convert",
  }) === "critical",
  "office_convert 应计入 memoryPressure",
);

const ocr = rc.tryAcquire({
  kind: "ocr",
  owner: "smoke-ocr",
  attemptId: "3",
});
assert(!ocr.ok, "持有 office_convert 时 OCR 应互斥");

rc.release(office.leaseId);
const ocr2 = rc.tryAcquire({
  kind: "ocr",
  owner: "smoke-ocr",
  attemptId: "4",
});
assert(ocr2.ok, "释放后 OCR 可获取");
rc.release(ocr2.leaseId);

console.log("smoke-office-8gb: ok");
