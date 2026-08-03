/**
 * KE-P0-01：ScopePolicy 授权矩阵
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createScopePolicy } from "../../services/knowledge/application/scope-policy";
import { KnowledgeError } from "../../services/knowledge/core/errors";
import {
  knowledgeCitation,
  knowledgeListSources,
  knowledgeOpen,
} from "../../services/agent/knowledge-tools";

const policy = createScopePolicy();

test("ScopePolicy: library all 可读任意 library chunk", async () => {
  const scope = await policy.resolve(
    { mode: "sources", library: "all" },
    { actor: { kind: "agent", id: "a1" } },
  );
  assert.equal(
    await policy.canReadChunk(
      {
        chunkId: "c1",
        documentId: "d1",
        source: "library",
      },
      scope,
    ),
    true,
  );
});

test("ScopePolicy: 文档子集外的 library chunk 拒绝", async () => {
  const scope = await policy.resolve(
    { mode: "sources", library: { documentIds: ["d1"] } },
    { actor: { kind: "agent", id: "a1" } },
  );
  assert.equal(
    await policy.canReadChunk(
      { chunkId: "c2", documentId: "d2", source: "library" },
      scope,
    ),
    false,
  );
  assert.equal(
    await policy.canReadChunk(
      { chunkId: "c1", documentId: "d1", source: "library" },
      scope,
    ),
    true,
  );
});

test("ScopePolicy: conversation chunk 必须双匹配 conversationId + fileId", async () => {
  const scope = await policy.resolve(
    {
      mode: "sources",
      conversationFiles: {
        conversationId: "conv-a",
        fileIds: ["f1"],
      },
    },
    { actor: { kind: "agent", id: "a1" }, conversationId: "conv-a" },
  );
  assert.equal(
    await policy.canReadChunk(
      {
        chunkId: "c1",
        documentId: "f1",
        source: "conversation_file",
        conversationId: "conv-a",
      },
      scope,
    ),
    true,
  );
  assert.equal(
    await policy.canReadChunk(
      {
        chunkId: "c1",
        documentId: "f1",
        source: "conversation_file",
        conversationId: "conv-b",
      },
      scope,
    ),
    false,
  );
  assert.equal(
    await policy.canReadChunk(
      {
        chunkId: "c1",
        documentId: "f2",
        source: "conversation_file",
        conversationId: "conv-a",
      },
      scope,
    ),
    false,
  );
});

test("ScopePolicy: mode none 拒绝一切", async () => {
  const scope = await policy.resolve(
    { mode: "none" },
    { actor: { kind: "local-user", id: "u" } },
  );
  assert.equal(scope.mode, "none");
  assert.equal(
    await policy.canReadChunk(
      { chunkId: "c", documentId: "d", source: "library" },
      scope,
    ),
    false,
  );
});

test("ScopePolicy: filterVisibleDocuments 按 library 子集过滤", async () => {
  const scope = await policy.resolve(
    { mode: "sources", library: { documentIds: ["a"] } },
    { actor: { kind: "agent", id: "a1" } },
  );
  const visible = policy.filterVisibleDocuments(
    [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ],
    scope,
  );
  assert.deepEqual(
    visible.map((d) => d.id),
    ["a"],
  );
});

test("Agent knowledgeOpen: 无 scope 抛 CHUNK_NOT_IN_SCOPE", async () => {
  await assert.rejects(
    () =>
      knowledgeOpen("any-chunk", {
        scope: { mode: "none" },
        ownerRef: "t1",
      }),
    (err: unknown) =>
      err instanceof KnowledgeError &&
      err.code === "chunk_not_in_scope" &&
      err.message === "CHUNK_NOT_IN_SCOPE",
  );
});

test("Agent knowledgeCitation: 无 scope 返回 unavailable", async () => {
  const resolved = await knowledgeCitation("any-chunk", {
    scope: { mode: "none" },
  });
  assert.equal(resolved.available, false);
});

test("Agent knowledgeListSources: none scope 返回空", async () => {
  const listed = await knowledgeListSources({ scope: { mode: "none" } });
  assert.deepEqual(listed.documents, []);
  assert.deepEqual(listed.sources, []);
});
