// ─────────────────────────────────────────────────────────────────────────
// Atlas — Roadmap lens
//   Phase timeline · progress · cross-phase gates · schedule risk · milestones.
//   Phase progress + status + risk are REAL (engine data). Target dates and
//   milestone markers are the VISION layer (land when phases carry dates).
//   Also ships the locked-until-data state.
// ─────────────────────────────────────────────────────────────────────────

function RoadmapView({ index, roadmapData, onSelect }) {
  if (roadmapData === "locked") return <RoadmapLocked />;
  const rows = index.metrics.roadmap || [];
  const blockedPhases = rows.filter(r => r.blocked > 0).length;

  return (
    <div className="atlas-work">
      <div className="rm-scroll">
        <div className="rm-inner">
          <div className="atlas-vision-banner">
            <AtlasGlyph name="clock" size={14} />
            <span>Phase progress and blockers come from project tasks. Target dates and milestones are unavailable until the source records them.</span>
          </div>

          <div className="rm-summary">
            <div className="kpi"><div className="kpi-eyebrow"><span className="tone-dot" style={{ background: "var(--accent)" }} /> Phases</div><div className="kpi-value">{rows.length}</div><div className="kpi-sub">P1 → P{rows.length}</div></div>
            <div className={"kpi" + (blockedPhases ? " alert" : "")}><div className="kpi-eyebrow"><span className="tone-dot" style={{ background: "var(--st-blocked)" }} /> Blocked phases</div><div className="kpi-value">{blockedPhases}</div><div className="kpi-sub">phases with blocked tasks</div></div>
            <div className="kpi"><div className="kpi-eyebrow"><span className="tone-dot" style={{ background: "var(--st-completed)" }} /> Shipped</div><div className="kpi-value">{rows.filter(r => r.status === "completed" || r.status === "shipped").length}</div><div className="kpi-sub">closed phases</div></div>
          </div>

          <div className="rm-timeline card">
            <div className="rm-rows">
              {rows.map((p, i) => {
                const owner = p.owner ? roleById(p.owner) : null;
                return (
                  <div key={p.id} className="rm-row">
                    <div className="rm-side">
                      <div className="rm-key">{p.key}</div>
                      <div className="rm-name">{p.name}</div>
                      <div className="rm-meta">{owner && <RoleAvatar role={owner} />}<span className={"rm-statepill " + p.status}>{p.status}</span></div>
                    </div>
                    <div className="rm-track">
                      <div className={"rm-bar st-" + p.status + (p.blocked > 0 ? " at-risk" : "")} style={{ left: "0%", width: "100%" }}>
                        <div className="rm-fill" style={{ width: p.pct + "%" }} />
                        <span className="rm-bar-lab">{p.completed}/{p.total} · {p.pct}%</span>
                      </div>
                    </div>
                    <div className="rm-risk">
                      {p.blocked > 0 && <span className="rm-blk">{p.blocked} blocked</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function RoadmapLocked() {
  const present = [{ label: "Phases", have: true }, { label: "Phase progress", have: true }, { label: "Blocked tasks", have: true }, { label: "Target dates", have: false }];
  return (
    <div className="atlas-work">
      <div className="atlas-state">
        <div className="atlas-state-card locked" style={{ "--m-hue": 250 }}>
          <div className="as-ico"><AtlasGlyph name="roadmap" size={26} /></div>
          <h3>Roadmap is hidden</h3>
          <p>Phase progress and blocked-task counts are available from project data. Target dates and milestones are unavailable until the source records them.</p>
          <p className="as-hint">Show Roadmap data in Atlas settings to view the available phase information.</p>
          <div className="as-modules">
            {present.map(n => <span key={n.label} className={"as-mod" + (n.have ? " have" : "")}>{n.have ? "✓ " : ""}{n.label}</span>)}
          </div>
          <div className="as-cta"><span className="as-hint">Atlas settings → <strong>Roadmap data → Show</strong>.</span></div>
        </div>
      </div>
    </div>
  );
}

window.AtlasRoadmapView = RoadmapView;
