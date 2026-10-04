// ─────────────────────────────────────────────────────────────────────────
// Atlas — shared parts (house-aligned)
//   node visual system · glyphs · lens selector (.view-tabs/.mode-toggle) ·
//   filters popover (.chip) · legend · trust signals · impact bars ·
//   search w/ dropdown · the Maestro command strip (agent-command, vision)
// ─────────────────────────────────────────────────────────────────────────

// Type → shape + compact code + the OWNING MODULE's hue.
const ATLAS_NODE_TYPES = {
  phase:    { code: "PHS", label: "Phase",    hue: 250 },
  task:     { code: "TSK", label: "Task",     hue: 260, module: "Khira" },
  plan:     { code: "PLN", label: "Plan",     hue: 195, module: "Planroom" },
  message:  { code: "MSG", label: "Message",  hue: 60,  module: "Courier" },
  decision: { code: "DEC", label: "Decision", hue: 20,  module: "Ledgers" },
  role:     { code: "ROL", label: "Role",     hue: 150, module: "Crews" },
  verdict:  { code: "VRD", label: "Verdict",  hue: 300, module: "Verdicts" },
  artifact: { code: "ART", label: "Artifact", hue: 130 },
};

const ATLAS_EDGE_TYPES = {
  belongs_to_phase:     "belongs to phase",
  assigned_to:          "assigned / authored",
  linked_to_plan:       "linked to plan",
  mentioned_in_message: "mentioned in message",
  blocked_by:           "blocked by",
  blocks:               "blocks",
  reviewed_by:          "reviewed by",
  decided_by:           "decided by",
  supersedes:           "supersedes",
  handoff_for:          "hands off task",
  handoff_accepted:     "handoff accepted",
};

function atlasNodeShape(type, r, extraClass) {
  const cls = "gn-shape" + (extraClass ? " " + extraClass : "");
  switch (type) {
    case "task":
      return <rect className={cls} x={-r} y={-r} width={2 * r} height={2 * r} rx={r * 0.32} />;
    case "plan":
      return <rect className={cls} x={-r * 0.85} y={-r} width={r * 1.7} height={2 * r} rx={3} />;
    case "message":
      return <circle className={cls} cx="0" cy="0" r={r} />;
    case "decision":
      return <rect className={cls} x={-r * 0.78} y={-r * 0.78} width={r * 1.56} height={r * 1.56} rx={3} transform="rotate(45)" />;
    case "role":
      return <circle className={cls} cx="0" cy="0" r={r} />;
    case "verdict": {
      const pts = [];
      for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; pts.push(`${(r * Math.cos(a)).toFixed(1)},${(r * Math.sin(a)).toFixed(1)}`); }
      return <polygon className={cls} points={pts.join(" ")} />;
    }
    case "phase":
      return <rect className={cls} x={-r * 1.4} y={-r * 0.8} width={r * 2.8} height={r * 1.6} rx={r * 0.8} />;
    default:
      return <circle className={cls} cx="0" cy="0" r={r} />;
  }
}

function AtlasNodeMark({ type, size = 22, hue }) {
  const meta = ATLAS_NODE_TYPES[type] || ATLAS_NODE_TYPES.task;
  const r = size * 0.4;
  const style = { "--gn-hue": hue != null ? hue : meta.hue };
  return (
    <svg width={size} height={size} viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`} className="li-node" style={style}>
      {atlasNodeShape(type, r)}
      <text className="gn-ico" style={{ fontFamily: "var(--font-mono)", fontSize: size * 0.3, fontWeight: 700 }}
            textAnchor="middle" dominantBaseline="central">{meta.code[0]}</text>
    </svg>
  );
}

// ── Glyph set ──────────────────────────────────────────────────────────────
const AtlasGlyph = ({ name, size = 16 }) => {
  const p = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
              strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" };
  switch (name) {
    case "pulse": return <svg {...p}><path d="M3 12h4l2 5 4-12 2 7h6" /></svg>;
    case "map": return <svg {...p}><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21" /><path d="M9 3v15M15 6v15" /></svg>;
    case "decisions": return <svg {...p}><path d="M12 2l10 10-10 10L2 12z" /><path d="M8.5 12l2.5 2.5 4.5-5" /></svg>;
    case "crew": return <svg {...p}><circle cx="8" cy="9" r="3" /><circle cx="16" cy="9" r="3" /><path d="M3 20c0-2.8 2.2-5 5-5s5 2.2 5 5" /><path d="M11 20c0-2.8 2.2-5 5-5s5 2.2 5 5" /></svg>;
    case "roadmap": return <svg {...p}><path d="M6 21V4" /><path d="M6 4h11l-2.5 3.5L17 11H6" /></svg>;
    case "lock": return <svg {...p}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>;
    case "check": return <svg {...p}><polyline points="4 12 9 17 20 6" /></svg>;
    case "undo": return <svg {...p}><path d="M3 7v6h6" /><path d="M3.5 13a8 8 0 1 0 2.2-7.4L3 8" /></svg>;
    case "expand": return <svg {...p}><path d="M3 9V3h6M21 15v6h-6" /><path d="M9 3 3 9M15 21l6-6" /></svg>;
    case "collapse": return <svg {...p}><path d="M9 3v6H3M15 21v-6h6" /><path d="M9 9 3 3M21 21l-6-6" /></svg>;
    case "search": return <svg {...p}><circle cx="11" cy="11" r="7" /><line x1="16" y1="16" x2="21" y2="21" /></svg>;
    case "focus": return <svg {...p}><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /></svg>;
    case "fit": return <svg {...p}><path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" /></svg>;
    case "plus": return <svg {...p}><line x1="12" y1="6" x2="12" y2="18" /><line x1="6" y1="12" x2="18" y2="12" /></svg>;
    case "minus": return <svg {...p}><line x1="6" y1="12" x2="18" y2="12" /></svg>;
    case "open": return <svg {...p}><path d="M7 17L17 7M9 7h8v8" /></svg>;
    case "copy": return <svg {...p}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>;
    case "link": return <svg {...p}><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07L11 5" /><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07L13 19" /></svg>;
    case "filter": return <svg {...p}><polygon points="3 4 21 4 14 12 14 19 10 21 10 12" /></svg>;
    case "legend": return <svg {...p}><circle cx="6" cy="7" r="2" /><circle cx="6" cy="17" r="2" /><line x1="11" y1="7" x2="20" y2="7" /><line x1="11" y1="17" x2="20" y2="17" /></svg>;
    case "x": return <svg {...p}><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>;
    case "graph": return <svg {...p}><circle cx="6" cy="6" r="2.2" /><circle cx="18" cy="7" r="2.2" /><circle cx="13" cy="17" r="2.2" /><path d="M8 7l3 8M16 8.5l-2.5 7M8 6.2L16 6.8" /></svg>;
    case "block": return <svg {...p}><circle cx="12" cy="12" r="9" /><line x1="6" y1="6" x2="18" y2="18" /></svg>;
    case "stale": return <svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 8v4l3 2" /></svg>;
    case "reject": return <svg {...p}><circle cx="12" cy="12" r="9" /><path d="M9 9l6 6M15 9l-6 6" /></svg>;
    case "orphan": return <svg {...p}><circle cx="12" cy="9" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" strokeDasharray="2 3" /></svg>;
    case "handoff": return <svg {...p}><path d="M3 12h14M13 7l5 5-5 5" /></svg>;
    case "load": return <svg {...p}><rect x="3" y="10" width="4" height="10" rx="1" /><rect x="10" y="5" width="4" height="15" rx="1" /><rect x="17" y="13" width="4" height="7" rx="1" /></svg>;
    case "bolt": return <svg {...p}><path d="M13 2L4 14h7l-1 8 9-12h-7z" /></svg>;
    case "pause": return <svg {...p}><line x1="9" y1="5" x2="9" y2="19" /><line x1="15" y1="5" x2="15" y2="19" /></svg>;
    case "play": return <svg {...p}><polygon points="6 4 20 12 6 20" /></svg>;
    case "reassign": return <svg {...p}><path d="M4 8h12l-3-3M20 16H8l3 3" /></svg>;
    case "message": return <svg {...p}><rect x="3" y="5" width="18" height="13" rx="2" /><polyline points="3 7 12 13 21 7" /></svg>;
    case "command": return <svg {...p}><path d="M9 3a3 3 0 1 0 0 6h6a3 3 0 1 0 0-6 3 3 0 0 0-3 3v6a3 3 0 1 1-3 3 3 3 0 0 1 3-3h6a3 3 0 1 1 3 3" /></svg>;
    case "milestone": return <svg {...p}><path d="M12 2l3 4-3 4-3-4z" /><line x1="12" y1="10" x2="12" y2="22" /></svg>;
    case "clock": return <svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
    case "settings": return <svg {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.18.42.28.86.28 1.32V11a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>;
    default: return <svg {...p}><circle cx="12" cy="12" r="9" /></svg>;
  }
};

// ── Vision-vs-buildable tag ────────────────────────────────────────────────
// Every speculative affordance carries one so the team never confuses the
// live target with what wires today.
function VisionTag({ kind = "vision", children }) {
  const label = children || (kind === "vision" ? "Vision" : kind === "buildable" ? "Buildable now" : "Live");
  return <span className={"atlas-tag atlas-tag-" + kind}>{label}</span>;
}

// ── Trust chip — explicit / inferred / backfilled provenance ───────────────
function TrustChip({ confidence }) {
  const map = {
    explicit:   { lab: "Explicit", cls: "explicit" },
    inferred:   { lab: "Inferred", cls: "inferred" },
    backfilled: { lab: "Backfilled", cls: "backfilled" },
  };
  const c = map[confidence] || map.explicit;
  return <span className={"atlas-trust " + c.cls}><span className="dot" /> {c.lab}</span>;
}

// ── Impact bars (affects N) — used by Pulse cards, inspector, decisions ────
function ImpactBars({ n }) {
  const tiers = Math.min(5, Math.max(1, Math.ceil((n || 0) / 3)));
  const color = (n || 0) <= 3 ? "var(--st-progress)" : "var(--st-blocked)";
  return (
    <span className="bars">
      {Array.from({ length: 5 }).map((_, i) => (
        <i key={i} style={{ height: `${4 + i * 2}px`, background: color, opacity: i < tiers ? 0.9 : 0.18 }} />
      ))}
    </span>
  );
}

// ── Lens selector — one house pattern (tabs or segmented). All 5 navigate;
// Crew/Roadmap show their own rich-or-locked state, never a dead tab.
const ATLAS_LENSES = [
  { id: "pulse",     label: "Pulse",     glyph: "pulse" },
  { id: "map",       label: "Map",       glyph: "map" },
  { id: "decisions", label: "Reviews & approvals", glyph: "decisions" },
  { id: "crew",      label: "Crew",      glyph: "crew" },
  { id: "roadmap",   label: "Roadmap",   glyph: "roadmap" },
  { id: "quality",   label: "Quality",   glyph: "legend" },
];

function AtlasLensTabs({ lens, onChange, counts, style = "tabs" }) {
  const items = ATLAS_LENSES.map(l => ({ ...l, count: counts[l.id] }));
  if (style === "segmented") {
    return (
      <div className="atlas-tools" role="tablist" style={{ gap: 6 }}>
        {items.map(it => (
          <button key={it.id} role="tab" aria-selected={lens === it.id}
                  className={"mode-toggle" + (lens === it.id ? " active" : "")} onClick={() => onChange(it.id)}>
            <AtlasGlyph name={it.glyph} size={14} />{it.label}
            {it.count != null && <span className="chip-count">{it.count}</span>}
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className="view-tabs" role="tablist">
      {items.map(it => (
        <button key={it.id} role="tab" aria-selected={lens === it.id}
                className={"view-tab" + (lens === it.id ? " active" : "")} onClick={() => onChange(it.id)}>
          <AtlasGlyph name={it.glyph} size={15} />{it.label}
          {it.count != null && <span className="vt-count">{it.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ── Search box with live dropdown + keyboard nav (Cmd+K focus wired in app) ─
function AtlasSearch({ index, inputRef, onSelect }) {
  const [q, setQ] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [hi, setHi] = React.useState(0);
  const wrap = React.useRef(null);
  React.useEffect(() => {
    function onDoc(e) { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  const results = React.useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return [];
    return index.nodes
      .filter(n => n.type !== "phase" && (n.id.toLowerCase().includes(term) || (n.title || "").toLowerCase().includes(term)))
      .slice(0, 8);
  }, [q, index]);
  function choose(n) { if (!n) return; onSelect(n.id); setOpen(false); setQ(""); }
  function onKey(e) {
    if (e.key === "ArrowDown") { e.preventDefault(); setHi(h => Math.min(results.length - 1, h + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi(h => Math.max(0, h - 1)); }
    else if (e.key === "Enter") { choose(results[hi]); }
    else if (e.key === "Escape") { setOpen(false); inputRef.current && inputRef.current.blur(); }
  }
  return (
    <div className="atlas-pop-wrap" ref={wrap}>
      <div className="atlas-search">
        <AtlasGlyph name="search" size={14} />
        <input ref={inputRef} placeholder="Search id or title…" value={q} aria-label="Search artifacts"
               onChange={(e) => { setQ(e.target.value); setOpen(true); setHi(0); }}
               onFocus={() => q && setOpen(true)} onKeyDown={onKey} />
        <span className="kbd">⌘K</span>
      </div>
      {open && results.length > 0 && (
        <div className="atlas-search-results" role="listbox" aria-label="Search results">
          {results.map((n, i) => (
            <button key={n.id} className={"asr-row" + (i === hi ? " hi" : "")} role="option" aria-selected={i === hi}
                    onMouseEnter={() => setHi(i)} onClick={() => choose(n)}>
              <AtlasNodeMark type={n.type} size={18} hue={n.type === "role" ? n.hue : undefined} />
              <span className="asr-id">{n.id}</span>
              <span className="asr-title">{n.type === "role" ? n.meta.name : n.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Filters popover (.chip set) ────────────────────────────────────────────
function AtlasFilters({ index, filters, setFilters, phases, roles }) {
  const [open, setOpen] = React.useState(false);
  const m = index.metrics;
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (!open) return;
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    function onKey(e) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);
  const n = filters.phase.size + filters.status.size + filters.type.size + filters.owner.size;
  const typeList = ["task", "plan", "message", "decision", "role"];
  const statusList = [
    { id: "blocked", label: "Blocked", color: "var(--st-blocked)" },
    { id: "in_progress", label: "In progress", color: "var(--st-progress)" },
    { id: "todo", label: "Todo", color: "var(--text-4)" },
    { id: "completed", label: "Done", color: "var(--st-completed)" },
  ];
  function toggle(group, val) {
    setFilters(prev => { const cur = new Set(prev[group]); cur.has(val) ? cur.delete(val) : cur.add(val); return { ...prev, [group]: cur }; });
  }
  function clear() { setFilters({ phase: new Set(), status: new Set(), type: new Set(), owner: new Set() }); }
  return (
    <div className="atlas-pop-wrap" ref={ref}>
      <button className={"mode-toggle" + (n ? " active" : "")} onClick={() => setOpen(o => !o)}>
        <AtlasGlyph name="filter" size={14} /> Filters{n > 0 && <span className="atlas-filter-n">{n}</span>}
      </button>
      {open && (
        <div className="atlas-filter-pop">
          <div className="atlas-filter-head"><span>Filter the graph</span>{n > 0 && <button onClick={clear}>Clear all</button>}</div>
          <div className="atlas-filter-body">
            <div className="atlas-filter-group">
              <div className="lab">Phase</div>
              <div className="atlas-chiprow">
                {phases.map(ph => (
                  <button key={ph.id} className={"chip" + (filters.phase.has(ph.id) ? " active" : "")} onClick={() => toggle("phase", ph.id)}>
                    {ph.key}<span className="chip-count">{m.byPhase[ph.id] ? m.byPhase[ph.id].total : 0}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="atlas-filter-group">
              <div className="lab">Status</div>
              <div className="atlas-chiprow">
                {statusList.map(s => (
                  <button key={s.id} className={"chip" + (filters.status.has(s.id) ? " active" : "")} onClick={() => toggle("status", s.id)}>
                    <span className="chip-dot" style={{ background: s.color }} />{s.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="atlas-filter-group">
              <div className="lab">Artifact type</div>
              <div className="atlas-chiprow">
                {typeList.map(t => (
                  <button key={t} className={"chip" + (filters.type.has(t) ? " active" : "")} onClick={() => toggle("type", t)}>
                    <span className="chip-dot" style={{ background: `oklch(60% 0.1 ${ATLAS_NODE_TYPES[t].hue})` }} />{ATLAS_NODE_TYPES[t].label}
                  </button>
                ))}
              </div>
            </div>
            <div className="atlas-filter-group">
              <div className="lab">Owner / role</div>
              <div className="atlas-chiprow">
                {roles.map(r => (
                  <button key={r.id} className={"chip" + (filters.owner.has(r.id) ? " active" : "")} onClick={() => toggle("owner", r.id)}>
                    <span className="chip-dot" style={{ background: `oklch(58% 0.14 ${r.hue})` }} />{r.id}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AtlasLegend() {
  const nodeTypes = ["task", "plan", "message", "decision", "role"];
  return (
    <div className="atlas-legend">
      <div>
        <div className="block-lab">Type — by shape + module hue</div>
        <div className="grid">{nodeTypes.map(t => <div key={t} className="item"><AtlasNodeMark type={t} size={20} /><span>{ATLAS_NODE_TYPES[t].label}</span></div>)}</div>
      </div>
      <div>
        <div className="block-lab">Status — by ring</div>
        <div className="grid">
          <div className="item"><RingSwatch cls="blocked" /><span>Blocked</span></div>
          <div className="item"><RingSwatch cls="in_progress" /><span>In progress</span></div>
          <div className="item"><RingSwatch cls="completed" /><span>Done</span></div>
          <div className="item"><RingSwatch cls="todo" /><span>Todo</span></div>
        </div>
      </div>
      <div>
        <div className="block-lab">Edges</div>
        <div className="grid">
          <div className="item"><span className="edge-line" /><span>Explicit</span></div>
          <div className="item"><span className="edge-line dashed" /><span>Inferred</span></div>
          <div className="item"><span className="edge-line blocked" /><span>Blocks</span></div>
        </div>
      </div>
    </div>
  );
}
function RingSwatch({ cls }) {
  return (
    <svg width="20" height="20" viewBox="-10 -10 20 20" className="li-node">
      <circle cx="0" cy="0" r="6" fill="var(--surface-3)" />
      <circle className={"gn-ring " + cls} cx="0" cy="0" r="8" />
    </svg>
  );
}

// ── Crew links strip — source-backed ownership and pending review counts ──
function CommandStrip({ index, agentFeed, onOpenCrew, onDismiss }) {
  const crew = index.metrics.crew || [];
  const linkedRoles = crew.filter(c => c.owns > 0);
  const awaitingYou = (index.decisions || []).filter(d => d.awaiting === "human-raj").length;

  if (agentFeed === "locked") {
    return (
      <div className="atlas-cmdstrip locked">
        <span className="cs-mark"><AtlasGlyph name="command" size={14} /> Maestro</span>
        <span className="cs-locked">Crew ownership is hidden. Show it in Atlas settings to inspect linked work.</span>
        <button className="cs-x icon-btn" onClick={onDismiss} title="Hide" aria-label="Hide command strip"><AtlasGlyph name="x" size={13} /></button>
      </div>
    );
  }
  return (
    <div className="atlas-cmdstrip">
      <span className="cs-mark"><AtlasGlyph name="command" size={14} /> Crew links</span>
      <span className="cs-stat"><strong>{linkedRoles.length}</strong> roles with linked work</span>
      <div className="cs-feed">
        {linkedRoles.slice(0, 3).map(c => (
          <button key={c.id} className="cs-agent" onClick={onOpenCrew} title={`${c.meta.name} · view linked work`}>
            <RoleAvatar role={c.meta} />
            <span className="cs-now">{c.meta.name} <em>{c.owns} linked item{c.owns === 1 ? "" : "s"}</em></span>
          </button>
        ))}
      </div>
      {awaitingYou > 0 && (
        <span className="cs-await"><AtlasGlyph name="decisions" size={12} /> {awaitingYou} awaiting you</span>
      )}
      <span className="cs-spacer" />
      <button className="btn cs-steer" onClick={onOpenCrew}><AtlasGlyph name="crew" size={13} /> View crew</button>
      <button className="cs-x icon-btn" onClick={onDismiss} title="Hide" aria-label="Hide command strip"><AtlasGlyph name="x" size={13} /></button>
    </div>
  );
}

Object.assign(window, {
  ATLAS_NODE_TYPES, ATLAS_EDGE_TYPES, atlasNodeShape, AtlasNodeMark, AtlasGlyph,
  ATLAS_LENSES, AtlasLensTabs, AtlasSearch, AtlasFilters, AtlasLegend,
  VisionTag, TrustChip, ImpactBars, CommandStrip,
});
