// ─────────────────────────────────────────────────────────────────────────
// Atlas — Crew lens (the agent-command moat)
//   Role roster, linked work, risky items, and the reports_to authority chain.
//   Live agent activity belongs to Maestro and is not inferred here.
// ─────────────────────────────────────────────────────────────────────────

// Authority / escalation chain — LAST-RESORT labeled fallback ONLY (AG-P13.3).
// The roster now renders from the REAL resolved persona join the engine attaches
// to each crew row (c.reportsTo / c.tier / c.resolved / c.persona, from
// metrics.crew[] — AG-P13.2). This flat ladder is kept ONLY to position rows that
// did NOT resolve (c.resolved === false), and such rows are rendered with a clear
// "unresolved" marker — never dressed up as if they were the real reports_to.
const CREW_REPORTS_TO_FALLBACK = { fe: "tl", be: "tl", tl: "spm", spm: "sdp", sdp: "human-raj", "human-raj": null };
const CREW_STATUS = {
  "on-station": { lab: "On station", cls: "ok" },
  "in-task":    { lab: "In task",    cls: "info" },
  "off-station":{ lab: "Off station", cls: "off" },
  unknown: { lab: "Status unknown", cls: "off" },
};

function CrewView({ index, agentFeed, actingAs, onSelect }) {
  if (agentFeed === "locked") return <CrewLocked index={index} />;
  const crew = index.metrics.crew || [];
  const maxOwns = Math.max(1, ...crew.map(c => c.owns));

  return (
    <div className="atlas-work">
      <div className="crew-scroll">
        <div className="crew-inner">
          <div className="atlas-vision-banner">
            <AtlasGlyph name="bolt" size={14} />
            <span>Roster, load, and ownership are computed from project data. Live agent activity is unavailable here.</span>
          </div>

          <div className="crew-grid">
            {crew.map(c => (
              <AgentCard key={c.id} c={c} maxOwns={maxOwns} isMe={c.id === actingAs}
                         onSelect={onSelect} />
            ))}
          </div>

          <AuthorityChain crew={crew} />
        </div>
      </div>
    </div>
  );
}

function AgentCard({ c, maxOwns, isMe, onSelect }) {
  const r = c.meta;
  const st = CREW_STATUS[c.status] || CREW_STATUS["off-station"];
  const ownPct = Math.round(((c.owns - c.riskyCount) / maxOwns) * 100);
  const riskPct = Math.round((c.riskyCount / maxOwns) * 100);
  return (
    <div className={"card agent-card" + (isMe ? " is-me" : "")} style={{ "--rr-hue": r.hue }}>
      <div className="agent-head">
        <RoleAvatar role={r} size="lg" showStatus />
        <div className="agent-id">
          <div className="agent-name">{r.name}{isMe && <span className="agent-you">you</span>}</div>
          <div className="agent-title">{r.title}</div>
        </div>
        <div className="agent-head-r">
          <span className={"agent-kind " + r.kind}>{r.kind === "human" ? "Human" : r.kind === "persona" ? "Role" : "Agent"}</span>
          <span className={"agent-status " + st.cls}>{st.lab}</span>
        </div>
      </div>

      {/* Real persona / escalation join (AG-P13.3): from metrics.crew[] resolved
          fields. Honest fallback — when the row did not resolve we say so rather
          than faking a tier. */}
      <div className={"agent-reports" + (c.resolved ? "" : " unresolved")}>
        {c.resolved ? (
          <>
            <span className="ar-tier">{TIER_LABEL[c.tier] || c.tier || "—"}</span>
            <span className="ar-sep">·</span>
            <span className="ar-to">{c.reportsTo ? <>reports to <strong>{c.reportsTo}</strong></> : "top of ladder"}</span>
          </>
        ) : (
          <span className="ar-unresolved">Persona join unresolved</span>
        )}
      </div>

      <div className="agent-now dim">
        <span className="an-lab">Activity</span>
        <span className="an-text">Live activity unavailable</span>
      </div>

      <div className="agent-load">
        <div className="al-row">
          <span className="al-lab">Load</span>
          <span className="al-nums"><strong>{c.owns}</strong> owned · <strong style={{ color: c.riskyCount ? "var(--pr-p1)" : "var(--text-3)" }}>{c.riskyCount}</strong> risky · <strong>{c.awaitingCount}</strong> awaiting</span>
        </div>
        <div className="al-bar"><i className="owns" style={{ width: ownPct + "%" }} /><i className="risky" style={{ width: riskPct + "%" }} /></div>
      </div>

      {c.riskyItems && c.riskyItems.length > 0 && (
        <div className="agent-owns">
          <div className="ao-lab">Risky items owned</div>
          <div className="atlas-afc-wrap">
            {c.riskyItems.slice(0, 5).map(n => (
              <ArtifactChip key={n.id} kind={n.type} id={n.id} label={n.id} onClick={() => onSelect(n.id)} />
            ))}
            {c.riskyItems.length > 5 && <span className="cp-more">+{c.riskyItems.length - 5}</span>}
          </div>
        </div>
      )}

    </div>
  );
}

// reports_to escalation chain — REAL persona tiers (AG-P13.3).
// Ranks rows top→down by the persona TIER resolved by the engine (c.tier from
// the AG-P13.2 join), so the escalation path reflects the real Crews reporting
// ladder, not a hardcoded fe→tl→spm→sdp chain. Rows whose join did NOT resolve
// (c.resolved === false) are NOT given a fake tier: they are pulled out into an
// honest "unresolved" band rendered separately, positioned with the last-resort
// CREW_REPORTS_TO_FALLBACK ladder only so they still have a place to sit — and
// clearly labeled as unresolved.
const TIER_RANK = { owner: 0, cxo: 1, lead: 2, senior: 3, junior: 4 };
const TIER_LABEL = { owner: "Owner", cxo: "Executive", lead: "Lead", senior: "Senior", junior: "Junior" };

function AuthorityChain({ crew }) {
  const resolved = crew.filter(c => c.resolved && c.tier);
  const unresolved = crew.filter(c => !(c.resolved && c.tier));

  // Real tiers: group resolved rows by their persona tier, top (owner) → down.
  const tierKeys = Object.keys(TIER_RANK)
    .filter(k => resolved.some(c => c.tier === k))
    .sort((a, b) => TIER_RANK[a] - TIER_RANK[b]);
  const realTiers = tierKeys.map(k => ({ key: k, rows: resolved.filter(c => c.tier === k) }));

  const haveReal = realTiers.length > 0;

  return (
    <div className="card authority-card">
      <div className="card-header">
        <span className="card-title">Authority &amp; escalation</span>
        <span className="card-eyebrow">reports_to · live persona ladder</span>
      </div>

      {haveReal && (
        <div className="auth-chain">
          {realTiers.map((tier, i) => (
            <React.Fragment key={tier.key}>
              <div className="auth-tier">
                {tier.rows.map(c => (
                  <div key={c.id} className="auth-node" style={{ "--rr-hue": c.meta.hue }} title={c.persona ? `persona: ${c.personaId}` : undefined}>
                    <RoleAvatar role={c.meta} showStatus />
                    <span className="auth-name">{c.meta.name}</span>
                    <span className="auth-title">{c.meta.title}</span>
                    <span className="auth-tier-lab">{TIER_LABEL[c.tier] || c.tier}{c.reportsTo ? ` → ${c.reportsTo}` : ""}</span>
                  </div>
                ))}
              </div>
              {i < realTiers.length - 1 && <div className="auth-link"><span>escalates to</span></div>}
            </React.Fragment>
          ))}
        </div>
      )}

      {unresolved.length > 0 && (
        <div className="auth-unresolved">
          <div className="auth-unresolved-lab">Unresolved · no persona join yet</div>
          <div className="auth-tier">
            {unresolved
              .slice()
              .sort((a, b) => authFallbackDepth(b.id) - authFallbackDepth(a.id))
              .map(c => (
                <div key={c.id} className="auth-node is-unresolved" style={{ "--rr-hue": c.meta.hue }}>
                  <RoleAvatar role={c.meta} showStatus />
                  <span className="auth-name">{c.meta.name}</span>
                  <span className="auth-title">{c.meta.title}</span>
                  <span className="auth-tier-lab unresolved">unresolved</span>
                </div>
              ))}
          </div>
        </div>
      )}

      <div className="auth-foot">
        {haveReal
          ? <span>Escalation ladder is the real Crews <code>reports_to</code> persona tier (resolved join).</span>
          : <><VisionTag kind="vision">Vision</VisionTag><span>No persona join resolved yet — load <code>roles/crews-index.json</code> to wire the real escalation ladder.</span></>}
      </div>
    </div>
  );
}

// Last-resort positioning ONLY for unresolved rows (depth in the fallback ladder).
function authFallbackDepth(id) {
  let d = 0, cur = id, guard = 0;
  while (CREW_REPORTS_TO_FALLBACK[cur] && guard++ < 12) { cur = CREW_REPORTS_TO_FALLBACK[cur]; d++; }
  return d;
}

function CrewLocked({ index }) {
  const present = [{ label: "Crews · roles", have: true }, { label: "Per-task owner", have: false }, { label: "Maestro live stream", have: false }, { label: "Persona map", have: false }];
  return (
    <div className="atlas-work">
      <div className="atlas-state">
        <div className="atlas-state-card locked" style={{ "--m-hue": 150 }}>
          <div className="as-ico"><AtlasGlyph name="crew" size={26} /></div>
          <h3>Crew — locked until agent data exists</h3>
          <p>The Crew lens commands the workforce: each agent's station and live activity, the work it owns, the reports_to escalation chain, and one-tap steer / reassign / intervene.</p>
          <p className="as-hint">It unlocks when Maestro streams live agent activity and the role→persona map is present. Roster + ownership backfill from the approved data-model extension.</p>
          <div className="as-modules">
            {present.map(n => <span key={n.label} className={"as-mod" + (n.have ? " have" : "")}>{n.have ? "✓ " : ""}{n.label}</span>)}
          </div>
          <div className="as-cta"><span className="as-hint">Preview the live target: Tweaks → <strong>Agent feed → Live</strong>.</span></div>
        </div>
      </div>
    </div>
  );
}

window.AtlasCrewView = CrewView;
