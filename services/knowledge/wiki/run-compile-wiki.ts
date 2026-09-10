/**
 * compile_wiki Job：摄取完成后排队，或用户点击后用本机模型写知识 IR。
 * Chat 占用 Gemma 时 defer（heavyKind）；全库重抽大纲不顺带入队。
 * 不伪装 chatActive：wiki_compile 已是 heavyKind，检索不该被这笔编译误判成对话繁忙。
 * 校验失败不写半成品，上一成功版本保留。
 */

import { randomUUID } from "node:crypto";
import { HTTP_TIMEOUT } from "../../../config/defaults";
import { createRuntimeServices } from "../../platform/composition-root";
import { collectAssistantText } from "./collect-assistant-text";
import {
  compileDocumentMirror,
  type CompiledWikiPage,
  type WikiCompileChunk,
  type WikiSection,
} from "./compile-document-mirror";
import { WIKI_SYNTHESIS_COMPILER_ID } from "./compile-synthesis";
import { compileWikiKnowledge } from "./knowledge-compiler";
import { preparePublishedWikiPage } from "./publish";
import { resolveWikiRelations } from "./wiki-relations";
import {
  fetchWikiPage,
  fetchWikiPageById,
  fetchWikiLinks,
  listWikiPages,
  publishWikiCompilation,
  recordWikiCompileRun,
  upsertWikiPage,
  type PersistedWikiPage,
  type WikiCompileRunInput,
} from "./persist";
import { wikiCompileErrorCode } from "./structured-completion";

export type CompileWikiLease = {
  ok: true;
  leaseId: string;
} | {
  ok: false;
  reason: string;
};

export type CompileWikiJobResult =
  | { deferred: true; reason: string }
  | {
      deferred?: false;
      pageId: string;
      compiler: string;
      skipped?: boolean;
      reason?: string;
      repaired?: boolean;
      batchCount?: number;
    };

export function isConceptWikiSource(id: string): boolean {
  return id.startsWith("concept:");
}

export async function runCompileWikiJob(context: {
  payload: Record<string, unknown>;
  deferIfBusy?: boolean;
  jobId?: string;
  onProgress?: (progress: Record<string, unknown>) => void;
  isChatActive?: () => boolean;
  tryAcquireWiki: (input: {
    owner: string;
    attemptId: string;
  }) => CompileWikiLease;
  releaseWiki: (leaseId: string) => void;
  unloadEmbedding?: () => void | Promise<void>;
  fetchDocument?: (input: {
    namespace: "library" | "conversation";
    documentId: string;
  }) => Promise<{ name?: string } | null>;
  fetchChunks?: (input: {
    namespace: "library" | "conversation";
    documentId: string;
  }) => Promise<WikiCompileChunk[]>;
  fetchPage?: typeof fetchWikiPage;
  fetchPageById?: typeof fetchWikiPageById;
  upsertPage?: typeof upsertWikiPage;
  recordCompileRun?: typeof recordWikiCompileRun;
  complete?: (input: { system: string; user: string }) => Promise<string>;
  completeSynthesis?: (input: {
    title: string;
    sections: WikiSection[];
    kind: string;
    system?: string;
    user?: string;
  }) => Promise<string>;
}): Promise<CompileWikiJobResult> {
  const namespace =
    context.payload.namespace === "conversation" ? "conversation" : "library";
  const pageId = String(context.payload.pageId || "").trim();
  const documentId = String(context.payload.documentId || "").trim();
  if (!pageId && !documentId) {
    throw new Error("compile_wiki 缺少 pageId 或 documentId");
  }

  const report = (progress: Record<string, unknown>) => {
    context.onProgress?.({ documentId, namespace, pageId, ...progress });
  };

  if (context.deferIfBusy && context.isChatActive?.()) {
    return { deferred: true, reason: "chat_priority" };
  }

  const fetchPage = context.fetchPage ?? fetchWikiPage;
  const fetchPageById = context.fetchPageById ?? fetchWikiPageById;
  const upsertPage = context.upsertPage ?? upsertWikiPage;
  const recordRun = context.recordCompileRun ?? recordWikiCompileRun;

  report({ phase: "loading" });
  let page: PersistedWikiPage | CompiledWikiPage | null = pageId
    ? await fetchPageById(pageId)
    : null;
  if (!page && documentId) {
    page = await fetchPage({ namespace, sourceDocumentId: documentId });
  }

  const isConcept =
    page?.kind === "concept" ||
    isConceptWikiSource(pageId) ||
    isConceptWikiSource(documentId);

  if ((!page || page.sections.length === 0) && !isConcept) {
    page = await compileOutlineIfMissing({
      namespace,
      documentId,
      fetchDocument: context.fetchDocument,
      fetchChunks: context.fetchChunks,
      upsertPage,
    });
  }
  if (!page || page.sections.length === 0) {
    throw new Error("还没有可综述的大纲，请等资料处理完成");
  }
  const target = page;

  const force = context.payload.force === true;
  if (target.userEdited && !force) {
    return {
      pageId: target.id,
      compiler: target.synthesisCompiler || WIKI_SYNTHESIS_COMPILER_ID,
      skipped: true,
      reason: "user_edited",
    };
  }

  const owner = `compile-wiki:${namespace}:${target.id}`;
  const acquire = context.tryAcquireWiki({
    owner,
    attemptId: String(context.jobId || target.id),
  });
  if (!acquire.ok) {
    if (context.deferIfBusy) {
      return { deferred: true, reason: acquire.reason };
    }
    throw new Error(`WIKI_LEASE_BUSY:${acquire.reason}`);
  }

  const complete =
    context.complete ??
    (async (input: { system: string; user: string }) => {
      if (context.completeSynthesis) {
        return context.completeSynthesis({
          title: target.title,
          sections: target.sections,
          kind: target.kind,
          system: input.system,
          user: input.user,
        });
      }
      return generateWithRuntime(input);
    });

  try {
    await context.unloadEmbedding?.();
    report({ phase: "synthesizing" });

    const compiled = await compileWikiKnowledge({
      title: target.title,
      kind: target.kind,
      sections: target.sections,
      compiler: WIKI_SYNTHESIS_COMPILER_ID,
      complete,
      onProgress: report,
    });

    const catalogPages = await listWikiPages({
      namespace: target.namespace,
      kind: "concept",
      limit: 500,
    });
    const resolved = resolveWikiRelations({
      fromId: target.id,
      relations: compiled.compiled.knowledge.relations,
      catalog: catalogPages.map((item) => ({
        id: item.id,
        title: item.title,
        aliases: [
          ...(item.knowledge?.aliases ?? []),
          ...(item.identity?.aliases ?? []),
        ],
      })),
    });
    compiled.compiled.knowledge.relations = resolved.relations;

    const prepared = preparePublishedWikiPage({
      page: target,
      compiled: compiled.compiled,
      compiler: WIKI_SYNTHESIS_COMPILER_ID,
    });
    // 单测注入 upsertPage 只落页体；生产走 publish，页+边同一事务。
    const stored = context.upsertPage
      ? await upsertPage(prepared)
      : await publishWikiCompilation({
          page: prepared,
          links: mergeSemanticOutgoing(
            (await fetchWikiLinks(prepared.id)).outgoing,
            resolved.resolved,
          ),
          pendingEdges: resolved.pending,
        });
    await recordRun({
      id: randomUUID(),
      pageId: stored.id,
      compiler: WIKI_SYNTHESIS_COMPILER_ID,
      status: "published",
      attempts: compiled.diagnostics.attempts,
      repaired: compiled.diagnostics.repaired,
      inputHash: compiled.diagnostics.inputHash,
      sectionCount: compiled.diagnostics.sectionCount,
      batchCount: compiled.diagnostics.batchCount,
      claimCount: compiled.diagnostics.claimCount,
      tokenIn: compiled.diagnostics.tokenIn,
      durationMs: compiled.diagnostics.durationMs,
    } satisfies WikiCompileRunInput);

    report({ phase: "ready", claims: compiled.diagnostics.claimCount });
    return {
      pageId: stored.id,
      compiler: WIKI_SYNTHESIS_COMPILER_ID,
      repaired: compiled.diagnostics.repaired,
      batchCount: compiled.diagnostics.batchCount,
    };
  } catch (error) {
    await recordRun({
      id: randomUUID(),
      pageId: target.id,
      compiler: WIKI_SYNTHESIS_COMPILER_ID,
      status: "failed",
      attempts: 1,
      errorCode: wikiCompileErrorCode(error),
    }).catch(() => false);
    throw error;
  } finally {
    context.releaseWiki(acquire.leaseId);
  }
}

function mergeSemanticOutgoing(
  existing: Awaited<ReturnType<typeof fetchWikiLinks>>["outgoing"],
  semantic: Awaited<ReturnType<typeof resolveWikiRelations>>["resolved"],
) {
  const semanticRels = new Set([
    "is_a",
    "depends_on",
    "causes",
    "contrasts_with",
    "related_to",
    "part_of",
  ]);
  const retained = existing.filter((link) => !semanticRels.has(link.rel));
  return [...retained, ...semantic];
}

async function generateWithRuntime(input: {
  system: string;
  user: string;
}): Promise<string> {
  const runtime = createRuntimeServices();
  const stream = await runtime.model.chat(
    [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
    {
      temperature: 0.2,
      maxTokens: 1200,
      signal: AbortSignal.timeout(HTTP_TIMEOUT.chat),
    },
  );
  return collectAssistantText(stream);
}

async function compileOutlineIfMissing(input: {
  namespace: "library" | "conversation";
  documentId: string;
  fetchDocument?: (input: {
    namespace: "library" | "conversation";
    documentId: string;
  }) => Promise<{ name?: string } | null>;
  fetchChunks?: (input: {
    namespace: "library" | "conversation";
    documentId: string;
  }) => Promise<WikiCompileChunk[]>;
  upsertPage: typeof upsertWikiPage;
}): Promise<CompiledWikiPage | null> {
  if (!input.documentId || isConceptWikiSource(input.documentId)) return null;
  if (!input.fetchChunks) return null;
  const [meta, chunks] = await Promise.all([
    input.fetchDocument?.({
      namespace: input.namespace,
      documentId: input.documentId,
    }),
    input.fetchChunks({
      namespace: input.namespace,
      documentId: input.documentId,
    }),
  ]);
  if (!chunks || chunks.length === 0) return null;
  const page = compileDocumentMirror({
    namespace: input.namespace,
    documentId: input.documentId,
    title: String(meta?.name || input.documentId),
    chunks,
  });
  return input.upsertPage(page);
}
