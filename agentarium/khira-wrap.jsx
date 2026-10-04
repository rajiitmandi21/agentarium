// Agentarium — Khira wrap (reuses existing ListView/BoardView/FocusView/OverviewView)

function KhiraView({
  activeProject,
  activeProjectId,
  projectAccess,
  onProjectRefresh,
  onNavigate,
  onOpenArtifact,
  openTaskId,
  editMode,
  reviewMode,
  activePhaseId,
  setActivePhaseId,
  phases,
}) {
  const H = window.helpers;
  const active = activeProject
    || window.projects.getProject(activeProjectId)
    || (window.projects.getAllProjects() || [])[0]
    || null;
  const phasesList = (active && active.phases) || [];
  const phaseId = phasesList.some((p) => p.id === activePhaseId)
    ? activePhaseId
    : ((phasesList[phasesList.length - 1] || {}).id || "p1");
  const phase = phasesList.find((p) => p.id === phaseId) || phasesList[0] || null;
  const phaseMeta = phases && phases.find((p) => p.id === phaseId);

  const [view, setView] = React.useState("board");
  const [selectedId, setSelectedId] = React.useState(null);
  const [filterStatus, setFilterStatus] = React.useState(() => new Set(["blocked", "in_progress", "todo", "completed"]));
  const [filterPriority, setFilterPriority] = React.useState(() => new Set(["p0", "p1", "p2", "pl"]));
  const [attentionOnly, setAttentionOnly] = React.useState(false);
  const [groupBy, setGroupBy] = React.useState("status");

  const [allEdits, setAllEdits] = React.useState(() => window.edits.loadAll());
  React.useEffect(() => { window.edits.saveAll(allEdits); }, [allEdits]);

  React.useEffect(() => { setSelectedId(null); }, [phaseId, activeProjectId]);

  const basePhaseData = phase?.data || { tasks: [], human_reviews: [] };
  const phaseEdits = (allEdits[active?.id] || {})[phase?.key] || {};
  const phaseData = React.useMemo(
    () => window.edits.applyPhaseEdits(basePhaseData, phaseEdits),
    [basePhaseData, phaseEdits]
  );
  const editCount = React.useMemo(() => window.edits.countEdits(phaseEdits), [phaseEdits]);

  React.useEffect(() => {
    if (!openTaskId || !active?.phases) return;
    for (const ph of active.phases) {
      const tasks = ph.data?.tasks || [];
      if (!tasks.some((t) => t.id === openTaskId)) continue;
      if (ph.id !== phaseId) setActivePhaseId(ph.id);
      setSelectedId(openTaskId);
      setView("list");
      return;
    }
  }, [openTaskId, active?.phases, activeProjectId, phaseId, setActivePhaseId]);

  const phaseLocked = phaseMeta?.locked || (phase && H.phaseStatus(phase) === "closed");

  const updateTask = React.useCallback((taskId, patch) => {
    if (!phase || phaseLocked) return;
    setAllEdits((prev) => {
      const next = { ...prev };
      const proj = { ...(next[active.id] || {}) };
      const ph = { ...(proj[phase.key] || {}) };
      const tasks = { ...(ph.tasks || {}) };
      // Only PM-meaningful edits refresh "PM reviewed" (which drives staleness
      // and fixture-refresh pruning); other field edits get a neutral edited_at.
      const isPmEdit = "pm_status" in patch || "pm_remark" in patch;
      const now = new Date().toISOString();
      tasks[taskId] = {
        ...(tasks[taskId] || {}),
        ...patch,
        ...(isPmEdit ? { pm_updated_at: now } : { edited_at: now }),
      };
      ph.tasks = tasks;
      proj[phase.key] = ph;
      next[active.id] = proj;
      return next;
    });
  }, [active?.id, phase, phaseLocked]);

  const addTaskReview = React.useCallback((taskId, review) => {
    if (!phase || phaseLocked) return;
    setAllEdits((prev) => {
      const next = { ...prev };
      const proj = { ...(next[active.id] || {}) };
      const ph = { ...(proj[phase.key] || {}) };
      const tasks = { ...(ph.tasks || {}) };
      const t = { ...(tasks[taskId] || {}) };
      t.extra_reviews = [...(t.extra_reviews || []), { ...review, at: new Date().toISOString(), _user: true }];
      tasks[taskId] = t;
      ph.tasks = tasks;
      proj[phase.key] = ph;
      next[active.id] = proj;
      return next;
    });
  }, [active?.id, phase, phaseLocked]);

  const addHumanReview = React.useCallback((text) => {
    if (!phase || phaseLocked) return;
    setAllEdits((prev) => {
      const next = { ...prev };
      const proj = { ...(next[active.id] || {}) };
      const ph = { ...(proj[phase.key] || {}) };
      ph.extra_human_reviews = [...(ph.extra_human_reviews || []), {
        at: new Date().toISOString(),
        date: new Date().toISOString().slice(0, 10),
        text,
        _user: true,
      }];
      proj[phase.key] = ph;
      next[active.id] = proj;
      return next;
    });
  }, [active?.id, phase, phaseLocked]);

  const apiWorkspace = !!(
    active?.apiWorkspace
    && window.projects
    && window.projects.isApiWorkspaceActive()
  );
  const sourceMode = apiWorkspace
    ? "api-writable"
    : active?.fixture
    ? "fixture"
    : active?.httpLinked
      ? "http"
      : active?.dirLinked && projectAccess && projectAccess.canSave
        ? "folder-writable"
        : active?.dirLinked
          ? "folder-readonly"
          : "snapshot";

  const canHardSave = !!(
    editCount > 0
    && !phaseLocked
    && phase
    && (
      (sourceMode === "api-writable" && /^p\d+$/i.test(phase.id || ""))
      || (
        sourceMode === "folder-writable"
        && window.projects.projectCanHardSave(active, projectAccess)
        && phase.writable
        && phase.relativePath
      )
    )
  );

  const showExportOnly = editCount > 0 && !canHardSave && !phaseLocked;

  const [saveState, setSaveState] = React.useState("idle");
  const [saveError, setSaveError] = React.useState("");
  const [saveCode, setSaveCode] = React.useState("");
  const [reloadingPhase, setReloadingPhase] = React.useState(false);
  const saveScope = `${activeProjectId || ""}:${phaseId || ""}`;
  const saveScopeRef = React.useRef(saveScope);
  saveScopeRef.current = saveScope;
  React.useEffect(() => {
    setSaveState("idle");
    setSaveError("");
    setSaveCode("");
    setReloadingPhase(false);
  }, [activeProjectId, phaseId]);

  function exportPhaseEdits() {
    if (!phase || editCount === 0) return;
    const payload = window.edits.preparePhaseForSave(basePhaseData, phaseEdits, new Date().toISOString());
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const base = phase.filename ? phase.filename.replace(/\.json$/i, "") : `status-${phase.key.toLowerCase()}`;
    a.download = `${base}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function hardSavePhase() {
    if (!canHardSave || !phase) return;
    const startedScope = saveScope;
    setSaveState("saving");
    setSaveError("");
    setSaveCode("");
    const savedAt = new Date().toISOString();
    const phaseKey = phase.key;
    const submittedEdits = JSON.parse(JSON.stringify(phaseEdits || {}));
    const payload = window.edits.preparePhaseForSave(basePhaseData, submittedEdits, savedAt);
    try {
      const r = await window.projects.savePhase(active.id, phase.id, payload, {
        forceApi: sourceMode === "api-writable",
        etag: phase.etag,
      });
      if (r.ok) {
        const savedEdits = sourceMode === "api-writable"
          ? window.edits.apiSaveablePhaseEdits(submittedEdits) : submittedEdits;
        setAllEdits((prev) => window.edits.clearSavedPhaseEdits(prev, active.id, phaseKey, savedEdits));
        onProjectRefresh();
        if (saveScopeRef.current !== startedScope) return;
        if (sourceMode === "api-writable" && window.edits.hasReviewerEdits(submittedEdits)) {
          setSaveState("error");
          setSaveError("Task fields saved. Reviewer edits remain in your draft and require the Verdicts action.");
          return;
        }
        setSaveState("saved");
        setTimeout(() => {
          if (saveScopeRef.current === startedScope) setSaveState("idle");
        }, 2400);
      } else {
        if (saveScopeRef.current !== startedScope) return;
        setSaveState("error");
        setSaveCode(r.code || "");
        setSaveError(r.error || "Save failed");
        onProjectRefresh();
      }
    } catch (e) {
      if (saveScopeRef.current !== startedScope) return;
      setSaveState("error");
      setSaveCode("timeout");
      setSaveError(e.message || String(e));
      onProjectRefresh();
    }
  }

  async function reloadLatestPhase() {
    if (!apiWorkspace || !phase || reloadingPhase) return;
    const startedScope = saveScope;
    setReloadingPhase(true);
    const result = await window.projects.reloadApiPhase(active.id, phase.id);
    if (saveScopeRef.current !== startedScope) return;
    if (result.ok) {
      setSaveError("");
      setSaveCode("");
      setSaveState("idle");
      onProjectRefresh();
    } else {
      setSaveError(result.error || "Could not reload latest phase.");
    }
    setReloadingPhase(false);
  }

  const counts = React.useMemo(() => H.getTaskCounts(phaseData.tasks), [phaseData]);

  const filteredTasks = React.useMemo(() => {
    return phaseData.tasks.filter((t) => {
      if (!filterStatus.has(t.status)) return false;
      // Tasks without a priority stay visible unless a specific one is required;
      // strict membership would silently drop them from List/Board entirely.
      if (t.priority && !filterPriority.has(t.priority)) return false;
      if (attentionOnly && H.attentionScore(t) === 0) return false;
      return true;
    });
  }, [phaseData, filterStatus, filterPriority, attentionOnly]);

  function toggleSet(setter, set, value) {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setter(next);
  }

  const { OverviewView, ListView, BoardView, FocusView, TaskDetailDrawer } = window;
  const editPolicy = phaseLocked
    ? { mode: "read-only", fields: ["phase closed"] }
    : sourceMode === "api-writable"
      ? { mode: "edit", fields: ["status, priority, PM verdict, reviews · saves through API"] }
    : sourceMode === "fixture"
      ? { mode: "edit", fields: ["PM fields · fixture · export only"] }
      : sourceMode === "http"
        ? { mode: "edit", fields: ["PM fields · HTTP · export only"] }
        : sourceMode === "snapshot"
          ? { mode: "edit", fields: ["PM fields · snapshot · export only"] }
          : sourceMode === "folder-readonly"
            ? { mode: "edit", fields: ["PM fields · folder read-only · reconnect for Save"] }
            : { mode: "edit", fields: ["status, priority, PM verdict, reviews · saves to disk"] };

  const showFilters = view === "list" || view === "board";

  // Empty-registry bail: render a quiet shell (after all hooks) instead of
  // crashing on a missing project object.
  if (!active || !phasesList.length) {
    return (
      <div className="modbody" style={{ padding: 16 }} data-screen-label="Khira">
        <ModuleHeader
          roomNo="01"
          eyebrow="Khira · Execution Board"
          title="No project loaded"
          subtitle="Load or select a project to view its tasks."
          editMode={editMode}
          reviewMode={reviewMode}
          editPolicy={{ mode: "read-only", fields: ["no project"] }} />
      </div>
    );
  }

  return (
    <div className="modbody" style={{ padding: 0, display: "flex", flexDirection: "column", overflow: "hidden" }} data-screen-label="Khira">
      <ModuleHeader
        roomNo="01"
        eyebrow="Khira · Execution Board"
        title={phase?.name || active.name}
        subtitle={phaseMeta ? phaseMeta.blurb : (apiWorkspace ? "API workspace · project-management/status/" : (active.fixture ? "Fixture · project-management/status/" : null))}
        editMode={editMode}
        reviewMode={reviewMode}
        editPolicy={editPolicy}
        actions={
          <>
            {canHardSave && (
              <button
                className={`save-btn save-btn-${saveState}`}
                disabled={saveState === "saving" || (apiWorkspace && ["conflict", "timeout", "missing-etag"].includes(saveCode))}
                onClick={hardSavePhase}>
                {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : "Save"}
              </button>
            )}
            {showExportOnly && (
              <button type="button" className="btn btn-export-json" onClick={exportPhaseEdits}>
                Export JSON ({editCount})
              </button>
            )}
            {saveState === "error" && saveError && (
              <span className="save-error" title={saveError}>{saveError}</span>
            )}
            {apiWorkspace && saveState === "error" && ["conflict", "timeout", "missing-etag"].includes(saveCode) && (
              <button type="button" className="btn" disabled={reloadingPhase} onClick={reloadLatestPhase}>
                {reloadingPhase ? "Reloading…" : "Reload latest phase · keep draft"}
              </button>
            )}
            <div style={{
              display: "inline-flex", background: "var(--surface-2)", border: "1px solid var(--border)",
              borderRadius: 8, padding: 2,
            }}>
              {[
                { v: "overview", l: "Overview", c: phaseData.tasks.length },
                { v: "focus", l: "Focus", c: counts.blockedOrAtRisk + counts.needsReview + counts.bugs + counts.stale + counts.needsHelp },
                { v: "list", l: "List", c: filteredTasks.length },
                { v: "board", l: "Board", c: filteredTasks.length },
              ].map((o) => (
                <button key={o.v} onClick={() => setView(o.v)} style={{
                  background: view === o.v ? "var(--bg-elev)" : "transparent",
                  boxShadow: view === o.v ? "var(--shadow-1)" : "none",
                  color: view === o.v ? "var(--text)" : "var(--text-3)",
                  border: "none", padding: "5px 10px", borderRadius: 6, fontSize: 11.5,
                  fontWeight: 600, cursor: "pointer",
                  display: "inline-flex", alignItems: "center", gap: 6,
                }}>
                  {o.l}
                  <span style={{
                    fontFamily: "var(--font-mono)", fontSize: 10,
                    color: view === o.v ? "var(--m-ink-strong)" : "var(--text-4)",
                    background: view === o.v ? "var(--m-tint)" : "var(--surface-3)",
                    padding: "0 5px", borderRadius: 3,
                  }}>{o.c}</span>
                </button>
              ))}
            </div>
          </>
        }
      />

      {showFilters && (
        <KhiraFilterBar
          view={view}
          counts={counts}
          filterStatus={filterStatus}
          filterPriority={filterPriority}
          attentionOnly={attentionOnly}
          groupBy={groupBy}
          toggleStatus={(v) => toggleSet(setFilterStatus, filterStatus, v)}
          togglePriority={(v) => toggleSet(setFilterPriority, filterPriority, v)}
          setAttentionOnly={setAttentionOnly}
          setGroupBy={setGroupBy} />
      )}

      <div className="khira-wrap" style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {view === "overview" && (
          <div style={{ overflow: "auto", flex: 1 }}>
            <OverviewView
              phaseData={phaseData}
              activePhaseName={phase?.name}
              editMode={editMode && !phaseLocked}
              onAddHumanReview={addHumanReview}
              onSelectTask={(id) => { setSelectedId(id); setView("list"); }} />
          </div>
        )}
        {view === "list" && (
          <div className={`tasks-pane ${selectedId ? "with-drawer" : ""} ${reviewMode ? "review-mode" : ""} ${editMode ? "edit-mode" : ""}`} style={{ flex: 1, minHeight: 0, overflow: "hidden", height: "100%" }}>
            <ListView tasks={filteredTasks} selectedId={selectedId} onSelectTask={setSelectedId} groupBy={groupBy} reviewMode={reviewMode} />
            {selectedId && (
              <TaskDetailDrawer
                task={filteredTasks.find((t) => t.id === selectedId) || phaseData.tasks.find((t) => t.id === selectedId)}
                onClose={() => setSelectedId(null)}
                editMode={editMode && !phaseLocked}
                onUpdate={(patch) => updateTask(selectedId, patch)}
                onAddReview={(review) => addTaskReview(selectedId, review)}
                onOpenArtifact={onOpenArtifact} />
            )}
          </div>
        )}
        {view === "board" && (
          <div className={`tasks-pane ${selectedId ? "with-drawer" : ""} ${reviewMode ? "review-mode" : ""} ${editMode ? "edit-mode" : ""}`} style={{ flex: 1, minHeight: 0, overflow: "hidden", height: "100%" }}>
            <BoardView tasks={filteredTasks} selectedId={selectedId} onSelectTask={setSelectedId} reviewMode={reviewMode} editMode={editMode && !phaseLocked} onChangeStatus={(taskId, status) => updateTask(taskId, { status })} />
            {selectedId && (
              <TaskDetailDrawer
                task={filteredTasks.find((t) => t.id === selectedId) || phaseData.tasks.find((t) => t.id === selectedId)}
                onClose={() => setSelectedId(null)}
                editMode={editMode && !phaseLocked}
                onUpdate={(patch) => updateTask(selectedId, patch)}
                onAddReview={(review) => addTaskReview(selectedId, review)}
                onOpenArtifact={onOpenArtifact} />
            )}
          </div>
        )}
        {view === "focus" && (
          <div className={`tasks-pane ${selectedId ? "with-drawer" : ""} ${editMode ? "edit-mode" : ""}`} style={{ flex: 1, minHeight: 0, overflow: "hidden", height: "100%" }}>
            <FocusView tasks={phaseData.tasks} onSelectTask={setSelectedId} />
            {selectedId && (
              <TaskDetailDrawer
                task={phaseData.tasks.find((t) => t.id === selectedId)}
                onClose={() => setSelectedId(null)}
                editMode={editMode && !phaseLocked}
                onUpdate={(patch) => updateTask(selectedId, patch)}
                onAddReview={(review) => addTaskReview(selectedId, review)}
                onOpenArtifact={onOpenArtifact} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function KhiraFilterBar({ view, counts, filterStatus, filterPriority, attentionOnly,
  groupBy, toggleStatus, togglePriority, setAttentionOnly, setGroupBy }) {
  return (
    <div className="viewbar" style={{ paddingTop: 10, paddingBottom: 10 }}>
      <div className="filter-chips" style={{ flex: 1 }}>
        <FilterChip active={filterStatus.has("blocked")} onClick={() => toggleStatus("blocked")}
          dotColor="var(--st-blocked)" label="Blocked" count={counts.blocked} />
        <FilterChip active={filterStatus.has("in_progress")} onClick={() => toggleStatus("in_progress")}
          dotColor="var(--st-progress)" label="In progress" count={counts.in_progress} />
        <FilterChip active={filterStatus.has("todo")} onClick={() => toggleStatus("todo")}
          dotColor="var(--text-4)" label="Todo" count={counts.todo} />
        <FilterChip active={filterStatus.has("completed")} onClick={() => toggleStatus("completed")}
          dotColor="var(--st-completed)" label="Done" count={counts.completed} />
        <span style={{ width: 1, height: 18, background: "var(--border)", margin: "0 4px" }} />
        {["p0", "p1", "p2", "pl"].map((p) => (
          <FilterChip key={p} active={filterPriority.has(p)} onClick={() => togglePriority(p)}
            dotColor={`var(--pr-${p})`} label={p.toUpperCase()} count={counts[p]} />
        ))}
        <span style={{ width: 1, height: 18, background: "var(--border)", margin: "0 4px" }} />
        <FilterChip active={attentionOnly} onClick={() => setAttentionOnly((v) => !v)}
          dotColor="var(--pr-p1)" label="Needs attention" />
      </div>
      {view === "list" && <GroupBySelect value={groupBy} onChange={setGroupBy} />}
    </div>
  );
}

function FilterChip({ active, onClick, label, count, dotColor }) {
  return (
    <button type="button" className={`chip ${active ? "active" : ""}`} aria-pressed={!!active} onClick={onClick}>
      {dotColor && <span className="chip-dot" style={{ background: dotColor }} />}
      <span>{label}</span>
      {typeof count === "number" && <span className="chip-count">{count}</span>}
    </button>
  );
}

function GroupBySelect({ value, onChange }) {
  const opts = [
    { v: "status", l: "Status" },
    { v: "priority", l: "Priority" },
    { v: "pm", l: "PM status" },
    { v: "none", l: "Flat list" },
  ];
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{
        fontSize: 10, color: "var(--text-3)", letterSpacing: "0.08em",
        textTransform: "uppercase", fontWeight: 700, fontFamily: "var(--font-mono)",
      }}>Group by</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={{
        background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--text)",
        borderRadius: 6, padding: "4px 8px", fontSize: 12, fontFamily: "inherit", outline: "none", cursor: "pointer",
      }}>
        {opts.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
      </select>
    </div>
  );
}

window.KhiraView = KhiraView;
