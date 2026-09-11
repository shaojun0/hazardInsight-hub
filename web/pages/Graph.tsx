import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GradingRule } from '../../shared/types';
import {
  IconDownload,
  IconFileText,
  IconMinus,
  IconNetwork,
  IconPlus,
  IconRefresh,
  IconUpload,
  IconX,
} from '../components/icons';
import { clearRulesApi, fetchRules, importDemoRules, importDemoRulesCsv, importRulesFile } from '../api/rules';
import {
  buildTree,
  chainToRoot,
  computeRadialLayout,
  constrainNodeDrag,
  graphMaxMagnification,
  semanticNodeScale,
  shownChildren,
  type GraphPoint,
  type RadialLayoutResult,
  type RuleTreeNode,
} from '../lib/radialGraph';

/* 圆球图谱固定配色（自包含，便于导出 PNG） */
const C = {
  root: '#152b48',
  levelA: '#c62828',
  levelB: '#1565c0',
  cat: '#f8fbff',
  catStroke: '#adc7e6',
  rule: '#1668dc',
  text: '#334155',
  edge: '#a4bddb',
  star: '#e0342f',
  accent: '#0a84ff',
  bg: '#ffffff',
  font: `-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Segoe UI", Arial, sans-serif`,
};

export function Graph() {
  const [rules, setRules] = useState<GradingRule[]>([]);
  const [level, setLevel] = useState('全部');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['root']));
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [matchKeys, setMatchKeys] = useState<Set<string>>(() => new Set());
  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 });
  const [positions, setPositions] = useState<{ layout: RadialLayoutResult | null; points: Record<string, GraphPoint> }>({ layout: null, points: {} });
  const [dragging, setDragging] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const gestureRef = useRef<{
    pointerId: number; key: string | null; start: GraphPoint; client: GraphPoint;
    camera: typeof camera; origin: GraphPoint; moved: boolean;
  } | null>(null);
  const [feedback, setFeedback] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const filteredRules = useMemo(
    () => (level === '全部' ? rules : rules.filter((r) => r.level === level)),
    [rules, level]
  );
  const tree = useMemo(() => buildTree(filteredRules), [filteredRules]);
  const baseLayout = useMemo(() => computeRadialLayout(tree, expanded), [tree, expanded]);
  const positionedLayout = useMemo(() => {
    const points = positions.layout === baseLayout ? positions.points : {};
    const nodes = baseLayout.nodes.map((node) => ({ ...node, ...points[node.key] }));
    const byKey = new Map(nodes.map((node) => [node.key, node]));
    return {
      ...baseLayout,
      nodes,
      edges: baseLayout.edges.map((edge) => ({ ...edge,
        fx: byKey.get(edge.fromKey)!.x, fy: byKey.get(edge.fromKey)!.y,
        tx: byKey.get(edge.toKey)!.x, ty: byKey.get(edge.toKey)!.y,
      })),
    };
  }, [baseLayout, positions]);
  const maxMagnification = useMemo(() => graphMaxMagnification(positionedLayout.nodes), [positionedLayout]);
  const magnification = 1 / camera.zoom;
  const nodeScale = semanticNodeScale(magnification);
  const layout = useMemo(() => ({ ...positionedLayout,
    nodes: positionedLayout.nodes.map((node) => ({ ...node, r: node.r * nodeScale })),
  }), [positionedLayout, nodeScale]);
  const selectedNode: RuleTreeNode | undefined = selectedKey ? tree.nodes[selectedKey] : undefined;
  const hoverPath = useMemo(() => new Set(hoverKey ? chainToRoot(tree, hoverKey) : []), [tree, hoverKey]);

  // 导入、重新载入和切换级别后直接呈现完整的环形全景。
  useEffect(() => {
    setExpanded(new Set(Object.values(tree.nodes).filter((node) => node.children.length).map((node) => node.key)));
    setSelectedKey(null);
    setHoverKey(null);
  }, [tree]);

  const reload = useCallback(async () => {
    const r = await fetchRules();
    setRules(r.data);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  /* 搜索：自动展开命中规则的父链并高亮 */
  useEffect(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      setMatchKeys(new Set());
      return;
    }
    const matched = new Set<string>();
    const ancestors = new Set<string>();
    for (const n of Object.values(tree.nodes)) {
      if (n.kind !== 'rule' || !n.rule) continue;
      const r = n.rule;
      const hay = `${r.code} ${r.text} ${r.categoryPath} ${r.levelName}`.toLowerCase();
      if (hay.includes(q)) {
        matched.add(n.key);
        chainToRoot(tree, n.key).forEach((k) => ancestors.add(k));
      }
    }
    setMatchKeys(matched);
    if (ancestors.size) setExpanded((prev) => new Set([...prev, ...ancestors]));
  }, [query, tree]);

  const pathSet = useMemo(() => {
    if (!matchKeys.size) return null;
    const s = new Set<string>();
    matchKeys.forEach((k) => chainToRoot(tree, k).forEach((x) => s.add(x)));
    return s;
  }, [matchKeys, tree]);

  const onLoad = useCallback(async (file: File | undefined | null) => {
    if (!file) return;
    try {
      const r = await importRulesFile(file);
      setRules(r.data);
      setFeedback(`导入成功（${file.name} · ${r.format?.toUpperCase() ?? ''}）：新增 ${r.added} 条，当前共 ${r.total} 条。`);
    } catch (e) {
      setFeedback(`导入失败：${(e as Error).message}（TXT：「级别 类目… 编码 内容」；CSV：「级别,类目…,编码,内容」）`);
    }
  }, []);

  const loadDemo = async (csv: boolean) => {
    try {
      const r = csv ? await importDemoRulesCsv() : await importDemoRules();
      setRules(r.data);
      setFeedback(`已载入演示示例（${csv ? 'CSV' : 'TXT'}）：新增 ${r.added} 条，当前共 ${r.total} 条。`);
    } catch {
      setFeedback('载入演示示例失败');
    }
  };

  const clearAll = async () => {
    const r = await clearRulesApi();
    setRules(r.data);
    setSelectedKey(null);
    setFeedback('已清空导入的判定规则。');
  };

  const handleNodeClick = useCallback((key: string) => {
    const n = tree.nodes[key];
    if (!n) return;
    if (n.children.length) {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    }
    setSelectedKey(key === selectedKey ? null : key);
  }, [tree, selectedKey]);

  const expandAll = () => {
    setExpanded(new Set(Object.values(tree.nodes).filter((n) => n.children.length).map((n) => n.key)));
  };
  const collapseAll = () => {
    setExpanded(new Set(['root']));
  };

  const fitRadius = baseLayout.maxRadius + 32;
  const fitGraph = useCallback(() => {
    setCamera({ x: 0, y: 0, zoom: 1 });
    setPositions({ layout: baseLayout, points: {} });
  }, [baseLayout]);

  useEffect(() => {
    gestureRef.current = null;
    setDragging(false);
    fitGraph();
  }, [fitGraph]);

  const clientToGraph = (clientX: number, clientY: number): GraphPoint | null => {
    const matrix = svgRef.current?.getScreenCTM();
    if (!matrix) return null;
    return new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
  };

  const clampCamera = useCallback((next: typeof camera) => {
    const limit = fitRadius * (1 + next.zoom * 0.8);
    return { ...next, x: Math.max(-limit, Math.min(limit, next.x)), y: Math.max(-limit, Math.min(limit, next.y)) };
  }, [fitRadius]);

  const zoomBy = useCallback((factor: number, anchor?: GraphPoint) => {
    setCamera((previous) => {
      const zoom = Math.min(2, Math.max(1 / maxMagnification, previous.zoom * factor));
      const ratio = zoom / previous.zoom;
      return clampCamera({ zoom,
        x: anchor ? anchor.x + (previous.x - anchor.x) * ratio : previous.x,
        y: anchor ? anchor.y + (previous.y - anchor.y) * ratio : previous.y,
      });
    });
  }, [clampCamera, maxMagnification]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (gestureRef.current) return;
      const anchor = clientToGraph(event.clientX, event.clientY);
      zoomBy(Math.exp(Math.max(-100, Math.min(100, event.deltaY)) * 0.002), anchor ?? undefined);
    };
    svg.addEventListener('wheel', wheel, { passive: false });
    return () => svg.removeEventListener('wheel', wheel);
  }, [zoomBy, rules.length]);

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || gestureRef.current) return;
    const point = clientToGraph(event.clientX, event.clientY);
    if (!point) return;
    const key = (event.target as Element).closest('[data-node-key]')?.getAttribute('data-node-key') ?? null;
    const node = layout.nodes.find((item) => item.key === key);
    gestureRef.current = {
      pointerId: event.pointerId, key, start: point, client: { x: event.clientX, y: event.clientY },
      camera, origin: node ? { x: node.x, y: node.y } : { x: camera.x, y: camera.y }, moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const dx = event.clientX - gesture.client.x;
    const dy = event.clientY - gesture.client.y;
    if (!gesture.moved && Math.hypot(dx, dy) < 4) return;
    gesture.moved = true;
    setDragging(true);
    if (gesture.key === null) {
      const rect = event.currentTarget.getBoundingClientRect();
      const scale = fitRadius * gesture.camera.zoom * 2 / Math.min(rect.width, rect.height);
      setCamera(clampCamera({ ...gesture.camera, x: gesture.origin.x - dx * scale, y: gesture.origin.y - dy * scale }));
    } else {
      const point = clientToGraph(event.clientX, event.clientY);
      const origin = baseLayout.nodes.find((node) => node.key === gesture.key);
      const current = layout.nodes.find((node) => node.key === gesture.key);
      if (!point || !origin || !current) return;
      const next = constrainNodeDrag({ ...origin, r: current.r }, {
        x: gesture.origin.x + point.x - gesture.start.x,
        y: gesture.origin.y + point.y - gesture.start.y,
      }, current, layout.nodes, 12 * nodeScale);
      setPositions((previous) => ({ layout: baseLayout, points: {
        ...(previous.layout === baseLayout ? previous.points : {}), [origin.key]: next,
      } }));
    }
  };

  const finishPointer = (event: React.PointerEvent<SVGSVGElement>, cancelled = false) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!cancelled && !gesture.moved && gesture.key) handleNodeClick(gesture.key);
  };

  const half = fitRadius * camera.zoom;
  const viewBox = `${camera.x - half} ${camera.y - half} ${half * 2} ${half * 2}`;

  const exportPng = () => {
    const outerG = document.getElementById('graph-outer');
    if (!outerG) return;
    const R = Math.max(80, ...layout.nodes.map((node) => Math.hypot(node.x, node.y) + node.r + 16));
    const half = R + 24;
    const clone = outerG.cloneNode(true) as SVGGElement;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.setAttribute('viewBox', `${-half} ${-half} ${half * 2} ${half * 2}`);
    svg.setAttribute('width', String(half * 2));
    svg.setAttribute('height', String(half * 2));
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('x', String(-half));
    bg.setAttribute('y', String(-half));
    bg.setAttribute('width', String(half * 2));
    bg.setAttribute('height', String(half * 2));
    bg.setAttribute('fill', C.bg);
    svg.appendChild(bg);
    svg.appendChild(clone);
    const xml = new XMLSerializer().serializeToString(svg);
    const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ratio = Math.min(2, 2200 / Math.max(1, half * 2));
      canvas.width = Math.round(half * 2 * ratio);
      canvas.height = Math.round(half * 2 * ratio);
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = C.bg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const a = document.createElement('a');
        a.href = canvas.toDataURL('image/png');
        a.download = '知识图谱-定级规则.png';
        a.click();
        setFeedback('知识图谱已导出为 PNG。');
      }
      URL.revokeObjectURL(url);
    };
    img.onerror = () => { URL.revokeObjectURL(url); setFeedback('导出失败'); };
    img.src = url;
  };

  const hasFocus = Boolean(query.trim()) && pathSet !== null;

  return (
    <div className="page">
      <div className="page-head graph-page-head" style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <h1>知识图谱</h1>
          <div className="sub">从规则全景到判定细节，探索安全知识之间的关联。支持 TXT / CSV 导入、搜索定位与图像导出。</div>
        </div>
        <div className="row">
          <button className="btn btn-primary-soft" onClick={() => fileRef.current?.click()}>
            <IconUpload size={14} />
            导入 TXT / CSV
          </button>
          <button className="btn btn-outline" onClick={() => void loadDemo(false)}>
            <IconFileText size={14} />
            载入示例 TXT
          </button>
          <button className="btn btn-outline" onClick={() => void loadDemo(true)}>
            <IconFileText size={14} />
            载入示例 CSV
          </button>
          <button className="btn btn-danger-soft" onClick={() => void clearAll()}>
            <IconX size={14} />
            清空
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.csv,text/plain,text/csv,application/csv"
            style={{ display: 'none' }}
            onChange={(e) => {
              void onLoad(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>
      </div>

      {feedback && (
        <div className="disclaimer-bar" style={{ marginBottom: 16, color: 'var(--text-2)' }}>
          <IconNetwork size={13} />
          {feedback}
        </div>
      )}

      {rules.length === 0 ? (
        <div className="card card-pad">
          <div className="state-block">
            <div className="big-ico"><IconNetwork size={28} /></div>
            <h3>尚未导入判定规则，先载入演示数据即可生成知识图谱</h3>
            <p>
              TXT 格式：<b className="mono">级别 类目… 编码 判定内容</b>；CSV 格式：<b className="mono">级别,类目…,编码,判定内容</b>（支持表头）。
            </p>
            <div className="state-actions">
              <button className="btn btn-primary" onClick={() => void loadDemo(false)}>载入示例 TXT</button>
              <button className="btn btn-primary-soft" onClick={() => void loadDemo(true)}>载入示例 CSV</button>
              <button className="btn btn-outline" onClick={() => fileRef.current?.click()}>选择文件导入</button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="card card-pad" style={{ marginBottom: 16 }}>
            <div className="filter-bar" style={{ marginBottom: 0 }}>
              <input
                className="input"
                style={{ flex: 1, minWidth: 220 }}
                placeholder="搜索：编码 / 判定内容 / 类目（自动展开命中路径并高亮）"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <select className="select" style={{ width: 140 }} value={level} onChange={(e) => setLevel(e.target.value)}>
                <option value="全部">全部级别</option>
                <option value="a">基础管理类（a）</option>
                <option value="b">现场作业类（b）</option>
              </select>
              <span className="chip">节点 {layout.nodes.length}</span>
              <span className="chip">连线 {layout.edges.length}</span>
              <div style={{ flex: 1 }} />
              <button className="btn btn-outline btn-sm" onClick={() => expandAll()}><IconPlus size={13} />全部展开</button>
              <button className="btn btn-outline btn-sm" onClick={() => collapseAll()}><IconMinus size={13} />全部收回</button>
              <button className="btn btn-outline btn-sm" disabled={magnification >= maxMagnification - 0.001} onClick={() => zoomBy(0.8)}><IconPlus size={13} />放大</button>
              <button className="btn btn-outline btn-sm" disabled={camera.zoom >= 2} onClick={() => zoomBy(1.25)}><IconMinus size={13} />缩小</button>
              <button className="btn btn-outline btn-sm" onClick={fitGraph}><IconRefresh size={13} />适配</button>
              <button className="btn btn-primary-soft btn-sm" onClick={exportPng}><IconDownload size={13} />导出 PNG</button>
            </div>
          </div>

          <div className="graph-workspace">
            <div className="card" style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
              <div className="graph-presentation-bar">
                <div><span className="graph-status-dot" /><b>规则关系全景</b><span className="graph-view-label">{magnification <= 1.05 ? '全景视图' : '细节视图'}</span></div>
                <div className="graph-zoom-control">
                  <span>全景</span>
                  <input type="range" aria-label="图谱缩放" min={0} max={100} step={0.1}
                    value={Math.max(0, Math.log(magnification) / Math.log(maxMagnification) * 100)}
                    onChange={(event) => zoomBy((1 / Math.pow(maxMagnification, Number(event.target.value) / 100)) / camera.zoom)} />
                  <span>细节</span><output>{magnification.toFixed(1)}×</output>
                </div>
              </div>
              <div className="graph-viewport">
                {layout.nodes.length === 0 ? (
                  <div className="state-block" style={{ paddingTop: 120 }}>
                    <p>当前筛选下无可见节点，请切换级别或导入数据。</p>
                  </div>
                ) : (
                  <svg
                    ref={svgRef}
                    className={`graph-canvas${dragging ? ' is-dragging' : ''}`}
                    aria-label="可缩放和拖动的知识图谱"
                    width="100%"
                    height="100%"
                    viewBox={viewBox}
                    preserveAspectRatio="xMidYMid meet"
                    style={{ display: 'block' }}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={(event) => finishPointer(event)}
                    onPointerCancel={(event) => finishPointer(event, true)}
                    onLostPointerCapture={(event) => finishPointer(event, true)}
                  >
                    <g id="graph-outer">
                      <defs>
                        <radialGradient id="graph-root-fill" cx="30%" cy="25%" r="85%"><stop offset="0" stopColor="#345982" /><stop offset="1" stopColor="#132840" /></radialGradient>
                        <radialGradient id="graph-rule-fill" cx="30%" cy="25%" r="85%"><stop offset="0" stopColor="#3899ff" /><stop offset="1" stopColor="#1262d0" /></radialGradient>
                      </defs>
                      <g>
                        {layout.edges.map((e, i) => {
                          const on = !hasFocus || (pathSet !== null && pathSet.has(e.fromKey) && pathSet.has(e.toKey));
                          const highlighted = hoverPath.has(e.fromKey) && hoverPath.has(e.toKey);
                          const radius = (Math.hypot(e.fx, e.fy) + Math.hypot(e.tx, e.ty)) / 2;
                          const fromAngle = Math.atan2(e.fy, e.fx);
                          const toAngle = Math.atan2(e.ty, e.tx);
                          return (
                            <path
                              key={i}
                              d={`M ${e.fx} ${e.fy} C ${radius * Math.cos(fromAngle)} ${radius * Math.sin(fromAngle)}, ${radius * Math.cos(toAngle)} ${radius * Math.sin(toAngle)}, ${e.tx} ${e.ty}`}
                              fill="none" pointerEvents="none"
                              stroke={highlighted ? C.accent : C.edge}
                              strokeWidth={(highlighted ? 3 : 1.25) * nodeScale}
                              opacity={highlighted ? 1 : !on || (hoverKey && !highlighted) ? 0.1 : 0.6}
                            />
                          );
                        })}
                      </g>
                      <g>
                        {layout.nodes.map((p) => {
                          const n = tree.nodes[p.key];
                          if (!n) return null;
                          const dim = (hasFocus && pathSet !== null && !pathSet.has(n.key)) || (hoverKey !== null && !hoverPath.has(n.key));
                          const isMatch = hasFocus && matchKeys.has(n.key);
                          const isSel = selectedKey === n.key;
                          const hasKids = n.children.length > 0;
                          const isOpen = shownChildren(tree, n.key, expanded).length > 0;
                          const fill = n.kind === 'root' ? 'url(#graph-root-fill)' : n.kind === 'rule' ? 'url(#graph-rule-fill)' : kindFill(n);
                          const stroke = n.kind === 'rule' && n.rule?.starred ? C.star : isMatch || isSel ? C.accent : kindStroke(n);
                          const sw = isMatch || isSel ? 3 : n.kind === 'rule' && n.rule?.starred ? 2.2 : 1.2;
                          return (
                            <g key={p.key} data-node-key={p.key} opacity={dim ? 0.25 : 1}
                              onPointerEnter={() => { if (!gestureRef.current) setHoverKey(p.key); }}
                              onPointerLeave={() => setHoverKey(null)}
                              role="button" tabIndex={0} aria-label={n.label}
                              aria-expanded={hasKids ? isOpen : undefined}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); handleNodeClick(p.key); }
                              }}>
                              <title>
                                {n.label}
                                {n.full ? `\n${n.full}` : ''}
                                {n.kind === 'rule' && n.rule?.starred ? '\n（强条）' : ''}
                                {hasKids ? (isOpen ? '\n（点击收回）' : '\n（点击展开）') : ''}
                              </title>
                              <circle cx={p.x} cy={p.y} r={p.r} fill={fill} stroke={stroke} strokeWidth={sw * nodeScale} />
                              {n.kind === 'root' && <circle cx={p.x} cy={p.y} r={p.r + 9 * nodeScale} fill="none" stroke="#93b9e8" strokeWidth={1.5 * nodeScale} />}
                              <text
                                x={p.x}
                                y={p.y}
                                textAnchor="middle"
                                dominantBaseline="central"
                                fontSize={nodeFont(n) * nodeScale}
                                fontWeight={n.kind === 'rule' ? 700 : 600}
                                fill={n.kind === 'cat' ? C.text : '#ffffff'}
                                style={{ pointerEvents: 'none' }}
                                fontFamily={C.font}
                              >
                                {n.short}
                              </text>
                              {hasKids && (
                                <g pointerEvents="none">
                                  <circle cx={p.x + p.r * 0.72} cy={p.y - p.r * 0.72} r={9 * nodeScale} fill={isOpen ? '#ffffff' : C.accent} stroke={C.accent} strokeWidth={1.6 * nodeScale} />
                                  <text
                                    x={p.x + p.r * 0.72}
                                    y={p.y - p.r * 0.72}
                                    textAnchor="middle"
                                    dominantBaseline="central"
                                    fontSize={12 * nodeScale}
                                    fontWeight={700}
                                    fill={isOpen ? C.accent : '#ffffff'}
                                    style={{ pointerEvents: 'none' }}
                                    fontFamily={C.font}
                                  >
                                    {isOpen ? '−' : '+'}
                                  </text>
                                </g>
                              )}
                            </g>
                          );
                        })}
                      </g>
                    </g>
                  </svg>
                )}
              </div>
              <div className="img-meta" style={{ padding: '0 14px 12px' }}>
                <span>点击展开 / 收回 · 滚轮缩放 · 拖动空白平移 · 拖动节点微调位置</span>
                <span>逐步放大消除重叠 · 适配恢复全景</span>
              </div>
            </div>

            <div className="graph-details">
              <div className="card card-pad" style={{ marginBottom: 16 }}>
                <b className="small" style={{ color: 'var(--navy)' }}>图例</b>
                <LegendRow color={C.root} label="定级规则库（圆心）" bright />
                <LegendRow color={C.levelA} label="a 基础管理类" bright />
                <LegendRow color={C.levelB} label="b 现场作业类" bright />
                <LegendRow color={C.cat} label="类目（层级）" stroke={C.catStroke} />
                <LegendRow color={C.rule} label="规则编码" bright star={C.star} starText="星=强条" />
                <p className="small muted" style={{ marginTop: 8, lineHeight: 1.7 }}>
                  导入后呈现完整环形全景。向右拖动缩放滑杆，逐步看清密集节点；最大倍率下节点完全分离。悬停高亮关联路径，拖动空白区域平移查看。
                </p>
              </div>

              <div className="card card-pad">
                <b className="small" style={{ color: 'var(--navy)' }}>节点详情</b>
                {selectedNode ? (
                  selectedNode.kind === 'rule' && selectedNode.rule ? (
                    <RuleDetail rule={selectedNode.rule} />
                  ) : (
                    <div className="small muted" style={{ marginTop: 8, lineHeight: 1.7 }}>
                      节点：<b>{selectedNode.label}</b>
                      {selectedNode.full && <br />}
                      {selectedNode.full}
                      {selectedNode.children.length > 0 && (
                        <>
                          <br />
                          下层子节点 {selectedNode.children.length} 个（{selectedNode.children.map((k) => tree.nodes[k]?.short).slice(0, 8).join(' / ')}
                          {selectedNode.children.length > 8 ? ' …' : ''}）
                        </>
                      )}
                    </div>
                  )
                ) : (
                  <div className="small muted" style={{ marginTop: 8, lineHeight: 1.7 }}>
                    点击图谱中的<b>圆球</b>：含子节点的球展开 / 收回其下层，规则球查看判定内容。
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function kindFill(n: RuleTreeNode): string {
  if (n.kind === 'root') return C.root;
  if (n.kind === 'level') return n.level === 'a' ? C.levelA : C.levelB;
  if (n.kind === 'rule') return C.rule;
  return C.cat;
}
function kindStroke(n: RuleTreeNode): string {
  if (n.kind === 'cat') return C.catStroke;
  if (n.kind === 'rule') return '#e3efff';
  if (n.kind === 'level') return n.level === 'a' ? C.levelA : C.levelB;
  return C.root;
}
function nodeFont(n: RuleTreeNode): number {
  if (n.kind === 'root') return 14;
  if (n.kind === 'level') return 12.5;
  return Math.min(11, (n.kind === 'rule' ? 34 : 42) / Math.max(1, n.short.length * (n.kind === 'rule' ? 0.65 : 1)));
}

function LegendRow({
  color,
  label,
  bright,
  stroke,
  star,
  starText,
}: {
  color: string;
  label: string;
  bright?: boolean;
  stroke?: string;
  star?: string;
  starText?: string;
}) {
  return (
    <div className="row" style={{ marginTop: 8, gap: 8 }}>
      <span style={{ width: 20, height: 20, borderRadius: 10, background: color, border: stroke ? `1.5px solid ${stroke}` : star ? `2px solid ${star}` : 'none', flex: 'none' }} />
      <span className="small" style={{ color: 'var(--text-2)' }}>
        {label}
        {star && <span className="small muted" style={{ marginLeft: 6 }}>{starText}</span>}
      </span>
    </div>
  );
}

function RuleDetail({ rule }: { rule: GradingRule }) {
  return (
    <div style={{ marginTop: 10 }}>
      <div className="row" style={{ gap: 8, marginBottom: 8 }}>
        <span className="mono" style={{ fontWeight: 800, color: rule.starred ? C.star : 'var(--primary-700)' }}>
          {rule.code}
        </span>
        {rule.starred && <span className="chip" style={{ color: '#fff', background: C.star, borderColor: C.star }}>强条 *</span>}
        <span className={`tag ${rule.level === 'a' ? 'tag-general' : 'tag-nuclear'}`}>{rule.levelName}</span>
      </div>
      <div className="small muted" style={{ lineHeight: 1.7 }}>级别：{rule.levelName}</div>
      <div className="small muted" style={{ lineHeight: 1.7 }}>类目：{rule.categoryPath || '—'}</div>
      <div className="small" style={{ color: 'var(--text-2)', lineHeight: 1.8, marginTop: 6 }}>{rule.text}</div>
    </div>
  );
}
