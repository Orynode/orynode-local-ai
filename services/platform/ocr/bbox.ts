/**
 * OCR bbox 校验与坐标系转换
 */

import type { NormalizedBoundingBox } from "../types";

const EPS = 1e-9;

export function isFiniteUnit(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** 校验左上角原点、0..1 归一化 bbox */
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
  if (
    x < -EPS ||
    y < -EPS ||
    width < -EPS ||
    height < -EPS ||
    x > 1 + EPS ||
    y > 1 + EPS ||
    width > 1 + EPS ||
    height > 1 + EPS ||
    x + width > 1 + EPS ||
    y + height > 1 + EPS
  ) {
    throw new Error("OCR_INVALID_BBOX");
  }
  return {
    x: clamp01(x),
    y: clamp01(y),
    width: clamp01(width),
    height: clamp01(height),
  };
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
