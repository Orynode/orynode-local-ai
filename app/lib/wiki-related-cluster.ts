export type WikiSourcePage = {
  id?: string;
  kind?: string;
  sourceDocumentId?: string;
  sections?: Array<{ sourceDocumentId?: string }>;
};

export function wikiSourceDocumentIds(page: WikiSourcePage): string[] {
  const fromSections = (page.sections ?? [])
    .map((section) => String(section.sourceDocumentId || "").trim())
    .filter((id) => id && !id.startsWith("concept:"));
  const root = String(page.sourceDocumentId || "").trim();
  if (root && !root.startsWith("concept:") && page.kind !== "concept") {
    fromSections.unshift(root);
  }
  return [...new Set(fromSections)];
}

/** 概念页只来自当前这一篇资料时，相关页就是自己，不应展示。 */
export function isSameSourceCluster(
  current: WikiSourcePage,
  neighbor: WikiSourcePage,
): boolean {
  const docs = [
    ...new Set([
      ...wikiSourceDocumentIds(current),
      ...wikiSourceDocumentIds(neighbor),
    ]),
  ];
  return docs.length <= 1;
}
