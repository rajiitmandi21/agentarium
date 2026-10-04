// ─────────────────────────────────────────────────────────────────────────
// Atlas — Map lens
//   Default = CRITICAL PATH hero: "these N nodes gate X% of remaining work,"
//   ranked on impactScore / dependents (the engine fields). The full-topology
//   node-graph is the secondary "Topology" drill — never the landing state.
//   Nodes recolored to module hues; status = thin stoplight ring; size = impact.
// ─────────────────────────────────────────────────────────────────────────

const NODE_R = 17;
const ROW_H = 60;
const COL_W = 96;
const SUB_COLS = 2;
const LANE_W = 250;
const LANE_PAD = 28;
const HEADER_H = 54;
const TOP_PAD = 64;

// G12c: derived mirror edges (`blocks` mirrors blocked_by, `implements` mirrors
// linked_to_plan) are excluded from degree/metrics in the engine — exclude them
// from the drawn edge set too, so one relationship renders as ONE curve (the
// red blocked_by direction) instead of two overlapping ones.
const ATLAS_MIRROR_EDGES = new Set(["blocks", "implements"]);

function nodeIsRisky(n) {
  return (n.risk && n.risk.length) || n.verdictState === "needs-review" || n.verdictState === "rejected" || n.status === "blocked";
}
function nodeRadius(n) {
  if (n.type === "role") return NODE_R;
  return NODE_R + Math.min(9, (n.affects || 0) * 1.6);
}

function atlasLayout(index, { showAll, filters, phases }) {
  const { nodes, edges, byId } = index;
  function passesFilter(n) {
    if (filters.phase.size && n.phase && !filters.phase.has(n.phase)) return false;
    if (filters.type.size && !filters.type.has(n.type)) return false;
    if (filters.status.size && n.type === "task" && !filters.status.has(n.status)) return false;
    if (filters.owner.size && n.ownerId && !filters.owner.has(n.ownerId)) return false;
    if (filters.owner.size && !n.ownerId && n.type !== "role") return false;
    return true;
  }
  const riskyIds = new Set(nodes.filter(n => n.type !== "phase" && nodeIsRisky(n)).map(n => n.id));
  const keep = new Set(riskyIds);
  for (const e of edges) {
    if (e.type === "belongs_to_phase") continue;
    if (byId[e.from]?.type === "role" || byId[e.to]?.type === "role") continue;
    if (riskyIds.has(e.from)) keep.add(e.to);
    if (riskyIds.has(e.to)) keep.add(e.from);
  }
  function inScope(n) { if (showAll) return true; if (n.type === "role") return true; return keep.has(n.id); }
  const visible = nodes.filter(n => n.type !== "phase" && passesFilter(n) && inScope(n));
  const visibleIds = new Set(visible.map(n => n.id));

  const phaseOrder = phases.map(p => p.id);
  const laneIds = [...phaseOrder, "__roles__"];
  const laneX = {};
  laneIds.forEach((lid, i) => { laneX[lid] = i * LANE_W; });
  const pos = {};
  const TYPE_ORDER = ["plan", "decision", "message", "task"];
  let maxY = 0;
  for (const pid of phaseOrder) {
    const laneNodes = visible.filter(n => n.phase === pid && n.type !== "role");
    laneNodes.sort((a, b) => { const ta = TYPE_ORDER.indexOf(a.type), tb = TYPE_ORDER.indexOf(b.type); if (ta !== tb) return ta - tb; return a.id.localeCompare(b.id); });
    laneNodes.forEach((n, i) => {
      const col = i % SUB_COLS, row = Math.floor(i / SUB_COLS);
      pos[n.id] = { x: laneX[pid] + LANE_PAD + col * COL_W + NODE_R, y: TOP_PAD + HEADER_H + row * ROW_H };
      maxY = Math.max(maxY, pos[n.id].y);
    });
  }
  const roleNodes = visible.filter(n => n.type === "role");
  roleNodes.sort((a, b) => a.id.localeCompare(b.id));
  roleNodes.forEach((n, i) => {
    pos[n.id] = { x: laneX["__roles__"] + LANE_PAD + (i % 2) * COL_W + NODE_R, y: TOP_PAD + HEADER_H + Math.floor(i / 2) * ROW_H };
    maxY = Math.max(maxY, pos[n.id].y);
  });
  const vEdges = edges.filter(e => e.type !== "belongs_to_phase" && visibleIds.has(e.from) && visibleIds.has(e.to));
  const width = laneIds.length * LANE_W;
  const height = Math.max(maxY + ROW_H + 40, 520);
  return { pos, visible, vEdges, visibleIds, laneX, laneIds, width, height };
}

function ringClassFor(n) {
  if (n.type === "task") return n.status;
  const v = n.verdictState || n.verdict;
  if (v === "rejected" || v === "blocked") return "blocked";
  if (v === "needs-review" || v === "in-test") return "in_progress";
  if (v === "done" || v === "approved" || v === "tested") return "completed";
  return "todo";
}
function riskBadgeFor(n) {
  if (n.verdictState === "rejected" || n.pmStatus === "rejected") return "rejected";
  if (n.risk && (n.risk.includes("stale-severe") || n.risk.includes("stale"))) return "stale";
  if (n.risk && n.risk.includes("bug")) return "bug";
  if (n.verdictState === "needs-review" || n.pmStatus === "needs-review") return "needs-review";
  return null;
}

// ════════════════════ CRITICAL PATH (Map hero) ═════════════════════════════
function CriticalPathView({ index, onSelect, onTrace, onOpenArtifact }) {
  // G3/C4: "gates downstream work" means holding up OPEN tasks via `blocks`
  // edges. dependents is exactly the transitive blocksAdj closure (tasks only),
  // so plans/messages/decisions never qualify; intersecting with the open-task
  // set keeps a blocker whose chain has fully completed from posing as a gate.
  const openTaskSet = new Set(index.nodes.filter(n => n.type === "task" && n.status !== "completed").map(n => n.id));
  const blockers = index.nodes
    .map(n => {
      if (n.type !== "task" || !(n.dependents || []).length) return null;
      const open = n.dependents.filter(d => openTaskSet.has(d));
      return open.length ? { node: n, open } : null;
    })
    .filter(Boolean)
    .sort((a, b) => (b.open.length - a.open.length) || (b.node.impactScore - a.node.impactScore));

  const covered = new Set();
  blockers.forEach(b => b.open.forEach(d => covered.add(d)));
  const pct = Math.min(100, Math.round((covered.size / Math.max(1, openTaskSet.size)) * 100));

  return (
    <div className="atlas-work">
      <div className="cp-scroll">
        <div className="cp-inner">
          {blockers.length === 0 ? (
            <div className="atlas-state"><div className="atlas-state-card">
              <div className="as-ico"><AtlasGlyph name="check" size={26} /></div>
              <h3>Nothing is gating downstream work</h3>
              <p>No `blocks` dependencies are live in the current scope. When a blocker appears, the chain it holds up surfaces here first — ranked by impact.</p>
              <div className="as-cta"><button className="btn" onClick={() => onTrace(null)}><AtlasGlyph name="graph" size={14} /> Open the topology graph</button></div>
            </div></div>
          ) : (
            <>
              <div className="cp-headline">
                <div className="cp-stat"><span className="cp-n">{blockers.length}</span><span className="cp-of">node{blockers.length === 1 ? "" : "s"}</span></div>
                <div className="cp-head-text">
                  gate <strong>{pct}%</strong> of remaining work — <span className="cp-sub">clear the top of this list and the most downstream tasks move at once.</span>
                </div>
              </div>
              <div className="cp-list">
                {blockers.map((b, i) => (
                  <CriticalCard key={b.node.id} node={b.node} open={b.open} rank={i + 1} index={index}
                                onSelect={() => onSelect(b.node.id)} onTrace={() => onTrace(b.node.id)}
                                onOpen={() => onOpenArtifact && onOpenArtifact(b.node)} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function CriticalCard({ node, open, rank, index, onSelect, onTrace, onOpen }) {
  const owner = node.ownerId ? roleById(node.ownerId) : null;
  // C4: the chain renders the OPEN tasks this node still holds up.
  const deps = (open || []).map(id => index.byId[id]).filter(Boolean);
  const shown = deps.slice(0, 5);
  const more = deps.length - shown.length;
  const ring = ringClassFor(node);
  const action = node.status === "blocked" ? "Unblock or escalate"
    : node.verdictState === "needs-review" ? "Route for verdict"
    : node.verdictState === "rejected" ? "Address rejection" : "Confirm it's moving";
  return (
    <div className="card cp-card" role="button" tabIndex={0}
         onClick={onSelect}
         onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }}>
      <div className="cp-rank">{rank}</div>
      <div className="cp-main">
        <div className="cp-top">
          <ArtifactChip kind={node.type} id={node.id} label={node.id} onClick={(e) => { e.stopPropagation(); onSelect(); }} />
          <span className={"tr-status " + ring} />
          {node.priority && <span className={"atlas-prio " + node.priority}>{node.priority.toUpperCase()}</span>}
        </div>
        <div className="cp-title">{node.title}</div>
        <div className="cp-chain">
          <span className="cp-chain-lab">blocks</span>
          <AtlasGlyph name="handoff" size={13} />
          {shown.map(d => <ArtifactChip key={d.id} kind={d.type} id={d.id} label={d.id} onClick={(e) => { e.stopPropagation(); onSelect(d.id); }} />)}
          {more > 0 && <span className="cp-more">+{more} more</span>}
        </div>
        <div className="cp-foot">
          {owner && <span className="atlas-owner"><RoleAvatar role={owner} /> {owner.id}</span>}
          <button className="cp-trace" onClick={(e) => { e.stopPropagation(); onTrace(); }}><AtlasGlyph name="graph" size={12} /> Trace in graph</button>
          <button className="cp-trace" onClick={(e) => { e.stopPropagation(); onOpen(); }}><AtlasGlyph name="open" size={12} /> {action}</button>
        </div>
      </div>
      <div className="cp-impact">
        <div className="ci-score">{node.impactScore}</div>
        <div className="ci-lab">impact</div>
        <div className="ci-affects"><ImpactBars n={node.affects} /> affects {node.affects}</div>
      </div>
    </div>
  );
}

// ════════════════════ TOPOLOGY GRAPH (drill) ═══════════════════════════════
function LegendButton() {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (!open) return;
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    function onKey(e) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div className="atlas-pop-wrap" ref={ref}>
      <button className={"mode-toggle" + (open ? " active" : "")} onClick={() => setOpen(o => !o)} aria-expanded={open} aria-label="Legend"><AtlasGlyph name="legend" size={14} /> Legend</button>
      {open && <div className="atlas-filter-pop" style={{ width: 260 }}><div className="atlas-filter-head"><span>Reading the map</span></div><div className="atlas-filter-body"><AtlasLegend /></div></div>}
    </div>
  );
}

function GraphView({ index, phases, selectedId, onSelect, showInferred, filters, embedded, auditIds }) {
  const auditing = !!(auditIds && auditIds.size);
  // While auditing, show every node so the low-coverage set is fully visible.
  const [showAll, setShowAll] = React.useState(false);
  React.useEffect(() => { if (auditing) setShowAll(true); }, [auditing]);
  const [view, setView] = React.useState({ x: 24, y: 0, k: 1 });
  const [tip, setTip] = React.useState(null);
  const svgRef = React.useRef(null);
  const drag = React.useRef(null);
  const layout = React.useMemo(() => atlasLayout(index, { showAll, filters, phases }), [index, showAll, filters, phases]);
  const { pos, visible, vEdges, laneIds, laneX, width, height } = layout;

  const neighborhood = React.useMemo(() => {
    if (!selectedId) return null;
    const set = new Set([selectedId]);
    for (const e of vEdges) { if (e.from === selectedId) set.add(e.to); if (e.to === selectedId) set.add(e.from); }
    return set;
  }, [selectedId, vEdges]);

  // G6: React attaches wheel listeners passively, so a synthetic onWheel +
  // preventDefault() is a no-op that spams console errors. Bind a native
  // non-passive wheel listener instead.
  React.useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    function onWheelNative(e) {
      e.preventDefault();
      const f = e.deltaY < 0 ? 1.12 : 0.89;
      setView(v => ({ ...v, k: Math.min(2.4, Math.max(0.4, v.k * f)) }));
    }
    el.addEventListener("wheel", onWheelNative, { passive: false });
    return () => el.removeEventListener("wheel", onWheelNative);
  }, []);
  function onDown(e) { if (e.target.closest(".gnode")) return; drag.current = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y }; }
  function onMove(e) { if (!drag.current) return; setView(v => ({ ...v, x: drag.current.ox + (e.clientX - drag.current.sx), y: drag.current.oy + (e.clientY - drag.current.sy) })); }
  function onUp() { drag.current = null; }
  function fit() { const wrap = svgRef.current?.parentElement; if (!wrap) return; const k = Math.min(1, (wrap.clientWidth - 40) / width); setView({ x: 24, y: 0, k }); }
  React.useEffect(() => { fit(); /* eslint-disable-next-line */ }, [width]);

  function edgePath(e) {
    const a = pos[e.from], b = pos[e.to]; if (!a || !b) return "";
    const dx = (b.x - a.x), dy = (b.y - a.y), mx = a.x + dx / 2, my = a.y + dy / 2;
    const bow = Math.abs(dx) > Math.abs(dy) ? -Math.min(60, Math.abs(dx) * 0.18) : Math.min(40, Math.abs(dy) * 0.2);
    return `M ${a.x} ${a.y} Q ${mx} ${my + bow} ${b.x} ${b.y}`;
  }
  function edgeClass(e) { let c = "gedge " + e.type; if (e.confidence === "inferred") c += " inferred"; if (selectedId) c += (e.from === selectedId || e.to === selectedId) ? " hot" : " dim"; return c; }

  const renderEdges = vEdges.filter(e => {
    if (ATLAS_MIRROR_EDGES.has(e.type)) return false; // G12c
    if (!showInferred && e.confidence === "inferred") return false;
    const roleEdge = (index.byId[e.from].type === "role" || index.byId[e.to].type === "role");
    if (roleEdge) { if (!selectedId) return false; return e.from === selectedId || e.to === selectedId; }
    return true;
  });

  return (
    <div className="graph-wrap">
      {auditing && (
        <div className="graph-audit-banner">
          <AtlasGlyph name="filter" size={13} />
          <strong>Auditing</strong> · {auditIds.size} low-coverage node{auditIds.size === 1 ? "" : "s"} highlighted (no owner · orphan · all-inferred). Solid = explicit, dashed = inferred.
        </div>
      )}
      <div className="graph-toolbar">
        <button className={"mode-toggle" + (!showAll ? " active" : "")} onClick={() => setShowAll(false)} title="Risky nodes + neighbors" aria-pressed={!showAll}><AtlasGlyph name="focus" size={13} /> Risky</button>
        <button className={"mode-toggle" + (showAll ? " active" : "")} onClick={() => setShowAll(true)} title="Every node" aria-pressed={showAll}><AtlasGlyph name="expand" size={13} /> All nodes</button>
        <LegendButton />
        <div className="graph-zoom">
          <button className="icon-btn" onClick={() => setView(v => ({ ...v, k: Math.min(2.4, v.k * 1.15) }))} title="Zoom in" aria-label="Zoom in"><AtlasGlyph name="plus" size={14} /></button>
          <button className="icon-btn" onClick={() => setView(v => ({ ...v, k: Math.max(0.4, v.k * 0.87) }))} title="Zoom out" aria-label="Zoom out"><AtlasGlyph name="minus" size={14} /></button>
          <button className="icon-btn" onClick={fit} title="Fit" aria-label="Fit graph to view"><AtlasGlyph name="fit" size={14} /></button>
        </div>
      </div>
      <svg ref={svgRef} className="graph-svg" onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}
           onClick={(e) => { if (!e.target.closest(".gnode")) onSelect(null); }}>
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {laneIds.map((lid, i) => {
            const ph = phases.find(p => p.id === lid);
            const active = ph && ph.status === "in_progress";
            const label = lid === "__roles__" ? "ROLES / CREWS" : (ph ? `${ph.key} · ${ph.name}` : lid);
            return (
              <g key={lid}>
                <rect className={"lane-band" + (active ? " active" : "")} x={laneX[lid]} y={TOP_PAD - 8} width={LANE_W - 12} height={height - TOP_PAD + 16} rx="10" />
                {i > 0 && <line className="lane-sep" x1={laneX[lid] - 6} y1={TOP_PAD - 8} x2={laneX[lid] - 6} y2={height - 24} />}
                <text className="lane-label" x={laneX[lid] + LANE_PAD - 4} y={TOP_PAD + 12}>{label}</text>
              </g>
            );
          })}
          {renderEdges.map(e => (
            <path key={e.id} className={edgeClass(e)} d={edgePath(e)}
                  onMouseEnter={() => { const a = pos[e.from], b = pos[e.to]; setTip({ x: view.x + ((a.x + b.x) / 2) * view.k, y: view.y + ((a.y + b.y) / 2) * view.k, type: ATLAS_EDGE_TYPES[e.type] || e.type, reason: e.reason, inferred: e.confidence === "inferred" }); }}
                  onMouseLeave={() => setTip(null)} />
          ))}
          {visible.map(n => {
            const pp = pos[n.id]; if (!pp) return null;
            const meta = ATLAS_NODE_TYPES[n.type] || ATLAS_NODE_TYPES.task;
            const hue = n.type === "role" ? n.hue : meta.hue;
            const dim = neighborhood && !neighborhood.has(n.id);
            const badge = riskBadgeFor(n), ring = ringClassFor(n), r = nodeRadius(n);
            const labelText = n.type === "role" ? n.meta.name : n.label;
            // Audit highlight (AG-P14.2 #29): flag low-coverage nodes; dim the rest.
            const audited = auditing && auditIds.has(n.id);
            const auditDim = auditing && !audited && n.type !== "role";
            return (
              <g key={n.id} className={"gnode" + (n.id === selectedId ? " sel" : "") + (dim ? " dim" : "") + (audited ? " audited" : "") + (auditDim ? " audit-dim" : "")} style={{ "--gn-hue": hue }} transform={`translate(${pp.x},${pp.y})`} onClick={() => onSelect(n.id)}>
                {atlasNodeShape(n.type, r)}
                {n.type !== "role" && <circle className={"gn-ring " + ring} cx="0" cy="0" r={r + 4} />}
                <text className="gn-ico" style={{ fontFamily: "var(--font-mono)", fontSize: n.type === "role" ? 11 : 9, fontWeight: 700 }} textAnchor="middle" dominantBaseline="central">{n.type === "role" ? n.meta.glyph : meta.code}</text>
                {badge && <circle className={"gn-badge " + badge} cx={r - 1} cy={-(r - 1)} r="5" />}
                <text className="gn-label" y={r + 18}>{labelText.length > 14 ? labelText.slice(0, 13) + "…" : labelText}</text>
              </g>
            );
          })}
        </g>
      </svg>
      {tip && <div className="edge-tip" style={{ left: tip.x, top: tip.y }}><span className="et-type">{tip.type}{tip.inferred && <span className="et-inf"> · inferred</span>}</span>{tip.reason}</div>}
      <div className="graph-hint">
        <span><strong>{visible.length}</strong> nodes · <strong>{renderEdges.length}</strong> edges{!showAll && " · risky subgraph"}</span>
        <span style={{ color: "var(--text-4)" }}>·</span>
        <span>node size = impact · <span style={{ color: "var(--st-blocked)" }}>red = blocks</span> · click to focus</span>
      </div>
    </div>
  );
}

// ════════════════════ MAP (wraps both submodes) ════════════════════════════
function MapView({ index, phases, selectedId, onSelect, showInferred, filters, mapMode, setMapMode, onOpenArtifact, auditIds }) {
  function trace(id) { setMapMode("graph"); if (id) onSelect(id); }
  return (
    <div className="atlas-work">
      <div className="atlas-submodes">
        <button className={"mode-toggle" + (mapMode === "critical" ? " active" : "")} onClick={() => setMapMode("critical")}><AtlasGlyph name="bolt" size={14} /> Critical path</button>
        <button className={"mode-toggle" + (mapMode === "graph" ? " active" : "")} onClick={() => setMapMode("graph")}><AtlasGlyph name="graph" size={14} /> Topology graph</button>
      </div>
      {mapMode === "critical"
        ? <CriticalPathView index={index} onSelect={onSelect} onTrace={trace} onOpenArtifact={onOpenArtifact} />
        : <GraphView index={index} phases={phases} selectedId={selectedId} onSelect={onSelect} showInferred={showInferred} filters={filters} auditIds={auditIds} />}
    </div>
  );
}

window.AtlasGraphView = GraphView;
window.AtlasMapView = MapView;
window.AtlasCriticalPathView = CriticalPathView;
