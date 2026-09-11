import assert from 'node:assert/strict';
import test from 'node:test';
import type { BBox } from '../../shared/types.js';
import {
  MIN_BBOX_SIZE,
  clientPointToNormalized,
  getResizeHandle,
  getVisibleHazards,
  hitTestHazards,
  moveBBox,
  replaceBBoxById,
  resizeBBox,
} from '../../web/lib/bboxGeometry.js';

function closeTo(actual: number, expected: number, message?: string) {
  assert.ok(Math.abs(actual - expected) < 1e-9, message ?? `${actual} should equal ${expected}`);
}

function bboxCloseTo(actual: BBox, expected: BBox) {
  closeTo(actual.x, expected.x, 'bbox.x');
  closeTo(actual.y, expected.y, 'bbox.y');
  closeTo(actual.width, expected.width, 'bbox.width');
  closeTo(actual.height, expected.height, 'bbox.height');
}

test('client coordinates map to normalized image coordinates at any CSS display size', () => {
  const point = clientPointToNormalized(210, 120, { left: 10, top: 20, width: 400, height: 200 });
  assert.deepEqual(point, { x: 0.5, y: 0.5 });

  const scaled = clientPointToNormalized(110, 70, { left: 10, top: 20, width: 200, height: 100 });
  assert.deepEqual(scaled, { x: 0.5, y: 0.5 });
});

test('hit testing prefers the last painted box and excludes hidden hazards', () => {
  const hazards = [
    { id: 'H001', bbox: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } },
    { id: 'H002', bbox: { x: 0.3, y: 0.3, width: 0.5, height: 0.5 } },
  ];
  assert.equal(hitTestHazards(hazards, { x: 0.4, y: 0.4 })?.id, 'H002');

  const visible = getVisibleHazards(hazards, 'H001');
  assert.deepEqual(visible.map((hazard) => hazard.id), ['H001']);
  assert.equal(hitTestHazards(visible, { x: 0.7, y: 0.7 }), null);
});

test('resize handle hit radius is expressed in CSS pixels', () => {
  const bbox = { x: 0.2, y: 0.3, width: 0.4, height: 0.3 };
  const rect = { left: 0, top: 0, width: 500, height: 250 };
  assert.equal(getResizeHandle({ x: 0.2, y: 0.3 }, bbox, rect), 'nw');
  assert.equal(getResizeHandle({ x: 0.6, y: 0.6 }, bbox, rect), 'se');
  assert.equal(getResizeHandle({ x: 0.4, y: 0.45 }, bbox, rect), null);
});

test('moving a bbox keeps its size and clamps it to every image edge', () => {
  const origin = { x: 0.2, y: 0.3, width: 0.4, height: 0.3 };
  bboxCloseTo(moveBBox(origin, 0.9, -0.8), { x: 0.6, y: 0, width: 0.4, height: 0.3 });
  bboxCloseTo(moveBBox(origin, -0.8, 0.9), { x: 0, y: 0.7, width: 0.4, height: 0.3 });
});

test('all four corner resize modes preserve the opposite corner and image bounds', () => {
  const origin = { x: 0.2, y: 0.3, width: 0.4, height: 0.3 };
  bboxCloseTo(resizeBBox(origin, 'nw', -0.5, -0.5), { x: 0, y: 0, width: 0.6, height: 0.6 });
  bboxCloseTo(resizeBBox(origin, 'ne', 0.6, -0.4), { x: 0.2, y: 0, width: 0.8, height: 0.6 });
  bboxCloseTo(resizeBBox(origin, 'se', 0.6, 0.7), { x: 0.2, y: 0.3, width: 0.8, height: 0.7 });
  bboxCloseTo(resizeBBox(origin, 'sw', -0.4, 0.8), { x: 0, y: 0.3, width: 0.6, height: 0.7 });
});

test('resize never shrinks a bbox below the backend minimum size', () => {
  const origin = { x: 0.2, y: 0.3, width: 0.4, height: 0.3 };
  const resized = resizeBBox(origin, 'nw', 1, 1);
  closeTo(resized.width, MIN_BBOX_SIZE);
  closeTo(resized.height, MIN_BBOX_SIZE);
  closeTo(resized.x + resized.width, origin.x + origin.width);
  closeTo(resized.y + resized.height, origin.y + origin.height);
});

test('bbox replacement changes only the target hazard object', () => {
  const first = { id: 'H001', bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, title: 'first' };
  const second = { id: 'H002', bbox: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }, title: 'second' };
  const corrected = { x: 0.5, y: 0.5, width: 0.3, height: 0.3 };
  const original = [first, second];
  const next = replaceBBoxById(original, second.id, corrected);

  assert.notEqual(next, original);
  assert.equal(next[0], first);
  assert.notEqual(next[1], second);
  assert.deepEqual(next[1].bbox, corrected);
  assert.deepEqual(first.bbox, { x: 0.1, y: 0.1, width: 0.2, height: 0.2 });
});
