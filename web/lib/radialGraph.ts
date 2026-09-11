/**
 * 定级规则知识图谱 —— 径向「圆球」树布局。
 * 根节点在圆心，子节点按层级分布在不同半径的同心环上；
 * 支持展开 / 收回：仅展开节点的子节点可见，叶子节点为规则编码。
 * 全景保持环形结构；缩放时逐步降低节点的相对占位，显露密集分支。
 */
import type { GradingRule } from '../../shared/types';

export type RKind = 'root' | 'level' | 'cat' | 'rule';

export interface RuleTreeNode {
  key: string;
  kind: RKind;
  /** 完整标签 */
  label: string;
  /** 圆球内显示的短标签 */
  short: string;
  /** 完整信息（tooltip / 详情） */
  full: string;
  level?: string;
  rule?: GradingRule;
  parent: string | null;
  children: string[];
  depth: number;
}

export interface RadialGraphData {
  nodes: Record<string, RuleTreeNode>;
  rootKey: string;
}

export const RING_GAP = 158;
export const RADIUS_BY_KIND: Record<RKind, number> = { root: 52, level: 34, cat: 25, rule: 21 };

function shortOf(label: string, max = 6): string {
  return label.length <= max ? label : label.slice(0, max - 1) + '…';
}

/** 从规则构建层次树（去重、父指针、深度）。 */
export function buildTree(rules: GradingRule[]): RadialGraphData {
  const nodes: Record<string, RuleTreeNode> = {};
  const ensure = (key: string, kind: RKind, label: string, short: string, full: string, level: string | undefined, parent: string | null): RuleTreeNode => {
    let n = nodes[key];
    if (!n) {
      n = { key, kind, label, short, full, level, parent, children: [], depth: 0 };
      nodes[key] = n;
    }
    return n;
  };
  const link = (parentKey: string, childKey: string) => {
    const p = nodes[parentKey];
    if (p && !p.children.includes(childKey)) p.children.push(childKey);
  };

  ensure('root', 'root', '定级规则库', '规则库', `定级规则库 · ${rules.length} 条判定规则`, undefined, null);

  for (const rule of rules) {
    const levelKey = `lv:${rule.level}`;
    ensure(
      levelKey,
      'level',
      `${rule.level} · ${rule.levelName}`,
      rule.level === 'a' ? 'A类' : 'B类',
      `${rule.levelName}（${rule.level}）`,
      rule.level,
      'root'
    );
    link('root', levelKey);

    let parent = levelKey;
    for (let i = 0; i < rule.categories.length; i += 1) {
      const prefix = rule.categories.slice(0, i + 1);
      const key = `cat:${rule.level}:${prefix.join('|')}`;
      ensure(key, 'cat', rule.categories[i], shortOf(rule.categories[i]), prefix.join(' / '), rule.level, parent);
      link(parent, key);
      parent = key;
    }

    const ruleKey = `rule:${rule.code}`;
    const ruleNode = ensure(ruleKey, 'rule', rule.code, shortOf(rule.code, 7), rule.text, rule.level, parent);
    ruleNode.rule = rule;
    link(parent, ruleKey);
  }

  // BFS 深度
  const queue = [nodes['root']];
  const seen = new Set<string>(['root']);
  while (queue.length) {
    const n = queue.shift()!;
    for (const c of n.children) {
      const child = nodes[c];
      if (!child || seen.has(c)) continue;
      seen.add(c);
      child.depth = n.depth + 1;
      queue.push(child);
    }
  }

  return { nodes, rootKey: 'root' };
}

export interface PlacedNode {
  key: string;
  kind: RKind;
  x: number;
  y: number;
  r: number;
  depth: number;
}

export interface RadialLayoutResult {
  nodes: PlacedNode[];
  edges: Array<{ fromKey: string; toKey: string; fx: number; fy: number; tx: number; ty: number }>;
  maxRadius: number;
}

/** 依据展开状态计算可见子节点。 */
export function shownChildren(tree: RadialGraphData, key: string, expanded: Set<string>): string[] {
  const n = tree.nodes[key];
  if (!n || !n.children.length) return [];
  if (n.kind === 'root') return n.children; // 根球始终展开
  return expanded.has(key) ? n.children : [];
}

/** 计算所有可见节点的父链（含自身），用于搜索自动展开路径。 */
export function chainToRoot(tree: RadialGraphData, key: string): string[] {
  const chain: string[] = [];
  let cur: string | null = key;
  for (let guard = 0; guard < 40 && cur; guard += 1) {
    chain.push(cur);
    cur = tree.nodes[cur]?.parent ?? null;
  }
  return chain;
}

/**
 * 径向布局：按子树叶子数分配扇区，保留稳定的同心环与放射形态。
 * 只布局「可见」（父节点已展开）的节点，返回圆球坐标。
 */
export function computeRadialLayout(tree: RadialGraphData, expanded: Set<string>): RadialLayoutResult {
  const root = tree.nodes[tree.rootKey];
  const memoWeight = new Map<string, number>();

  const leafWeight = (key: string): number => {
    if (memoWeight.has(key)) return memoWeight.get(key)!;
    const kids = shownChildren(tree, key, expanded);
    const w = kids.length ? kids.reduce((s, k) => s + leafWeight(k), 0) : 1;
    memoWeight.set(key, w);
    return w;
  };

  const placedMap = new Map<string, PlacedNode>();
  const assign = (key: string, a0: number, a1: number) => {
    const n = tree.nodes[key];
    if (!n) return;
    const radius = RING_GAP * n.depth;
    const angle = (a0 + a1) / 2;
    placedMap.set(key, {
      key,
      kind: n.kind,
      x: radius * Math.cos(angle),
      y: radius * Math.sin(angle),
      r: RADIUS_BY_KIND[n.kind],
      depth: n.depth,
    });

    const kids = shownChildren(tree, key, expanded);
    if (!kids.length) return;
    const total = kids.reduce((s, k) => s + leafWeight(k), 0);
    const util = a1 - a0;
    let cur = a0;
    for (const k of kids) {
      const span = util * (leafWeight(k) / total);
      assign(k, cur, cur + span);
      cur += span;
    }
  };

  assign(root.key, -Math.PI, Math.PI);

  const nodes = [...placedMap.values()];
  const edges: Array<{ fromKey: string; toKey: string; fx: number; fy: number; tx: number; ty: number }> = [];
  for (const n of nodes) {
    for (const k of shownChildren(tree, n.key, expanded)) {
      const c = placedMap.get(k);
      if (c) edges.push({ fromKey: n.key, toKey: k, fx: n.x, fy: n.y, tx: c.x, ty: c.y });
    }
  }

  return { nodes, edges, maxRadius: Math.max(80, ...nodes.map((node) => Math.hypot(node.x, node.y) + node.r + 16)) };
}

/** 屏幕上的圆球温和变大（最多 3 倍），世界坐标中的占位单调减小。 */
export function semanticNodeScale(magnification: number): number {
  const m = Math.max(1, magnification);
  return Math.min(3, Math.sqrt(m)) / m;
}

/** 根据实际最近邻计算最大倍率，包含描边和展开标记的安全距离。 */
export function graphMaxMagnification(nodes: readonly PlacedNode[]): number {
  let required = 12;
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const distance = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
      required = Math.max(required, 3 * (nodes[i].r + nodes[j].r + 24) / Math.max(distance, 0.001));
    }
  }
  return Math.ceil(required);
}

export interface GraphPoint { x: number; y: number }
export const MAX_NODE_DRAG = 100;

/** 节点在原位置附近移动；沿拖动路径限制位移，避免与其他圆球重叠。 */
export function constrainNodeDrag(origin: PlacedNode, target: GraphPoint, current: GraphPoint, nodes: readonly PlacedNode[], gap = 12): GraphPoint {
  if (origin.kind === 'root') return { x: origin.x, y: origin.y };
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const scale = Math.min(1, MAX_NODE_DRAG / (Math.hypot(dx, dy) || 1));
  const end = { x: origin.x + dx * scale, y: origin.y + dy * scale };
  const vx = end.x - current.x;
  const vy = end.y - current.y;
  const lengthSquared = vx * vx + vy * vy;
  let fraction = 1;
  if (lengthSquared > 0) {
    for (const node of nodes) {
      if (node.key === origin.key) continue;
      const x = current.x - node.x;
      const y = current.y - node.y;
      const clearance = origin.r + node.r + gap;
      const b = 2 * (x * vx + y * vy);
      const c = x * x + y * y - clearance * clearance;
      const discriminant = b * b - 4 * lengthSquared * c;
      if (discriminant < 0 || b >= 0) continue;
      const entry = (-b - Math.sqrt(discriminant)) / (2 * lengthSquared);
      if (entry >= 0 && entry < fraction) fraction = Math.max(0, entry - 0.001);
    }
  }
  return { x: current.x + vx * fraction, y: current.y + vy * fraction };
}
