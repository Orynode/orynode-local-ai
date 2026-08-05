/**
 * host-memory TS ↔ mjs 契约 + ResourceCoordinator memoryPressure
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyHostMemory,
  recommendedMaxContext,
  recommendedRuntimePreset,
  hostMemoryClassLabel,
  hostKnowledgeCeiling,
  resolveMemoryPressure,
  memoryPressureToResourcePressure,
  HOST_MEMORY_LOW_MAX_BYTES,
  HOST_MEMORY_MEDIUM_MAX_BYTES,
} from "../../services/platform/host-memory";
import * as fromScripts from "../../scripts/data-service/host-memory.mjs";
import { createResourceCoordinator } from "../../scripts/data-service/resource-coordinator.mjs";

test("host-memory: TS 与 mjs 阈值一致", () => {
  assert.equal(HOST_MEMORY_LOW_MAX_BYTES, fromScripts.HOST_MEMORY_LOW_MAX_BYTES);
  assert.equal(
    HOST_MEMORY_MEDIUM_MAX_BYTES,
    fromScripts.HOST_MEMORY_MEDIUM_MAX_BYTES,
  );
});

test("host-memory: 分类与推荐上下文", () => {
  assert.equal(classifyHostMemory(8 * 1024 ** 3), "low");
  assert.equal(classifyHostMemory(16 * 1024 ** 3), "medium");
  assert.equal(classifyHostMemory(32 * 1024 ** 3), "high");
  assert.equal(recommendedMaxContext("low"), 8192);
  assert.equal(recommendedMaxContext("medium"), 16384);
  assert.equal(recommendedMaxContext("high"), 32768);
  assert.equal(fromScripts.recommendedMaxContext("low"), 8192);
  assert.equal(fromScripts.recommendedMaxContext("high"), 32768);
  assert.equal(hostKnowledgeCeiling("low", true), "balanced");
  assert.equal(hostKnowledgeCeiling("low", false), "lite");
  assert.equal(hostKnowledgeCeiling("high", true), "quality");
  assert.equal(fromScripts.hostKnowledgeCeiling("low", true), "balanced");
});

test("host-memory: 本机推荐预设", () => {
  const low = recommendedRuntimePreset("low");
  assert.equal(low.settings.maxContext, 8192);
  assert.equal(low.settings.knowledgeTier, "auto");
  assert.equal(hostMemoryClassLabel("low"), "约 8GB");
  const high = fromScripts.recommendedRuntimePreset("high");
  assert.equal(high.settings.maxContext, 32768);
  assert.equal(high.label, "高配本机推荐");
});

test("host-memory: pressure 合成", () => {
  assert.equal(
    resolveMemoryPressure({ hostClass: "high" }),
    "normal",
  );
  assert.equal(
    resolveMemoryPressure({ hostClass: "low" }),
    "normal",
  );
  assert.equal(
    resolveMemoryPressure({ hostClass: "high", chatActive: true }),
    "critical",
  );
  assert.equal(
    resolveMemoryPressure({
      hostClass: "low",
      embedResident: true,
    }),
    "normal",
  );
  assert.equal(
    resolveMemoryPressure({
      hostClass: "low",
      heavyKind: "embedding",
    }),
    "critical",
  );
  assert.equal(memoryPressureToResourcePressure("constrained"), "high");
  assert.equal(fromScripts.memoryPressureToResourcePressure("normal"), "normal");
});

test("ResourceCoordinator: 8GB 空闲 normal，Chat → critical；embedResident 可观测", () => {
  const rc = createResourceCoordinator({
    totalmemBytes: 8 * 1024 ** 3,
  });
  const snap = rc.snapshot();
  assert.equal(snap.hostMemoryClass, "low");
  assert.equal(snap.recommendedMaxContext, 8192);
  assert.equal(snap.memoryRecommendedPreset.settings.maxContext, 8192);
  assert.equal(snap.memoryPressure, "normal");
  assert.equal(snap.resourcePressure, "normal");
  assert.equal(snap.embedResident, false);

  const token = rc.markChatActive(60_000);
  assert.equal(rc.snapshot().memoryPressure, "critical");
  rc.markChatIdle(token);
  assert.equal(rc.snapshot().memoryPressure, "normal");

  rc.setEmbedResident(true);
  assert.equal(rc.snapshot().embedResident, true);
  assert.equal(rc.snapshot().memoryPressure, "normal");
});

test("ResourceCoordinator: 高配主机 idle 为 normal", () => {
  const rc = createResourceCoordinator({
    totalmemBytes: 32 * 1024 ** 3,
  });
  assert.equal(rc.snapshot().hostMemoryClass, "high");
  assert.equal(rc.snapshot().memoryPressure, "normal");
  assert.equal(rc.snapshot().resourcePressure, "normal");
});
