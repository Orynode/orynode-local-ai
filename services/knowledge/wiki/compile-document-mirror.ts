/**
 * W0：从 chunk + headingPath 抽取 document_mirror，不调用 LLM。
 */

export const WIKI_COMPILER_ID = "heading_extract_v1";

export const WIKI_EXCERPT_MAX_CHARS = 480;
export const WIKI_MAX_SECTIONS = 48;
/** 全库重抽/概念归并一次扫这么多篇，避免 8GB 机器被拖死 */
export const WIKI_LIBRARY_SCAN_CAP = 500;

export type WikiPageKind = "document_mirror" | "concept" | "synthesis";

export type WikiCompileChunk = {
  id: string;
  content: string;
  pageNumber: number;
  position?: number;
  headingPath?: unknown;
  startLine?: number | null;
  endLine?: number | null;
};

export type WikiSection = {
  headingPath: string[];
  heading: string;
  excerpt: string;
  chunkId: string;
  pageNumber: number;
  startLine?: number;
  endLine?: number;
  sourceDocumentId?: string;
  sourceDocumentTitle?: string;
};

export type WikiClaimStatus = "active" | "withdrawn" | "conflicted" | "pending";

export type WikiEvidence = {
  documentId: string;
  chunkId: string;
  pageNumber?: number;
  startLine?: number;
  endLine?: number;
};

export type WikiClaim = {
  id: string;
  text: string;
  citationSectionIndexes: number[];
  sourceChunkIds: string[];
  fingerprint?: string;
  evidence?: WikiEvidence[];
  status?: WikiClaimStatus;
  compilerVersion?: string;
  kind?: "definition" | "fact" | "process" | "constraint" | "comparison";
};

export type WikiSemanticRelation = {
  target: string;
  rel: "is_a" | "part_of" | "depends_on" | "causes" | "contrasts_with" | "related_to";
  citationSectionIndexes: number[];
  status?: "resolved" | "pending";
  resolvedToId?: string;
};

export type WikiConceptIdentity = {
  stableId: string;
  canonicalTitle: string;
  aliases: string[];
  disambiguation?: string;
  pinned?: boolean;
};

export type WikiKnowledge = {
  aliases: string[];
  claims: WikiClaim[];
  relations: WikiSemanticRelation[];
  identity?: WikiConceptIdentity;
};

export type CompiledWikiPage = {
  id: string;
  slug: string;
  title: string;
  kind: WikiPageKind;
  namespace: "library" | "conversation";
  sourceDocumentId: string;
  markdown: string;
  sections: WikiSection[];
  compiler: typeof WIKI_COMPILER_ID | string;
  status: "ready" | "stale";
  synthesisMarkdown?: string;
  synthesisCompiler?: string;
  knowledge?: WikiKnowledge;
  identity?: WikiConceptIdentity;
  notesMarkdown?: string;
  userEdited?: boolean;
  wikiBuildId?: string;
};

export function wikiPageSlug(
  namespace: "library" | "conversation",
  documentId: string,
): string {
  return `mirror:${namespace}:${documentId}`;
}

export function parseHeadingPath(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((part) => String(part).trim()).filter(Boolean);
  }
  if (typeof raw !== "string") return [];
  const text = raw.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map((part) => String(part).trim()).filter(Boolean);
    }
  } catch {
    // fall through
  }
  return text
    .split(/\s*\/\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function stripLeadingHeading(content: string, heading: string): string {
  const trimmed = content.trim();
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingLine = new RegExp(
    `^(?:#{1,6}\\s*)?${escaped}\\s*(?:\\n+|$)`,
  );
  return trimmed.replace(headingLine, "").trim();
}

function buildExcerpt(parts: string[], maxChars: number): string {
  let out = "";
  for (const part of parts) {
    const piece = part.trim();
    if (!piece) continue;
    const next = out ? `${out}\n\n${piece}` : piece;
    if (out && next.length > maxChars) break;
    out = next;
    if (out.length >= maxChars) break;
  }
  if (out.length <= maxChars) return out;
  return `${out.slice(0, maxChars).trimEnd()}…`;
}

function sectionKey(chunk: WikiCompileChunk): string {
  const path = parseHeadingPath(chunk.headingPath);
  if (path.length > 0) return `h:${JSON.stringify(path)}`;
  return `p:${chunk.pageNumber}`;
}

function sectionHeading(chunk: WikiCompileChunk, path: string[]): string {
  if (path.length > 0) return path.join(" / ");
  return `第 ${chunk.pageNumber} 页`;
}

export function compileDocumentMirror(input: {
  namespace: "library" | "conversation";
  documentId: string;
  title: string;
  chunks: WikiCompileChunk[];
}): CompiledWikiPage {
  const title = String(input.title || "未命名资料").trim() || "未命名资料";
  const ordered = [...input.chunks].sort((a, b) => {
    const page = (a.pageNumber || 0) - (b.pageNumber || 0);
    if (page !== 0) return page;
    return (a.position ?? 0) - (b.position ?? 0);
  });

  const groups = new Map<string, WikiCompileChunk[]>();
  for (const chunk of ordered) {
    if (!String(chunk.content ?? "").trim()) continue;
    const key = sectionKey(chunk);
    const list = groups.get(key);
    if (list) list.push(chunk);
    else groups.set(key, [chunk]);
  }

  const sections: WikiSection[] = [];
  for (const group of groups.values()) {
    if (sections.length >= WIKI_MAX_SECTIONS) break;
    const first = group[0];
    if (!first) continue;
    const headingPath = parseHeadingPath(first.headingPath);
    const heading = sectionHeading(first, headingPath);
    const texts = group.map((chunk) =>
      stripLeadingHeading(chunk.content, headingPath.at(-1) || heading),
    );
    const excerpt = buildExcerpt(texts, WIKI_EXCERPT_MAX_CHARS);
    if (!excerpt) continue;
    sections.push({
      headingPath,
      heading,
      excerpt,
      chunkId: first.id,
      pageNumber: first.pageNumber,
      ...(first.startLine != null ? { startLine: first.startLine } : {}),
      ...(first.endLine != null ? { endLine: first.endLine } : {}),
    });
  }

  const slug = wikiPageSlug(input.namespace, input.documentId);
  const body = sections
    .map((section) => `## ${section.heading}\n\n${section.excerpt}`)
    .join("\n\n");
  const markdown = [
    `# ${title}`,
    "",
    "这份大纲从文档标题层级抽取，没有调用大模型。每一节都能回到原来的切片。",
    "",
    body || "（没有可抽取的章节）",
  ].join("\n");

  return {
    id: slug,
    slug,
    title,
    kind: "document_mirror",
    namespace: input.namespace,
    sourceDocumentId: input.documentId,
    markdown,
    sections,
    compiler: WIKI_COMPILER_ID,
    status: "ready",
  };
}
