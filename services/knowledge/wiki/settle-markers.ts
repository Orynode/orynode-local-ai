/**
 * 沉淀笔记标记。纯字符串，可在浏览器与 Node 共用。
 */

export function settleMarker(settleId: string): string {
  return `<!--orynode-settle:${settleId}-->`;
}

export function lastSettleId(text: string): string | null {
  const matches = [
    ...String(text || "").matchAll(/<!--orynode-settle:([^>\s]+)-->/g),
  ];
  const id = matches.at(-1)?.[1]?.trim();
  return id || null;
}

/** 正文已在笔记里时，撤销应对准原来那条标记，而不是新生成的 id。 */
export function settleIdForBody(text: string, body: string): string | null {
  const needle = String(body || "").trim();
  if (!needle) return null;
  const blocks = [
    ...String(text || "").matchAll(
      /<!--orynode-settle:([^>\s]+)-->\s*([\s\S]*?)<!--\/orynode-settle:\1-->/g,
    ),
  ];
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const id = blocks[index]?.[1]?.trim();
    const inner = String(blocks[index]?.[2] || "").trim();
    if (id && inner === needle) return id;
  }
  return null;
}

export function stripSettleMarkers(text: string): string {
  return String(text || "")
    .replace(/<!--\/?orynode-settle:[^>]+-->\s*/g, "")
    .trim();
}
