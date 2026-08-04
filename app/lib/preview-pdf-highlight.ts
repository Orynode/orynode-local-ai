/** PDF 预览高亮：OCR 归一化 bbox + 页内字符偏移（纯计算，便于单测） */

export type PdfTextItemLike = {
  str?: string;
  /** pdf.js transform: [scaleX, skewY, skewX, scaleY, translateX, translateY] */
  transform: number[];
  width?: number;
  height?: number;
};

export type PdfHighlightRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/** OCR / Citation 归一化框：[x, y, width, height]，左上角原点，0..1 */
export type NormalizedBboxTuple = [number, number, number, number];

export type PdfHighlightPlan =
  | { mode: "bbox"; bbox: NormalizedBboxTuple }
  | { mode: "offsets"; start: number; end: number }
  | { mode: "none" };

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** 校验并钳位归一化 bbox；非法则返回 null */
export function parsePreviewBbox(raw: unknown): NormalizedBboxTuple | null {
  if (!Array.isArray(raw) || raw.length < 4) return null;
  const x = raw[0];
  const y = raw[1];
  const w = raw[2];
  const h = raw[3];
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof w !== "number" ||
    typeof h !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(w) ||
    !Number.isFinite(h) ||
    w <= 0 ||
    h <= 0
  ) {
    return null;
  }
  const nx = clamp01(x);
  const ny = clamp01(y);
  const nw = Math.min(w, Math.max(0, 1 - nx));
  const nh = Math.min(h, Math.max(0, 1 - ny));
  if (nw <= 0 || nh <= 0) return null;
  return [nx, ny, nw, nh];
}

/**
 * 高亮策略：OCR bbox 优先（扫描件无可靠字符偏移），否则退回字符偏移。
 */
export function resolvePdfHighlightPlan(input: {
  bbox?: unknown;
  startOffset?: number | null;
  endOffset?: number | null;
}): PdfHighlightPlan {
  const bbox = parsePreviewBbox(input.bbox);
  if (bbox) return { mode: "bbox", bbox };

  const start =
    typeof input.startOffset === "number" && Number.isFinite(input.startOffset)
      ? Math.floor(input.startOffset)
      : null;
  const end =
    typeof input.endOffset === "number" && Number.isFinite(input.endOffset)
      ? Math.floor(input.endOffset)
      : null;
  if (start != null && end != null && end > start) {
    return { mode: "offsets", start, end };
  }
  return { mode: "none" };
}

/** 仅在当前页等于引用页时绘制高亮；无引用页则不画 */
export function isHighlightPageActive(
  currentPage: number,
  highlightPage: number | null | undefined,
): boolean {
  if (
    typeof highlightPage !== "number" ||
    !Number.isFinite(highlightPage) ||
    highlightPage < 1
  ) {
    return false;
  }
  if (!Number.isFinite(currentPage) || currentPage < 1) return false;
  return Math.floor(currentPage) === Math.floor(highlightPage);
}

/** 归一化 bbox → 页面像素矩形（与渲染 canvas 同尺寸） */
export function highlightRectForNormalizedBbox(
  bbox: NormalizedBboxTuple,
  pageWidthPx: number,
  pageHeightPx: number,
): PdfHighlightRect | null {
  if (!(pageWidthPx > 0) || !(pageHeightPx > 0)) return null;
  const [x, y, w, h] = bbox;
  const left = x * pageWidthPx;
  const top = y * pageHeightPx;
  const width = w * pageWidthPx;
  const height = h * pageHeightPx;
  if (width < 0.5 || height < 0.5) return null;
  return { left, top, width, height };
}

/** pdf.js v6 移除 convertToViewportRectangle；用两点还原矩形 */
export function pdfRectToViewport(
  viewport: { convertToViewportPoint(x: number, y: number): number[] },
  pdfRect: number[],
): number[] {
  const [x0, y0, x1, y1] = pdfRect;
  const [vx0, vy0] = viewport.convertToViewportPoint(x0, y0);
  const [vx1, vy1] = viewport.convertToViewportPoint(x1, y1);
  return [vx0, vy0, vx1, vy1];
}

/**
 * 将 [startOffset, endOffset) 映射到视口矩形。
 * 偏移按 items[].str 以空格拼接计算（与 parsePdf / chunk 抽取一致）。
 */
export function highlightRectsForOffsets(
  items: PdfTextItemLike[],
  convertToViewportRectangle: (pdfRect: number[]) => number[],
  startOffset: number,
  endOffset: number,
): PdfHighlightRect[] {
  const start = Math.max(0, Math.floor(startOffset));
  const end = Math.max(start, Math.floor(endOffset));
  if (end <= start || items.length === 0) return [];

  const rects: PdfHighlightRect[] = [];
  let cursor = 0;
  let seenTextItem = false;

  for (const item of items) {
    const str = typeof item.str === "string" ? item.str : "";
    if (!str) continue;
    if (seenTextItem) cursor += 1; // join(" ")
    seenTextItem = true;

    const itemStart = cursor;
    const itemEnd = cursor + str.length;
    cursor = itemEnd;
    if (itemEnd <= start || itemStart >= end) continue;

    const localStart = Math.max(0, start - itemStart);
    const localEnd = Math.min(str.length, end - itemStart);
    if (localEnd <= localStart) continue;

    const [, , , scaleY, tx, ty] = item.transform;
    const fullWidth =
      typeof item.width === "number" && Number.isFinite(item.width)
        ? item.width
        : Math.abs(item.transform[0]) * str.length;
    const height =
      typeof item.height === "number" && Number.isFinite(item.height)
        ? item.height
        : Math.abs(scaleY) || 12;

    const ratioStart = localStart / str.length;
    const ratioEnd = localEnd / str.length;
    const x0 = tx + fullWidth * ratioStart;
    const x1 = tx + fullWidth * ratioEnd;
    const y0 = ty;
    const y1 = ty + height;

    const viewport = convertToViewportRectangle([x0, y0, x1, y1]);
    const left = Math.min(viewport[0], viewport[2]);
    const top = Math.min(viewport[1], viewport[3]);
    const width = Math.abs(viewport[2] - viewport[0]);
    const heightPx = Math.abs(viewport[3] - viewport[1]);
    if (width < 0.5 || heightPx < 0.5) continue;
    rects.push({ left, top, width, height: heightPx });
  }

  return rects;
}

/** 根据高亮计划生成要绘制的矩形列表 */
export function rectsForHighlightPlan(
  plan: PdfHighlightPlan,
  input: {
    pageWidthPx: number;
    pageHeightPx: number;
    items?: PdfTextItemLike[];
    convertToViewportRectangle?: (pdfRect: number[]) => number[];
  },
): PdfHighlightRect[] {
  if (plan.mode === "bbox") {
    const rect = highlightRectForNormalizedBbox(
      plan.bbox,
      input.pageWidthPx,
      input.pageHeightPx,
    );
    return rect ? [rect] : [];
  }
  if (plan.mode === "offsets") {
    if (!input.items || !input.convertToViewportRectangle) return [];
    return highlightRectsForOffsets(
      input.items,
      input.convertToViewportRectangle,
      plan.start,
      plan.end,
    );
  }
  return [];
}
