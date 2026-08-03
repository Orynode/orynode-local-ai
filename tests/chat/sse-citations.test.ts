import assert from "node:assert/strict";
import test from "node:test";
import { extractReferencedCitationIds } from "../../services/chat/prompt";
import {
  openAiChatStreamToModelEvents,
  modelEventsFromAsync,
  type ModelStreamEvent,
} from "../../services/chat/model-stream";
import {
  wrapChatStreamWithMetadata,
  wrapModelStreamAsOrynodeSse,
  ORYNODE_SSE_VERSION,
} from "../../services/chat/sse";

async function readSseFrames(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: Array<{ event: string; data: unknown }> = [];
  while (true) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: !done });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      let event = "message";
      let data = "";
      for (const line of part.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) data = line.slice(5).trim();
      }
      if (!data || data === "[DONE]") continue;
      frames.push({ event, data: JSON.parse(data) });
    }
    if (done) break;
  }
  return frames;
}

const sampleCitations = [
  {
    id: "S1",
    chunkId: "c1",
    documentId: "d1",
    revisionId: "legacy",
    processingBuildId: "legacy",
    title: "a",
    sourceType: "library",
    locator: { kind: "page" as const, page: 1 },
    excerpt: "x",
  },
  {
    id: "S2",
    chunkId: "c2",
    documentId: "d2",
    revisionId: "legacy",
    processingBuildId: "legacy",
    title: "b",
    sourceType: "library",
    locator: { kind: "page" as const, page: 1 },
    excerpt: "y",
  },
];

test("wrapChatStreamWithMetadata: Orynode SSE v1 metadata→delta→done", async () => {
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: "见 [S1] 与 [S2]" } }],
          })}\n\n`,
        ),
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  const stream = wrapChatStreamWithMetadata(
    upstream,
    {
      type: "metadata",
      providedCitations: sampleCitations,
      retrievalTraceId: "trace-1",
      diagnostics: {
        strategy: ["keyword"],
        candidateCount: 2,
        elapsedMs: 1,
        degradedCapabilities: ["vector"],
      },
    },
    {
      onComplete: (fullText) => ({
        type: "done",
        referencedCitationIds: extractReferencedCitationIds(fullText, [
          "S1",
          "S2",
        ]),
      }),
    },
  );

  const frames = await readSseFrames(stream);
  assert.equal(frames[0]?.event, "metadata");
  assert.equal((frames[0]?.data as { version: number }).version, ORYNODE_SSE_VERSION);
  assert.equal((frames[0]?.data as { traceId: string }).traceId, "trace-1");

  const delta = frames.find((f) => f.event === "delta");
  assert.equal((delta?.data as { text: string }).text, "见 [S1] 与 [S2]");

  const done = frames.at(-1);
  assert.equal(done?.event, "done");
  assert.deepEqual(
    (done?.data as { referencedCitationIds: string[] }).referencedCitationIds,
    ["S1", "S2"],
  );
  assert.equal(frames.filter((f) => f.event === "done").length, 1);
});

test("fake Windows backend 与 OpenAI backend 共用同一前端 contract", async () => {
  async function* windowsEvents(): AsyncGenerator<ModelStreamEvent> {
    yield { type: "delta", text: "来自 [S1]" };
    yield { type: "usage", inputTokens: 10, outputTokens: 4 };
    yield { type: "done", finishReason: "stop" };
  }

  const stream = wrapModelStreamAsOrynodeSse(
    modelEventsFromAsync(windowsEvents()),
    {
      version: ORYNODE_SSE_VERSION,
      traceId: "win-1",
      providedCitations: sampleCitations,
      diagnostics: null,
      capabilities: { backend: "windows-stub" },
    },
    {
      onComplete: (fullText) => ({
        referencedCitationIds: extractReferencedCitationIds(fullText, ["S1", "S2"]),
      }),
    },
  );

  const frames = await readSseFrames(stream);
  assert.equal(frames[0]?.event, "metadata");
  assert.ok(frames.some((f) => f.event === "delta"));
  assert.ok(frames.some((f) => f.event === "usage"));
  assert.equal(frames.at(-1)?.event, "done");
  assert.deepEqual(
    (frames.at(-1)?.data as { referencedCitationIds: string[] }).referencedCitationIds,
    ["S1"],
  );
});

test("openAiChatStreamToModelEvents: 断流产生 error + done", async () => {
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("socket reset"));
    },
  });

  const events: ModelStreamEvent[] = [];
  const reader = openAiChatStreamToModelEvents(upstream).getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (value) events.push(value);
    if (done) break;
  }

  assert.ok(events.some((e) => e.type === "error"));
  assert.ok(events.some((e) => e.type === "done"));
});

test("referenced citation 不得超出 provided 集合", async () => {
  async function* events(): AsyncGenerator<ModelStreamEvent> {
    yield { type: "delta", text: "[S1] 与伪造 [S9]" };
    yield { type: "done", finishReason: "stop" };
  }

  const stream = wrapModelStreamAsOrynodeSse(
    modelEventsFromAsync(events()),
    {
      version: ORYNODE_SSE_VERSION,
      traceId: "t",
      providedCitations: sampleCitations,
      diagnostics: null,
    },
    {
      onComplete: (fullText) => ({
        referencedCitationIds: extractReferencedCitationIds(fullText, ["S1", "S2"]),
      }),
    },
  );

  const frames = await readSseFrames(stream);
  assert.deepEqual(
    (frames.at(-1)?.data as { referencedCitationIds: string[] }).referencedCitationIds,
    ["S1"],
  );
});
