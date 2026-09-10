export type WikiTrailEntry = { id: string; title: string };

export type WikiPageNav = "open" | "related" | "reload" | "back";

/** 点相关页时记下当前页，方便返回。 */
export function pushWikiTrail(
  trail: WikiTrailEntry[],
  current: WikiTrailEntry | null | undefined,
  nextId: string,
): WikiTrailEntry[] {
  const id = String(current?.id || "").trim();
  const next = String(nextId || "").trim();
  if (!id || !next || id === next) return trail;
  const withoutDup = trail.filter((entry) => entry.id !== id);
  return [...withoutDup, { id, title: String(current?.title || id) }].slice(-12);
}
