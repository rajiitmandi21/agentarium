// Agentarium — Verdicts (gates board + queue)

function useVerdictColumnCollapse() {
  const [colOverride, setColOverride] = React.useState({});
  const isCollapsed = (key, isEmpty) =>
    colOverride[key] === undefined ? isEmpty : colOverride[key];
  const toggle = (key, isEmpty) => {
    setColOverride((o) => ({
      ...o,
      [key]: !(o[key] === undefined ? isEmpty : o[key]),
    }));
  };
  return { isCollapsed, toggle };
}

// Defensive wrappers — shared helpers are treated as untrusted at this module boundary.
function safeRole(id) {
  let r = null;
  try { r = id == null ? null : roleById(id); } catch (err) { r = null; }
  if (r) return r;
  const label = id == null ? "unknown" : String(id);
  return { id: label, name: label, hue: 0 };
}

function safeRelTime(t) {
  if (typeof t !== "string" || t.length === 0) return "—";
  try { return relTime(t) || "—"; } catch (err) { return "—"; }
}

function cmpAtDesc(a, b) {
  const ka = typeof a === "string" && a.length > 0 ? a : null;
  const kb = typeof b === "string" && b.length > 0 ? b : null;
  if (ka && kb) return kb.localeCompare(ka);
  if (ka) return -1; // dated records sort before undated ones
  if (kb) return 1;
  return 0;
}

function VerdictsView({ actingAs, onOpenArtifact, editMode, reviewMode, activePhaseId, verdicts }) {
  const [view, setView] = React.useState("gates"); // gates | queue
  const colCollapse = useVerdictColumnCollapse();
  const scoped = verdicts || (activePhaseId
    ? (AG.VERDICTS || []).filter((v) => !v.phase || v.phase === activePhaseId)
    : (AG.VERDICTS || []));
  const pendingCount = scoped.filter((v) => v.state === "needs-review").length;

  return (
    <div className="modbody" data-screen-label="Verdicts">
      <ModuleHeader
        roomNo="06"
        eyebrow="Verdicts · Trust Layer"
        title="Gates & sign-offs"
        subtitle={`${pendingCount} pending · acting as ${safeRole(actingAs).id}`}
        editMode={editMode}
        reviewMode={reviewMode}
        editPolicy={{ mode: "read-only", fields: ["derived from Khira pm_status"] }}
        actions={
          <>
            <div style={{
              display: "inline-flex", background: "var(--surface-2)", border: "1px solid var(--border)",
              borderRadius: 8, padding: 2,
            }}>
              {[{ v: "gates", l: "Gates" }, { v: "queue", l: "Queue" }].map(o => (
                <button key={o.v} type="button" aria-pressed={view === o.v} onClick={() => setView(o.v)} style={{
                  background: view === o.v ? "var(--bg-elev)" : "transparent",
                  boxShadow: view === o.v ? "var(--shadow-1)" : "none",
                  color: view === o.v ? "var(--text)" : "var(--text-3)",
                  border: "none", padding: "5px 12px", borderRadius: 6, fontSize: 11.5,
                  fontWeight: 600, cursor: "pointer",
                }}>
                  {o.l}
                </button>
              ))}
            </div>
          </>
        }
      />
      <PmSourceBanner readOnly />

      <div style={{ marginTop: 18 }}>
        {view === "gates"
          ? <GatesBoard verdicts={scoped} onOpen={onOpenArtifact} actingAs={actingAs} colCollapse={colCollapse} />
          : <VerdictQueue verdicts={scoped} onOpen={onOpenArtifact} actingAs={actingAs} />}
      </div>
    </div>
  );
}

function GatesBoard({ verdicts, onOpen, actingAs, colCollapse }) {
  const { isCollapsed, toggle } = colCollapse;
  const list = verdicts || [];
  const baseCols = [
    { id: "needs-review", label: "Needs review", hue: 70 },
    { id: "in-test",      label: "In test",      hue: 220 },
    { id: "tested",       label: "Tested · approved", hue: 150, also: ["done"] },
    { id: "rejected",     label: "Rejected · superseded", hue: 25, also: ["superseded", "blocked"] },
  ];
  const knownStates = new Set(baseCols.flatMap((c) => [c.id].concat(c.also || [])));
  const cols = baseCols.concat([{ id: "other", label: "Other · unmapped", hue: 290 }]);
  const itemsFor = (c) =>
    c.id === "other"
      ? list.filter((v) => !knownStates.has(v.state))
      : list.filter((v) => v.state === c.id || (c.also || []).includes(v.state));
  return (
    <div className="verdict-board">
      {cols.map(c => {
        const items = itemsFor(c);
        const empty = items.length === 0;
        const collapsed = isCollapsed(c.id, empty);
        if (collapsed) {
          return (
            <div key={c.id} className="verdict-col verdict-col-rail collapsed"
                 role="button" tabIndex={0} aria-expanded={false}
                 onClick={() => toggle(c.id, empty)}
                 onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(c.id, empty); } }}>
              <span className="rail-dot" style={{ background: `oklch(58% 0.16 ${c.hue})` }} />
              <span className="cc-vname">{c.label}</span>
              <span className="cc-count">{items.length}</span>
            </div>
          );
        }
        return (
          <div key={c.id} className="verdict-col">
            <div className="verdict-col-head" style={{ borderBottom: `2px solid oklch(70% 0.10 ${c.hue})` }}>
              <span style={{ width: 8, height: 8, borderRadius: 50, background: `oklch(58% 0.16 ${c.hue})` }} />
              <span className="lbl" style={{ color: `oklch(40% 0.14 ${c.hue})` }}>{c.label}</span>
              <span className="cnt">{items.length}</span>
              <button type="button" className="col-collapse-btn" aria-label="Collapse column" aria-expanded={true}
                      onClick={() => toggle(c.id, empty)}>▾</button>
            </div>
            <div className="verdict-col-body">
              {items.map((v, i) => <VCard key={v.id ?? `${c.id}-${i}`} v={v} onOpen={onOpen} actingAs={actingAs} />)}
              {empty && (
                <div style={{ padding: 20, textAlign: "center", color: "var(--text-3)", fontSize: 12 }}>
                  empty
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function VCard({ v, onOpen, actingAs }) {
  const target = verdictTarget(v);
  const openable = !!(target && target.kind != null && target.id != null && onOpen);
  const open = () => { if (openable) onOpen(target.kind, target.id); };
  const chipKind = target ? target.kind : undefined;
  const chipId = target ? target.id : undefined;
  const actor = v.actor ? safeRole(v.actor) : null;
  const awaiting = v.awaiting ? safeRole(v.awaiting) : null;
  const isMine = v.awaiting === actingAs;
  const titleText = v.note || v.title || v.id || "(untitled verdict)";
  return (
    <article className="vcard"
             style={isMine ? { borderColor: "oklch(70% 0.10 var(--r-hue))", boxShadow: "0 0 0 2px var(--r-tint)" } : null}
             role={openable ? "button" : undefined}
             tabIndex={openable ? 0 : undefined}
             aria-label={`${titleText}${openable ? ` — open ${target.kind} ${target.id}` : ""}`}
             onClick={open}
             onKeyDown={(e) => { if (openable && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(); } }}>
      <div className="v-head">
        <Stamp state={v.state} />
        <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--text-3)" }}>{v.id}</span>
      </div>
      <div className="v-note">{titleText}</div>
      <div className="v-meta">
        <ArtifactChip kind={chipKind} id={chipId} />
      </div>
      <div className="v-meta" style={{ borderTop: "1px dashed var(--border)", paddingTop: 6 }}>
        {actor ? <><RoleAvatar role={actor} /><span style={{ color: "var(--text-2)" }}>{actor.id}</span></> : <span style={{ color: "var(--text-3)" }}>Actor unrecorded</span>}
        {awaiting && (
          <>
            <span style={{ color: "var(--text-4)" }}>→</span>
            <RoleAvatar role={awaiting} />
            <span style={{ color: "var(--text-2)" }}>{awaiting.id}</span>
          </>
        )}
        <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10 }}>{safeRelTime(v.at)}</span>
      </div>
    </article>
  );
}

function VerdictQueue({ verdicts, onOpen, actingAs }) {
  const sorted = (verdicts || []).slice().sort((a, b) => {
    // Mine awaiting first, then needs-review, then newest first (undated records last)
    const am = a.awaiting === actingAs ? 0 : 1;
    const bm = b.awaiting === actingAs ? 0 : 1;
    if (am !== bm) return am - bm;
    const an = a.state === "needs-review" ? 0 : 1;
    const bn = b.state === "needs-review" ? 0 : 1;
    if (an !== bn) return an - bn;
    return cmpAtDesc(a.at, b.at);
  });
  return (
    <div style={{
      background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden",
    }}>
      {sorted.map((v, i) => {
        const target = verdictTarget(v);
        const openable = !!(target && target.kind != null && target.id != null && onOpen);
        const open = () => { if (openable) onOpen(target.kind, target.id); };
        const chipKind = target ? target.kind : undefined;
        const chipId = target ? target.id : undefined;
        const actor = v.actor ? safeRole(v.actor) : null;
        const aw = v.awaiting ? safeRole(v.awaiting) : null;
        const titleText = v.note || v.title || v.id || "(untitled verdict)";
        return (
          <div key={v.id ?? `queue-${i}`}
               className="vq-item"
               style={{
                 padding: "12px 16px",
                 borderTop: i === 0 ? "none" : "1px solid var(--border)",
                 background: v.awaiting === actingAs ? "var(--r-tint)" : "transparent",
                 cursor: "pointer",
               }}
               role={openable ? "button" : undefined}
               tabIndex={openable ? 0 : undefined}
               aria-label={`${titleText}${openable ? ` — open ${target.kind} ${target.id}` : ""}`}
               onClick={open}
               onKeyDown={(e) => { if (openable && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(); } }}>
            <Stamp state={v.state} />
            <div style={{ minWidth: 0 }}>
              <div className="vq-title">{titleText}</div>
              <div className="vq-meta">
                <ArtifactChip kind={chipKind} id={chipId} />
                <span>·</span>
                {actor ? <><RoleAvatar role={actor} /><span>{actor.id}</span></> : <span>Actor unrecorded</span>}
                {aw && <><span style={{ color: "var(--text-4)" }}>→</span><RoleAvatar role={aw} /><span>{aw.id}</span></>}
                {v.awaiting === actingAs && <span className="tag" style={{ background: "var(--r-accent)", color: "white", borderColor: "transparent" }}>YOU</span>}
              </div>
            </div>
            <div className="vq-when">{safeRelTime(v.at)}</div>
          </div>
        );
      })}
      {sorted.length === 0 && (
        <div style={{ padding: 20, textAlign: "center", color: "var(--text-3)", fontSize: 12 }}>
          No verdicts in scope
        </div>
      )}
    </div>
  );
}

window.VerdictsView = VerdictsView;
