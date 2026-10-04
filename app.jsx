// Main App

const { useState, useMemo, useEffect, useRef } = React;
const HHH = window.helpers;
const { OverviewView, ListView, BoardView, FocusView, TaskDetailDrawer, Icon, ProjectSwitcher, AddProjectModal } = window;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "light",
  "density": "comfortable",
  "accent": "#5b6cff"
}/*EDITMODE-END*/;

const ACCENT_OPTIONS = {
  '#5b6cff': { color: 'oklch(55% 0.16 260)', soft: 'oklch(94% 0.04 260)', text: 'oklch(36% 0.16 260)' },
  '#1f9d7a': { color: 'oklch(55% 0.14 160)', soft: 'oklch(94% 0.04 160)', text: 'oklch(36% 0.14 160)' },
  '#c97a1a': { color: 'oklch(62% 0.16 70)',  soft: 'oklch(94% 0.06 80)',  text: 'oklch(42% 0.16 70)' },
  '#d24559': { color: 'oklch(58% 0.17 15)',  soft: 'oklch(95% 0.04 15)',  text: 'oklch(38% 0.17 15)' },
};

function ProjectAccessBadge({ access }) {
  if (!access) return null;
  const cls = `proj-access proj-access-${access.state}`;
  const hint = access.dirName
    ? `${access.label} · ${access.dirName}`
    : access.label;
  return (
    <span className={cls} title={hint}>
      {access.label}
      {access.lastRefreshAt && access.state === 'linked' && (
        <span className="proj-access-sub">
          {' · refreshed '}{HHH.relTime(access.lastRefreshAt)}
        </span>
      )}
    </span>
  );
}

// API Workspace source-mode badge (AG-P8.6). Shows only when /api/health
// reported an API workspace with write enabled — otherwise nothing renders and
// the app reads/saves via snapshot/local exactly as before.
function ApiSourceBadge({ source, persona }) {
  if (!source || !source.ok || !source.writeEnabled) return null;
  const ver = source.version ? ` · v${source.version}` : '';
  return (
    <span
      className="proj-access proj-access-api"
      title={`API workspace${ver} · writes over /api as ${persona || 'human-raj'}`}>
      API workspace
      <span className="proj-access-sub">{' · '}{persona || 'human-raj'}</span>
    </span>
  );
}

function ReconnectFolderButton({ projectId, access, onDone }) {
  const [busy, setBusy] = useState(false);
  if (!access || !access.canReconnect) return null;
  if (access.state !== 'permission-needed' && access.state !== 'reconnect') return null;

  async function onClick() {
    setBusy(true);
    try {
      const r = await window.projects.reconnectProjectFolder(projectId);
      onDone(r);
    } catch (e) {
      onDone({ ok: false, error: e.message || String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <button className="reconnect-btn" disabled={busy} onClick={onClick} title="Re-pick the project folder to restore disk access">
      {busy ? 'Linking…' : 'Reconnect folder'}
    </button>
  );
}

function RefreshFromDiskButton({ project, access, onRefreshed }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(''); // transient "Refreshed" / error message

  const supported = window.projects.isDirPickerSupported();
  const canRefresh = !!(access && access.canRefresh);
  const disabled = !supported || !canRefresh || busy;

  let tooltip;
  if (!supported) tooltip = 'Folder picker unsupported in this browser (use Chrome / Edge / Brave / Arc).';
  else if (project && project.builtin) tooltip = 'Built-in sample — re-import as a folder-linked project to enable refresh.';
  else if (access && access.state === 'snapshot') tooltip = 'Snapshot only — import via Pick folder to enable refresh.';
  else if (access && access.state === 'permission-needed') tooltip = 'Permission needed — use Reconnect folder.';
  else if (access && access.state === 'reconnect') tooltip = 'Folder handle missing — use Reconnect folder.';
  else tooltip = `Re-read status JSON from disk for "${project.name}"`;

  async function onClick() {
    if (disabled) return;
    setBusy(true);
    setStatus('');
    try {
      const r = await window.projects.refreshProjectFromDir(project.id);
      if (r.ok) {
        const warnCount = (r.errors || []).length + (r.warnings || []).length;
        setStatus(warnCount > 0 ? `Refreshed (${warnCount} warning${warnCount === 1 ? '' : 's'})` : 'Refreshed');
        onRefreshed({ refreshResult: r });
      } else {
        setStatus(r.error || 'Refresh failed');
        onRefreshed({ refreshResult: r });
      }
    } catch (e) {
      setStatus(e.message || String(e));
    } finally {
      setBusy(false);
      setTimeout(() => setStatus(''), 2400);
    }
  }

  return (
    <button className="icon-btn refresh-btn" disabled={disabled} title={tooltip} onClick={onClick}
      style={{ marginLeft: 4, opacity: disabled ? 0.45 : 1, position: 'relative' }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        style={{ transform: busy ? 'rotate(180deg)' : 'none', transition: 'transform 400ms ease' }}>
        <polyline points="23 4 23 10 17 10" />
        <polyline points="1 20 1 14 7 14" />
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
      </svg>
      {status && (
        <span style={{
          position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)',
          marginTop: 4, padding: '4px 8px', background: 'var(--bg-2)', border: '1px solid var(--border)',
          borderRadius: 4, fontSize: 11, whiteSpace: 'nowrap', zIndex: 10
        }}>{status}</span>
      )}
    </button>
  );
}

function App() {
  const [tweaks, setTweak] = window.useTweaks(TWEAK_DEFAULTS);

  // Apply theme + density
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', tweaks.theme);
    document.documentElement.setAttribute('data-density', tweaks.density);
    const ac = ACCENT_OPTIONS[tweaks.accent] || ACCENT_OPTIONS['#5b6cff'];
    document.documentElement.style.setProperty('--accent', ac.color);
    document.documentElement.style.setProperty('--accent-soft', ac.soft);
    document.documentElement.style.setProperty('--accent-text', ac.text);
  }, [tweaks.theme, tweaks.density, tweaks.accent]);

  // Projects
  const [projectVersion, setProjectVersion] = useState(0); // bump to re-read projects
  const projects = useMemo(() => window.projects.getAllProjects(), [projectVersion]);
  const [activeProjectId, setActiveProjectId] = useState(() => window.projects.getActiveProjectId());
  const [showAddProject, setShowAddProject] = useState(false);
  const [projectAccess, setProjectAccess] = useState(null);
  const [refreshPanel, setRefreshPanel] = useState(null); // { errors, warnings } from last refresh
  // API Workspace source mode (AG-P8.6): probe /api/health once on load. When
  // the server is up with write enabled, hard Save routes over the API and a
  // source-mode badge surfaces; otherwise the app degrades to snapshot/local.
  const [apiSource, setApiSource] = useState(null); // null=probing | {ok, writeEnabled, ...}
  useEffect(() => {
    let cancelled = false;
    if (!window.projects || !window.projects.probeApiHealth) {
      setApiSource({ ok: false, writeEnabled: false });
      return;
    }
    window.projects.probeApiHealth().then((h) => {
      if (!cancelled) setApiSource(h || { ok: false, writeEnabled: false });
    });
    return () => { cancelled = true; };
  }, []);
  const apiWorkspace = !!(apiSource && apiSource.ok && apiSource.writeEnabled);

  const activeProject = useMemo(
    () => projects.find(p => p.id === activeProjectId) || projects[0],
    [projects, activeProjectId]
  );

  useEffect(() => { window.projects.setActiveProjectId(activeProjectId); }, [activeProjectId]);

  useEffect(() => {
    let cancelled = false;
    window.projects.inspectProjectAccess(activeProjectId).then((a) => {
      if (!cancelled) setProjectAccess(a);
    });
    return () => { cancelled = true; };
  }, [activeProjectId, projectVersion]);

  useEffect(() => {
    if (!activeProject || activeProject.builtin) {
      setRefreshPanel(null);
      return;
    }
    const issues = window.helpers.filterDisplayWarnings([
      ...(activeProject.importWarnings || []),
    ]);
    if (activeProject.lastRefreshError) {
      issues.unshift(activeProject.lastRefreshError);
    }
    setRefreshPanel(issues.length ? { issues } : null);
  }, [activeProject]);

  // Phase — default to the latest (last) non-closed phase so the most recent
  // active phase opens automatically. Falls back to the last phase if all are closed.
  function pickDefaultPhaseId(project) {
    if (!project.phases || project.phases.length === 0) return 'p1';
    for (let i = project.phases.length - 1; i >= 0; i--) {
      if (HHH.phaseStatus(project.phases[i]) !== 'closed') return project.phases[i].id;
    }
    return project.phases[project.phases.length - 1].id;
  }
  const [activePhaseId, setActivePhaseId] = useState(() => pickDefaultPhaseId(activeProject));
  // Reset active phase if we switch projects (and phase no longer exists)
  useEffect(() => {
    if (!activeProject.phases.find(p => p.id === activePhaseId)) {
      setActivePhaseId(pickDefaultPhaseId(activeProject));
    }
  }, [activeProject.id]);

  const activePhase = activeProject.phases.find(p => p.id === activePhaseId) || activeProject.phases[0];
  const basePhaseData = activePhase ? activePhase.data : { tasks: [], human_reviews: [], title: '', subtitle: '', last_updated: '' };

  // View
  const [view, setView] = useState('overview'); // 'overview' | 'list' | 'board' | 'focus'

  // Editable shadow state — keyed by [projectId][phaseKey]
  const [editMode, setEditMode] = useState(false);
  const [allEdits, setAllEdits] = useState(() => window.edits.loadAll());

  // Persist on every change
  useEffect(() => { window.edits.saveAll(allEdits); }, [allEdits]);

  const phaseEdits = allEdits[activeProject.id] || {};

  // Mutators
  const updateTask = React.useCallback((phaseKey, taskId, patch) => {
    setAllEdits(prev => {
      const next = { ...prev };
      const proj = { ...(next[activeProject.id] || {}) };
      const ph = { ...(proj[phaseKey] || {}) };
      const tasks = { ...(ph.tasks || {}) };
      tasks[taskId] = { ...(tasks[taskId] || {}), ...patch, pm_updated_at: new Date().toISOString() };
      ph.tasks = tasks;
      proj[phaseKey] = ph;
      next[activeProject.id] = proj;
      return next;
    });
  }, [activeProject.id]);

  const addTaskReview = React.useCallback((phaseKey, taskId, review) => {
    setAllEdits(prev => {
      const next = { ...prev };
      const proj = { ...(next[activeProject.id] || {}) };
      const ph = { ...(proj[phaseKey] || {}) };
      const tasks = { ...(ph.tasks || {}) };
      const t = { ...(tasks[taskId] || {}) };
      t.extra_reviews = [...(t.extra_reviews || []), { ...review, at: new Date().toISOString(), _user: true }];
      tasks[taskId] = t;
      ph.tasks = tasks;
      proj[phaseKey] = ph;
      next[activeProject.id] = proj;
      return next;
    });
  }, [activeProject.id]);

  const addHumanReview = React.useCallback((phaseKey, text) => {
    setAllEdits(prev => {
      const next = { ...prev };
      const proj = { ...(next[activeProject.id] || {}) };
      const ph = { ...(proj[phaseKey] || {}) };
      ph.extra_human_reviews = [...(ph.extra_human_reviews || []), {
        at: new Date().toISOString(),
        date: new Date().toISOString().slice(0, 10),
        text,
        _user: true,
      }];
      proj[phaseKey] = ph;
      next[activeProject.id] = proj;
      return next;
    });
  }, [activeProject.id]);

  const revertPhase = React.useCallback((phaseKey) => {
    if (!confirm('Discard all edits for this phase? This cannot be undone.')) return;
    setAllEdits(prev => {
      const next = { ...prev };
      const proj = { ...(next[activeProject.id] || {}) };
      delete proj[phaseKey];
      if (Object.keys(proj).length === 0) delete next[activeProject.id];
      else next[activeProject.id] = proj;
      return next;
    });
  }, [activeProject.id]);

  // Filters
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState(() => new Set(['blocked','in_progress','todo','completed']));
  const [filterPriority, setFilterPriority] = useState(() => new Set(['p0','p1','p2','pl']));
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [groupBy, setGroupBy] = useState('status'); // 'status' | 'priority' | 'pm' | 'none'
  const [reviewMode, setReviewMode] = useState(false);

  // Selection
  const [selectedId, setSelectedId] = useState(null);

  // Effective phase data with edits applied
  const phaseData = useMemo(
    () => window.edits.applyPhaseEdits(basePhaseData, phaseEdits[activePhase ? activePhase.key : '']),
    [basePhaseData, phaseEdits, activePhase && activePhase.key]
  );
  const editCount = useMemo(
    () => window.edits.countEdits(phaseEdits[activePhase ? activePhase.key : '']),
    [phaseEdits, activePhase && activePhase.key]
  );

  const activePhaseStatus = activePhase ? HHH.phaseStatus(activePhase) : 'todo';
  const phaseLocked = activePhaseStatus === 'closed';

  // API workspace can hard-save any phase that maps to a data_p*.json id,
  // regardless of File System Access folder linkage — the write goes over HTTP.
  const apiCanHardSave = useMemo(() => {
    if (!apiWorkspace || !activeProject || !activeProject.apiWorkspace
      || editCount === 0 || phaseLocked || !activePhase) return false;
    return /^p\d+$/i.test(activePhase.id || '');
  }, [apiWorkspace, activeProject, editCount, phaseLocked, activePhase]);

  const localCanHardSave = useMemo(() => {
    if (editCount === 0 || phaseLocked || !activePhase) return false;
    return window.projects.projectCanHardSave(activeProject, projectAccess)
      && activePhase.writable
      && !!activePhase.relativePath;
  }, [editCount, phaseLocked, activeProject, projectAccess, activePhase]);

  const canHardSave = apiCanHardSave || localCanHardSave;
  // Route preference: when API workspace is active, the API is canonical; only
  // fall through to the local folder path when API mode is off.
  const saveViaApi = apiCanHardSave;

  const [saveState, setSaveState] = useState('idle'); // idle | saving | saved | error
  const [saveError, setSaveError] = useState('');
  const [saveCode, setSaveCode] = useState('');
  const [reloadingPhase, setReloadingPhase] = useState(false);
  const saveScope = `${activeProjectId || ''}:${activePhaseId || ''}`;
  const saveScopeRef = useRef(saveScope);
  saveScopeRef.current = saveScope;

  useEffect(() => {
    setSaveState('idle');
    setSaveError('');
    setSaveCode('');
    setReloadingPhase(false);
  }, [activePhaseId, activeProjectId]);

  async function hardSavePhase() {
    if (!canHardSave || !activePhase) return;
    const startedScope = saveScope;
    setSaveState('saving');
    setSaveError('');
    const savedAt = new Date().toISOString();
    const phaseKey = activePhase.key;
    const submittedEdits = JSON.parse(JSON.stringify(phaseEdits[phaseKey] || {}));
    const payload = window.edits.preparePhaseForSave(
      basePhaseData,
      submittedEdits,
      savedAt
    );
    try {
      // Route by source mode: API workspace → PUT /api/status/:phase (persona
      // header), else the unchanged local File System Access path. Same states;
      // on any failure the draft is preserved (edits are only cleared on ok).
      const r = saveViaApi
        ? await window.projects.savePhase(activeProject.id, activePhase.id, payload, {
            forceApi: true,
            etag: activePhase.etag,
          })
        : await window.projects.savePhaseToDir(activeProject.id, activePhase.id, payload);
      if (r.ok) {
        const savedEdits = saveViaApi ? window.edits.apiSaveablePhaseEdits(submittedEdits) : submittedEdits;
        setAllEdits(prev => window.edits.clearSavedPhaseEdits(prev, activeProject.id, phaseKey, savedEdits));
        setProjectVersion(v => v + 1);
        if (saveScopeRef.current !== startedScope) return;
        if (saveViaApi && window.edits.hasReviewerEdits(submittedEdits)) {
          setSaveState('error');
          setSaveError('Task fields saved. Reviewer edits remain in your draft and require the Verdicts action.');
          return;
        }
        setSaveState('saved');
        setTimeout(() => {
          if (saveScopeRef.current === startedScope) setSaveState('idle');
        }, 2400);
      } else {
        if (saveScopeRef.current !== startedScope) return;
        setSaveState('error');
        setSaveCode(r.code || '');
        setSaveError(r.error || 'Save failed');
        if (r.code === 'permission-needed' || r.code === 'reconnect' || r.code === 'timeout') {
          setProjectVersion(v => v + 1);
        }
      }
    } catch (e) {
      if (saveScopeRef.current !== startedScope) return;
      // savePhaseToDir is guarded to always resolve, but guard here too so a
      // thrown error can never leave the button stuck on "Saving…".
      setSaveState('error');
      setSaveCode('timeout');
      setSaveError(e.message || String(e));
      setProjectVersion(v => v + 1);
    }
  }

  async function reloadLatestApiPhase() {
    if (!saveViaApi || !activeProject || !activePhase || reloadingPhase) return;
    const startedScope = saveScope;
    setReloadingPhase(true);
    const result = await window.projects.reloadApiPhase(activeProject.id, activePhase.id);
    if (saveScopeRef.current !== startedScope) return;
    if (result.ok) {
      setSaveState('idle');
      setSaveError('');
      setSaveCode('');
      setProjectVersion(v => v + 1);
    } else {
      setSaveError(result.error || 'Could not reload latest phase.');
    }
    setReloadingPhase(false);
  }

  // Reset selection when phase changes
  useEffect(() => { setSelectedId(null); }, [activePhaseId]);

  useEffect(() => { if (phaseLocked && editMode) setEditMode(false); }, [phaseLocked, editMode]);

  // Keyboard: cmd+k focus search, esc close drawer
  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        document.getElementById('search-input')?.focus();
      } else if (e.key === 'Escape') {
        setSelectedId(null);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Filter tasks
  const filteredTasks = useMemo(() => {
    const q = search.trim().toLowerCase();
    return phaseData.tasks.filter(t => {
      if (!filterStatus.has(t.status)) return false;
      if (!filterPriority.has(t.priority)) return false;
      if (attentionOnly && HHH.attentionScore(t) === 0) return false;
      if (q) {
        const hay = (t.id + ' ' + t.title + ' ' + (t.description||'') + ' ' + (t.pm_remark||'')).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [phaseData, search, filterStatus, filterPriority, attentionOnly]);

  const selectedTask = useMemo(() => {
    if (!selectedId) return null;
    return phaseData.tasks.find(t => t.id === selectedId) || null;
  }, [phaseData, selectedId]);

  const counts = useMemo(() => HHH.getTaskCounts(phaseData.tasks), [phaseData]);

  function toggleSet(setter, set, value) {
    const next = new Set(set);
    if (next.has(value)) next.delete(value); else next.add(value);
    setter(next);
  }

  // KPI counts for view tab badges
  const tabCounts = {
    overview: phaseData.tasks.length,
    list: filteredTasks.length,
    board: filteredTasks.length,
    focus: counts.blocked + counts.needsReview + counts.hasBlockers + counts.bugs + counts.stale,
  };

  return (
    <div className="app">
      {/* Top bar */}
      <div className="topbar">
        <ProjectSwitcher
          activeProjectId={activeProjectId}
          projects={projects}
          onChange={(id) => { setActiveProjectId(id); setSelectedId(null); }}
          onAddClick={() => setShowAddProject(true)}
          onDeleteProject={(id) => {
            window.projects.deleteProject(id);
            if (activeProjectId === id) setActiveProjectId('builtin');
            setProjectVersion(v => v + 1);
          }}
        />

        <ProjectAccessBadge access={projectAccess} />

        <ApiSourceBadge
          source={apiSource}
          persona={window.projects.getActingPersona && window.projects.getActingPersona()} />

        <RefreshFromDiskButton
          project={activeProject}
          access={projectAccess}
          onRefreshed={() => { setProjectVersion(v => v + 1); setSelectedId(null); }}
        />

        <ReconnectFolderButton
          projectId={activeProjectId}
          access={projectAccess}
          onDone={() => { setProjectVersion(v => v + 1); setSelectedId(null); }}
        />

        <div className="topbar-sep"></div>

        <div className="phase-switcher" role="tablist">
          {activeProject.phases.map(p => {
            const st = HHH.phaseStatus(p);
            return (
              <button key={p.id}
                className={`phase-pill ${p.id === activePhaseId ? 'active' : ''} phase-${st}`}
                onClick={() => setActivePhaseId(p.id)}
                title={`Status: ${HHH.PHASE_STATUS_LABEL[st]}`}>
                <span className="ph-row">
                  <span className="ph-label">{p.label}</span>
                  <span className={`phase-status-chip chip-${st}`} aria-label={HHH.PHASE_STATUS_LABEL[st]}>
                    <span className={`phase-status-dot dot-${st}`} aria-hidden="true">
                      {st === 'closed' && (
                        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
                        </svg>
                      )}
                    </span>
                    <span className="phase-status-text">{HHH.PHASE_STATUS_LABEL[st]}</span>
                  </span>
                </span>
                <span className="ph-name">{p.name}</span>
              </button>
            );
          })}
        </div>

        <div className="topbar-actions">
          <div className="search-box">
            <Icon name="search" size={14} className="search-icon" />
            <input id="search-input" type="text" placeholder="Search tasks, ids, reviews…"
              value={search} onChange={e => setSearch(e.target.value)} />
            <span className="kbd">⌘K</span>
          </div>
          <button
            className={`mode-toggle ${reviewMode ? 'active' : ''}`}
            onClick={() => setReviewMode(v => !v)}
            title="Surface reviewer & PM comments inline"
            aria-pressed={reviewMode}>
            <Icon name={reviewMode ? 'check' : 'spark'} size={14} />
            <span>Review&nbsp;mode</span>
          </button>
          <button
            className={`mode-toggle edit-toggle ${editMode ? 'active' : ''}`}
            onClick={() => setEditMode(v => !v)}
            disabled={phaseLocked}
            title={phaseLocked ? 'Phase is closed — read-only' : (editMode ? 'Exit edit mode' : 'Edit status, priority, PM fields, add reviews')}
            aria-pressed={editMode}>
            <Icon name={editMode ? 'check' : 'tweaks'} size={14} />
            <span>{phaseLocked ? 'Locked' : (editMode ? 'Editing' : 'Edit')}</span>
            {editCount > 0 && <span className="edit-count">{editCount}</span>}
          </button>
          {editCount > 0 && (
            <>
              {canHardSave && (
                <button
                  className={`save-btn save-btn-${saveState}`}
                  disabled={saveState === 'saving' || (saveViaApi && ['conflict', 'timeout', 'missing-etag'].includes(saveCode))}
                  title={saveViaApi
                    ? `Save over API · PUT /api/status/${activePhase.id} as ${(window.projects.getActingPersona && window.projects.getActingPersona()) || 'human-raj'}`
                    : (activePhase.relativePath
                      ? `Save draft edits to ${activePhase.relativePath}`
                      : 'Save to linked folder')}
                  onClick={hardSavePhase}>
                  {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : 'Save'}
                </button>
              )}
              <button className="icon-btn" title={canHardSave
                ? 'Download JSON copy (fallback)'
                : 'Export edited JSON (snapshot / built-in)'}
                onClick={() => exportPhase(activePhase.key, phaseData, activePhase.relativePath)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 4 V16" /><polyline points="7 11 12 16 17 11" /><line x1="4" y1="20" x2="20" y2="20" />
                </svg>
              </button>
              <button className="icon-btn" title="Revert all edits for this phase"
                onClick={() => revertPhase(activePhase.key)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12 a9 9 0 1 0 3-6.7" /><polyline points="3 4 3 9 8 9" />
                </svg>
              </button>
              {saveState === 'error' && saveError && (
                <span className="save-error" title={saveError}>{saveError}</span>
              )}
              {saveViaApi && saveState === 'error' && ['conflict', 'timeout', 'missing-etag'].includes(saveCode) && (
                <button type="button" className="btn" disabled={reloadingPhase} onClick={reloadLatestApiPhase}>
                  {reloadingPhase ? 'Reloading…' : 'Reload latest phase · keep draft'}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* View tabs + filters */}
      <div className="viewbar">
        {refreshPanel && refreshPanel.issues.length > 0 && (
          <div className="import-warnings-panel" role="status">
            <div className="import-warnings-title">
              {projectAccess && projectAccess.state === 'reconnect'
                ? 'This project cannot refresh from disk until you reconnect the folder.'
                : 'Import / refresh notes (last known good data is still shown)'}
            </div>
            <ul className="import-warnings-list">
              {refreshPanel.issues.slice(0, 12).map((msg, i) => (
                <li key={i}>{msg}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="view-tabs">
          <ViewTab name="Overview"  icon="overview" active={view==='overview'} onClick={() => setView('overview')} />
          <ViewTab name="Tasks"     icon="list"     count={tabCounts.list} active={view==='list'}     onClick={() => setView('list')} />
          <ViewTab name="Board"     icon="board"    active={view==='board'}    onClick={() => setView('board')} />
          <ViewTab name="Focus"     icon="focus"    count={tabCounts.focus} active={view==='focus'}    onClick={() => setView('focus')} />
        </div>

        <div className="viewbar-right">
          {(view === 'list' || view === 'board') && (
            <div className="filter-chips">
              <FilterChip active={filterStatus.has('blocked')}     onClick={() => toggleSet(setFilterStatus, filterStatus, 'blocked')}
                dotColor="var(--st-blocked)" label={`Blocked`} count={counts.blocked} />
              <FilterChip active={filterStatus.has('in_progress')} onClick={() => toggleSet(setFilterStatus, filterStatus, 'in_progress')}
                dotColor="var(--st-progress)" label={`In progress`} count={counts.in_progress} />
              <FilterChip active={filterStatus.has('todo')}        onClick={() => toggleSet(setFilterStatus, filterStatus, 'todo')}
                dotColor="var(--text-4)" label={`Todo`} count={counts.todo} />
              <FilterChip active={filterStatus.has('completed')}   onClick={() => toggleSet(setFilterStatus, filterStatus, 'completed')}
                dotColor="var(--st-completed)" label={`Done`} count={counts.completed} />

              <span style={{ width: 1, height: 18, background: 'var(--border)', margin: '0 4px' }}></span>

              {['p0','p1','p2','pl'].map(p => (
                <FilterChip key={p} active={filterPriority.has(p)} onClick={() => toggleSet(setFilterPriority, filterPriority, p)}
                  dotColor={`var(--pr-${p})`} label={p.toUpperCase()} count={counts[p]} />
              ))}

              <span style={{ width: 1, height: 18, background: 'var(--border)', margin: '0 4px' }}></span>

              <FilterChip active={attentionOnly} onClick={() => setAttentionOnly(v => !v)}
                dotColor="var(--pr-p1)" label="Needs attention only" />

              {view === 'list' && (
                <>
                  <span style={{ width: 1, height: 18, background: 'var(--border)', margin: '0 4px' }}></span>
                  <GroupBySelect value={groupBy} onChange={setGroupBy} />
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Main content */}
      <div className="main">
        {view === 'overview' && (
          <OverviewView phaseData={phaseData} activePhaseName={activePhase.name}
            editMode={editMode}
            onAddHumanReview={(text) => addHumanReview(activePhase.key, text)}
            onSelectTask={(id) => { setSelectedId(id); setView('list'); }} />
        )}

        {view === 'list' && (
          <div className={`tasks-pane ${selectedTask ? 'with-drawer' : ''} ${reviewMode ? 'review-mode' : ''} ${editMode ? 'edit-mode' : ''}`}>
            <ListView tasks={filteredTasks} selectedId={selectedId} onSelectTask={setSelectedId} groupBy={groupBy} reviewMode={reviewMode} />
            {selectedTask && <TaskDetailDrawer task={selectedTask} onClose={() => setSelectedId(null)}
              editMode={editMode}
              onUpdate={(patch) => updateTask(activePhase.key, selectedTask.id, patch)}
              onAddReview={(review) => addTaskReview(activePhase.key, selectedTask.id, review)} />}
          </div>
        )}

        {view === 'board' && (
          <div className={`tasks-pane ${selectedTask ? 'with-drawer' : ''} ${reviewMode ? 'review-mode' : ''} ${editMode ? 'edit-mode' : ''}`} style={{ height: '100%', overflow: 'hidden' }}>
            <BoardView tasks={filteredTasks} selectedId={selectedId} onSelectTask={setSelectedId} reviewMode={reviewMode}
              editMode={editMode}
              phaseLocked={phaseLocked}
              onChangeStatus={(taskId, status) => updateTask(activePhase.key, taskId, { status })} />
            {selectedTask && <TaskDetailDrawer task={selectedTask} onClose={() => setSelectedId(null)}
              editMode={editMode}
              onUpdate={(patch) => updateTask(activePhase.key, selectedTask.id, patch)}
              onAddReview={(review) => addTaskReview(activePhase.key, selectedTask.id, review)} />}
          </div>
        )}

        {view === 'focus' && (
          <div className={`tasks-pane ${selectedTask ? 'with-drawer' : ''} ${editMode ? 'edit-mode' : ''}`}>
            <FocusView tasks={phaseData.tasks} onSelectTask={setSelectedId} />
            {selectedTask && <TaskDetailDrawer task={selectedTask} onClose={() => setSelectedId(null)}
              editMode={editMode}
              onUpdate={(patch) => updateTask(activePhase.key, selectedTask.id, patch)}
              onAddReview={(review) => addTaskReview(activePhase.key, selectedTask.id, review)} />}
          </div>
        )}
      </div>

      {/* Tweaks panel */}
      <TweaksControls tweaks={tweaks} setTweak={setTweak} />

      {/* Add Project modal */}
      {showAddProject && (
        <AddProjectModal
          onClose={() => setShowAddProject(false)}
          onAdded={(proj) => {
            setShowAddProject(false);
            setProjectVersion(v => v + 1);
            setActiveProjectId(proj.id);
            setSelectedId(null);
          }}
        />
      )}
    </div>
  );
}

function ViewTab({ name, icon, active, onClick, count }) {
  return (
    <button className={`view-tab ${active ? 'active' : ''}`} onClick={onClick}>
      <Icon name={icon} size={14} />
      <span>{name}</span>
      {typeof count === 'number' && <span className="vt-count">{count}</span>}
    </button>
  );
}

function FilterChip({ active, onClick, label, count, dotColor }) {
  return (
    <button className={`chip ${active ? 'active' : ''}`} onClick={onClick}>
      {dotColor && <span className="chip-dot" style={{ background: dotColor }}></span>}
      <span>{label}</span>
      {typeof count === 'number' && <span className="chip-count">{count}</span>}
    </button>
  );
}

function GroupBySelect({ value, onChange }) {
  const opts = [
    { v: 'status', l: 'Status' },
    { v: 'priority', l: 'Priority' },
    { v: 'pm', l: 'PM status' },
    { v: 'none', l: 'Flat list' },
  ];
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 600 }}>Group by</span>
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{
          background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)',
          borderRadius: 6, padding: '3px 8px', fontSize: 12, fontFamily: 'inherit', outline: 'none', cursor: 'pointer'
        }}>
        {opts.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
      </select>
    </div>
  );
}

function TweaksControls({ tweaks, setTweak }) {
  const { TweaksPanel, TweakSection, TweakRadio, TweakColor } = window;
  return (
    <TweaksPanel>
      <TweakSection label="Appearance">
        <TweakRadio label="Theme" value={tweaks.theme} options={[
          { value: 'light', label: 'Light' },
          { value: 'dark',  label: 'Dark' },
        ]} onChange={(v) => setTweak('theme', v)} />
        <TweakRadio label="Density" value={tweaks.density} options={[
          { value: 'comfortable', label: 'Comfort' },
          { value: 'compact',     label: 'Compact' },
        ]} onChange={(v) => setTweak('density', v)} />
      </TweakSection>
      <TweakSection label="Accent">
        <TweakColor label="Accent" value={tweaks.accent}
          options={Object.keys(ACCENT_OPTIONS)}
          onChange={(v) => setTweak('accent', v)} />
      </TweakSection>
    </TweaksPanel>
  );
}

function exportPhase(phaseKey, phaseData, relativePath) {
  const json = JSON.stringify(phaseData, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const base = relativePath
    ? relativePath.split('/').pop().replace(/\.json$/i, '')
    : `status-${phaseKey.toLowerCase()}`;
  a.download = `${base}-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
