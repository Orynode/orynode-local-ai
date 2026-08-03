/**
 * 从 DocumentBlock bbox 推导 Citation locator.bbox
 */

export type BlockBboxRef = {
  pageNumber: number;
  bbox: { x: number; y: number; width: number; height: number } | null;
};

/**
 * 同页单一紧密区域 → [x,y,w,h]；跨分散区域则仅页定位并标记 degraded。
 */
export function locatorBboxFromBlockRefs(
  refs: BlockBboxRef[],
  page: number,
): {
  bbox?: [number, number, number, number];
  degraded: boolean;
} {
  const withBbox = refs.filter(
    (r) =>
      r.pageNumber === page &&
      r.bbox &&
      Number.isFinite(r.bbox.x) &&
      Number.isFinite(r.bbox.y) &&
      Number.isFinite(r.bbox.width) &&
      Number.isFinite(r.bbox.height),
  );
  if (withBbox.length === 0) {
    return { degraded: false };
  }
  if (withBbox.length === 1) {
    const b = withBbox[0].bbox!;
    return {
      bbox: [b.x, b.y, b.width, b.height],
      degraded: false,
    };
  }

  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  let sumArea = 0;
  for (const r of withBbox) {
    const b = r.bbox!;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
    sumArea += b.width * b.height;
  }
  const width = Math.max(0, maxX - minX);
  const height = Math.max(0, maxY - minY);
  const unionArea = width * height;
  // 并集远大于各块面积之和 → 区域分散，不写 bbox
  if (unionArea > sumArea * 3 || unionArea > 0.45) {
    return { degraded: true };
  }
  return {
    bbox: [minX, minY, width, height],
    degraded: false,
  };
}
