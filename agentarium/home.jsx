// Agentarium — Home (command center)

const EMPTY_PLAN = {
  id: "—",
  title: "No plans in this phase",
  summary: "",
  checklist: { done: 0, total: 0 },
  sections: [],
  linkedTasks: 0,
  linkedMessages: 0,
  verdict: "",
};

function resolveRole(id) {
  return roleById(id) || { id: id || "?" };
}

function HomeView({ actingAs, activeProject, onNavigate, onOpenArtifact, onRefresh, onConnect, refreshing, editMode, reviewMode, activePhaseId, phases, verdicts: scopedVerdicts }) {
  const AG = window.AGENTARIUM;
  const activity = AG.ACTIVITY || [];
  const verdicts = scopedVerdicts || AG.VERDICTS || [];
  const plans = AG.PLANS || [];
  const messages = AG.MESSAGES || [];
  const decisions = AG.DECISIONS || [];
  const roles = AG.ROLES || [];

  const phaseData = React.useMemo(() => {
    if (!activeProject || !activePhaseId) return { tasks: [] };
    const ph = activeProject.phases.find((p) => p.id === activePhaseId);
    return ph && ph.data ? ph.data : { tasks: [] };
  }, [activeProject, activePhaseId]);

  const tasks = phaseData.tasks || [];
  const plansInPhase = activePhaseId
    ? plans.filter((p) => p.phase === activePhaseId)
    : plans;
  const messagesInPhase = activePhaseId
    ? messages.filter((m) => m.phase === activePhaseId)
    : messages;
  const pendingVerdicts = verdicts.filter((v) => v.state === "needs-review").length;
  const awaitingMe = verdicts.filter((v) => v.state === "needs-review" && v.awaiting && v.awaiting === actingAs).length;
  const activePlans = plansInPhase.filter((p) => p.status === "active").length;
  const unreadMsgs = messagesInPhase.filter((m) => m.status === "unread").length;
  const openTasks = tasks.filter((t) => t.status !== "completed").length;
  const inProgressTasks = tasks.filter((t) => t.status === "in_progress").length;
  const blockerCount = tasks.filter((t) => t.status === "blocked" || (t.blockers && t.blockers.length)).length;
  const shippedPlans = plansInPhase.filter((p) => p.status === "shipped").length;
  const activeDecisions = decisions.filter((d) => d.status === "active").length;
  const supersededDecisions = decisions.filter((d) => d.status === "superseded").length;

  const recentMsgs = messagesInPhase.slice()
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
    .slice(0, 4);
  const activePlan = plansInPhase.find((p) => p.status === "active")
    || plansInPhase[0]
    || EMPTY_PLAN;
  const pendingV = verdicts.filter((v) => v.state === "needs-review").slice(0, 6);
  const phaseMeta = phases && phases.find((p) => p.id === activePhaseId);
  const now = parseFlexibleDate(AG.NOW) || new Date();
  const activityLast24h = activity.filter((item) => {
    const at = parseFlexibleDate(item.at);
    if (!at) return false;
    const age = now - at;
    return age >= 0 && age <= 24 * 60 * 60 * 1000;
  });

  return (
    <div className="modbody" data-screen-label="Home">
      <ModuleHeader
        roomNo="00"
        eyebrow="Agentarium · Command Center"
        title="Today on the floor"
        subtitle={phaseMeta ? `${activeProject ? activeProject.name : "Unknown project"} · ${phaseMeta.name}` : (AG._source || "project-management/")}
        editMode={editMode}
        reviewMode={reviewMode}
        editPolicy={{ mode: "read-only", fields: ["dashboard view"] }}
        actions={
          <>
            <button type="button" className="btn" disabled={refreshing}
                    onClick={activeProject && (activeProject.dirLinked || activeProject.httpLinked || activeProject.fixture || activeProject.builtin) ? onRefresh : onConnect}>
              <Glyph name="refresh" size={14} />
              {refreshing ? 'Refreshing…' : activeProject && (activeProject.dirLinked || activeProject.httpLinked || activeProject.fixture || activeProject.builtin) ? 'Refresh from source' : 'Re-import JSON'}
            </button>
            <ReadOnlyBtn className="btn primary"><Glyph name="plus" size={14} /> New artifact</ReadOnlyBtn>
          </>
        }
      />

      {/* Status strip — five tiles */}
      <div className="home-strip" style={{ marginTop: 16 }}>
        <Tile
          eyebrow="Pending verdicts"
          val={pendingVerdicts}
          sub={awaitingMe ? `${awaitingMe} awaiting ${resolveRole(actingAs).id}` : `${pendingVerdicts} in queue`}
          tone="warn"
          onClick={() => onNavigate("verdicts")}
        />
        <Tile
          eyebrow="Active plans"
          val={activePlans}
          sub={`${shippedPlans} shipped · ${activePlans} active`}
          onClick={() => onNavigate("planroom")}
        />
        <Tile
          eyebrow="Unread messages"
          val={unreadMsgs}
          sub={`${messagesInPhase.length} total this phase`}
          onClick={() => onNavigate("courier")}
        />
        <Tile
          eyebrow="Open tasks"
          val={openTasks}
          sub={`${blockerCount} blocked · ${inProgressTasks} in progress`}
          tone="bad"
          onClick={() => onNavigate("khira")}
        />
        <Tile
          eyebrow="Decisions on record"
          val={activeDecisions}
          sub={`${supersededDecisions} superseded · ${decisions.length} total`}
          onClick={() => onNavigate("ledgers")}
        />
      </div>

      <div className="home-grid" style={{ marginTop: 16 }}>
        {/* Pending verdicts queue */}
        <div className="home-card" style={{ gridColumn: "1 / span 1", gridRow: "span 2" }}>
          <h3>
            <Glyph name="verdict" size={14} /> Pending verdicts
            <span className="h-meta">{pendingVerdicts} items · awaiting decision</span>
          </h3>
          <div className="verdict-q">
            {pendingV.map(v => (
              <VerdictQItem key={v.id} v={v} onOpen={() => { const t = verdictTarget(v); onOpenArtifact(t.kind, t.id); }} />
            ))}
          </div>
        </div>

        {/* Project roles */}
        <div className="home-card">
          <h3>
            <Glyph name="crew" size={14} /> Project roles
            <span className="h-meta">{roles.length} registered</span>
          </h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
            {roles.map(r => (
              <button key={r.id}
                      onClick={() => onNavigate("crews", { role: r.id })}
                      style={{
                        appearance: "none",
                        boxSizing: "border-box",
                        background: "var(--surface-2)",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        padding: "10px 12px",
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        font: "inherit",
                        color: "inherit",
                        textAlign: "left",
                        cursor: "pointer",
                      }}>
                <RoleAvatar role={r} showStatus />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>{r.id}</div>
                  <div style={{ fontSize: 10.5, color: "var(--text-3)", fontFamily: "var(--font-mono)" }}>
                    {r.tasks} tasks · {r.pending} pending
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Active plan */}
        <div className="home-card" style={{ gridColumn: "2", position: "relative" }}>
          <h3>
            <Glyph name="plan" size={14} /> Active plan
            <span className="h-meta">{activePlan.id} · {(activePlan.checklist || { done: 0, total: 0 }).done}/{(activePlan.checklist || { done: 0, total: 0 }).total} steps</span>
          </h3>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-0.01em" }}>{activePlan.title}</div>
              <p style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.5 }}>{activePlan.summary}</p>
              <div className="checkmile" style={{ marginTop: 14 }}>
                {(activePlan.sections || []).map((s, i) => (
                  <i key={i} className={s.done ? "done" : ""} title={s.title} />
                ))}
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
                {activePlan === EMPTY_PLAN ? (
                  <span className="tag">{activePlan.id}</span>
                ) : (
                  <ArtifactChip kind="plan" id={activePlan.id} label={activePlan.id} onClick={() => onNavigate("planroom", { plan: activePlan.id })} />
                )}
                <span className="tag">{activePlan.linkedTasks} tasks</span>
                <span className="tag">{activePlan.linkedMessages} messages</span>
                <Stamp state={activePlan.verdict} />
              </div>
            </div>
          </div>
        </div>

        {/* Recent messages */}
        <div className="home-card" style={{ gridColumn: "1 / span 2" }}>
          <h3>
            <Glyph name="courier" size={14} /> Signal Courier — recent
            <span className="h-meta">{unreadMsgs} unread · {messagesInPhase.length} this phase</span>
          </h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
            {recentMsgs.map(m => (
              <button key={m.id}
                      onClick={() => onNavigate("courier", { message: m.id })}
                      style={{
                        appearance: "none",
                        boxSizing: "border-box",
                        background: m.status === "unread" ? "var(--m-tint, var(--surface-2))" : "var(--surface-2)",
                        border: "1px solid " + (m.status === "unread" ? "var(--m-line, var(--border-strong))" : "var(--border)"),
                        borderLeft: m.status === "unread" ? "3px solid oklch(60% 0.16 60)" : "1px solid var(--border)",
                        borderRadius: 8,
                        padding: "10px 12px",
                        font: "inherit",
                        color: "inherit",
                        textAlign: "left",
                        cursor: "pointer",
                      }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span className={"tag kind-" + m.kind}>{m.kind}</span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-3)", marginLeft: "auto" }}>
                    {relTime(m.date)}
                  </span>
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: "-0.005em", lineHeight: 1.3, marginBottom: 6 }}>
                  {m.subject}
                </div>
                <RolePair fromId={messageFromId(m)} toId={messageToId(m)} via={m.via} />
              </button>
            ))}
          </div>
        </div>

        {/* Cross-module ticker */}
        <div className="home-card" style={{ gridColumn: "1 / span 2" }}>
          <h3>
            <Glyph name="circle" size={14} /> Project ticker
            <span className="h-meta">cross-module activity · last 24h</span>
          </h3>
          <div className="ticker">
            {activityLast24h.slice(0, 8).map((a, i) => (
              <TickerRow key={i} a={a} onOpen={(k, id) => onOpenArtifact(k, id)} />
            ))}
            {activityLast24h.length === 0 && (
              <div className="empty-note">No cross-module activity in the last 24 hours.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Tile({ eyebrow, val, sub, tone, onClick }) {
  return (
    <button onClick={onClick} style={{ appearance: "none", boxSizing: "border-box", background: "none", border: "none", borderRadius: 0, padding: 0, font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer", display: "block", position: "static", overflow: "visible" }} className="home-tile">
      <div className="ht-eyebrow">{eyebrow}</div>
      <div className="ht-val" style={tone === "warn" ? { color: "oklch(58% 0.16 70)" } :
                                  tone === "bad"  ? { color: "var(--st-blocked)" } : null}>
        {val}
      </div>
      <div className="ht-sub">{sub}</div>
    </button>
  );
}

function VerdictQItem({ v, onOpen }) {
  const target = verdictTarget(v);
  const actor = v.actor ? resolveRole(v.actor) : null;
  const awaiting = v.awaiting ? resolveRole(v.awaiting) : null;
  return (
    <button
      className="vq-item"
      onClick={onOpen}
      style={{
        appearance: "none",
        boxSizing: "border-box",
        background: "none",
        borderLeft: "none",
        borderRight: "none",
        borderBottom: "none",
        font: "inherit",
        color: "inherit",
        textAlign: "left",
      }}
    >
      <Stamp state={v.state} />
      <div style={{ minWidth: 0 }}>
        <div className="vq-title">{v.note || v.title}</div>
        <div className="vq-meta">
          <ArtifactChip kind={target.kind} id={target.id} />
          <span>·</span>
          {actor ? <><span>reviewed by</span><RoleAvatar role={actor} /><span>{actor.id}</span></> : <span>Reviewer unrecorded</span>}
          {awaiting && (
            <>
              <span>·</span>
              <span>awaiting</span>
              <RoleAvatar role={awaiting} />
              <span>{awaiting.id}</span>
            </>
          )}
        </div>
      </div>
      <div className="vq-when">{relTime(v.at)}</div>
    </button>
  );
}

function TickerRow({ a, onOpen }) {
  const actor = resolveRole(a.actor);
  let nav = null;
  if (a.kind === "message" && msgById(a.target)) nav = { kind: "message", id: a.target };
  else if (a.kind === "plan" && planById(a.target)) nav = { kind: "plan", id: a.target };
  else if (a.kind === "decision" && decById(a.target)) nav = { kind: "decision", id: a.target };
  let body;
  switch (a.kind) {
    case "message":
      body = <>sent message <strong>{msgById(a.target)?.subject?.slice(0, 80) || a.target}</strong> {a.verb}</>;
      break;
    case "plan":
      body = <>{a.verb} plan <strong>{planById(a.target)?.title || a.target}</strong></>;
      break;
    case "decision":
      body = <>{a.verb} decision <strong>{decById(a.target)?.title || a.target}</strong></>;
      break;
    case "verdict":
      body = <>{a.verb} on <strong>{a.target}</strong></>;
      break;
    case "open":
      body = <>opened <strong>{a.target}</strong></>;
      break;
    default:
      body = <>{a.verb || a.kind} <strong>{a.target}</strong></>;
  }
  const content = (
    <>
      <span className="ticker-when">{relTime(a.at)}</span>
      <div className="ticker-text">
        <RoleAvatar role={actor} /> <strong>{actor.id}</strong> {body}
      </div>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-4)" }}>{a.kind}</span>
    </>
  );
  if (!nav) {
    return (
      <div className="ticker-row">{content}</div>
    );
  }
  return (
    <button
      className="ticker-row"
      onClick={() => onOpen(nav.kind, nav.id)}
      style={{
        appearance: "none",
        background: "none",
        borderLeft: "none",
        borderRight: "none",
        borderBottom: "none",
        fontFamily: "inherit",
        fontWeight: "inherit",
        fontStyle: "inherit",
        color: "inherit",
        textAlign: "left",
        cursor: "pointer",
      }}
    >
      {content}
    </button>
  );
}

window.HomeView = HomeView;
