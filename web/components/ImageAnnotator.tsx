import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { BBox, Hazard } from '../../shared/types';
import { GRADE_META } from '../lib/constants';
import {
  bboxEquals,
  clientPointToNormalized,
  getResizeHandle,
  getVisibleHazards,
  hitTestHazards,
  moveBBox,
  pointInBBox,
  replaceBBoxById,
  resizeBBox,
  type Point,
  type ResizeHandle,
} from '../lib/bboxGeometry';

export interface AnnotatorHandle {
  getDataUrl: (hazardId?: Hazard['id']) => string | null;
}

interface Props {
  imageUrl: string;
  hazards: Hazard[];
  selectedHazardId: Hazard['id'] | null;
  showLabels: boolean;
  onSelectHazard: (hazardId: Hazard['id'] | null) => void;
  onChangeBBox: (hazardId: Hazard['id'], bbox: BBox) => void;
}

interface DrawState {
  hazards: Hazard[];
  selectedHazardId: Hazard['id'] | null;
  showLabels: boolean;
}

interface Interaction {
  pointerId: number;
  hazardId: Hazard['id'];
  mode: 'move' | ResizeHandle;
  startPoint: Point;
  startClientX: number;
  startClientY: number;
  originBBox: BBox;
  draftBBox: BBox;
  moved: boolean;
}

const MAX_EDGE = 1600;
const DRAG_THRESHOLD_CSS_PX = 3;
const HANDLE_SIZE_CSS_PX = 10;

const AnnotatorInner = forwardRef<AnnotatorHandle, Props>(function Annotator(
  { imageUrl, hazards, selectedHazardId, showLabels, onSelectHazard, onChangeBBox },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const interactionRef = useRef<Interaction | null>(null);
  const drawStateRef = useRef<DrawState>({ hazards, selectedHazardId, showLabels });
  drawStateRef.current = { hazards, selectedHazardId, showLabels };

  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image || canvas.width <= 0 || canvas.height <= 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const state = drawStateRef.current;
    const interaction = interactionRef.current;
    const visibleHazards = getVisibleHazards(state.hazards, state.selectedHazardId);
    const displayHazards = interaction
      ? replaceBBoxById(visibleHazards, interaction.hazardId, interaction.draftBBox)
      : visibleHazards;

    drawScene(ctx, image, canvas.width, canvas.height, displayHazards, {
      selectedHazardId: state.selectedHazardId,
      showLabels: state.showLabels,
      showHandles: state.selectedHazardId !== null,
      displayRect: canvas.getBoundingClientRect(),
      showEmptyState: state.hazards.length === 0,
    });
  }, []);

  const scheduleDraw = useCallback(() => {
    if (animationFrameRef.current !== null) return;
    animationFrameRef.current = requestAnimationFrame(() => {
      animationFrameRef.current = null;
      drawCanvas();
    });
  }, [drawCanvas]);

  const getDataUrl = useCallback((hazardId?: Hazard['id']): string | null => {
    const image = imageRef.current;
    const sourceCanvas = canvasRef.current;
    if (!image || !sourceCanvas || sourceCanvas.width <= 0 || sourceCanvas.height <= 0) return null;
    const output = document.createElement('canvas');
    output.width = sourceCanvas.width;
    output.height = sourceCanvas.height;
    const ctx = output.getContext('2d');
    if (!ctx) return null;
    const state = drawStateRef.current;
    const exportHazards = hazardId === undefined
      ? state.hazards
      : state.hazards.filter((hazard) => hazard.id === hazardId);
    if (hazardId !== undefined && exportHazards.length === 0) return null;
    drawScene(ctx, image, output.width, output.height, exportHazards, {
      selectedHazardId: null,
      showLabels: hazardId !== undefined || state.showLabels,
      showHandles: false,
      showEmptyState: state.hazards.length === 0,
    });
    return output.toDataURL('image/png');
  }, []);

  useImperativeHandle(ref, () => ({ getDataUrl }), [getDataUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    imageRef.current = null;
    interactionRef.current = null;
    const image = new Image();
    let cancelled = false;
    image.onload = () => {
      if (cancelled) return;
      const scale = Math.min(1, MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      imageRef.current = image;
      drawCanvas();
    };
    image.src = imageUrl;
    return () => {
      cancelled = true;
      if (imageRef.current === image) imageRef.current = null;
    };
  }, [drawCanvas, imageUrl]);

  useEffect(() => {
    drawCanvas();
  }, [drawCanvas, hazards, selectedHazardId, showLabels]);

  useEffect(() => () => {
    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
  }, []);

  function onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas || interactionRef.current) return;
    const rect = canvas.getBoundingClientRect();
    const point = clientPointToNormalized(event.clientX, event.clientY, rect);
    const state = drawStateRef.current;

    if (state.selectedHazardId === null) {
      const hit = hitTestHazards(state.hazards, point);
      onSelectHazard(hit?.id ?? null);
      return;
    }

    const selected = state.hazards.find((hazard) => hazard.id === state.selectedHazardId);
    if (!selected) {
      onSelectHazard(null);
      return;
    }
    const handle = getResizeHandle(point, selected.bbox, rect);
    const mode: Interaction['mode'] | null = handle ?? (pointInBBox(point, selected.bbox) ? 'move' : null);
    if (!mode) {
      onSelectHazard(null);
      return;
    }

    interactionRef.current = {
      pointerId: event.pointerId,
      hazardId: selected.id,
      mode,
      startPoint: point,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originBBox: { ...selected.bbox },
      draftBBox: { ...selected.bbox },
      moved: false,
    };
    canvas.setPointerCapture(event.pointerId);
    canvas.style.cursor = cursorForMode(mode);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) {
      updateHoverCursor(canvas, event.clientX, event.clientY, drawStateRef.current);
      return;
    }

    event.stopPropagation();
    event.preventDefault();
    const distance = Math.hypot(
      event.clientX - interaction.startClientX,
      event.clientY - interaction.startClientY
    );
    if (!interaction.moved && distance < DRAG_THRESHOLD_CSS_PX) return;
    interaction.moved = true;

    const point = clientPointToNormalized(event.clientX, event.clientY, canvas.getBoundingClientRect());
    const deltaX = point.x - interaction.startPoint.x;
    const deltaY = point.y - interaction.startPoint.y;
    interaction.draftBBox = interaction.mode === 'move'
      ? moveBBox(interaction.originBBox, deltaX, deltaY)
      : resizeBBox(interaction.originBBox, interaction.mode, deltaX, deltaY);
    scheduleDraw();
  }

  function onPointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
    event.stopPropagation();
    event.preventDefault();
    const canvas = canvasRef.current;
    const interaction = interactionRef.current;
    if (!canvas || !interaction || interaction.pointerId !== event.pointerId) return;
    interactionRef.current = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);

    if (interaction.moved && !bboxEquals(interaction.originBBox, interaction.draftBBox)) {
      onChangeBBox(interaction.hazardId, interaction.draftBBox);
    } else {
      drawCanvas();
    }
    updateHoverCursor(canvas, event.clientX, event.clientY, drawStateRef.current);
  }

  function cancelInteraction(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    const interaction = interactionRef.current;
    if (!canvas || !interaction || interaction.pointerId !== event.pointerId) return;
    interactionRef.current = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    canvas.style.cursor = 'crosshair';
    drawCanvas();
  }

  return (
    <canvas
      ref={canvasRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={cancelInteraction}
      onLostPointerCapture={cancelInteraction}
      style={{ cursor: 'crosshair', touchAction: 'none' }}
    />
  );
});

interface DrawOptions {
  selectedHazardId: Hazard['id'] | null;
  showLabels: boolean;
  showHandles: boolean;
  displayRect?: { width: number; height: number };
  showEmptyState: boolean;
}

function drawScene(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  width: number,
  height: number,
  hazards: readonly Hazard[],
  options: DrawOptions
) {
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);
  for (const hazard of hazards) {
    drawBox(ctx, hazard, width, height, options.selectedHazardId === hazard.id, options.showLabels);
  }

  if (options.showHandles && options.selectedHazardId !== null) {
    const selected = hazards.find((hazard) => hazard.id === options.selectedHazardId);
    if (selected) drawResizeHandles(ctx, selected, width, height, options.displayRect);
  }

  if (options.showEmptyState) {
    ctx.font = '24px system-ui';
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.textAlign = 'center';
    ctx.fillText('未发现明显安全隐患', width / 2, height / 2);
  }
}

function drawBox(
  ctx: CanvasRenderingContext2D,
  hazard: Hazard,
  width: number,
  height: number,
  isActive: boolean,
  showLabels: boolean
) {
  const bbox = hazard.bbox;
  const x = bbox.x * width;
  const y = bbox.y * height;
  const boxWidth = bbox.width * width;
  const boxHeight = bbox.height * height;
  const meta = GRADE_META[hazard.grade];

  ctx.save();
  ctx.fillStyle = meta.color;
  ctx.globalAlpha = 0.16;
  ctx.fillRect(x, y, boxWidth, boxHeight);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = meta.color;
  ctx.lineWidth = isActive ? 4 : 2.5;
  ctx.setLineDash(isActive ? [] : [7, 5]);
  ctx.strokeRect(x, y, boxWidth, boxHeight);
  ctx.setLineDash([]);

  if (showLabels) {
    const text = ` ${hazard.index}  ${hazard.grade}级  ${hazard.category} `;
    ctx.font = '600 15px system-ui, "PingFang SC", "Microsoft YaHei"';
    const textWidth = ctx.measureText(text).width;
    const labelWidth = textWidth + 14;
    const labelHeight = 26;
    let labelX = x;
    let labelY = y - labelHeight - 4;
    if (labelY < 4) labelY = y + 4;
    if (labelX + labelWidth > width - 4) labelX = Math.max(4, width - labelWidth - 4);
    ctx.fillStyle = meta.color;
    ctx.fillRect(labelX, labelY, labelWidth, labelHeight);
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(text, labelX + 7, labelY + labelHeight / 2 + 0.5);
  }
  ctx.restore();
}

function drawResizeHandles(
  ctx: CanvasRenderingContext2D,
  hazard: Hazard,
  width: number,
  height: number,
  displayRect?: { width: number; height: number }
) {
  const bbox = hazard.bbox;
  const corners = [
    { x: bbox.x * width, y: bbox.y * height },
    { x: (bbox.x + bbox.width) * width, y: bbox.y * height },
    { x: (bbox.x + bbox.width) * width, y: (bbox.y + bbox.height) * height },
    { x: bbox.x * width, y: (bbox.y + bbox.height) * height },
  ];
  const halfWidth = (HANDLE_SIZE_CSS_PX / 2) * (displayRect?.width ? width / displayRect.width : 1);
  const halfHeight = (HANDLE_SIZE_CSS_PX / 2) * (displayRect?.height ? height / displayRect.height : 1);
  const lineScale = displayRect?.width ? width / displayRect.width : 1;
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = GRADE_META[hazard.grade].color;
  ctx.lineWidth = Math.max(1.5, 2 * lineScale);
  for (const corner of corners) {
    ctx.fillRect(corner.x - halfWidth, corner.y - halfHeight, halfWidth * 2, halfHeight * 2);
    ctx.strokeRect(corner.x - halfWidth, corner.y - halfHeight, halfWidth * 2, halfHeight * 2);
  }
  ctx.restore();
}

function updateHoverCursor(canvas: HTMLCanvasElement, clientX: number, clientY: number, state: DrawState) {
  const rect = canvas.getBoundingClientRect();
  const point = clientPointToNormalized(clientX, clientY, rect);
  if (state.selectedHazardId !== null) {
    const selected = state.hazards.find((hazard) => hazard.id === state.selectedHazardId);
    if (!selected) {
      canvas.style.cursor = 'crosshair';
      return;
    }
    const handle = getResizeHandle(point, selected.bbox, rect);
    canvas.style.cursor = handle
      ? cursorForMode(handle)
      : pointInBBox(point, selected.bbox) ? 'move' : 'crosshair';
    return;
  }
  canvas.style.cursor = hitTestHazards(state.hazards, point) ? 'pointer' : 'crosshair';
}

function cursorForMode(mode: Interaction['mode']): string {
  if (mode === 'move') return 'move';
  return mode === 'nw' || mode === 'se' ? 'nwse-resize' : 'nesw-resize';
}

export const ImageAnnotator = AnnotatorInner;
