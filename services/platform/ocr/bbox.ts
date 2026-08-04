/**
 * OCR bbox 校验与坐标系转换
 */

import type { NormalizedBoundingBox } from "../types";

const EPS = 1e-9;

export function isFiniteUnit(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * 校验并归一化为左上角原点、落在 [0,1] 内的 bbox。
 *
 * Apple Vision 常给出 x+width 略大于 1 的浮点误差；此时钳位裁剪，
 * 而不是抛 OCR_INVALID_BBOX 导致整页/整文档失败。
 * 非有限值或负宽高仍拒绝。
 */
export function parseNormalizedBbox(raw: unknown): NormalizedBoundingBox {
  if (!raw || typeof raw !== "object") {
    throw new Error("OCR_INVALID_BBOX");
  }
  const o = raw as Record<string, unknown>;
  const x = o.x;
  const y = o.y;
  const width = o.width;
  const height = o.height;
  if (
    !isFiniteUnit(x) ||
    !isFiniteUnit(y) ||
    !isFiniteUnit(width) ||
    !isFiniteUnit(height)
  ) {
    throw new Error("OCR_INVALID_BBOX");
  }
  if (width < -EPS || height < -EPS) {
    throw new Error("OCR_INVALID_BBOX");
  }

  const nx = clamp01(x);
  const ny = clamp01(y);
  const nw = Math.min(Math.max(0, width), Math.max(0, 1 - nx));
  const nh = Math.min(Math.max(0, height), Math.max(0, 1 - ny));
  return { x: nx, y: ny, width: nw, height: nh };
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Apple Vision 归一化框（原点在左下）→ Orynode 左上角原点。
 * Vision 给出的是 (x, y, width, height)，y 为底边距。
 */
export function visionBboxToTopLeft(bbox: {
  x: number;
  y: number;
  width: number;
  height: number;
}): NormalizedBoundingBox {
  return parseNormalizedBbox({
    x: bbox.x,
    y: 1 - bbox.y - bbox.height,
    width: bbox.width,
    height: bbox.height,
  });
}

/** 覆盖多个 block 的最小外接框；若区域过于分散返回 null（调用方降级 page） */
export function unionBboxes(
  boxes: NormalizedBoundingBox[],
  options?: { maxSpanRatio?: number },
): NormalizedBoundingBox | null {
  if (boxes.length === 0) return null;
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  const width = Math.max(0, maxX - minX);
  const height = Math.max(0, maxY - minY);
  const maxSpan = options?.maxSpanRatio ?? 0.85;
  if (width > maxSpan || height > maxSpan) return null;
  return parseNormalizedBbox({ x: minX, y: minY, width, height });
}
