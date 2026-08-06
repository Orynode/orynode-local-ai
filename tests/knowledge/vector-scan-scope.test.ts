import assert from "node:assert/strict";
import test from "node:test";
import { planVectorScanScope } from "../../services/knowledge/retrieval/vector-scan-scope";

test("planVectorScanScope: 无关键词命中不收窄", () => {
  const scope = { mode: "sources" as const, library: "all" as const };
  const plan = planVectorScanScope(scope, []);
  assert.equal(plan.narrowed, false);
  assert.equal(plan.scope.library, "all");
  assert.equal(plan.documentIds, undefined);
});

test("planVectorScanScope: 命中足够强则收窄到文档集合", () => {
  const scope = { mode: "sources" as const, library: "all" as const };
  const plan = planVectorScanScope(scope, [
    "doc-a",
    "doc-b",
    "doc-c",
    "doc-a",
  ]);
  assert.equal(plan.narrowed, true);
  assert.deepEqual(plan.documentIds, ["doc-a", "doc-b", "doc-c"]);
  assert.deepEqual(
    plan.scope.library && plan.scope.library !== "all"
      ? plan.scope.library.documentIds
      : null,
    ["doc-a", "doc-b", "doc-c"],
  );
});

test("planVectorScanScope: 弱命中（文档数 < 门槛）不收窄", () => {
  const scope = { mode: "sources" as const, library: "all" as const };
  const plan = planVectorScanScope(scope, ["doc-a", "doc-b"]);
  assert.equal(plan.narrowed, false);
  assert.equal(plan.scope.library, "all");
  assert.equal(plan.documentIds, undefined);
});

test("planVectorScanScope: minimum_match 弱证据门槛翻倍", () => {
  const scope = { mode: "sources" as const, library: "all" as const };
  const ids = ["d1", "d2", "d3", "d4", "d5"];
  // 5 文档强命中 → 收窄；同数量 minimum_match 命中 → 不收窄
  assert.equal(planVectorScanScope(scope, ids).narrowed, true);
  assert.equal(
    planVectorScanScope(scope, ids, { minimumMatchOnly: true }).narrowed,
    false,
  );
  // 达到翻倍门槛（6）→ 收窄
  assert.equal(
    planVectorScanScope(scope, [...ids, "d6"], { minimumMatchOnly: true })
      .narrowed,
    true,
  );
});

test("planVectorScanScope: minDocs 可覆盖默认门槛", () => {
  const scope = { mode: "sources" as const, library: "all" as const };
  assert.equal(
    planVectorScanScope(scope, ["doc-a"], { minDocs: 1 }).narrowed,
    true,
  );
});

test("planVectorScanScope: 与用户已选文档求交", () => {
  const scope = {
    mode: "sources" as const,
    library: { documentIds: ["doc-a", "doc-c"] },
  };
  const plan = planVectorScanScope(scope, ["doc-a", "doc-b", "doc-c"], {
    minDocs: 2,
  });
  assert.equal(plan.narrowed, true);
  assert.deepEqual(plan.documentIds, ["doc-a", "doc-c"]);
});

test("planVectorScanScope: 求交后不足门槛不收窄", () => {
  const scope = {
    mode: "sources" as const,
    library: { documentIds: ["doc-a"] },
  };
  const plan = planVectorScanScope(scope, ["doc-a", "doc-b", "doc-c"]);
  assert.equal(plan.narrowed, false);
});
