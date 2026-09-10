import {
  compileDocumentMirror,
  type CompiledWikiPage,
  type WikiCompileChunk,
} from "./compile-document-mirror";
import { enqueueCompileWikiJob } from "./enqueue-compile";
import {
  fetchWikiPage,
  markWikiSourceUpdated,
  upsertWikiPage,
} from "./persist";

export function mirrorStatusAfterSourceChange(
  existing: { synthesisMarkdown?: string } | null | undefined,
): "ready" | "stale" {
  return existing?.synthesisMarkdown?.trim() ? "stale" : "ready";
}

export async function compileAndUpsertDocumentMirror(
  input: {
    namespace: "library" | "conversation";
    documentId: string;
    title: string;
    chunks: WikiCompileChunk[];
  },
  options?: {
    strict?: boolean;
    /** 仅显式请求时排队 Gemma 编译；普通摄取/修订只维护 W0 mirror。 */
    enqueueKnowledge?: boolean;
    fetchExisting?: typeof fetchWikiPage;
    upsertPage?: typeof upsertWikiPage;
    markSourceUpdated?: typeof markWikiSourceUpdated;
    enqueueCompileWiki?: typeof enqueueCompileWikiJob;
  },
): Promise<CompiledWikiPage | null> {
  const fetchExisting = options?.fetchExisting ?? fetchWikiPage;
  const upsertPage = options?.upsertPage ?? upsertWikiPage;
  const markUpdated = options?.markSourceUpdated ?? markWikiSourceUpdated;
  const enqueue = options?.enqueueCompileWiki ?? enqueueCompileWikiJob;

  let existing: CompiledWikiPage | null | undefined;
  let stored: CompiledWikiPage | null = null;
  try {
    if (!input.documentId || input.chunks.length === 0) return null;
    existing = await fetchExisting({
      namespace: input.namespace,
      sourceDocumentId: input.documentId,
    });
    const page = compileDocumentMirror(input);
    page.status = mirrorStatusAfterSourceChange(existing);
    stored = await upsertPage(page);
    if (input.namespace === "library") {
      await markUpdated(input.documentId);
    }
  } catch (error) {
    console.warn(
      "[wiki] compile failed",
      error instanceof Error ? error.message : error,
    );
    if (options?.strict) throw error;
    return null;
  }

  if (
    stored &&
    options?.enqueueKnowledge === true &&
    stored.sections.length > 0 &&
    !existing?.userEdited
  ) {
    try {
      await enqueue({
        namespace: input.namespace,
        documentId: input.documentId,
        pageId: stored.id,
        title: input.title,
      });
    } catch (error) {
      console.warn(
        "[wiki] enqueue compile_wiki failed",
        error instanceof Error ? error.message : error,
      );
    }
  }

  return stored;
}
