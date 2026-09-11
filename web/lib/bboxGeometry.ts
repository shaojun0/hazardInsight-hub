import type { BBox } from '../../shared/types';

export const MIN_BBOX_SIZE = 0.02;

export interface Point {
  x: number;
  y: number;
}

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type ResizeHandle = 'nw' | 'ne' | 'se' | 'sw';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** 将浏览器客户区坐标换算为 Canvas 图片内的 0~1 坐标。 */
export function clientPointToNormalized(clientX: number, clientY: number, rect: RectLike): Point {
  return {
    x: rect.width > 0 ? (clientX - rect.left) / rect.width : 0,
    y: rect.height > 0 ? (clientY - rect.top) / rect.height : 0,
  };
}

export function pointInBBox(point: Point, bbox: BBox): boolean {
  return point.x >= bbox.x
    && point.x <= bbox.x + bbox.width
    && point.y >= bbox.y
    && point.y <= bbox.y + bbox.height;
}

/** 与 Canvas 绘制顺序一致，从数组末尾向前命中最上层框。 */
export function hitTestHazards<T extends { bbox: BBox }>(hazards: readonly T[], point: Point): T | null {
  for (let index = hazards.length - 1; index >= 0; index -= 1) {
    if (pointInBBox(point, hazards[index].bbox)) return hazards[index];
  }
  return null;
}

export function getVisibleHazards<T extends { id: string }>(hazards: readonly T[], selectedHazardId: string | null): T[] {
  return selectedHazardId === null
    ? [...hazards]
    : hazards.filter((hazard) => hazard.id === selectedHazardId);
}

export function getResizeHandle(
  point: Point,
  bbox: BBox,
  rect: RectLike,
  hitRadiusCssPx = 12
): ResizeHandle | null {
  const corners: Array<[ResizeHandle, Point]> = [
    ['nw', { x: bbox.x, y: bbox.y }],
    ['ne', { x: bbox.x + bbox.width, y: bbox.y }],
    ['se', { x: bbox.x + bbox.width, y: bbox.y + bbox.height }],
    ['sw', { x: bbox.x, y: bbox.y + bbox.height }],
  ];
  for (const [handle, corner] of corners) {
    const dx = Math.abs(point.x - corner.x) * rect.width;
    const dy = Math.abs(point.y - corner.y) * rect.height;
    if (dx <= hitRadiusCssPx && dy <= hitRadiusCssPx) return handle;
  }
  return null;
}

export function clampBBox(bbox: BBox, minimumSize = MIN_BBOX_SIZE): BBox {
  const minSize = clamp(minimumSize, 0, 1);
  const width = clamp(bbox.width, minSize, 1);
  const height = clamp(bbox.height, minSize, 1);
  return {
    x: clamp(bbox.x, 0, 1 - width),
    y: clamp(bbox.y, 0, 1 - height),
    width,
    height,
  };
}

export function moveBBox(origin: BBox, deltaX: number, deltaY: number): BBox {
  const valid = clampBBox(origin);
  return {
    ...valid,
    x: clamp(valid.x + deltaX, 0, 1 - valid.width),
    y: clamp(valid.y + deltaY, 0, 1 - valid.height),
  };
}

export function resizeBBox(
  origin: BBox,
  handle: ResizeHandle,
  deltaX: number,
  deltaY: number,
  minimumSize = MIN_BBOX_SIZE
): BBox {
  const valid = clampBBox(origin, minimumSize);
  const minSize = clamp(minimumSize, 0, 1);
  let left = valid.x;
  let top = valid.y;
  let right = valid.x + valid.width;
  let bottom = valid.y + valid.height;

  if (handle === 'nw' || handle === 'sw') {
    left = clamp(valid.x + deltaX, 0, right - minSize);
  } else {
    right = clamp(valid.x + valid.width + deltaX, left + minSize, 1);
  }

  if (handle === 'nw' || handle === 'ne') {
    top = clamp(valid.y + deltaY, 0, bottom - minSize);
  } else {
    bottom = clamp(valid.y + valid.height + deltaY, top + minSize, 1);
  }

  return clampBBox({ x: left, y: top, width: right - left, height: bottom - top }, minSize);
}

export function bboxEquals(a: BBox, b: BBox, epsilon = 1e-7): boolean {
  return Math.abs(a.x - b.x) <= epsilon
    && Math.abs(a.y - b.y) <= epsilon
    && Math.abs(a.width - b.width) <= epsilon
    && Math.abs(a.height - b.height) <= epsilon;
}

export function replaceBBoxById<T extends { id: string; bbox: BBox }>(
  hazards: readonly T[],
  hazardId: string,
  bbox: BBox
): T[] {
  return hazards.map((hazard) => (hazard.id === hazardId ? { ...hazard, bbox } : hazard));
}
