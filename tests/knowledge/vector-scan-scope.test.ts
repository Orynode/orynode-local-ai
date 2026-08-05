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

test("planVectorScanScope: 有命中则收窄到文档集合", () => {
  const scope = { mode: "sources" as const, library: "all" as const };
  const plan = planVectorScanScope(scope, ["doc-a", "doc-b", "doc-a"]);
  assert.equal(plan.narrowed, true);
  assert.deepEqual(plan.documentIds, ["doc-a", "doc-b"]);
  assert.deepEqual(
    plan.scope.library !== "all" ? plan.scope.library.documentIds : null,
    ["doc-a", "doc-b"],
  );
});

test("planVectorScanScope: 与用户已选文档求交", () => {
  const scope = {
    mode: "sources" as const,
    library: { documentIds: ["doc-a", "doc-c"] },
  };
  const plan = planVectorScanScope(scope, ["doc-a", "doc-b"]);
  assert.equal(plan.narrowed, true);
  assert.deepEqual(plan.documentIds, ["doc-a"]);
});
