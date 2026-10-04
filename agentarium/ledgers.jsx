// Agentarium — Ledgers (stamped decision records)

function ledgerPhaseScopeLabel(activePhaseId, scope) {
  if (!activePhaseId) return "all phases";
  if (scope === "strict") return `${activePhaseId} only`;
  return `${activePhaseId} + cross-phase policy`;
}

function decisionVisible(d, activePhaseId, scope) {
  if (!activePhaseId || scope === "all") return true;
  if (scope === "strict") return d.phase === activePhaseId;
  if (d.phase === activePhaseId) return true;
  const planInPhase = (d.affects?.plans || []).some((pid) => {
    const p = AG.PLANS.find((x) => x.id === pid);
    return p && p.phase === activePhaseId;
  });
  if (planInPhase) return true;
  if (d.status === "active" && d.phase) {
    const dn = parseInt(String(d.phase).replace(/\D/g, ""), 10) || 0;
    const an = parseInt(String(activePhaseId).replace(/\D/g, ""), 10) || 0;
    if (an >= dn) return true;
  }
  return false;
}

function LedgersView({ openDecision, onNavigate, onOpenArtifact, editMode, reviewMode, activePhaseId }) {
  const [filter, setFilter] = React.useState("all"); // all | active | superseded
  const [phaseScope, setPhaseScope] = React.useState("relevant"); // relevant | strict | all
  const [selected, setSelected] = React.useState(openDecision || null);
  const cardRefs = React.useRef({});

  const decs = AG.DECISIONS
    .filter((d) => decisionVisible(d, activePhaseId, phaseScope))
    .filter((d) => filter === "all" ? true : d.status === filter);

  const linkedHidden = !!openDecision
    && AG.DECISIONS.some((d) => d.id === openDecision)
    && !decs.some((d) => d.id === openDecision);

  // Deep-link intake: select the routed decision and relax the status filter once
  // if it would otherwise hide the target. Phase scope is left to the user — the
  // hidden-decision notice below offers the explicit reveal action.
  React.useEffect(() => {
    if (!openDecision) return;
    setSelected(openDecision);
    const hit = AG.DECISIONS.find((d) => d.id === openDecision);
    if (hit && filter !== "all" && hit.status !== filter) setFilter("all");
  }, [openDecision]);

  // Scroll the selected card into view on selection change and when a hidden
  // target is newly revealed by relaxing filters (linkedHidden true -> false).
  React.useEffect(() => {
    if (linkedHidden || !selected) return;
    const el = cardRefs.current[selected];
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected, linkedHidden]);

  return (
    <div className="modbody" data-screen-label="Ledgers">
      <ModuleHeader
        roomNo="04"
        eyebrow="Ledgers · Durable Memory"
        title="Decisions on record"
        subtitle={`${decs.filter((d) => d.status === "proposed").length} pending · ${decs.filter((d) => d.status === "active").length} active · ${decs.filter((d) => d.status === "superseded").length} superseded · ${ledgerPhaseScopeLabel(activePhaseId, phaseScope)}`}
        editMode={editMode}
        reviewMode={reviewMode}
        editPolicy={{ mode: "read-only", fields: ["append-only · record via repo"] }}
        actions={
          <>
            <PhaseScopeSeg value={phaseScope} onChange={setPhaseScope} />
            <FilterSeg2 value={filter} onChange={setFilter} />
            <ReadOnlyBtn className="btn primary"><Glyph name="plus" size={14} /> Record decision</ReadOnlyBtn>
          </>
        }
      />
      <PmSourceBanner readOnly />

      <div className="ledger-toolbar" style={{ marginTop: 18 }}>
        <strong>BOOK 04</strong>
        <span>· {activePhaseId ? activePhaseId.toUpperCase() : "All phases"}</span>
        <span>· Append-only</span>
        <span className="ledger-counter">{decs.length} entries</span>
      </div>

      {linkedHidden && (
        <div className="note-card" style={{ marginTop: 12 }}>
          Decision <strong>{openDecision}</strong> is on record but hidden by the current phase/status filters.{" "}
          <button type="button" className="btn"
                  onClick={() => { setPhaseScope("all"); setFilter("all"); }}>
            Show all phases &amp; statuses
          </button>
        </div>
      )}

      <div className="ledger-wrap">
        {decs.length === 0 && (
          <div className="note-card" style={{ gridColumn: "1 / -1" }}>
            {phaseScope !== "all"
              ? (<>No decisions match this phase scope. Try <strong>Relevant</strong> or <strong>All phases</strong> to include cross-phase policy records.</>)
              : filter !== "all"
                ? (<>No {filter === "proposed" ? "pending" : filter} decisions under this scope. Set the status filter back to <strong>All</strong> to widen the net.</>)
                : (<>Nothing is on record yet. Decisions appear here once recorded in the repo.</>)}
          </div>
        )}
        {decs.map((d) => (
          <LedgerCard key={d.id}
                      d={d}
                      activePhaseId={activePhaseId}
                      selected={selected === d.id}
                      cardRef={(el) => {
                        if (el) cardRefs.current[d.id] = el;
                        else delete cardRefs.current[d.id];
                      }}
                      onClick={() => setSelected(d.id)}
                      onOpenArtifact={onOpenArtifact}
                      onNavigate={onNavigate} />
        ))}
      </div>

      {/* AG-P11.5 Maestro run trail (audit). Read-only surface over the append-only
          run records. The runtime NEVER writes pm_* verdicts; the verdict pointer is
          a Reviewer-only seam, shown but never set here. */}
      <MaestroRunTrail />
    </div>
  );
}

// Compact, READ-ONLY audit surface over the append-only Maestro run records
// (AG.RUNS, loaded by pm-loader from project-management/runs/). The full run-trail
// inspector is a later increment; this lands the Ledgers tie-in: the run trail is
// surfaced as durable audit memory, provenance-stamped, with the Reviewer-only
// verdict seam visible (never written here — runtime writes no pm_*/verdicts).
function MaestroRunTrail() {
  const RUN_TRAIL_LIMIT = 12;
  const allRuns = (typeof AG !== "undefined" && Array.isArray(AG.RUNS)) ? AG.RUNS : [];
  if (!allRuns.length) return null;
  // A run emits one append-only record PER lifecycle transition (the trail). For
  // the audit summary we collapse to ONE row per run_id — the most-advanced record
  // (latest provenance timestamp) — so the operator reads one line per conducted
  // run. The full per-transition trail remains on disk under runs/.
  const latestByRun = new Map();
  for (const r of allRuns) {
    const rid = r.run_id || r.record_id || r._file;
    const at = (r._provenance && r._provenance.at) || r.at || "";
    const prev = latestByRun.get(rid);
    const prevAt = prev ? ((prev._provenance && prev._provenance.at) || prev.at || "") : "";
    if (!prev || String(at).localeCompare(String(prevAt)) >= 0) latestByRun.set(rid, r);
  }
  const sorted = Array.from(latestByRun.values()).sort((a, b) => {
    const ta = (a._provenance && a._provenance.at) || a.at || "";
    const tb = (b._provenance && b._provenance.at) || b.at || "";
    return String(tb).localeCompare(String(ta));
  });
  return (
    <div className="ledger-runtrail" style={{ marginTop: 26 }}>
      <div className="ledger-toolbar">
        <strong>RUN TRAIL</strong>
        <span>· Maestro</span>
        <span>· Append-only audit</span>
        <span className="ledger-counter">{sorted.length} run{sorted.length === 1 ? "" : "s"} · {allRuns.length} record{allRuns.length === 1 ? "" : "s"}</span>
      </div>
      <ul className="ledger-runtrail-list" style={{ listStyle: "none", padding: 0, margin: "10px 0 0" }}>
        {sorted.slice(0, RUN_TRAIL_LIMIT).map((r, i) => {
          const prov = r._provenance || {};
          const tasks = (r.attached_tasks || []).map((t) => t.id).filter(Boolean);
          return (
            <li key={r.record_id || r.run_id || i} className="ledger-runtrail-row dept-reg"
                style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap",
                         padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
              <code style={{ fontSize: 11.5, color: "var(--text)" }}>{r.run_id || "run"}</code>
              <span className={`ledger-runstate state-${r.status || "queued"}`}
                    style={{ fontSize: 11, fontWeight: 600, color: "var(--text-2)" }}>{r.status || "—"}</span>
              {tasks.length ? <span style={{ fontSize: 11, color: "var(--text-3)" }}>{tasks.join(", ")}</span> : null}
              <span style={{ fontSize: 11, color: "var(--text-3)" }}
                    title="Representational simulated effort — never money">
                {(r.effort_units || 0)} effort unit{r.effort_units === 1 ? "" : "s"}
              </span>
              <span style={{ fontSize: 10.5, color: "var(--text-3)", marginLeft: "auto" }}>
                {prov.persona ? `by ${prov.persona}` : (r.acting_persona ? `by ${r.acting_persona}` : "")}
                {prov.at ? ` · ${prov.at}` : (r.at ? ` · ${r.at}` : "")}
              </span>
              <span className="ledger-runverdict"
                    style={{ fontSize: 10.5, color: r.verdict_ref ? "var(--text-2)" : "var(--text-3)" }}
                    title="Reviewer-only verdict sign-off (never written by the runtime)">
                {r.verdict_ref ? "verdict on record" : "awaiting Reviewer verdict"}
              </span>
            </li>
          );
        })}
        {sorted.length > RUN_TRAIL_LIMIT && (
          <li style={{ fontSize: 11, color: "var(--text-3)", padding: "6px 10px", listStyle: "none" }}>
            Showing latest {RUN_TRAIL_LIMIT} of {sorted.length} runs · {allRuns.length} record{allRuns.length === 1 ? "" : "s"} total
          </li>
        )}
      </ul>
      <p className="ledger-runtrail-note" style={{ fontSize: 11, color: "var(--text-3)", marginTop: 8 }}>
        Append-only run records, provenance-stamped (acting persona + timestamp). Verdict sign-off is Reviewer-only —
        the runtime writes no <code>pm_*</code> fields. Effort is representational simulated load, never money.
      </p>
    </div>
  );
}

function PhaseScopeSeg({ value, onChange }) {
  const opts = [
    { v: "relevant", l: "Relevant" },
    { v: "strict", l: "This phase" },
    { v: "all", l: "All phases" },
  ];
  return (
    <div role="group" aria-label="Phase scope" style={{
      display: "inline-flex", background: "var(--surface-2)", border: "1px solid var(--border)",
      borderRadius: 8, padding: 2, marginRight: 6,
    }}>
      {opts.map((o) => (
        <button key={o.v} type="button" aria-pressed={value === o.v} onClick={() => onChange(o.v)} style={{
          background: value === o.v ? "var(--bg-elev)" : "transparent",
          boxShadow: value === o.v ? "var(--shadow-1)" : "none",
          color: value === o.v ? "var(--text)" : "var(--text-3)",
          border: "none", padding: "5px 10px", borderRadius: 6, fontSize: 11.5,
          fontWeight: 600, cursor: "pointer",
        }}>
          {o.l}
        </button>
      ))}
    </div>
  );
}

function FilterSeg2({ value, onChange }) {
  const opts = [
    { v: "all", l: "All" },
    { v: "proposed", l: "Pending" },
    { v: "active", l: "Active" },
    { v: "superseded", l: "Superseded" },
  ];
  return (
    <div role="group" aria-label="Status filter" style={{
      display: "inline-flex", background: "var(--surface-2)", border: "1px solid var(--border)",
      borderRadius: 8, padding: 2,
    }}>
      {opts.map((o) => (
        <button key={o.v} type="button" aria-pressed={value === o.v} onClick={() => onChange(o.v)} style={{
          background: value === o.v ? "var(--bg-elev)" : "transparent",
          boxShadow: value === o.v ? "var(--shadow-1)" : "none",
          color: value === o.v ? "var(--text)" : "var(--text-3)",
          border: "none", padding: "5px 12px", borderRadius: 6, fontSize: 11.5,
          fontWeight: 600, cursor: "pointer",
        }}>
          {o.l}
        </button>
      ))}
    </div>
  );
}

function LedgerCard({ d, activePhaseId, selected, cardRef, onClick, onOpenArtifact, onNavigate }) {
  const ownerId = d.decidedBy || d.owner || null;
  const by = ownerId ? roleById(ownerId) : null;
  const affects = d.affects || { plans: [], taskIds: [], tasks: 0, messages: 0 };
  const plans = affects.plans || [];
  const taskIds = affects.taskIds || [];
  const witnesses = Array.isArray(d.witnesses) ? [...new Set(d.witnesses)] : [];
  const options = d.options || [];
  const pending = d.status === "proposed" || d.verdict === "proposed";
  // Defensive default only: pm-loader's normalizeDecision always stamps verdict,
  // so "draft" below is unreachable through loaded data.
  const seal = pending ? "proposed"
              : d.verdict === "approved" ? "approved"
              : d.verdict === "rejected" ? "rejected"
              : d.verdict === "superseded" ? "superseded" : "draft";
  const inscription = pending ? "Pending"
                    : d.verdict === "approved" ? "Approved"
                    : d.verdict === "rejected" ? "Rejected"
                    : d.verdict === "superseded" ? "Voided" : "Draft";
  const approver = pending && d.approver ? roleById(d.approver) : null;
  const linkedMsgs = AG.MESSAGES.filter((m) => m.linkedDecisions && m.linkedDecisions.includes(d.id));
  const crossPhase = activePhaseId && d.phase && d.phase !== activePhaseId
    && d.status === "active";
  return (
    <article ref={cardRef}
             className={"ledger-card " + (d.status === "superseded" ? "superseded " : "") + (pending ? "proposed" : "")}
             style={selected ? { outline: "2px solid var(--text)", outlineOffset: 2 } : undefined}
             role="button"
             aria-pressed={!!selected}
             tabIndex={0}
             onClick={onClick}
             onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}>
      <div className="ledger-head">
        <div className="ledger-serial">
          <strong>{d.id}</strong>
          {fmtDate(d.at)}
          {pending && (
            <span className="ledger-pending-pill" style={{
              display: "inline-flex", alignItems: "center", gap: 4, marginTop: 6,
              padding: "3px 8px", borderRadius: 6,
              background: "oklch(70% 0.16 75 / 0.16)", color: "oklch(58% 0.16 75)",
              border: "1px solid oklch(70% 0.16 75 / 0.42)",
              fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 700,
              letterSpacing: "0.12em", textTransform: "uppercase",
            }}>
              ● Pending approval
            </span>
          )}
          {crossPhase && (
            <span className="tag" style={{ display: "block", marginTop: 4, fontSize: 10 }}>
              cross-phase · {d.phase}
            </span>
          )}
        </div>
        <div>
          <h3 className="ledger-title">{d.title}</h3>
          <div className="ledger-byline">
            <span>{d.decidedBy ? "Decided by" : "Owner"}</span>
            {by && <RoleAvatar role={by} />}
            <strong style={{ color: "var(--text)" }}>{ownerId || "unrecorded"}</strong>
            <span className="at">· {fmtDateTime(d.at)}</span>
            {pending && approver && (
              <>
                <span>· Awaiting</span>
                <RoleAvatar role={approver} />
                <strong style={{ color: "oklch(58% 0.16 75)" }}>{approver.id}</strong>
              </>
            )}
            {!pending && witnesses.length > 0 && (
              <>
                <span>· Witnessed</span>
                {witnesses.map((w) => {
                  const r = roleById(w);
                  return <RoleAvatar key={w} role={r} />;
                })}
              </>
            )}
          </div>
        </div>
        <div className="ledger-seal-slot">
          <Seal kind={seal} inscription={inscription} subtext={d.seal} />
        </div>
      </div>

      <div className="ledger-body">
        <div className="ledger-block">
          <h4>Why</h4>
          <div className="why">{d.why || d.summary || "—"}</div>
        </div>

        {options.length > 0 && (
          <div className="ledger-block">
            <h4>Options on the table</h4>
            <div className="ledger-opts">
              {options.map((o, i) => (
                <div key={i} className={"ledger-opt " + (o.chosen ? "chosen" : "")}>
                  <span className="mark">{o.chosen ? "✓" : "✕"}</span>
                  <span>{o.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="ledger-affects">
        <span style={{
          fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.14em",
          textTransform: "uppercase", color: "var(--text-3)", fontWeight: 700,
          alignSelf: "center", marginRight: 4,
        }}>Affects</span>

        {plans.map((pid) => (
          <ArtifactChip key={pid} kind="plan" id={pid}
                        onClick={(e) => { e.stopPropagation(); onNavigate("planroom", { plan: pid }); }} />
        ))}
        {taskIds.map((tid) => (
          <ArtifactChip key={tid} kind="task" id={tid}
                        onClick={(e) => { e.stopPropagation(); onOpenArtifact("task", tid); }} />
        ))}
        {!taskIds.length && affects.tasks > 0 && (
          <ArtifactChip kind="task" id={`${affects.tasks} tasks`} label={`${affects.tasks} tasks`}
                        onClick={(e) => { e.stopPropagation(); onNavigate("khira"); }} />
        )}
        {linkedMsgs.map((m) => (
          <ArtifactChip key={m.id} kind="message" id={m.id} label={m.id.split("-").slice(-1)[0]}
                        onClick={(e) => { e.stopPropagation(); onOpenArtifact("message", m.id); }} />
        ))}
        {(affects.messages > linkedMsgs.length) && (
          <span className="tag" style={{ fontSize: 10 }}>+{affects.messages - linkedMsgs.length} cited in thread</span>
        )}

        {d.status === "superseded" && (
          <span className="tag" style={{ marginLeft: "auto", color: "var(--text-3)" }}>This entry voided</span>
        )}
      </div>
    </article>
  );
}

window.LedgersView = LedgersView;
