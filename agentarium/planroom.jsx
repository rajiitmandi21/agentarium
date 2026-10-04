// Agentarium — Planroom (mission wall / blueprint)

function activateOnKey(fn) {
  return (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };
}

function PlanProgressMile({ label, done, total, variant, alwaysShow }) {
  const n = Math.max(0, Number(total) || 0);
  const d = Math.max(0, Number(done) || 0);
  if (!alwaysShow && n < 1) return null;
  const cap = n >= 1 ? Math.min(n, 32) : 1;
  const filled = n >= 1 ? Math.round((d / n) * cap) : 0;
  const empty = n < 1;
  return (
    <div className={"plan-progress-block" + (variant ? " plan-progress-" + variant : "") + (empty ? " plan-progress-empty" : "")}>
      <div className="checkmile-row">
        <span>{label}</span>
        <span>
          {empty
            ? <span style={{ color: "var(--text-3)", fontWeight: 400 }}>none in plan</span>
            : <><strong>{d}</strong>/{n}</>}
        </span>
      </div>
      <div className="checkmile">
        {Array.from({ length: cap }, (_, i) => (
          <i key={i} className={!empty && i < filled ? "done" : ""} />
        ))}
      </div>
    </div>
  );
}

function PlanroomView({ openPlan, onNavigate, onOpenArtifact, editMode, reviewMode, edits, onPatch, activePhaseId, phases }) {
  const allPlans = AG.PLANS;
  const phasePlans = activePhaseId
    ? allPlans.filter(p => p.phase === activePhaseId)
    : allPlans;
  const openPlanValid = openPlan && allPlans.some((p) => p.id === openPlan) ? openPlan : null;
  const [selected, setSelected] = React.useState(openPlanValid || (phasePlans[0] && phasePlans[0].id) || null);
  React.useEffect(() => {
    if (openPlanValid) {
      setSelected(openPlanValid);
      return;
    }
    if (!phasePlans.some((p) => p.id === selected)) {
      setSelected((phasePlans[0] && phasePlans[0].id) || null);
    }
  }, [openPlan, activePhaseId, allPlans]);

  // Explicit cross-module navigation may pin one out-of-phase plan; ordinary
  // phase changes always reconcile selection back into the visible corridor.
  const visiblePlans = openPlanValid && !phasePlans.some((p) => p.id === openPlanValid)
    ? phasePlans.concat(allPlans.filter((p) => p.id === openPlanValid))
    : phasePlans;

  // Merge edits overlay onto plan
  function withEdits(p) {
    const e = edits && edits[p.id];
    if (!e) return p;
    let next = { ...p, ...e };
    if (e.sections) {
      // sections is { [sectionId]: { done: bool } }
      next.sections = (p.sections || []).map(s => e.sections[s.id] ? { ...s, ...e.sections[s.id] } : s);
      next.checklist = {
        total: next.sections.length,
        done: next.sections.filter(s => s.done).length,
      };
    }
    return next;
  }

  const plan = selected ? withEdits(visiblePlans.find(p => p.id === selected) || visiblePlans[0]) : null;

  const canEdit = false;

  function toggleSection(planId, sectionId, current) {
    if (!canEdit || !edits) return;
    onPatch(planId, {
      sections: {
        ...(edits[planId]?.sections || {}),
        [sectionId]: { done: !current },
      },
    });
  }

  return (
    <div className="modbody" style={{ padding: 0 }} data-screen-label="Planroom">
      <ModuleHeader
        roomNo="02"
        eyebrow="Planroom · Mission Wall"
        title="Plans"
        subtitle={`${visiblePlans.filter(p => p.status === "active").length} active in this phase · ${allPlans.filter(p => p.status === "shipped").length} shipped overall`}
        editMode={editMode}
        reviewMode={reviewMode}
        editPolicy={{ mode: "read-only", fields: ["view · export via repo"] }}
        actions={
          <>
            <ReadOnlyBtn className="btn"><Glyph name="folder" size={14} /> Open plan file</ReadOnlyBtn>
            <ReadOnlyBtn className="btn primary"><Glyph name="plus" size={14} /> New plan</ReadOnlyBtn>
          </>
        }
      />
      <PmSourceBanner readOnly />
      <div className="plan-room">
        <div className="split-2">
          <div className="plan-grid">
            {visiblePlans.map(p => (
              <PlanCard key={p.id}
                        plan={withEdits(p)}
                        active={p.id === selected}
                        editMode={editMode}
                        phases={phases}
                        onClick={() => setSelected(p.id)} />
            ))}
          </div>

          {plan ? (
            <PlanDetail plan={plan}
                        editMode={editMode}
                        reviewMode={reviewMode}
                        phases={phases}
                        onToggleSection={toggleSection}
                        onOpenArtifact={onOpenArtifact}
                        onNavigate={onNavigate} />
          ) : (
            <div className="note-card" style={{ margin: 18 }}>No plan selected. Pick a plan from the wall.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function PlanCard({ plan, active, onClick, editMode, phases }) {
  const author = roleById(plan.author);
  const allSections = plan.sections || [];
  const allTaskSections = plan.taskSections || [];
  const maxShownTasks = plan.checklist && plan.checklist.total > 0 ? 2 : 4;
  const shownSections = Math.min(allSections.length, 3);
  const shownTaskSections = Math.min(allTaskSections.length, maxShownTasks);
  const moreCount = allSections.length + allTaskSections.length - shownSections - shownTaskSections;
  return (
    <div className={"plan-card " + (active ? "active" : "") + (plan.status === "superseded" ? " superseded" : "")}
         style={{ "--hue": active ? "var(--m-hue)" : 195 }}
         role="button"
         aria-pressed={active}
         tabIndex={0}
         onClick={onClick}
         onKeyDown={activateOnKey(onClick)}>
      {plan.status === "active" && <div className="plan-card-pin" />}
      <div className="plan-card-head">
        <div className="plan-card-eye">
          {plan.id} · {plan.status}
          {plan.phase && <span style={{ marginLeft: 8 }}><PhaseChip phaseId={plan.phase} phases={phases} /></span>}
        </div>
        <div className="plan-card-title">{plan.title}</div>
        <div className="plan-card-sum">{plan.summary}</div>
      </div>

      <div className="plan-card-meta">
        <span><strong>By</strong> {plan.author}</span>
        <span><strong>Updated</strong> {relTime(plan.updated)}</span>
        <span><strong>Path</strong> <code style={{ background: "var(--surface-2)", padding: "1px 5px", borderRadius: 3 }}>{plan.path}</code></span>
      </div>

      <div className="plan-card-body">
        <PlanProgressMile
          label="Checklist"
          done={(plan.checklist && plan.checklist.done) || 0}
          total={(plan.checklist && plan.checklist.total) || 0}
          variant="checklist"
          alwaysShow />
        <PlanProgressMile
          label="Tasks"
          done={(plan.taskProgress && plan.taskProgress.done) || 0}
          total={(plan.taskProgress && plan.taskProgress.total) || 0}
          variant="tasks"
          alwaysShow />

        {(allSections.length > 0 || allTaskSections.length > 0) && (
          <div className="plan-sections">
            {allSections.length > 0 && allSections.slice(0, shownSections).map(s => (
              <div key={s.id} className={"plan-sec " + (s.done ? "done" : "")}>
                <span className="check"></span>
                <span className="pt">{s.title}</span>
              </div>
            ))}
            {allTaskSections.length > 0 && allTaskSections.slice(0, shownTaskSections).map(s => (
              <div key={s.id} className={"plan-sec " + (s.done ? "done" : "")}>
                <span className="check"></span>
                <span className="pt">{s.title}</span>
              </div>
            ))}
            {moreCount > 0 && (
              <div className="plan-sec" style={{ color: "var(--text-3)" }}>
                <span className="check" style={{ visibility: "hidden" }}></span>
                <span className="pt" style={{ fontStyle: "italic" }}>
                  + {moreCount} more items
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="plan-card-foot">
        <RoleAvatar role={author} />
        <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>
          {(plan.reviewers || []).length} reviewer{(plan.reviewers || []).length === 1 ? "" : "s"}
        </span>
        <div className="ms">
          <Stamp state={plan.verdict} />
        </div>
      </div>
    </div>
  );
}

function PlanDetail({ plan, onOpenArtifact, onNavigate, editMode, reviewMode, phases, onToggleSection }) {
  if (!plan) return null;
  const author = roleById(plan.author);
  const linkedMsgs = AG.MESSAGES.filter(m => m.linkedPlan === plan.id);
  const linkedDecs = AG.DECISIONS.filter(d => d.affects && d.affects.plans && d.affects.plans.includes(plan.id));

  return (
    <div className="plan-detail" data-plan-id={plan.id} data-plan-phase={plan.phase || ""} style={{ position: "sticky", top: 18 }}>
      <div className="plan-detail-head">
        <div className="modhead-eyebrow" style={{ marginBottom: 6 }}>
          <span className="rno">{plan.id}</span>
          <span>Plan detail · {plan.status.toUpperCase()}</span>
          {plan.phase && <PhaseChip phaseId={plan.phase} phases={phases} />}
          <span style={{ marginLeft: "auto" }}>
            <Stamp state={plan.verdict} />
          </span>
        </div>
        <h2 style={{ margin: "4px 0 0", fontSize: 18, letterSpacing: "-0.015em", fontWeight: 600, lineHeight: 1.25 }}>{plan.title}</h2>
        <div style={{ display: "flex", gap: 14, marginTop: 10, fontSize: 11.5, color: "var(--text-3)", fontFamily: "var(--font-mono)" }}>
          <span><RoleAvatar role={author} /> by <strong style={{ color: "var(--text-2)" }}>{(author && author.id) || plan.author}</strong></span>
          <span>updated {fmtDate(plan.updated)}</span>
        </div>
      </div>

      <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 18 }}>
        <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <PlanProgressMile label="Checklist" done={(plan.checklist && plan.checklist.done) || 0} total={(plan.checklist && plan.checklist.total) || 0} variant="checklist" alwaysShow />
          <PlanProgressMile label="Tasks" done={(plan.taskProgress && plan.taskProgress.done) || 0} total={(plan.taskProgress && plan.taskProgress.total) || 0} variant="tasks" alwaysShow />
          <p style={{ margin: 0, fontSize: 11, color: "var(--text-3)", lineHeight: 1.45 }}>
            Checklist tracks markdown <code>- [ ]</code> items in the plan file. Tasks tracks linked Khira tasks with <code>status: completed</code>.
          </p>
        </section>

        {/* Summary + checklist */}
        <section>
          <h4 style={{ margin: "0 0 8px", fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--text-3)", fontWeight: 700 }}>Summary</h4>
          <p style={{ margin: 0, fontSize: 13, color: "var(--text)", lineHeight: 1.55, padding: editMode ? "6px 8px" : 0 }}>
            {plan.summary}
          </p>
        </section>

        {(plan.checklist && plan.checklist.total > 0) && (
          <section>
            <h4 style={{ margin: "0 0 8px", fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--text-3)", fontWeight: 700 }}>
              Checklist · {plan.checklist.done}/{plan.checklist.total}
            </h4>
            <div className="plan-sections">
              {(plan.sections || []).map(s => (
                <div key={s.id}
                     className={"plan-sec " + (s.done ? "done" : "")}
                     style={{ cursor: "default" }}>
                  <span className="check"></span>
                  <span className="pt" style={{ fontFamily: "var(--font-sans)" }}>{s.title}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {(plan.taskProgress && plan.taskProgress.total > 0) && (
          <section>
            <h4 style={{ margin: "0 0 8px", fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--text-3)", fontWeight: 700 }}>
              Linked tasks · {plan.taskProgress.done}/{plan.taskProgress.total}
            </h4>
            <div className="plan-sections">
              {(plan.taskSections || []).map(s => (
                <div key={s.id} className={"plan-sec " + (s.done ? "done" : "")}
                     style={{ cursor: s.taskId ? "pointer" : "default" }}
                     role={s.taskId ? "button" : undefined}
                     tabIndex={s.taskId ? 0 : undefined}
                     onClick={() => s.taskId && onOpenArtifact("task", s.taskId)}
                     onKeyDown={s.taskId ? activateOnKey(() => onOpenArtifact("task", s.taskId)) : undefined}>
                  <span className="check"></span>
                  <span className="pt" style={{ fontFamily: "var(--font-sans)" }}>{s.title}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Linked artifacts */}
        <section>
          <h4 style={{ margin: "0 0 8px", fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--text-3)", fontWeight: 700 }}>Linked</h4>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {(plan.task_ids || []).map((tid) => (
              <ArtifactChip key={tid} kind="task" id={tid} label={tid}
                            onClick={() => onOpenArtifact("task", tid)} />
            ))}
            {!plan.task_ids?.length && plan.linkedTasks > 0 && (
              <ArtifactChip kind="task" id={`${plan.linkedTasks} tasks`} label={`${plan.linkedTasks} linked (count only)`}
                            onClick={() => onNavigate("khira")} />
            )}
            {linkedMsgs.map(m => (
              <ArtifactChip key={m.id} kind="message" id={m.id} label={m.id.split("-").slice(-1)[0]}
                            onClick={() => onOpenArtifact("message", m.id)} />
            ))}
            {linkedDecs.map(d => (
              <ArtifactChip key={d.id} kind="decision" id={d.id} label={d.id}
                            onClick={() => onOpenArtifact("decision", d.id)} />
            ))}
          </div>
        </section>

        {/* Reviewers */}
        <section>
          <h4 style={{ margin: "0 0 8px", fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--text-3)", fontWeight: 700 }}>Reviewers</h4>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {(plan.reviewers || []).map(rid => {
              const r = roleById(rid);
              return (
                <span key={rid} style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "4px 10px 4px 4px",
                  background: "var(--surface-2)", border: "1px solid var(--border)",
                  borderRadius: 999, fontSize: 12,
                }}>
                  <RoleAvatar role={r} />
                  <span>{(r && r.id) || rid}</span>
                </span>
              );
            })}
          </div>
        </section>

        {/* Actions */}
        <section style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <ReadOnlyBtn className="btn"><Glyph name="plus" size={13} /> Add checklist item</ReadOnlyBtn>
          <ReadOnlyBtn className="btn"><Glyph name="link" size={13} /> Cut Khira task</ReadOnlyBtn>
          <ReadOnlyBtn className="btn role"><Glyph name="verdict" size={13} /> Request verdict</ReadOnlyBtn>
        </section>
      </div>
    </div>
  );
}

window.PlanroomView = PlanroomView;
