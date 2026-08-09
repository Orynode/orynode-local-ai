/**
 * Citation Protocol — 引用标记的唯一解析 / 规范化入口。
 *
 * 职责边界：
 * - 本模块：parse / canonicalize / 转 markdown 链接文本 / prompt 规则
 * - app/lib/citation-markdown.ts：react-markdown 展示适配（urlTransform + 胶囊）
 * - useChat.finalizeAnswer：落库正文 + referencedCitationIds 的唯一写路径
 * - /api/chat done：只用 extractReferencedCitationIds 下发 ids，不改正文
 *
 * 规范：
 * - 对外只承认展开后的 [S1][S2]…
 * - 输入兼容 [S1]、[S1][S2]、[S1, S2]、[S1、S2]
 * - 落点：该行出现的合法引用收到该行末尾
 */

function citationGroupRe(): RegExp {
  return /\[\s*(S\d+(?:\s*[,，、;；]\s*S\d+)*)\s*\]/gi;
}

export const CITATION_PROMPT_RULES = `引用资料时只能使用提供的编号；规范格式为紧挨着的 [S1][S2]（每个编号单独一对方括号）。
禁止写成 [S1, S2] 或 [S1、S2]。不要编造未提供的编号或文件路径。
若某行需要标注依据，把该行用到的引用标记放在该行末尾（紧跟该行文字之后）；不要插在句中，也不要把全文所有引用都堆到整段回答最后一行。`;

function groundingTerms(text: string): Set<string> {
  const normalized = text.toLocaleLowerCase();
  const terms = new Set(
    normalized.match(/[a-z0-9][a-z0-9._+-]{1,}/g) ?? [],
  );
  for (const run of normalized.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    for (let i = 0; i < run.length - 1; i += 1) {
      terms.add(run.slice(i, i + 2));
    }
  }
  return terms;
}

function overlapScore(left: string, rightTerms: Set<string>): number {
  let score = 0;
  for (const term of groundingTerms(left)) {
    if (rightTerms.has(term)) score += 1;
  }
  return score;
}

/**
 * 小模型偶尔会漏写引用标记。仅当回答与某条来源存在至少两个独立词项
 * 的可证明重叠时，才把该来源补到最相关行；无可靠证据时保持不引用。
 */
export function groundUncitedAssistantAnswer(
  text: string,
  citations: Array<{ id: string; excerpt: string }>,
): { content: string; referencedIds: string[] } {
  const canonical = canonicalizeAssistantCitations(
    text,
    citations.map((citation) => citation.id),
  );
  if (canonical.referencedIds.length > 0 || citations.length === 0) {
    return canonical;
  }

  let bestCitation: (typeof citations)[number] | null = null;
  let bestScore = 0;
  for (const citation of citations) {
    const score = overlapScore(text, groundingTerms(citation.excerpt));
    if (score > bestScore) {
      bestCitation = citation;
      bestScore = score;
    }
  }
  if (!bestCitation || bestScore < 2) return canonical;

  const excerptTerms = groundingTerms(bestCitation.excerpt);
  const lines = canonical.content.split("\n");
  let bestLine = -1;
  let bestLineScore = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const score = overlapScore(lines[index] ?? "", excerptTerms);
    if (score > bestLineScore) {
      bestLine = index;
      bestLineScore = score;
    }
  }
  if (bestLine < 0 || bestLineScore < 2) return canonical;
  lines[bestLine] = `${lines[bestLine]?.trimEnd()}[${bestCitation.id}]`;
  return canonicalizeAssistantCitations(
    lines.join("\n"),
    citations.map((citation) => citation.id),
  );
}

export function parseCitationIdsFromGroup(inner: string): string[] {
  const ids: string[] = [];
  for (const match of String(inner).matchAll(/S\d+/gi)) {
    const raw = match[0];
    if (!raw) continue;
    const id = `S${raw.slice(1)}`;
    ids.push(id);
  }
  return ids;
}

function collectCitationIdsInOrder(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of String(text).matchAll(citationGroupRe())) {
    const inner = match[1] ?? "";
    for (const id of parseCitationIdsFromGroup(inner)) {
      if (seen.has(id)) continue;
      seen.add(id);
      found.push(id);
    }
  }
  return found;
}

/** 只提取 id，不改写正文（供 SSE done 等「只要集合」的场景） */
export function extractReferencedCitationIds(
  answer: string,
  allowedIds: Iterable<string>,
): string[] {
  const allowed = new Set(allowedIds);
  return collectCitationIdsInOrder(answer).filter((id) => allowed.has(id));
}

export type CanonicalCitations = {
  content: string;
  referencedIds: string[];
};

function canonicalizeLine(
  line: string,
  allowed: Set<string>,
  onId: (id: string) => void,
): string {
  const lineIds: string[] = [];
  const seenOnLine = new Set<string>();

  for (const match of line.matchAll(citationGroupRe())) {
    for (const id of parseCitationIdsFromGroup(match[1] ?? "")) {
      if (!allowed.has(id)) continue;
      if (seenOnLine.has(id)) continue;
      seenOnLine.add(id);
      lineIds.push(id);
      onId(id);
    }
  }

  const leading = line.match(/^[ \t]*/)?.[0] ?? "";
  const body = line
    .slice(leading.length)
    .replace(citationGroupRe(), "")
    .replace(/[ \t\u00a0\u3000]+([。．.！!？?；;，,])/g, "$1")
    .replace(/[ \t\u00a0\u3000]{2,}/g, " ")
    .replace(/[ \t\u00a0\u3000]+$/g, "");

  if (lineIds.length === 0) {
    return leading + body;
  }

  const markers = lineIds.map((id) => `[${id}]`).join("");
  return leading + (body ? `${body}${markers}` : markers);
}

/**
 * 规范化助手回答中的引用（写库与展示共用，幂等）。
 * useChat.finalizeAnswer 用其结果作为落库 content / referencedCitationIds。
 */
export function canonicalizeAssistantCitations(
  text: string,
  allowedIds: Iterable<string>,
): CanonicalCitations {
  const allowed = new Set(allowedIds);
  const referencedIds: string[] = [];
  const seen = new Set<string>();

  const onId = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    referencedIds.push(id);
  };

  const lines = String(text)
    .split("\n")
    .map((line) => canonicalizeLine(line, allowed, onId));

  const merged: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const onlyMarkers = /^(?:\[S\d+\])+$/.test(trimmed);
    if (onlyMarkers && merged.length > 0) {
      let i = merged.length - 1;
      while (i >= 0 && merged[i]!.trim() === "") i -= 1;
      if (i >= 0) {
        merged[i] = merged[i]!.replace(/[ \t]+$/g, "") + trimmed;
        continue;
      }
    }
    merged.push(line);
  }

  const content = merged.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  return { content, referencedIds };
}

/**
 * 将规范单标转为 Markdown 链接，供胶囊组件挂载。
 * 连续 [S5][S7] → 单链 `citation:S5,S7`；链接可见文案固定为「来源」
 * （真实文档名由 CiteRefChip 根据 provided citations 渲染，不依赖此文案）。
 *
 * 渲染侧必须用 citationUrlTransform 放行 `citation:`（见 citation-markdown.ts）。
 */
export function toCitationMarkdownLinks(
  content: string,
  allowedIds: Iterable<string>,
): string {
  const allowed = new Set(allowedIds);
  return String(content).replace(/(?:\[S\d+\])+/g, (run) => {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const match of run.matchAll(/\[(S\d+)\]/g)) {
      const id = match[1];
      if (!id || !allowed.has(id) || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    if (ids.length === 0) return run;
    return `[来源](citation:${ids.join(",")})`;
  });
}
