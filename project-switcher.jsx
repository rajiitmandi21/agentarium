// Project switcher + Add Project modal

// Does a project have inspectable, eagerly-populated phase data? If not, the
// source affordance is hidden (never a broken modal — per the acceptance bar).
function projectHasSourceData(p) {
  if (!p) return false;
  if (p.schema) return true;
  return Array.isArray(p.phases) && p.phases.some(ph => ph && ph.data);
}

function ProjectSwitcher({ activeProjectId, projects, onChange, onAddClick, onDeleteProject }) {
  const [open, setOpen] = React.useState(false);
  const [sourceProject, setSourceProject] = React.useState(null);
  const ref = React.useRef(null);
  const active = projects.find(p => p.id === activeProjectId) || projects[0];

  React.useEffect(() => {
    function onDoc(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    window.addEventListener('mousedown', onDoc);
    return () => window.removeEventListener('mousedown', onDoc);
  }, []);

  return (
    <div className="proj-switcher" ref={ref}>
      <button className={`proj-trigger ${open ? 'open' : ''}`} onClick={() => setOpen(v => !v)}>
        <span className="proj-mark"></span>
        <span className="proj-name">{active.name}</span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.55 }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="proj-menu">
          <div className="proj-menu-eyebrow">Projects</div>
          {projects.map(p => (
            <div key={p.id} className={`proj-menu-row ${p.id === activeProjectId ? 'active' : ''}`}>
              <button className="proj-menu-item" onClick={() => { onChange(p.id); setOpen(false); }}>
                <span className="proj-mark sm"></span>
                <span style={{ flex: 1, textAlign: 'left' }}>
                  <div className="proj-menu-name">{p.name}</div>
                  <div className="proj-menu-sub">
                    {p.phases.length} phase{p.phases.length !== 1 ? 's' : ''}
                    {p.builtin && ' · built-in'}
                  </div>
                </span>
                {p.id === activeProjectId && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="4 12 10 18 20 6" />
                  </svg>
                )}
              </button>
              {projectHasSourceData(p) && (
                <button className="proj-menu-source" title="View data source"
                  aria-label={`View data source for ${p.name}`}
                  onClick={(e) => { e.stopPropagation(); setOpen(false); setSourceProject(p); }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" /><circle cx="12" cy="12" r="3" />
                  </svg>
                </button>
              )}
              <button className="proj-menu-delete"
                title={p.builtin ? 'Built-in project — cannot be deleted' : 'Delete project'}
                disabled={p.builtin}
                onClick={(e) => { e.stopPropagation(); if (p.builtin) return; if (confirm(`Delete project "${p.name}"?`)) onDeleteProject(p.id); }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                </svg>
              </button>
            </div>
          ))}
          <div className="proj-menu-divider"></div>
          <button className="proj-menu-add" onClick={() => { onAddClick(); setOpen(false); }}>
            <span style={{ fontSize: 14 }}>＋</span>
            <span>Add project from JSON files…</span>
          </button>
        </div>
      )}
      {sourceProject && (
        <ProjectSourceModal project={sourceProject} onClose={() => setSourceProject(null)} />
      )}
    </div>
  );
}

function AddProjectModal({ onClose, onAdded }) {
  const [name, setName] = React.useState('');
  const [files, setFiles] = React.useState([]); // [{filename, data}]
  const [schema, setSchema] = React.useState(null);
  const [errors, setErrors] = React.useState([]);
  const [warnings, setWarnings] = React.useState([]);
  const [busy, setBusy] = React.useState(false);
  const [dirHandle, setDirHandle] = React.useState(null); // FileSystemDirectoryHandle | null
  const fileInputRef = React.useRef(null);
  const dirSupported = window.projects.isDirPickerSupported();

  // Modal semantics: Escape closes; focus is restored to the opener on unmount.
  // The close callback arrives as a fresh inline closure on every parent render,
  // so it is read through a ref and the keydown listener is subscribed ONCE per
  // mount — keying this effect to [onClose] replayed focus restoration to the
  // opener mid-session whenever the shell re-rendered behind the open modal.
  // Opener focus is captured during first render, BEFORE commit applies
  // autoFocus to fields inside the modal.
  const openerFocusRef = React.useRef(null);
  if (openerFocusRef.current === null) openerFocusRef.current = document.activeElement;
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;
  React.useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onCloseRef.current(); }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const opener = openerFocusRef.current;
      if (opener && typeof opener.focus === 'function') opener.focus();
    };
  }, []);

  function autoNameFrom(parsed) {
    if (!name && parsed.length > 0) {
      const t = parsed[0].data && parsed[0].data.title;
      if (t) setName(t.split('-')[0].trim());
    }
  }

  async function handleFiles(e) {
    const fl = e.target.files;
    if (!fl || fl.length === 0) return;
    setBusy(true);
    const result = await window.projects.importFromFiles(fl);
    setBusy(false);
    setFiles(result.phases);
    setSchema(result.schema);
    setErrors(result.errors);
    setWarnings(result.warnings || []);
    setDirHandle(null); // file-picker path doesn't give us a directory handle
    autoNameFrom(result.phases);
  }

  async function handlePickFolder() {
    if (!dirSupported) return;
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      setBusy(true);
      const result = await window.projects.readPhasesFromDir(handle);
      setBusy(false);
      setFiles(result.phases);
      setSchema(result.schema);
      setErrors(result.errors);
      setWarnings(result.warnings || []);
      if (result.statusOnly || (result.errors && result.errors.length && !result.phases.length)) {
        setDirHandle(null);
      } else {
        setDirHandle(handle);
      }
      autoNameFrom(result.phases);
    } catch (e) {
      setBusy(false);
      if (e.name !== 'AbortError') setErrors([e.message || String(e)]);
    }
  }

  async function save() {
    if (files.length === 0) { setErrors(['Select at least one phase JSON file.']); return; }
    const proj = window.projects.buildProject(name || 'Untitled project', files, schema, {
      dirLinked: !!dirHandle,
      writable: !!dirHandle,
    });
    if (dirHandle) {
      let resolved;
      try {
        resolved = await window.projects.resolvePmRoot(dirHandle);
      } catch (e) {
        setErrors([e.message || String(e)]);
        return;
      }
      if (resolved.statusOnly) {
        setErrors([
          'Select the project-management/ folder (or repo root), not status/ alone.',
        ]);
        return;
      }
      const writeOk = await window.projects.verifyDirWritePermission(dirHandle);
      if (!writeOk) {
        setErrors([
          'Write permission was not granted. Re-pick the folder and allow read/write access for Save.',
        ]);
        return;
      }
      const now = new Date().toISOString();
      proj.dirName = dirHandle.name;
      proj.sourceRoot = resolved.sourceRoot;
      proj.pmRootLinked = true;
      proj.linkedAt = now;
      proj.lastRefreshAt = now;
      proj.lastKnownFileCount = files.length;
      proj.accessState = 'linked';
      proj.httpLinked = false;
      proj.fixture = false;
      proj.importWarnings = window.helpers
        ? window.helpers.filterDisplayWarnings(warnings)
        : warnings;
      try { await window.projects.saveDirHandle(proj.id, dirHandle); }
      catch (e) { console.warn('saveDirHandle failed', e); }
      if (window.pmLoader && window.pmLoader.loadArtifactBundleFromHandle) {
        try {
          const bundle = await window.pmLoader.loadArtifactBundleFromHandle(resolved.pmRoot);
          bundle.sourceLabel = `${resolved.sourceRoot} (folder linked)`;
          window.pmLoader.applyToAgentarium(bundle);
        } catch (e) {
          console.warn('PM artifact load from folder failed', e);
        }
      }
    } else {
      proj.accessState = 'snapshot';
    }
    window.projects.addProject(proj);
    onAdded(proj);
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="add-project-title"
           onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3 id="add-project-title">Add project</h3>
          <button className="drawer-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <p className="modal-help">
            {window.AGENTARIUM_RELEASE && <>Your project is read in your browser and is not uploaded to our hosting service. Link a folder for local saves, or import JSON files and export your changes. </>}
            Load a folder of phase status JSON files (one per phase). Optionally include a
            <code>&nbsp;schema.json&nbsp;</code> file matching the Agentarium task schema —
            files are validated against the required keys (<code>title</code>, <code>tasks</code>, etc.).
            {dirSupported && (
              <> <strong>Pick folder</strong> (read/write): select the <code>project-management/</code> folder or the repo root — not <code>status/</code> alone. Enables <em>Refresh</em> and Khira <em>Save</em>.</>
            )}
          </p>

          <label className="form-row">
            <span className="form-label">Project name</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Pharma Pilot Q3" autoFocus />
          </label>

          {dirSupported && (
            <label className="form-row">
              <span className="form-label">Pick folder (recommended — enables Refresh from disk)</span>
              <button type="button" className="file-drop" onClick={handlePickFolder}
                style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }}>
                <div className="file-drop-cta">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
                  </svg>
                  <div style={{ fontWeight: 500, fontSize: 13 }}>
                    {dirHandle ? `📁 ${dirHandle.name} linked` : 'Click to pick folder…'}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                    Repo root or <code>project-management/</code> — loads status, plans, messages, roles, and decisions from one root
                  </div>
                </div>
              </button>
            </label>
          )}

          <label className="form-row">
            <span className="form-label">
              {dirSupported ? 'Or pick individual files (no auto-refresh)' : 'Phase JSON files (+ optional schema.json)'}
            </span>
            <div className="file-drop"
              onClick={() => fileInputRef.current && fileInputRef.current.click()}>
              <input type="file" multiple accept=".json,application/json" ref={fileInputRef}
                onChange={handleFiles} style={{ display: 'none' }} />
              <div className="file-drop-cta">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 5 V19" /><polyline points="6 11 12 5 18 11" />
                </svg>
                <div style={{ fontWeight: 500, fontSize: 13 }}>Click to select JSON files</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>Multiple files allowed</div>
              </div>
            </div>
          </label>

          {busy && <div className="modal-status">Parsing files…</div>}

          {files.length > 0 && (
            <div className="file-list">
              <div className="form-label" style={{ marginBottom: 6 }}>
                {files.length} phase{files.length !== 1 ? 's' : ''} parsed
                {schema && ' · schema attached'}
              </div>
              {files.map((f, i) => (
                <div key={i} className="file-item">
                  <span className="file-num">{i + 1}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="file-title">{(f.data && f.data.title) || f.filename}</div>
                    <div className="file-meta">
                      <span className="mono">{f.filename}</span>
                      {' · '}{(f.data && f.data.tasks ? f.data.tasks.length : 0)} tasks
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {errors.length > 0 && (
            <div className="modal-errors">
              <div className="form-label" style={{ color: 'var(--st-blocked)', marginBottom: 6 }}>
                {errors.length} validation issue{errors.length !== 1 ? 's' : ''}
              </div>
              <ul>{errors.slice(0, 8).map((e, i) => <li key={i}>{e}</li>)}</ul>
              {errors.length > 8 && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>… and {errors.length - 8} more</div>}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="hr-btn-secondary" onClick={onClose}>Cancel</button>
          <button className="hr-btn-primary"
            onClick={save}
            disabled={files.length === 0 || !name.trim()}>
            Add project
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Project Source Viewer (AG-P14.3) ──────────────────────────────────────
// Read-only inspector: schema.json (when present) + per-phase data_p*.json that
// back ANY loaded project. Builds its file list purely from project.schema and
// project.phases[].data — no file I/O, no backend, no active-project change. It
// never writes back: a pure audit window onto the bytes the board renders.

function projectOrigin(project) {
  if (!project) return { key: 'local', label: 'Local' };
  if (project.builtin) return { key: 'builtin', label: 'Built-in' };
  if (project.apiWorkspace) return { key: 'api-workspace', label: 'API workspace' };
  if (project.fixture) return { key: 'fixture', label: 'Fixture' };
  if (project.httpLinked) return { key: 'http-linked', label: 'HTTP linked' };
  if (project.dirLinked) return { key: 'dir-linked', label: 'Folder linked' };
  return { key: 'snapshot', label: 'Imported snapshot' };
}

// One left-rail entry per inspectable file. schema.json first (when present),
// then phases in their natural (filename-derived) order.
function buildSourceFiles(project) {
  const files = [];
  if (project && project.schema) {
    files.push({
      id: 'schema',
      kind: 'schema',
      filename: 'schema.json',
      phaseKey: null,
      title: 'Status schema',
      taskCount: null,
      data: project.schema,
    });
  }
  for (const ph of (project && project.phases) || []) {
    if (!ph || !ph.data) continue;
    const tasks = Array.isArray(ph.data.tasks) ? ph.data.tasks.length : 0;
    files.push({
      id: 'phase-' + (ph.id || ph.key || files.length),
      kind: 'data',
      filename: ph.filename || ('data_' + String(ph.key || '').toLowerCase() + '.json'),
      phaseKey: ph.key || null,
      title: (ph.data && ph.data.title) || ph.name || ph.label || ph.key || 'Phase',
      taskCount: tasks,
      data: ph.data,
    });
  }
  return files;
}

function bytesLabel(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function downloadJsonBlob(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the click has been dispatched so the download isn't cancelled.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ProjectSourceModal({ project, onClose }) {
  const files = React.useMemo(() => buildSourceFiles(project), [project]);
  const [selectedId, setSelectedId] = React.useState(files.length ? files[0].id : null);
  const [copied, setCopied] = React.useState(false);
  const modalRef = React.useRef(null);
  // Guard against a drag that STARTS inside the modal and ENDS on the backdrop
  // closing it (selecting JSON text, etc.). Only a true backdrop press closes.
  const downOnBackdrop = React.useRef(false);

  // Modal semantics: Escape closes; focus is restored to the opener on unmount.
  // The close callback arrives as a fresh inline closure on every parent render,
  // so it is read through a ref and the keydown listener is subscribed ONCE per
  // mount — keying this effect to [onClose] replayed focus restoration to the
  // opener mid-session whenever the shell re-rendered behind the open modal.
  // Opener focus is captured during first render, BEFORE commit applies
  // autoFocus to fields inside the modal.
  const openerFocusRef = React.useRef(null);
  if (openerFocusRef.current === null) openerFocusRef.current = document.activeElement;
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;
  React.useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onCloseRef.current(); }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const opener = openerFocusRef.current;
      if (opener && typeof opener.focus === 'function') opener.focus();
    };
  }, []);

  const origin = projectOrigin(project);
  const selected = files.find(f => f.id === selectedId) || files[0] || null;
  const pretty = React.useMemo(
    () => (selected ? JSON.stringify(selected.data, null, 2) : ''),
    [selected]
  );
  const lineCount = pretty ? pretty.split('\n').length : 0;
  const byteCount = pretty ? new Blob([pretty]).size : 0;

  const safeName = String((project && project.name) || 'project')
    .trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';

  function fileDownloadName(f) {
    if (f.kind === 'schema') return `${safeName}-schema.json`;
    const key = (f.phaseKey || f.id || 'phase').toString().toLowerCase();
    return `${safeName}-${key}.json`;
  }

  async function handleCopy() {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(pretty);
      } else {
        throw new Error('clipboard unavailable');
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch (e) {
      console.warn('Copy failed', e);
    }
  }

  function handleDownload() {
    if (!selected) return;
    downloadJsonBlob(fileDownloadName(selected), pretty);
  }

  function handleDownloadAll() {
    // Stagger so the browser doesn't coalesce/block the individual downloads.
    files.forEach((f, i) => {
      const text = JSON.stringify(f.data, null, 2);
      setTimeout(() => downloadJsonBlob(fileDownloadName(f), text), i * 120);
    });
  }

  function onBackdropDown(e) {
    downOnBackdrop.current = !(modalRef.current && modalRef.current.contains(e.target));
  }
  function onBackdropUp(e) {
    if (downOnBackdrop.current && !(modalRef.current && modalRef.current.contains(e.target))) {
      onClose();
    }
    downOnBackdrop.current = false;
  }

  return (
    <div className="src-backdrop" onMouseDown={onBackdropDown} onMouseUp={onBackdropUp}>
      <div className="src-modal" ref={modalRef} role="dialog" aria-modal="true" aria-labelledby="source-modal-title">
        <div className="src-head">
          <div className="src-head-titles">
            <h3 id="source-modal-title">Data source</h3>
            <div className="src-head-sub">
              <span className="src-proj-name">{project.name}</span>
              <span className={`src-badge src-badge-${origin.key}`}>{origin.label}</span>
            </div>
          </div>
          <button className="drawer-close" aria-label="Close" onClick={onClose}>×</button>
        </div>

        <div className="src-body">
          <div className="src-rail">
            <div className="src-rail-eyebrow">
              {files.length} file{files.length !== 1 ? 's' : ''}
            </div>
            {files.map(f => (
              <button key={f.id}
                className={`src-file-row ${f.id === selectedId ? 'selected' : ''}`}
                onClick={() => setSelectedId(f.id)}>
                <span className={`src-kind src-kind-${f.kind}`}>{f.kind}</span>
                <span className="src-file-main">
                  <span className="src-file-name mono">{f.filename}</span>
                  <span className="src-file-meta">
                    {f.phaseKey ? f.phaseKey + ' · ' : ''}
                    {f.taskCount != null ? `${f.taskCount} task${f.taskCount !== 1 ? 's' : ''}` : 'schema'}
                  </span>
                </span>
              </button>
            ))}
          </div>

          <div className="src-pane">
            <div className="src-toolbar">
              <span className={`src-chip src-chip-${selected ? selected.kind : 'data'}`}>
                {selected ? selected.kind : '—'}
              </span>
              <span className="src-toolbar-name mono">{selected ? selected.filename : '—'}</span>
              <span className="src-toolbar-meta">{bytesLabel(byteCount)} · {lineCount} lines</span>
              <span className="src-toolbar-spacer" />
              <button className="src-act" onClick={handleCopy} disabled={!selected}>
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button className="src-act" onClick={handleDownload} disabled={!selected}>Download</button>
              <button className="src-act" onClick={handleDownloadAll} disabled={!files.length}>Download all</button>
            </div>
            {origin.key === 'builtin' && (
              <div className="src-note">
                Built-in data from <code>window.PHASE_DATA</code> — read-only; changes apply at app reload only, never edited in place.
              </div>
            )}
            <pre className="src-json">{pretty}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ProjectSwitcher, AddProjectModal, ProjectSourceModal });
