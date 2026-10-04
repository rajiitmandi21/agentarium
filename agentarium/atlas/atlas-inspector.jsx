// ─────────────────────────────────────────────────────────────────────────
// Atlas — Inspector (drawer)
// House components: .card sections · .afc chips · .role-av · .tr-status ·
// .stamp · .activity-item trail · .btn · .icon-btn. Directional in/out
// relationship labels, trust chips (explicit/inferred/backfilled), freshness.
// ─────────────────────────────────────────────────────────────────────────

const MODULE_FOR_TYPE = { task: "Khira", plan: "Planroom", message: "Courier", decision: "Ledgers", role: "Crews", verdict: "Verdicts" };
const TASK_STATUS_LABEL = { blocked: "Blocked", in_progress: "In progress", todo: "Todo", completed: "Done" };

function fmtVState(s) {
  return ({ "needs-review": "Needs review", "in-test": "In test", tested: "Tested", done: "Approved", approved: "Approved", rejected: "Rejected", blocked: "Blocked", superseded: "Superseded" })[s] || s;
}
const RISK_LABEL = { blocked: "Blocked", "has-blockers": "Has blockers", rejected: "Rejected", "needs-review": "Needs review", stale: "Stale > 72h", "stale-severe": "Severe stale", bug: "Open bug" };

// directional relationship label: [outgoing(node is `from`), incoming(node is `to`)]
const REL_LABEL = {
  blocked_by:           ["Blocked by", "Blocks"],
  assigned_to:          ["Owner / author", "Owns / authored"],
  linked_to_plan:       ["Linked plan", "Linked tasks"],
  mentioned_in_message: ["Mentions", "Mentioned in"],
  reviewed_by:          ["Reviewed by", "Reviews"],
  decided_by:           ["Decided by", "Decides"],
  supersedes:           ["Supersedes", "Superseded by"],
  handoff_for:          ["Hands off", "Handed off by"],
  handoff_accepted:     ["Accepted by", "Accepts"],
};

// G2: derived mirror edges. The engine emits `blocks` as the exact reverse of
// blocked_by and `implements` as a parallel of linked_to_plan, but excludes
// both from degree/metrics so one relationship counts once. The inspector must
// apply the same rule: fold mirrors into their canonical type before labeling,
// flipping the direction for the reversed mirror (`blocks`), so a counterpart
// appears in ONE group and connectedTotal counts it ONCE.
const EDGE_CANON = {
  blocks:     { of: "blocked_by", flip: true },
  implements: { of: "linked_to_plan", flip: false },
};

function InspCard({ title, eyebrow, children }) {
  return (
    <section className="card">
      <div className="card-header"><span className="card-title">{title}</span>{eyebrow && <span className="card-eyebrow">{eyebrow}</span>}</div>
      {children}
    </section>
  );
}

function AtlasInspector({ node, index, onClose, onSelect, onFocus, onOpenArtifact }) {
  // G8: copied state carries the outcome — { which, ok } — so the button can
  // report a real failure instead of always claiming success.
  const [copied, setCopied] = React.useState(null);
  const copyTimer = React.useRef(null);
  // C5: don't leave a stray timer that could fire after the drawer unmounts.
  React.useEffect(() => () => clearTimeout(copyTimer.current), []);
  // G13/C2: Esc closes the drawer — but Escape inside an input/textarea belongs
  // to that control (dismiss the search dropdown, blur a field), not to us.
  React.useEffect(() => {
    if (!node) return;
    function onKey(e) {
      if (e.target && typeof e.target.closest === "function"
        && e.target.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [node, onClose]);
  if (!node) return null;
  const meta = ATLAS_NODE_TYPES[node.type] || ATLAS_NODE_TYPES.task;
  const hue = node.type === "role" ? node.hue : meta.hue;

  // group connected nodes by DIRECTIONAL relationship + confidence
  const groups = {};
  for (const e of index.edges) {
    // G2: canonicalize mirrored edges first so they merge into their
    // canonical relationship's group instead of duplicating it.
    const canon = EDGE_CANON[e.type];
    const etype = canon ? canon.of : e.type;
    let other = null, dir = null;
    if (e.from === node.id) { other = e.to; dir = 0; }
    else if (e.to === node.id) { other = e.from; dir = 1; }
    else continue;
    if (canon && canon.flip) dir = 1 - dir;
    const on = index.byId[other];
    if (!on || on.type === "phase") continue;
    const label = (REL_LABEL[etype] || [etype, etype])[dir];
    const key = label + "|" + e.confidence;
    const group = groups[key] = groups[key] || { label, confidence: e.confidence, items: [], itemIds: new Set() };
    if (!group.itemIds.has(on.id)) {
      group.itemIds.add(on.id);
      group.items.push(on);
    }
  }
  const groupKeys = Object.keys(groups).sort((a, b) => {
    const rank = c => c.endsWith("explicit") ? 0 : c.endsWith("backfilled") ? 1 : 2;
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  const connectedTotal = Object.values(groups).reduce((s, g) => s + g.items.length, 0);

  function copy(text, which) {
    function finish(ok) {
      setCopied({ which, ok });
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(null), 1300);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => finish(true), () => finish(false));
      return;
    }
    // Legacy fallback for insecure contexts (plain http / file://).
    try {
      const ta = document.createElement("textarea");
      ta.value = String(text == null ? "" : text);
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      finish(ok);
    } catch (e) { finish(false); }
  }

  const phase = node.phase ? index.byId[node.phase] : null;
  const owner = node.ownerId ? index.byId[node.ownerId] : null;
  const risk = node.risk || [];
  const verdicts = node.verdicts || [];
  const ownerLabel = node.type === "plan" ? "Author" : "Owner";
  const fresh = node.lastTouch || (node.meta && (node.meta.updated || node.meta.at || node.meta.date)) || null;
  // G7: the engine stamps provenance on the node (e.g. inferred stub plans) —
  // read it first; only fall back to the owner-backfill heuristic.
  const sourceConfidence = node.sourceConfidence || (node.ownerBackfilled ? "backfilled" : "explicit");

  return (
    <aside className="atlas-insp" role="dialog" aria-modal="false" aria-label={`Inspector: ${node.id}`}>
      <div className="atlas-insp-head">
        <button className="icon-btn close" onClick={onClose} aria-label="Close inspector"><AtlasGlyph name="x" size={15} /></button>
        <div className="atlas-insp-kind">
          <span className="atlas-kindchip" style={{ "--k-hue": hue }}>{meta.label}</span>
          <span className="atlas-insp-id">{node.id}</span>
        </div>
        <h2>{node.type === "role" ? node.meta.name + " · " + node.meta.title : node.title}</h2>
        <div className="atlas-insp-badges">
          {node.priority && <span className={"atlas-prio " + node.priority}>{node.priority.toUpperCase()}</span>}
          {node.verdictState && <Stamp state={node.verdictState === "done" ? "approved" : node.verdictState} label={fmtVState(node.verdictState)} />}
          {node.stale && <span className="chip" style={{ color: "var(--pr-p1)", borderColor: "var(--warn-line)" }}>{node.stale === "severe" ? "Severe stale" : "Stale > 72h"}</span>}
          {node.affects > 0 && <span className="atlas-impact" title="Tasks affected downstream"><ImpactBars n={node.affects} /> affects {node.affects}</span>}
        </div>
      </div>

      <div className="atlas-insp-body">
        <InspCard title="Facts">
          <dl className="atlas-kv">
            <dt>Type</dt><dd>{meta.label}{meta.module && <span className="inferred-tag" style={{ marginLeft: 4 }}>· {meta.module}</span>}</dd>
            {node.type === "task" && <><dt>Status</dt><dd><span className={"tr-status " + node.status} /> {TASK_STATUS_LABEL[node.status]}</dd></>}
            {node.affects > 0 && <><dt>Impact</dt><dd className="mono">score {node.impactScore} · affects {node.affects}</dd></>}
            {phase && <><dt>Phase</dt><dd>{phase.label} · {phase.title}</dd></>}
            {owner && <><dt>{ownerLabel}</dt><dd><RoleAvatar role={owner.meta} /> {owner.meta.name}{node.ownerBackfilled ? <span className="inferred-tag">backfilled</span> : null}</dd></>}
            {node.verdictAwaiting && index.byId[node.verdictAwaiting] && <><dt>Awaiting</dt><dd><RoleAvatar role={index.byId[node.verdictAwaiting].meta} /> {node.verdictAwaiting}</dd></>}
            {fresh && <><dt>Updated</dt><dd className="mono">{relTime(fresh)}</dd></>}
            <dt>Connections</dt><dd className="mono">{connectedTotal}{phase ? <span className="inferred-tag" style={{ marginLeft: 6 }}>+ phase</span> : null}</dd>
          </dl>
        </InspCard>

        {risk.length > 0 && (
          <InspCard title="Risk signals">
            <div className="filter-chips" style={{ padding: 0 }}>
              {risk.map(r => <span key={r} className="chip" style={{ color: r.includes("stale") || r === "needs-review" ? "var(--pr-p1)" : "var(--st-blocked)" }}>{RISK_LABEL[r] || r}</span>)}
            </div>
          </InspCard>
        )}

        {node.type === "message" && node.handoffTargetId && (
          <InspCard title="Handoff trace" eyebrow={node.handoffStale ? "stale > 72h" : "open"}>
            <div className={"atlas-handoff-trace" + (node.handoffStale ? " stale" : "")}>
              <div className="aht-row">
                <span className="aht-lab">Target</span>
                <ArtifactChip kind="task" id={node.handoffTargetId} label={node.handoffTargetId}
                              onClick={() => onSelect(node.handoffTargetId)} />
                {node.handoffTargetStatus && (
                  <span className="aht-status"><span className={"tr-status " + node.handoffTargetStatus} /> {TASK_STATUS_LABEL[node.handoffTargetStatus] || node.handoffTargetStatus}</span>
                )}
              </div>
              {node.handoffSentAt && (
                <div className="aht-row"><span className="aht-lab">Sent</span><span className="mono">{relTime(node.handoffSentAt)}</span></div>
              )}
              {node.handoffStale ? (
                <div className="aht-resend">
                  <AtlasGlyph name="stale" size={13} /> Stale handoff — target still open past the 72h rule.
                  {MODULE_FOR_TYPE[node.type] && <button className="btn" onClick={() => onOpenArtifact && onOpenArtifact(node)}><AtlasGlyph name="handoff" size={13} /> Resend in {MODULE_FOR_TYPE[node.type]}</button>}
                </div>
              ) : (
                <div className="aht-ok"><AtlasGlyph name="handoff" size={13} /> Handoff is within the 72h window — waiting on the target to close.</div>
              )}
            </div>
          </InspCard>
        )}

        <InspCard title="Source of truth">
          <div className="atlas-source"><AtlasGlyph name="link" size={12} /><span style={{ flex: 1 }}>{node.sourcePath}</span></div>
          <div style={{ marginTop: 8 }}><TrustChip confidence={sourceConfidence} /></div>
        </InspCard>

        <InspCard title={`Connected · ${connectedTotal}`}>
          {groupKeys.length === 0 && (
            <div className="atlas-orphan-note">
              <div className="on-head"><AtlasGlyph name="orphan" size={15} /> Orphan — no links in source</div>
              <p>Atlas couldn't connect {node.id} to any plan, message, decision, or owner. This isn't a render gap — it's the gap Atlas surfaces: in the legacy model most Khira tasks carry no <span className="mono">plan_ids</span> or <span className="mono">owner</span>.</p>
              <div className="on-actions">{MODULE_FOR_TYPE[node.type] && <button className="btn" onClick={() => onOpenArtifact && onOpenArtifact(node)}><AtlasGlyph name="link" size={13} /> Link in {MODULE_FOR_TYPE[node.type]}</button>}</div>
              <div className="on-foot">With the approved <span className="mono">plan_ids</span>/<span className="mono">owner</span> backfill, {node.id} resolves to real relationships — toggle Tweaks → <strong>Relationships → Extended</strong>.</div>
            </div>
          )}
          {groupKeys.map(key => {
            const g = groups[key];
            return (
              <div key={key} className="atlas-relgroup">
                <div className="rg-lab">{g.label}<span className="n">· {g.items.length}</span><TrustChip confidence={g.confidence} /></div>
                <div className="atlas-afc-wrap">
                  {g.items.map(on => <ArtifactChip key={on.id + g.label} kind={on.type} id={on.id} label={on.type === "role" ? on.meta.name : (on.label || on.id)} onClick={() => onSelect(on.id)} />)}
                </div>
              </div>
            );
          })}
        </InspCard>

        {verdicts.length > 0 && (
          <InspCard title={`Verdict trail · ${verdicts.length}`}>
            <div className="activity-list">
              {verdicts.map(v => {
                const colour = v.state === "rejected" || v.state === "blocked" ? "var(--st-blocked)" : v.state === "needs-review" ? "var(--pr-p1)" : v.state === "done" || v.state === "tested" || v.state === "approved" ? "var(--st-completed)" : "var(--text-4)";
                return (
                  <div key={v.id} className="activity-item">
                    <span className="activity-dot" style={{ background: colour }} />
                    <div>
                      <div className="activity-text"><span style={{ fontWeight: 600, color: colour }}>{fmtVState(v.state)}</span><span style={{ color: "var(--text-3)" }}> by {v.actor}</span>{v.note && <div style={{ marginTop: 2 }}>{v.note}</div>}</div>
                      <div className="activity-time">{relTime(v.at)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </InspCard>
        )}

        <InspCard title="Actions">
          <div className="atlas-insp-actions">
            {MODULE_FOR_TYPE[node.type] && <button className="btn primary" onClick={() => onOpenArtifact && onOpenArtifact(node)}><AtlasGlyph name="open" size={14} /> Open in {MODULE_FOR_TYPE[node.type]}<span className="sub">{node.id}</span></button>}
            <button className="btn" onClick={() => onFocus(node.id)}><AtlasGlyph name="focus" size={14} /> Trace on the map</button>
            <button className="btn" onClick={() => copy(node.id, "id")}><AtlasGlyph name="copy" size={14} /> {copied && copied.which === "id" ? (copied.ok ? "Copied id" : "Copy failed") : "Copy artifact id"}</button>
            <button className="btn" onClick={() => copy(node.sourcePath, "path")}><AtlasGlyph name="copy" size={14} /> {copied && copied.which === "path" ? (copied.ok ? "Copied path" : "Copy failed") : "Copy source path"}</button>
          </div>
        </InspCard>
      </div>
    </aside>
  );
}

window.AtlasInspector = AtlasInspector;
