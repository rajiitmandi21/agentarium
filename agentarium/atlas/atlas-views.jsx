// ─────────────────────────────────────────────────────────────────────────
// Atlas — Pulse lens (what needs me now) + Decisions lens (verdicts that gate
// the most work, approved/rejected in place). House components only.
// ─────────────────────────────────────────────────────────────────────────

const { useState: useStateV, useRef: useRefV } = React;

// ════════════════════════════ PULSE ════════════════════════════════════════
const PULSE_LANES = [
  { key: "blocked",      kinds: ["blocked"],                   title: "Blocked",                    sev: "critical", desc: "Can't proceed without an unblock or decision" },
  { key: "rejected",     kinds: ["rejected"],                  title: "Rejected reviews",           sev: "critical", desc: "Failed a verdict — needs rework" },
  { key: "stale",        kinds: ["stale-severe", "stale"],     title: "Stale in progress",          sev: "high",     desc: "No movement past the 72h rule" },
  { key: "needs-review", kinds: ["needs-review"],              title: "Awaiting a verdict",         sev: "high",     desc: "Sitting in someone's review queue" },
  { key: "hi-pri-idle",  kinds: ["hi-pri-idle"],               title: "High-priority, confirm it's moving", sev: "medium", desc: "P0 / P1 in progress" },
  { key: "open-handoff", kinds: ["open-handoff"],              title: "Unresolved handoffs",        sev: "medium",   desc: "Handoff sent, target still open" },
  { key: "orphan",       kinds: ["orphan-task", "orphan-plan"], title: "Missing links",             sev: "medium",   desc: "Tasks with no plan · plans with no tasks" },
  { key: "overloaded",   kinds: ["overloaded"],                title: "Overloaded owners",          sev: "medium",   desc: "Carrying too many risky items" },
];

function PulseView({ index, phases, selectedId, onSelect, onMetric, justResolved, resolvedAt }) {
  const scrollRef = useRefV(null);
  const laneRefs = useRefV({});
  const m = index.metrics;
  // Live status reflection (AG-P14.1): ids that transitioned OUT of risk on the
  // last project refresh. They no longer surface in index.attention (the rebuild
  // dropped them), so synthesize a transient "Just resolved" lane that fades them
  // out with a badge before they leave the board — turning invisible background
  // agent work (a verdict landed, a blocker cleared) into visible motion.
  const resolved = justResolved instanceof Set ? justResolved : new Set();
  const resolvedStamps = resolvedAt || {};
  const stillRisky = new Set(index.attention.map(a => a.id));
  const resolvedItems = [...resolved]
    .filter(id => !stillRisky.has(id) && index.byId[id])
    .map(id => {
      const n = index.byId[id];
      return { id, kind: "just-resolved", node: n, label: n.title || n.label || id,
        owner: n.ownerId || null, resolvedAt: resolvedStamps[id] || null,
        why: "Cleared since the last refresh", action: "No action needed" };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const byKind = {};
  for (const a of index.attention) (byKind[a.kind] = byKind[a.kind] || []).push(a);
  const riskyLanes = PULSE_LANES
    .map(l => ({ ...l, items: l.kinds.flatMap(k => byKind[k] || []).sort((a, b) => (b.node?.impactScore || 0) - (a.node?.impactScore || 0)) }))
    .filter(l => l.items.length);
  const resolvedLane = resolvedItems.length
    ? { key: "just-resolved", kinds: ["just-resolved"], title: "Just resolved", sev: "resolved",
        desc: "Cleared since the last refresh — fading out", items: resolvedItems, isResolvedLane: true }
    : null;
  const activeLanes = resolvedLane ? [resolvedLane, ...riskyLanes] : riskyLanes;

  function scrollToLane(key) {
    const el = laneRefs.current[key], wrap = scrollRef.current;
    if (el && wrap) wrap.scrollTo({ top: el.offsetTop - 12, behavior: "smooth" });
  }
  const kpis = [
    { lab: "Blocked", val: m.blocked, tone: m.blocked ? "alert" : "", dot: "var(--st-blocked)", sub: "can't proceed", go: () => scrollToLane("blocked") },
    { lab: "Rejected", val: m.rejected, tone: m.rejected ? "alert" : "", dot: "var(--st-blocked)", sub: "failed a verdict", go: () => scrollToLane("rejected") },
    { lab: "Stale > 72h", val: m.stale, tone: m.stale ? "warn" : "", dot: "var(--pr-p1)", sub: "no movement", go: () => scrollToLane("stale") },
    { lab: "Awaiting verdict", val: m.needsReview, tone: m.needsReview ? "warn" : "", dot: "var(--pr-p1)", sub: "in review queues", go: () => scrollToLane("needs-review") },
    { lab: "Review & approval queue", val: index.decisions.length, tone: "", dot: "var(--accent)", sub: "needs a recorded verdict or decision", go: () => onMetric({ goDecisions: true }) },
    { lab: "Missing links", val: m.orphanTasks + m.orphanPlans, tone: "", dot: "var(--text-4)", sub: "orphans", go: () => scrollToLane("orphan") },
  ];

  return (
    <div className="atlas-work">
      <div className="pulse-scroll" ref={scrollRef}>
        <div className="pulse-inner">
          <div className="atlas-kpis">
            {kpis.map(k => (
              <button key={k.lab} className={"kpi " + k.tone + (k.val === 0 ? " is-zero" : "")} onClick={k.go}>
                <div className="kpi-eyebrow"><span className="tone-dot" style={{ background: k.dot }} /> {k.lab}</div>
                <div className="kpi-value">{k.val}</div>
                <div className="kpi-sub">{k.sub}</div>
              </button>
            ))}
          </div>
          {activeLanes.length === 0 ? (
            <div className="atlas-state"><div className="atlas-state-card">
              <div className="as-ico"><AtlasGlyph name="check" size={26} /></div>
              <h3>Nothing needs you right now</h3>
              <p>No blocked, rejected, stale, orphaned, or overloaded items in the current scope.</p>
            </div></div>
          ) : (
            <div className="atlas-lanes">
              {activeLanes.map(lane => (
                <section key={lane.key} ref={el => (laneRefs.current[lane.key] = el)}>
                  <div className="atlas-lane-head">
                    <span className="atlas-lane-eyebrow"><span className={"sev " + lane.sev} /> {lane.title}</span>
                    <span className="atlas-lane-count">{lane.items.length}</span>
                    <span className="atlas-lane-desc">{lane.desc}</span>
                  </div>
                  <div className="atlas-cards">
                    {lane.items.map(it => (
                      <PulseCard key={it.kind + it.id} item={it} sev={lane.sev} index={index}
                                 selected={it.id === selectedId} onSelect={() => onSelect(it.id)}
                                 justResolved={lane.isResolvedLane} resolvedAt={it.resolvedAt} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PulseCard({ item, sev, index, selected, onSelect, justResolved = false, resolvedAt = null }) {
  const sevCls = sev === "critical" ? "crit" : sev === "high" ? "high" : sev === "resolved" ? "resolved" : "med";
  const n = item.node;
  const owner = item.owner ? index.byId[item.owner] : null;
  const affects = (n && n.affects) || 0;
  return (
    <div className={"card atlas-card " + sevCls + (selected ? " sel" : "") + (justResolved ? " just-resolved" : "")}
         role="button" tabIndex={0} onClick={onSelect}
         onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }}>
      <div className="atlas-card-top">
        <ArtifactChip kind={n.type} id={item.id} label={item.id} />
        {n.priority && <span className={"atlas-prio " + n.priority}>{n.priority.toUpperCase()}</span>}
        {justResolved && (
          <span className="just-resolved-badge" title={resolvedAt ? `Resolved ${relTime(resolvedAt)}` : "Resolved on the last refresh"}>
            <AtlasGlyph name="check" size={10} /> just resolved
          </span>
        )}
        {!justResolved && affects > 0 && (
          <span className={"atlas-impact" + (affects <= 3 ? " low" : "")} title="Tasks affected downstream">
            <ImpactBars n={affects} /> affects {affects}
          </span>
        )}
      </div>
      <div className="atlas-card-title">{item.label}</div>
      <div className="atlas-card-why">{item.why}</div>
      <div className="atlas-card-foot">
        {owner && owner.meta && <span className="atlas-owner"><RoleAvatar role={owner.meta} /> {owner.meta.id || owner.meta.name}</span>}
        <span className="atlas-next"><AtlasGlyph name="open" size={11} /> {item.action}</span>
      </div>
    </div>
  );
}

// ════════════════════════════ DECISIONS ═════════════════════════════════════
function DecisionsView({ index, onSelect, onOpenArtifact }) {
  const queue = index.decisions;

  return (
    <div className="atlas-work" style={{ position: "relative" }}>
      <div className="dec-scroll">
        <div className="dec-inner">
          <div className="dec-intro">
            <span className="atlas-lane-eyebrow"><AtlasGlyph name="decisions" size={15} /> Review & approval queue</span>
            <span className="lead">
              <strong>{queue.length}</strong> {queue.length === 1 ? "item needs" : "items need"} a recorded verdict or decision, ranked by impact score.
              Open the source artifact to review it.
            </span>
          </div>
          {queue.length === 0 ? (
            <div className="atlas-state"><div className="atlas-state-card">
              <div className="as-ico"><AtlasGlyph name="check" size={26} /></div>
              <h3>No reviews or approvals waiting</h3>
              <p>New work routed for review appears here, ranked by what it unblocks.</p>
            </div></div>
          ) : (
            <div className="dec-list">
              {queue.map((d, i) => (
                <DecisionCard key={d.id} d={d} rank={i + 1} index={index}
                              onOpen={() => onOpenArtifact && onOpenArtifact(d.node)} onInspect={() => onSelect(d.id)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DecisionCard({ d, rank, index, onOpen, onInspect }) {
  const [trailOpen, setTrailOpen] = useStateV(false);
  const n = d.node;
  const owner = d.ownerId ? roleById(d.ownerId) : null;
  const awaiting = d.awaiting ? roleById(d.awaiting) : null;
  const verdicts = n.verdicts || [];
  const affects = d.affects || 0;
  const tier = Math.min(8, Math.max(1, Math.ceil(affects / 2)));

  return (
    <div className="card dec-card">
      <div className="dec-card-main">
        <div className="dec-rank"><span className="hash">#</span>{rank}</div>
        <div className="dec-body">
          <div className="dec-top">
            <ArtifactChip kind={n.type} id={n.id} label={n.id} onClick={onInspect} />
            {n.priority && <span className={"atlas-prio " + n.priority}>{n.priority.toUpperCase()}</span>}
            <Stamp state={d.kind === "decision-pending" ? "proposed" : "needs-review"} />
          </div>
          <div className="dec-title">{n.title}</div>
          <div className="dec-why"><div className="quote">{d.why}</div></div>
          <div className="dec-meta">
            {owner && <span className="who">task owner <RoleAvatar role={owner} /> {owner.name}</span>}
            {awaiting && <span className="who">awaiting <RoleAvatar role={awaiting} /> {awaiting.name}</span>}
            {n.phase && index.byId[n.phase] && <span>{index.byId[n.phase].label}</span>}
          </div>
        </div>
        <div className="dec-gates">
          <div className={"g-val" + (affects >= 4 ? " hot" : "")}>{affects}</div>
          <div className="g-lab">tasks affected</div>
          <div className="g-meter">{Array.from({ length: 8 }).map((_, i) => <i key={i} className={i < tier ? "on" + (affects <= 3 ? " low" : "") : ""} />)}</div>
          <div className="g-score">impact {n.impactScore}</div>
        </div>
      </div>
      <div className="dec-actions">
        <button className="btn primary" onClick={onOpen}><AtlasGlyph name="open" size={14} /> Open in {({ task: "Khira", plan: "Planroom", message: "Courier", decision: "Ledgers" })[n.type] || "module"}</button>
        <span className="spacer" />
        {verdicts.length > 0 && <button className="trail-toggle" onClick={() => setTrailOpen(o => !o)}><AtlasGlyph name={trailOpen ? "collapse" : "legend"} size={13} /> {verdicts.length} prior {verdicts.length === 1 ? "verdict" : "verdicts"}</button>}
      </div>
      {trailOpen && verdicts.length > 0 && (
        <div className="dec-trail">
          <div className="activity-list">
            {verdicts.map(v => {
              const colour = v.state === "rejected" || v.state === "blocked" ? "var(--st-blocked)" : v.state === "needs-review" ? "var(--pr-p1)" : v.state === "done" || v.state === "approved" || v.state === "tested" ? "var(--st-completed)" : "var(--text-4)";
              return (
                <div key={v.id} className="activity-item">
                  <span className="activity-dot" style={{ background: colour }} />
                  <div className="activity-text">
                    <span style={{ fontWeight: 600, color: colour }}>{({ "needs-review": "Needs review", rejected: "Rejected", approved: "Approved", done: "Approved", tested: "Tested", "in-test": "In test" })[v.state] || v.state}</span>
                    <span style={{ color: "var(--text-3)" }}> by {v.actor}</span>
                    {v.note && <div style={{ marginTop: 2 }}>{v.note}</div>}
                  </div>
                  <span className="activity-time">{relTime(v.at)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════ QUALITY (data-quality macro lens) ═════════════
// AG-P14.2 #29 — a discoverable graph-quality surface: % explicit / % inferred /
// % backfilled edges + explicit owner-coverage %, and an "Audit" affordance that
// jumps the operator to the low-coverage nodes (orphan / no-owner / all-inferred).
// Reads metrics.quality (pure counting in the engine) — no clock, no recompute.
function QualityView({ index, onSelect, onAudit, auditActive }) {
  const q = (index.metrics && index.metrics.quality) || {
    edges: 0, explicit: 0, inferred: 0, backfilled: 0,
    explicitPct: 0, inferredPct: 0, backfilledPct: 0,
    tasks: 0, tasksWithOwner: 0, ownerCoverage: 0,
    orphanTasks: 0, orphanPlans: 0, noOwnerTasks: 0,
    lowCoverageIds: [], lowCoverageCount: 0,
  };
  const segs = [
    { key: "explicit", lab: "Explicit", pct: q.explicitPct, n: q.explicit, cls: "explicit", desc: "source-backed links from schema fields" },
    { key: "inferred", lab: "Inferred", pct: q.inferredPct, n: q.inferred, cls: "inferred", desc: "text-mention / co-mention guesses" },
    { key: "backfilled", lab: "Backfilled", pct: q.backfilledPct, n: q.backfilled, cls: "backfilled", desc: "simulated data-model backfill" },
  ].filter(s => s.n > 0 || s.key !== "backfilled");
  const lowNodes = (q.lowCoverageIds || []).map(id => index.byId[id]).filter(Boolean);

  return (
    <div className="atlas-work">
      <div className="dec-scroll">
        <div className="dec-inner aq-inner">
          <div className="dec-intro">
            <span className="atlas-lane-eyebrow"><AtlasGlyph name="legend" size={15} /> Graph quality</span>
            <span className="lead">
              How much of this graph is <strong>real</strong> vs. <strong>speculated</strong>. <strong>{q.explicitPct}%</strong> of {q.edges} links are source-explicit;
              <strong> {q.ownerCoverage}%</strong> of {q.tasks} tasks carry an explicit owner. Audit jumps you to the gaps.
            </span>
          </div>

          <div className="aq-cards">
            <div className="card aq-bigcard">
              <div className="aq-card-lab">Edge provenance · {q.edges} links</div>
              <div className="aq-bar" role="img" aria-label={`${q.explicitPct}% explicit, ${q.inferredPct}% inferred, ${q.backfilledPct}% backfilled`}>
                {segs.map(s => s.pct > 0 && (
                  <span key={s.key} className={"aq-seg " + s.cls} style={{ width: s.pct + "%" }} title={`${s.lab} · ${s.n} (${s.pct}%)`} />
                ))}
              </div>
              <div className="aq-legend">
                {segs.map(s => (
                  <span key={s.key} className="aq-legend-item">
                    <span className={"aq-dot " + s.cls} /> <strong>{s.pct}%</strong> {s.lab}
                    <span className="aq-legend-n">{s.n}</span>
                  </span>
                ))}
              </div>
              <div className="aq-edge-note">Solid edges = explicit · dashed = inferred on the Map. {segs.find(s => s.key === "explicit")?.desc}.</div>
            </div>

            <div className="card aq-bigcard">
              <div className="aq-card-lab">Owner coverage</div>
              <div className="aq-ring-row">
                <Donut pct={q.ownerCoverage} />
                <div className="aq-ring-meta">
                  <div className="aq-ring-big">{q.ownerCoverage}<span className="aq-pct">%</span></div>
                  <div className="aq-ring-sub"><strong>{q.tasksWithOwner}</strong> of {q.tasks} tasks have an explicit <span className="mono">owner_id</span></div>
                  <div className="aq-ring-gap">{q.noOwnerTasks} no-owner · {q.orphanTasks} orphan task{q.orphanTasks === 1 ? "" : "s"} · {q.orphanPlans} orphan plan{q.orphanPlans === 1 ? "" : "s"}</div>
                </div>
              </div>
            </div>
          </div>

          <div className="card aq-audit">
            <div className="aq-audit-head">
              <div>
                <span className="atlas-lane-eyebrow"><span className="sev medium" /> Audit · low-coverage nodes</span>
                <div className="aq-audit-sub">{q.lowCoverageCount} node{q.lowCoverageCount === 1 ? "" : "s"} have no explicit owner, no plan link, or only inferred connections.</div>
              </div>
              <button className={"mode-toggle" + (auditActive ? " active" : "")} onClick={onAudit} title="Highlight low-coverage nodes on the Map">
                <AtlasGlyph name="filter" size={14} /> {auditActive ? "Auditing on Map" : "Audit on Map"}
              </button>
            </div>
            {lowNodes.length === 0 ? (
              <div className="aq-audit-clean"><AtlasGlyph name="check" size={15} /> Every node has explicit coverage — nothing to audit.</div>
            ) : (
              <div className="aq-audit-list">
                {lowNodes.map(n => (
                  <button key={n.id} className="aq-audit-row" onClick={() => onSelect(n.id)}>
                    <ArtifactChip kind={n.type} id={n.id} label={n.id} />
                    <span className="aq-audit-title">{n.type === "role" ? (n.meta && n.meta.name) : n.title}</span>
                    <span className="aq-audit-flags">
                      {(n.coverageFlags || []).map(f => (
                        <span key={f} className={"aq-flag " + f}>{({ "no-owner": "no owner", "orphan": "orphan", "all-inferred": "all inferred" })[f] || f}</span>
                      ))}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Small deterministic SVG donut for owner-coverage %.
function Donut({ pct }) {
  const R = 26, C = 2 * Math.PI * R;
  const on = Math.max(0, Math.min(100, pct || 0));
  const dash = (on / 100) * C;
  return (
    <svg className="aq-donut" width="68" height="68" viewBox="0 0 68 68">
      <circle cx="34" cy="34" r={R} className="aq-donut-track" />
      <circle cx="34" cy="34" r={R} className="aq-donut-on"
              strokeDasharray={`${dash} ${C - dash}`} transform="rotate(-90 34 34)" />
    </svg>
  );
}

window.AtlasPulseView = PulseView;
window.AtlasDecisionsView = DecisionsView;
window.AtlasQualityView = QualityView;
