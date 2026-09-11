import assert from 'node:assert/strict';
import test from 'node:test';
import type { GradingRule } from '../../shared/types.js';
import { buildTree, computeRadialLayout, constrainNodeDrag, graphMaxMagnification, semanticNodeScale, RING_GAP, MAX_NODE_DRAG, type PlacedNode } from '../../web/lib/radialGraph.js';

test('radial overview preserves its rings and zoom monotonically removes overlap through the maximum', () => {
  const rules: GradingRule[] = Array.from({ length: 750 }, (_, index) => ({
    id: String(index), level: index < 50 ? 'a' : 'b', levelName: '测试类',
    categories: ['现场作业', `工程类别${index % 17}`, `分组${index % 51}`],
    categoryPath: '测试', code: `TEST${index}`, text: '规则', starred: false, source: 'imported', importedAt: '',
  }));
  const tree = buildTree(rules);
  const expanded = new Set(Object.keys(tree.nodes));
  const layout = computeRadialLayout(tree, expanded);
  assert.equal(layout.nodes.length, Object.keys(tree.nodes).length);
  assert.equal(layout.edges.length, layout.nodes.length - 1);
  const maxZoom = graphMaxMagnification(layout.nodes);
  for (let i = 0; i < layout.nodes.length; i += 1) {
    const node = layout.nodes[i];
    assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y));
    assert.ok(Math.hypot(node.x, node.y) + node.r < layout.maxRadius);
    assert.ok(Math.abs(Math.hypot(node.x, node.y) - RING_GAP * node.depth) < 1e-6, '全景保持同心环');
    for (const other of layout.nodes.slice(i + 1)) {
      const distance = Math.hypot(node.x - other.x, node.y - other.y);
      let previousOverlap = Infinity;
      for (const magnification of [1, 2, 4, 8, maxZoom]) {
        const scale = semanticNodeScale(magnification);
        const overlap = Math.max(0, (node.r + other.r + 24) * scale - distance);
        assert.ok(overlap <= previousOverlap + 1e-6, '放大过程中重叠只减不增');
        previousOverlap = overlap;
      }
      assert.ok(previousOverlap < 1e-6, `${node.key} overlaps ${other.key} at maximum`);
    }
  }
  assert.deepEqual(computeRadialLayout(tree, expanded), layout, '布局稳定可重现');
  assert.equal(computeRadialLayout(tree, new Set(['root'])).nodes.length, 3);
});

test('semantic node scaling is continuous at overview and detail limits', () => {
  assert.equal(semanticNodeScale(1), 1);
  assert.ok(Math.abs(semanticNodeScale(1.001) - 1) < 0.001);
  let previous = 1;
  for (let m = 1; m <= 200; m += 0.1) {
    const scale = semanticNodeScale(m);
    assert.ok(scale <= previous + 1e-9);
    assert.ok(scale * m <= 3 + 1e-9, '屏幕节点尺寸增长不超过三倍');
    previous = scale;
  }
});

test('node dragging stays near its origin and cannot cross a neighboring node', () => {
  const node: PlacedNode = { key: 'a', kind: 'rule', x: 0, y: 0, r: 21, depth: 1 };
  const other: PlacedNode = { ...node, key: 'b', x: 65 };
  const moved = constrainNodeDrag(node, { x: 200, y: 0 }, node, [node]);
  assert.equal(Math.hypot(moved.x, moved.y), MAX_NODE_DRAG);
  const blocked = constrainNodeDrag(node, { x: 200, y: 0 }, node, [node, other]);
  assert.ok(blocked.x < 12);
  assert.ok(Math.hypot(blocked.x - other.x, blocked.y - other.y) >= node.r + other.r + 12);
  const root = { ...node, kind: 'root' as const };
  assert.deepEqual(constrainNodeDrag(root, { x: 100, y: 100 }, root, [root]), { x: 0, y: 0 });
  assert.deepEqual(node, { key: 'a', kind: 'rule', x: 0, y: 0, r: 21, depth: 1 });
});
