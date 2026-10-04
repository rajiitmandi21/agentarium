// Agentarium — main shell + router

const { useState, useEffect, useMemo, useRef } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "light",
  "density": "comfortable",
  "accent": "#5b6cff",
  "actingAs": "human-raj",
  "module": "home",
  "moduleIntensity": "moderate",
  "sourceMode": "local",
  "verdictTreatment": "stamp"
}/*EDITMODE-END*/;

const ACCENT_OPTIONS = {
  '#5b6cff': { color: 'oklch(55% 0.16 260)', soft: 'oklch(94% 0.04 260)', text: 'oklch(36% 0.16 260)' },
  '#1f9d7a': { color: 'oklch(55% 0.14 160)', soft: 'oklch(94% 0.04 160)', text: 'oklch(36% 0.14 160)' },
  '#c97a1a': { color: 'oklch(62% 0.16 70)',  soft: 'oklch(94% 0.06 80)',  text: 'oklch(42% 0.16 70)' },
  '#d24559': { color: 'oklch(58% 0.17 15)',  soft: 'oklch(95% 0.04 15)',  text: 'oklch(38% 0.17 15)' },
};

function mergePmWarningsForProject(project) {
  const lists = [window.AGENTARIUM?._warnings, project?.importWarnings];
  if (window.pmLoader && window.pmLoader.filterUserWarnings) {
    const seen = new Set();
    const out = [];
    for (const list of lists) {
      for (const w of window.pmLoader.filterUserWarnings(list)) {
        if (!seen.has(w)) { seen.add(w); out.push(w); }
      }
    }
    return out;
  }
  if (window.helpers && window.helpers.mergeDisplayWarnings) {
    return window.helpers.mergeDisplayWarnings(...lists);
  }
  return (lists[0] || []).concat(lists[1] || []);
}

function Agentarium() {
  const [tweaks, setTweak] = window.useTweaks(TWEAK_DEFAULTS);
  const {
    HomeView, AtlasView, KhiraView, PlanroomView, CourierView, LedgersView, CrewsView, VerdictsView,
    ProjectSwitcher, AddProjectModal,
  } = window;

  // ── Projects (Khira-backed, multi-source) ──────────────────────────
  const [projectVersion, setProjectVersion] = useState(0);
  const [crewsRosterVersion, setCrewsRosterVersion] = useState(0);

  // Crews edits-version counter: bumped after a Crews-side owner_id write so the
  // cross-phase crewsTasks memo re-reads the shared edits overlay. app.jsx holds NO
  // allEdits snapshot — KhiraView owns the overlay; we always read/write loadAll() fresh.
  const [crewsEditsVersion, setCrewsEditsVersion] = useState(0);
  const projects = useMemo(() => window.projects.getAllProjects(), [projectVersion]);
  const [activeProjectId, setActiveProjectId] = useState(() => window.projects.getActiveProjectId());
  const activeProject = useMemo(
    () => projects.find(p => p.id === activeProjectId) || projects[0],
    [projects, activeProjectId]
  );
  useEffect(() => { window.projects.setActiveProjectId(activeProjectId); }, [activeProjectId]);
  const [showAddProject, setShowAddProject] = useState(false);

  const [pmVersion, setPmVersion] = useState(0);
  const [projectAccess, setProjectAccess] = useState(null);
  const [pmWarnings, setPmWarnings] = useState([]);
  // Fatal artifact-load failure (bootstrap stores it on AGENTARIUM._loadError)
  // must be visible, not an eternal "Loading…" phase. Dismissible per session.
  const [loadErrorDismissed, setLoadErrorDismissed] = useState(false);

  useEffect(() => {
    setPmWarnings(mergePmWarningsForProject(activeProject));
  }, [activeProject, projectVersion, pmVersion]);

  useEffect(() => {
    let cancelled = false;
    window.projects.inspectProjectAccess(activeProjectId).then((a) => {
      if (!cancelled) setProjectAccess(a);
    });
    return () => { cancelled = true; };
  }, [activeProjectId, projectVersion]);

  const [refreshing, setRefreshing] = useState(false);
  async function refreshSource() {
    setRefreshing(true);
    setPmWarnings([]);
    setLoadErrorDismissed(false);
    try {
      if (activeProject && activeProject.httpLinked) {
        await window.projects.refreshHttpLinkedProject(activeProjectId);
        setPmVersion((v) => v + 1);
      } else if (activeProject && activeProject.dirLinked && !activeProject.builtin && !activeProject.httpLinked) {
        const r = await window.projects.refreshProjectFromDir(activeProjectId);
        if (!r.ok) throw new Error(r.error || 'Reconnect your folder and retry refresh.');
        setPmVersion((v) => v + 1);
      } else if (window.pmLoader) {
        const isFixture = activeProject && activeProject.fixture;
        await window.pmLoader.registerFixtureProject({ setActive: !!isFixture });
        setPmVersion((v) => v + 1);
      }
      if (window.projects.scrubStoredImportWarnings) {
        window.projects.scrubStoredImportWarnings();
      }
      const refreshProj = window.projects.getProject(window.projects.getActiveProjectId());
      if (refreshProj && (refreshProj.fixture || refreshProj.httpLinked) && window.edits && window.edits.pruneStaleTaskEdits) {
        if (refreshProj.phases) {
          const pruned = window.edits.pruneStaleTaskEdits(window.edits.loadAll(), refreshProj.id, refreshProj.phases);
          window.edits.saveAll(pruned);
        }
      }
      setProjectVersion((v) => v + 1);
      const proj = window.projects.getProject(window.projects.getActiveProjectId());
      setPmWarnings(mergePmWarningsForProject(proj));
    } catch (e) {
      console.warn('refreshSource', e);
      setPmWarnings([e.message || 'Refresh failed. Reconnect your data and retry.']);
    } finally {
      setRefreshing(false);
    }
  }

  const visiblePmWarnings = useMemo(
    () => [...new Set([...mergePmWarningsForProject(activeProject), ...pmWarnings])],
    [activeProject, pmWarnings, pmVersion, projectVersion],
  );

  // Module state — keep local but persist via tweaks
  const [module, setModuleLocal] = useState(tweaks.module || "home");
  const [routeArgs, setRouteArgs] = useState({});
  const [searchQuery, setSearchQuery] = useState("");
  // Keyboard-navigable search results (combobox/listbox pattern).
  const [activeSearchIdx, setActiveSearchIdx] = useState(-1);
  const searchRef = useRef(null);
  useEffect(() => { setActiveSearchIdx(-1); }, [searchQuery]);

  // Global edit / review modes (shell-level; brief: editing is deliberate)
  const [editMode, setEditMode] = useState(false);
  const [reviewMode, setReviewMode] = useState(false);

  // In-memory edit overlays (until structured save lands)
  const [edits, setEdits] = useState({ plans: {}, roles: {}, verdicts: {} });
  function patch(domain, id, fields) {
    setEdits(prev => ({
      ...prev,
      [domain]: { ...(prev[domain] || {}), [id]: { ...(prev[domain]?.[id] || {}), ...fields } },
    }));
  }
  const editCount = Object.values(edits).reduce((s, d) => s + Object.keys(d).length, 0);

  function setModule(m, args) {
    setModuleLocal(m);
    setRouteArgs(args || {});
    setTweak("module", m);
  }

  useEffect(() => {
    function focusGlobalSearch(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (searchRef.current) searchRef.current.focus();
      }
    }
    document.addEventListener("keydown", focusGlobalSearch);
    return () => document.removeEventListener("keydown", focusGlobalSearch);
  }, []);

  // Acting-as
  const actingAs = tweaks.actingAs || "human-raj";
  const setActingAs = (id) => setTweak("actingAs", id);

  const PHASES = useMemo(() => {
    if (activeProject && activeProject.phases && activeProject.phases.length > 0) {
      return window.pmLoader.phasesFromStatusFiles(
        activeProject.phases.map((ph, i) => ({
          id: ph.id || `p${i + 1}`,
          data: ph.data,
        }))
      );
    }
    return window.AGENTARIUM.PHASES || [];
  }, [activeProject, projectVersion, pmVersion]);

  const [activePhaseId, setActivePhaseId] = useState("p5");
  useEffect(() => {
    if (!PHASES.length) return;
    if (PHASES.some((p) => p.id === activePhaseId)) return;
    const inprog = PHASES.find((p) => p.status === "in_progress");
    setActivePhaseId(inprog ? inprog.id : PHASES[PHASES.length - 1].id);
  }, [PHASES, activeProjectId]);

  const scopedVerdicts = useMemo(() => {
    if (activeProject && window.pmLoader && window.pmLoader.verdictsForProject) {
      return window.pmLoader.verdictsForProject(activeProject, activePhaseId);
    }
    const all = window.AGENTARIUM.VERDICTS || [];
    return activePhaseId ? all.filter((v) => !v.phase || v.phase === activePhaseId) : all;
  }, [activeProject, activePhaseId, projectVersion, pmVersion]);

  useEffect(() => {
    if (!activeProject || !window.pmLoader) return;
    if (window.AGENTARIUM_RELEASE?.staticHosting) {
      let cancelled = false;
      // A status-only import has no plans/messages/decisions. Never carry the
      // demo or another connected folder's artifacts into the new project.
      window.pmLoader.applyToAgentarium({ NOW: new Date().toISOString(), ROLES: [], PLANS: [],
        MESSAGES: [], DECISIONS: [], PHASES: [], VERDICTS: [], ACTIVITY: [],
        sourceLabel: activeProject.dirLinked ? 'Connected folder' : 'JSON snapshot', warnings: [] });
      window.pmLoader.applyProjectPhasesToAgentarium(activeProject);
      setPmVersion(v => v + 1);
      (async () => {
        let bundle = null;
        if (activeProject.builtin || activeProject.fixture) {
          bundle = await window.pmLoader.loadArtifactBundle();
        } else if (activeProject.dirLinked) {
          const handle = await window.projects.getDirHandle(activeProject.id);
          if (handle) {
            const resolved = await window.projects.resolvePmRoot(handle);
            bundle = await window.pmLoader.loadArtifactBundleFromHandle(resolved.pmRoot);
          }
        }
        if (!cancelled && bundle) {
          window.pmLoader.applyToAgentarium(bundle);
          window.pmLoader.applyProjectPhasesToAgentarium(activeProject);
          setPmVersion(v => v + 1);
        }
      })().catch(error => { if (!cancelled) setPmWarnings([error.message || 'Reconnect your project folder.']); });
      return () => { cancelled = true; };
    }
    const applied = window.pmLoader.applyProjectPhasesToAgentarium(activeProject);
    // Project changes replace the global phase/verdict compatibility view.
    // Force one follow-up render so global-backed modules observe the update.
    if (applied) setPmVersion((v) => v + 1);
  }, [activeProject, projectVersion]);

  // ── Crews wiring ───────────────────────────────────────────────────
  // Cross-phase, edits-applied task array. Reads window.edits.loadAll() FRESH each
  // run; recomputes on projectVersion / crewsEditsVersion / module so just-made
  // owner_id edits (and Khira session writes) show immediately. Each project phase
  // carries .key (e.g. "P1") and .data; the shared edits overlay is keyed
  // loadAll()[projectId][phase.key].tasks[taskId] — mirror khira-wrap.
  const crewsTasks = useMemo(() => {
    const out = [];
    const phases = (activeProject && activeProject.phases) || [];
    const all = window.edits.loadAll();
    const projEdits = all[activeProjectId] || {};
    for (const ph of phases) {
      const base = (ph.data && Array.isArray(ph.data.tasks)) ? ph.data : { ...(ph.data || {}), tasks: [] };
      const phEdits = projEdits[ph.key] || {};
      const merged = window.edits.applyPhaseEdits(base, phEdits);
      for (const t of (merged.tasks || [])) out.push(t);
    }
    return out;
  }, [activeProject, activeProjectId, projectVersion, crewsEditsVersion, module]);

  // Single write point for Crews assignment. Locates the owning phase by
  // scanning project phases for the task id, then writes owner_id (+pm_updated_at)
  // into the window.edits overlay keyed by phase.key — EXACTLY khira-wrap updateTask.
  // staffing_state passes through verbatim; applyPhaseEdits drops it on read.
  const assignOwnerToTask = React.useCallback((taskId, patch) => {
    const phases = (activeProject && activeProject.phases) || [];
    let phaseKey = null;
    for (const ph of phases) {
      if ((ph.data?.tasks || []).some((t) => t.id === taskId)) { phaseKey = ph.key; break; }
    }
    if (!phaseKey) return;
    const all = window.edits.loadAll();
    const proj = { ...(all[activeProjectId] || {}) };
    const ph = { ...(proj[phaseKey] || {}) };
    const tasks = { ...(ph.tasks || {}) };
    tasks[taskId] = { ...(tasks[taskId] || {}), ...patch, pm_updated_at: new Date().toISOString() };
    ph.tasks = tasks;
    proj[phaseKey] = ph;
    all[activeProjectId] = proj;
    window.edits.saveAll(all);
    setCrewsEditsVersion((v) => v + 1);
  }, [activeProject, activeProjectId]);

  // Live roster snapshot from CrewsAgents (localStorage ag-crews-agents-v1).
  // Re-snapshots on crewsRosterVersion bump after retire/release.
  const crewsAgents = useMemo(
    () => (window.CrewsAgents && window.CrewsAgents.listAgents ? (window.CrewsAgents.listAgents() || []) : []),
    [crewsRosterVersion]
  );

  const onRetireAgent = React.useCallback((agentId) => {
    if (window.CrewsAgents && window.CrewsAgents.retireAgent) window.CrewsAgents.retireAgent(agentId);
    setCrewsRosterVersion((v) => v + 1);
  }, []);

  const onReleaseAgent = React.useCallback((agentId) => {
    if (window.CrewsAgents && window.CrewsAgents.removeAgent) window.CrewsAgents.removeAgent(agentId);
    setCrewsRosterVersion((v) => v + 1);
  }, []);

  // Apply theme/density/accent
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", tweaks.theme);
    document.documentElement.setAttribute("data-density", tweaks.density);
    document.documentElement.setAttribute("data-mintensity", tweaks.moduleIntensity);
    document.documentElement.setAttribute("data-verdict", tweaks.verdictTreatment);
    const ac = ACCENT_OPTIONS[tweaks.accent] || ACCENT_OPTIONS["#5b6cff"];
    document.documentElement.style.setProperty("--accent", ac.color);
    document.documentElement.style.setProperty("--accent-soft", ac.soft);
    document.documentElement.style.setProperty("--accent-text", ac.text);
  }, [tweaks.theme, tweaks.density, tweaks.accent, tweaks.moduleIntensity, tweaks.verdictTreatment]);

  // Edit / Review mode → data attrs (so CSS can show affordances)
  useEffect(() => {
    document.documentElement.setAttribute("data-edit",   editMode   ? "on" : "off");
    document.documentElement.setAttribute("data-review", reviewMode ? "on" : "off");
  }, [editMode, reviewMode]);

  // Module + role hues -> CSS vars
  const modules = window.MODULES || [];
  const activeMod = modules.find(m => m.id === module) || modules[0] || { id: "home", hue: 80 };
  const activeRole = roleById(actingAs);
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--m-hue", activeMod.hue);
    root.style.setProperty("--r-hue", activeRole.hue);
    root.setAttribute("data-acting-kind", activeRole.kind || "agent");
  }, [activeMod.hue, activeRole.hue, activeRole.kind]);

  // ── Cross-module artifact open
  function openArtifact(kind, id) {
    if (kind === "task")     setModule("khira",   { task: id });
    else if (kind === "plan")     setModule("planroom", { plan: id });
    else if (kind === "message")  setModule("courier",  { message: id });
    else if (kind === "decision") setModule("ledgers",  { decision: id });
    else if (kind === "verdict")  setModule("verdicts", { verdict: id });
    else if (kind === "role")     setModule("crews",    { role: id });
  }

  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (q.length < 2) return [];
    const rows = [];
    for (const ph of (activeProject && activeProject.phases) || []) {
      for (const task of (ph.data && ph.data.tasks) || []) {
        rows.push({ kind: "task", id: task.id, label: task.title || task.description || task.id, meta: ph.id });
      }
    }
    for (const plan of window.AGENTARIUM.PLANS || []) {
      rows.push({ kind: "plan", id: plan.id, label: plan.title || plan.id, meta: plan.phase });
    }
    for (const message of window.AGENTARIUM.MESSAGES || []) {
      rows.push({ kind: "message", id: message.id, label: message.subject || message.id, meta: message.phase });
    }
    for (const decision of window.AGENTARIUM.DECISIONS || []) {
      rows.push({ kind: "decision", id: decision.id, label: decision.title || decision.id, meta: decision.status });
    }
    for (const role of window.AGENTARIUM.ROLES || []) {
      rows.push({ kind: "role", id: role.id, label: role.name || role.title || role.id, meta: role.title });
    }
    return rows
      .filter((row) => `${row.id} ${row.label} ${row.meta || ""}`.toLowerCase().includes(q))
      .sort((a, b) => {
        const aStarts = a.id.toLowerCase().startsWith(q) ? 0 : 1;
        const bStarts = b.id.toLowerCase().startsWith(q) ? 0 : 1;
        return aStarts - bStarts || a.id.localeCompare(b.id);
      })
      .slice(0, 8);
  }, [searchQuery, activeProject, projectVersion, pmVersion]);

  function chooseSearchResult(result) {
    openArtifact(result.kind, result.id);
    setSearchQuery("");
  }

  const prov = window.AGENTARIUM_PROVENANCE || {};
  const proj = activeProject;
  const acc = projectAccess;
  const localSourcePath =
    (acc && acc.state === "api-workspace") || (proj && proj.apiWorkspace)
      ? `${(proj && proj.sourceRoot) || "project-management/"} (API workspace · ${acc && acc.canSave ? "writable" : "unavailable"})`
      : (acc && acc.state === "fixture") || (proj && proj.fixture)
      ? "project-management/ (fixture · export only)"
      : (acc && acc.state === "http-linked") || (proj && proj.httpLinked)
        ? `${(proj && proj.sourceRoot) || "project-management/"} (HTTP · read-only)`
        : proj && proj.dirLinked && acc && acc.canSave
          ? `${acc.dirName} · ${acc.sourceRoot || proj.sourceRoot || "project-management/"} (folder · writable)`
          : proj && proj.dirLinked
            ? `${acc?.dirName || "?"} · ${proj.sourceRoot || "project-management/"} (folder · reconnect for Save)`
            : (acc && acc.state === "snapshot") || (proj && !proj.dirLinked)
              ? "Snapshot (export only)"
              : (acc && acc.dirName) || "project-management/";

  // Source-mode labels reflect LIVE state (health probe + project access), not
  // design-time copy: the API workspace is implemented, so "planned" / "not
  // connected" placeholders would misreport a running server.
  const apiProbe = window.projects && window.projects.getApiSourceState
    ? window.projects.getApiSourceState() : null;
  const apiReachable = !!((acc && acc.state === "api-workspace") || (apiProbe && apiProbe.ok));
  const apiWritableLabel = acc && acc.state === "api-workspace"
    ? (acc.canSave ? "writable" : "unavailable")
    : ((apiProbe && apiProbe.ok && apiProbe.writeEnabled) ? "writable" : "unavailable");
  const sourceInfo = {
    local: {
      path: localSourcePath,
      drafts: editCount,
      sync: projectAccess && projectAccess.lastRefreshAt
        ? `refreshed ${window.helpers.relTime(projectAccess.lastRefreshAt)}`
        : (window.AGENTARIUM._source || "fixture"),
    },
    api: {
      path: apiReachable
        ? `${(proj && proj.sourceRoot) || "project-management/"} (API workspace · ${apiWritableLabel})`
        : "API workspace (server unreachable)",
      drafts: 0,
      sync: apiReachable
        ? (apiProbe && apiProbe.version ? `server v${apiProbe.version}` : "connected")
        : "not connected",
    },
    hybrid: {
      path: "project-management/ ↔ API",
      drafts: editCount,
      sync: apiReachable ? "API reachable" : "local canonical",
    },
  }[tweaks.sourceMode] || { path: "—", drafts: 0, sync: "" };

  return (
    <div className="aga">
      {/* Module rail */}
      <aside className="rail">
        <div className="rail-brand">
          <div className="rail-brand-mark"><span /></div>
          <div className="rail-brand-name">AGENT—<br />ARIUM</div>
        </div>
        {window.MODULES.map(m => {
          const badge = m.id === "verdicts" ? scopedVerdicts.filter(v => v.state === "needs-review" && v.awaiting === actingAs).length :
                        m.id === "courier"  ? (window.AGENTARIUM.MESSAGES || []).filter(x => x.status === "unread" && (!activePhaseId || !x.phase || x.phase === activePhaseId)).length :
                        null;
          return (
            <button key={m.id}
                    className={"rail-btn " + (m.id === module ? "active" : "")}
                    onClick={() => setModule(m.id)}
                    style={m.id === module ? { "--m-hue": m.hue } : null}>
              <span className="rail-glyph"><Glyph name={m.glyph} size={20} /></span>
              <span className="rail-label">{m.label}</span>
              {badge ? <span className="rail-badge">{badge}</span> : null}
            </button>
          );
        })}
        <div className="rail-spacer" />
        <div className="rail-foot">
          <button className="rail-btn" title="Settings" aria-label="Settings"
                  onClick={() => window.postMessage({ type: "__activate_edit_mode" }, "*")}>
            <span className="rail-glyph"><Glyph name="settings" size={20} /></span>
          </button>
        </div>
      </aside>

      {/* Topbar */}
      <header className="aga-topbar">
        <ProjectSwitcher
          activeProjectId={activeProjectId}
          projects={projects}
          onChange={(id) => { setActiveProjectId(id); }}
          onAddClick={() => setShowAddProject(true)}
          onDeleteProject={(id) => {
            window.projects.deleteProject(id);
            if (activeProjectId === id) setActiveProjectId("builtin");
            setProjectVersion(v => v + 1);
          }}
        />

        <button className="icon-btn refresh-btn" title="Refresh from source"
                onClick={refreshSource}
                style={{ marginLeft: -4, height: 30, width: 30 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
               strokeLinecap="round" strokeLinejoin="round"
               style={{ animation: refreshing ? "spin 600ms linear" : "none" }}>
            <path d="M3 12 a9 9 0 1 0 3-6.7" />
            <polyline points="3 4 3 9 8 9" />
          </svg>
        </button>

        <div className="topbar-sep" />

        <PhaseSwitcher activePhaseId={activePhaseId}
                       phases={PHASES}
                       onChange={setActivePhaseId}
                       editMode={editMode} />

        <div className="aga-crumb">
          <span className="sep">/</span>
          <span className="here">{activeMod.label}</span>
        </div>

        <div className="aga-search">
          <Glyph name="search" size={14} />
          <input ref={searchRef}
                 value={searchQuery}
                 onChange={(e) => setSearchQuery(e.target.value)}
                 onKeyDown={(e) => {
                   if (e.key === "ArrowDown") {
                     e.preventDefault();
                     setActiveSearchIdx((i) => Math.min(i + 1, searchResults.length - 1));
                   } else if (e.key === "ArrowUp") {
                     e.preventDefault();
                     setActiveSearchIdx((i) => Math.max(i - 1, -1));
                   } else if (e.key === "Escape") {
                     setSearchQuery("");
                     setActiveSearchIdx(-1);
                   } else if (e.key === "Enter") {
                     const pick = activeSearchIdx >= 0
                       ? searchResults[activeSearchIdx]
                       : (searchResults.length === 1 ? searchResults[0] : null);
                     if (pick) chooseSearchResult(pick);
                   }
                 }}
                 role="combobox"
                 aria-label="Search tasks, plans, messages, decisions, roles"
                 aria-controls="aga-search-results"
                 aria-activedescendant={activeSearchIdx >= 0 ? `aga-search-opt-${activeSearchIdx}` : undefined}
                 aria-expanded={searchQuery.trim().length >= 2}
                 placeholder="Search tasks, plans, messages, decisions, roles…" />
          <span className="kbd">⌘K</span>
          {searchQuery.trim().length >= 2 && (
            <div className="aga-search-results" id="aga-search-results" role="listbox" aria-label="Search results">
              {searchResults.map((result, i) => (
                <button key={`${result.kind}:${result.id}`}
                        type="button"
                        id={`aga-search-opt-${i}`}
                        role="option"
                        aria-selected={i === activeSearchIdx}
                        onMouseEnter={() => setActiveSearchIdx(i)}
                        onClick={() => chooseSearchResult(result)}>
                  <span className={`tag kind-${result.kind}`}>{result.kind}</span>
                  <span className="aga-search-result-copy">
                    <strong>{result.id}</strong>
                    <span>{result.label}</span>
                  </span>
                  {result.meta && <small>{result.meta}</small>}
                </button>
              ))}
              {searchResults.length === 0 && <div className="aga-search-empty">No matching artifacts.</div>}
            </div>
          )}
        </div>

        <div className="aga-topright">
          <button
            className={`mode-toggle ${reviewMode ? "active" : ""}`}
            onClick={() => setReviewMode(v => !v)}
            title="Surface reviewer & PM comments inline"
            aria-pressed={reviewMode}>
            <Glyph name={reviewMode ? "circle" : "search"} size={13} />
            <span>Review</span>
          </button>
          <button
            className={`mode-toggle edit-toggle ${editMode ? "active" : ""}`}
            onClick={() => setEditMode(v => !v)}
            title={editMode ? "Exit edit mode" : "Edit fields where the policy allows"}
            aria-pressed={editMode}>
            <Glyph name={editMode ? "circle" : "settings"} size={13} />
            <span>{editMode ? "Editing" : "Edit"}</span>
            {editCount > 0 && <span className="edit-count">{editCount}</span>}
          </button>

          <SourcePill mode={tweaks.sourceMode}
                      path={sourceInfo.path}
                      lastSync={sourceInfo.sync}
                      drafts={sourceInfo.drafts}
                      onClick={() => {
                        const order = ["local", "hybrid", "api"];
                        const next = order[(order.indexOf(tweaks.sourceMode) + 1) % order.length];
                        setTweak("sourceMode", next);
                      }} />
          <ActingAsPill activeId={actingAs} onChange={setActingAs} />
        </div>
      </header>

      {/* Main */}
      <main className="aga-main">
        {window.AGENTARIUM_RELEASE && (
          <section className="release-notice" aria-label="Release capabilities">
            <div>
              <strong>Agentarium {window.AGENTARIUM_RELEASE.version} · First release</strong>
              <p>Connect your project folder to browse your workspace and edit tasks. Your project files stay on your device. JSON imports support editing and export.</p>
              <details><summary>Available now &amp; upcoming</summary>
                <p>Available: task editing, project views, plans, messages, decisions, crews, review queues and Atlas. Save linked folders in Chrome or Edge; use JSON import and export in other browsers.</p>
                <p>Upcoming: plan authoring, message compose/reply, decision authoring, independent review submission, cloud sync and real agent execution. Maestro offers a simulation preview; dispatch currently requires the optional local API.</p>
              </details>
            </div>
            <button type="button" className="btn primary" onClick={() => setShowAddProject(true)}>Connect your data</button>
          </section>
        )}
        {module === "home"     && <HomeView     actingAs={actingAs} activeProject={activeProject} onNavigate={setModule} onOpenArtifact={openArtifact} onRefresh={refreshSource} onConnect={() => setShowAddProject(true)} refreshing={refreshing} editMode={editMode} reviewMode={reviewMode} activePhaseId={activePhaseId} phases={PHASES} verdicts={scopedVerdicts} />}
        {module === "atlas"    && <AtlasView    actingAs={actingAs} activeProject={activeProject} onOpenArtifact={openArtifact} activePhaseId={activePhaseId} phases={PHASES} atlasVersion={`${activeProjectId}:${projectVersion}:${pmVersion}`} />}
        {module === "khira"    && <KhiraView    activeProject={activeProject} activeProjectId={activeProjectId} projectAccess={projectAccess} onProjectRefresh={() => setProjectVersion(v => v + 1)} onNavigate={setModule} onOpenArtifact={openArtifact} openTaskId={routeArgs.task} editMode={editMode} reviewMode={reviewMode} activePhaseId={activePhaseId} setActivePhaseId={setActivePhaseId} phases={PHASES} />}
        {module === "planroom" && <PlanroomView openPlan={routeArgs.plan} onNavigate={setModule} onOpenArtifact={openArtifact} editMode={editMode} reviewMode={reviewMode} edits={edits.plans} onPatch={(id, f) => patch("plans", id, f)} activePhaseId={activePhaseId} phases={PHASES} />}
        {module === "courier"  && <CourierView  openMessage={routeArgs.message} actingAs={actingAs} onNavigate={setModule} onOpenArtifact={openArtifact} editMode={editMode} reviewMode={reviewMode} activePhaseId={activePhaseId} phases={PHASES} />}
        {module === "ledgers"  && <LedgersView  openDecision={routeArgs.decision} onNavigate={setModule} onOpenArtifact={openArtifact} editMode={editMode} reviewMode={reviewMode} activePhaseId={activePhaseId} phases={PHASES} />}
        {module === "crews"    && <CrewsView    actingAs={actingAs} onActAs={setActingAs} onNavigate={setModule} onOpenArtifact={openArtifact} editMode={editMode} reviewMode={reviewMode} edits={edits.roles} onPatch={(id, f) => patch("roles", id, f)} tasks={crewsTasks} onAssignTask={assignOwnerToTask} agents={crewsAgents} onRetireAgent={onRetireAgent} onReleaseAgent={onReleaseAgent} />}
        {module === "maestro"  && <MaestroView   actingAs={actingAs} onNavigate={setModule} onOpenArtifact={openArtifact} activeProject={activeProject} sourceMode={tweaks.sourceMode} tasks={crewsTasks} agents={crewsAgents} />}
        {module === "verdicts" && <VerdictsView actingAs={actingAs} onNavigate={setModule} onOpenArtifact={openArtifact} editMode={editMode} reviewMode={reviewMode} edits={edits.verdicts} onPatch={(id, f) => patch("verdicts", id, f)} activePhaseId={activePhaseId} phases={PHASES} verdicts={scopedVerdicts} />}
      </main>

      {!loadErrorDismissed && window.AGENTARIUM && window.AGENTARIUM._loadError && (
        <div className="import-warnings-panel source-completeness-panel" role="alert">
          <div className="import-warnings-title">
            Agentarium could not load project-management data
            <button type="button" className="drawer-close" style={{ marginLeft: 8 }}
                    aria-label="Dismiss load error banner"
                    onClick={() => setLoadErrorDismissed(true)}>×</button>
          </div>
          <ul className="import-warnings-list">
            <li>{String(window.AGENTARIUM._loadError)}</li>
            <li>Check the data source (is the API server running? is project-management/pm-index.json readable?) and use Refresh.</li>
          </ul>
        </div>
      )}

      {window.AGENTARIUM?._completeness?.warnings?.length > 0 && (
        <div className="import-warnings-panel source-completeness-panel" role="alert">
          <div className="import-warnings-title">Source completeness</div>
          <ul className="import-warnings-list">
            {window.AGENTARIUM._completeness.warnings.map((msg, i) => <li key={i}>{msg}</li>)}
          </ul>
        </div>
      )}

      {visiblePmWarnings.length > 0 && (
        <div className="import-warnings-panel" role="status">
          <div className="import-warnings-title">Phase-link notes</div>
          <ul className="import-warnings-list">
            {visiblePmWarnings.slice(0, 4).map((msg, i) => <li key={i}>{msg}</li>)}
          </ul>
        </div>
      )}

      {/* Status bar */}
      <footer className="aga-status">
        <div className="aga-status-group aga-status-role">
          <span className="seg"><span className="pulse" /> <strong className="aga-status-strong">{activeRole.id}</strong> · <span className="aga-status-muted">{activeRole.title}</span></span>
        </div>
        <div className="aga-status-group aga-status-source">
          <span className="seg" title={sourceInfo.path}>Source <strong className="aga-status-strong">{tweaks.sourceMode}</strong> · <span className="aga-status-path">{sourceInfo.path}</span></span>
          <span className="seg aga-status-muted">{sourceInfo.sync}</span>
          {sourceInfo.drafts > 0 && <span className="seg aga-status-draft">{sourceInfo.drafts} draft{sourceInfo.drafts === 1 ? "" : "s"}</span>}
        </div>
        <div className="aga-status-group aga-status-meta">
          <span className="seg aga-provenance">
            {prov.footerCredit || "Built by Raj Kumar"}
            {(prov.handles || []).map((h) => (
              <span key={h.id} className="aga-handle"> · {h.label}</span>
            ))}
          </span>
          <span className="seg">v<strong className="aga-status-strong">{prov.version || "0.2.0"}</strong></span>
        </div>
      </footer>

      {/* Tweaks panel */}
      <AgaTweaks tweaks={tweaks} setTweak={setTweak} />

      {/* Add Project modal */}
      {showAddProject && (
        <AddProjectModal
          onClose={() => setShowAddProject(false)}
          onAdded={(proj) => {
            setShowAddProject(false);
            setProjectVersion(v => v + 1);
            setActiveProjectId(proj.id);
          }}
        />
      )}

      {/* Always-on persona frame — reflects the Acting-As role (AG-P14.4).
          position:fixed so it has zero layout impact; pointer-events:none
          so no edge/topbar/rail/status/modal control is ever blocked. */}
      <div className="aga-persona-frame" aria-hidden="true" />
    </div>
  );
}

function AgaTweaks({ tweaks, setTweak }) {
  const { TweaksPanel, TweakSection, TweakRadio, TweakColor, TweakSelect } = window;
  return (
    <TweaksPanel>
      <TweakSection label="Appearance">
        <TweakRadio label="Theme" value={tweaks.theme}
          options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]}
          onChange={(v) => setTweak("theme", v)} />
        <TweakRadio label="Density" value={tweaks.density}
          options={[{ value: "comfortable", label: "Comfort" }, { value: "compact", label: "Compact" }]}
          onChange={(v) => setTweak("density", v)} />
        <TweakColor label="Accent" value={tweaks.accent}
          options={Object.keys(ACCENT_OPTIONS)}
          onChange={(v) => setTweak("accent", v)} />
      </TweakSection>

      <TweakSection label="Module identity">
        <TweakRadio label="Intensity" value={tweaks.moduleIntensity}
          options={[
            { value: "subtle", label: "Subtle" },
            { value: "moderate", label: "Moderate" },
            { value: "bold", label: "Bold" },
          ]}
          onChange={(v) => setTweak("moduleIntensity", v)} />
        <TweakRadio label="Verdicts" value={tweaks.verdictTreatment}
          options={[
            { value: "stamp", label: "Stamp" },
            { value: "gate",  label: "Gate" },
            { value: "inline",label: "Inline" },
          ]}
          onChange={(v) => setTweak("verdictTreatment", v)} />
      </TweakSection>

      <TweakSection label="Acting as">
        <TweakSelect label="Role" value={tweaks.actingAs}
          options={window.AGENTARIUM.ROLES.map(r => ({ value: r.id, label: `${r.name} · ${r.title}` }))}
          onChange={(v) => setTweak("actingAs", v)} />
      </TweakSection>

      <TweakSection label="Source mode">
        <TweakRadio label="Mode" value={tweaks.sourceMode}
          options={[
            { value: "local",  label: "Local" },
            { value: "hybrid", label: "Hybrid" },
            { value: "api",    label: "API" },
          ]}
          onChange={(v) => setTweak("sourceMode", v)} />
      </TweakSection>
    </TweaksPanel>
  );
}

function AgentariumRoot() {
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    if (!window.agentariumReady) { setReady(true); return; }
    window.agentariumReady.then(() => setReady(true));
  }, []);
  if (!ready) {
    return (
      <div className="aga" style={{ placeItems: "center", padding: 48 }}>
        <p style={{ color: "var(--text-2)", fontFamily: "var(--font-mono)" }}>Loading Agentarium…</p>
      </div>
    );
  }
  return <Agentarium />;
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<AgentariumRoot />);
