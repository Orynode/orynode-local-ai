/**
 * Markdown 标题路径辅助（parser / chunker / citation 共用）
 */

export type MarkdownHeading = {
  level: number;
  title: string;
};

export type HeadingStackEntry = MarkdownHeading;

/** 解析单行 ATX 标题（# ～ ######） */
export function parseMarkdownHeadingLine(line: string): MarkdownHeading | null {
  const match = /^(#{1,6})\s+(.+?)\s*$/.exec(String(line ?? "").trimEnd());
  if (!match) return null;
  const title = match[2]!.replace(/\s+#+\s*$/, "").trim();
  if (!title) return null;
  return { level: match[1]!.length, title };
}

/** 同级/更高级截断后压栈；返回标题路径字符串数组 */
export function pushHeadingPath(
  stack: HeadingStackEntry[],
  heading: MarkdownHeading,
): { stack: HeadingStackEntry[]; path: string[] } {
  const next = stack.filter((entry) => entry.level < heading.level);
  next.push(heading);
  return {
    stack: next,
    path: next.map((entry) => entry.title),
  };
}

/**
 * 从块正文推断标题路径：取前若干行中首个 ATX 标题。
 */
export function inferHeadingPathFromContent(
  content: string,
  fallback?: string[],
): string[] | undefined {
  if (fallback && fallback.length > 0) return [...fallback];
  const lines = String(content ?? "").split("\n").slice(0, 8);
  for (const line of lines) {
    const heading = parseMarkdownHeadingLine(line);
    if (heading) return [heading.title];
  }
  return undefined;
}

/** 软规范化：保留换行，仅折叠行内空白 */
export function softNormalizeMarkdown(text: string): string {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function contentLooksLikeMarkdown(text: string): boolean {
  return /^(#{1,6})\s+\S/m.test(text) || /^```/m.test(text);
}
