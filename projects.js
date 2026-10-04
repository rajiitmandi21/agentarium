// Projects layer — manages list of projects (each a set of phase data files).
// Built-in project is loaded from window.PHASE_DATA (data.js).
// User-added projects live in localStorage.

window.projects = (function(){
  const STORAGE_KEY = 'dt-projects-v1';
  const ACTIVE_KEY = 'dt-active-project-v1';
  const PERSONA_KEY = 'dt-acting-persona-v1';
  // Default acting persona = the project operator. This is the seam the future
  // Crews persona-frame selector overrides via setActingPersona(); never hard-fail
  // when nothing is configured.
  const DEFAULT_PERSONA = 'human-raj';

  function getActingPersona() {
    try {
      return localStorage.getItem(PERSONA_KEY) || DEFAULT_PERSONA;
    } catch (e) {
      return DEFAULT_PERSONA;
    }
  }
  function setActingPersona(id) {
    try {
      if (id) localStorage.setItem(PERSONA_KEY, id);
      else localStorage.removeItem(PERSONA_KEY);
    } catch (e) { /* ignore storage failures */ }
  }

  // Required top-level keys per schema-81a7a299.json
  const REQUIRED_TOP = ['title', 'subtitle', 'last_updated', 'human_reviews', 'tasks'];
  const REQUIRED_TASK = ['id', 'title', 'status', 'priority', 'blockers', 'reviews', 'subtasks'];
  const VALID_STATUSES = new Set(['completed', 'in_progress', 'todo', 'blocked']);
  const VALID_PRIORITIES = new Set(['p0', 'p1', 'p2', 'pl']);
  const VALID_PM_STATUSES = new Set(['', 'done', 'tested', 'needs-review', 'rejected', 'superseded']);
  const PHASE_FILE_RE = /^data(_p\d+)?\.json$/i;

  function isPhaseDataFile(name) {
    return PHASE_FILE_RE.test(name);
  }

  function isSchemaFile(name) {
    return /^schema\.json$/i.test(name);
  }

  function isoValid(ts) {
    if (!ts || typeof ts !== 'string') return false;
    const d = new Date(ts);
    return !isNaN(d.getTime());
  }

  function collectImportWarnings(phases) {
    const warnings = [];
    const seenIds = new Map();
    for (const p of phases) {
      const label = p.filename || 'phase';
      const data = p.data;
      if (!data) continue;
      if (data.last_updated && !isoValid(data.last_updated)) {
        warnings.push(`${label}: last_updated is not a valid ISO timestamp`);
      }
      for (const t of data.tasks || []) {
        if (t.id) {
          if (seenIds.has(t.id)) {
            warnings.push(`Duplicate task id "${t.id}" in ${label} and ${seenIds.get(t.id)}`);
          } else seenIds.set(t.id, label);
        }
        if (t.status && !VALID_STATUSES.has(t.status)) {
          warnings.push(`${label}: task ${t.id || '?'} has unknown status "${t.status}"`);
        }
        if (t.priority && !VALID_PRIORITIES.has(t.priority)) {
          warnings.push(`${label}: task ${t.id || '?'} has unknown priority "${t.priority}"`);
        }
        if (t.pm_status != null && t.pm_status !== '' && !VALID_PM_STATUSES.has(t.pm_status)) {
          warnings.push(`${label}: task ${t.id || '?'} has unsupported pm_status "${t.pm_status}"`);
        }
        if (t.code_updated_at && !isoValid(t.code_updated_at)) {
          warnings.push(`${label}: task ${t.id || '?'} has invalid code_updated_at`);
        }
      }
    }
    return sanitizeImportWarnings(warnings);
  }

  function patchUserProject(projectId, patch) {
    const all = loadUserProjects();
    const i = all.findIndex(p => p.id === projectId);
    if (i < 0) return null;
    all[i] = { ...all[i], ...patch };
    saveUserProjects(all);
    return all[i];
  }

  async function dirHasPhaseFiles(handle) {
    for await (const [name, entry] of handle.entries()) {
      if (entry.kind === 'file' && isPhaseDataFile(name)) return true;
    }
    return false;
  }

  async function dirHasSubdir(handle, subdirName) {
    for await (const [name, entry] of handle.entries()) {
      if (entry.kind === 'directory' && name === subdirName) return true;
    }
    return false;
  }

  // Resolve canonical project-management/ root + status path prefix relative to linkRoot (saved handle).
  async function resolvePmRoot(handle) {
    if (!handle) throw new Error('No directory handle');

    if (await dirHasSubdir(handle, 'project-management')) {
      const pmRoot = await handle.getDirectoryHandle('project-management');
      return {
        linkRoot: handle,
        pmRoot,
        sourceRoot: 'project-management/',
        relativePrefix: 'project-management/status/',
        statusOnly: false,
      };
    }

    const hasStatus = await dirHasSubdir(handle, 'status');
    const hasPlans = await dirHasSubdir(handle, 'plans');
    const hasMessages = await dirHasSubdir(handle, 'messages');
    const hasRoles = await dirHasSubdir(handle, 'roles');
    if (hasStatus && (hasPlans || hasMessages || hasRoles)) {
      return {
        linkRoot: handle,
        pmRoot: handle,
        sourceRoot: 'project-management/',
        relativePrefix: 'status/',
        statusOnly: false,
      };
    }

    if (await dirHasPhaseFiles(handle)) {
      return {
        linkRoot: handle,
        pmRoot: null,
        sourceRoot: 'status/',
        relativePrefix: '',
        statusOnly: true,
      };
    }

    throw new Error(
      'No project-management/ layout found. Pick the repo root or the project-management/ folder.'
    );
  }

  // Legacy alias — status dir + prefix from link root.
  async function resolveStatusDir(handle) {
    const resolved = await resolvePmRoot(handle);
    if (resolved.statusOnly) {
      return { statusDir: resolved.linkRoot, relativePrefix: '' };
    }
    const statusDir = await resolved.pmRoot.getDirectoryHandle('status');
    return { statusDir, relativePrefix: resolved.relativePrefix };
  }

  function migrateStoredProjects() {
    const all = loadUserProjects();
    let dirty = false;
    for (const p of all) {
      if (p.httpLinked && p.dirLinked) {
        p.dirLinked = false;
        dirty = true;
      }
    }
    if (dirty) saveUserProjects(all);
  }

  function validatePhase(data, fileLabel) {
    const errors = [];
    if (!data || typeof data !== 'object') {
      errors.push(`${fileLabel}: not an object`);
      return errors;
    }
    for (const k of REQUIRED_TOP) {
      if (!(k in data)) errors.push(`${fileLabel}: missing required key "${k}"`);
    }
    if (!Array.isArray(data.tasks)) {
      errors.push(`${fileLabel}: "tasks" must be an array`);
    } else {
      data.tasks.forEach((t, i) => {
        for (const k of REQUIRED_TASK) {
          if (!(k in t)) errors.push(`${fileLabel}: tasks[${i}] missing "${k}"`);
        }
        if (t.status && !VALID_STATUSES.has(t.status)) {
          errors.push(`${fileLabel}: tasks[${i}].status = "${t.status}" not in valid set`);
        }
        if (t.priority && !VALID_PRIORITIES.has(t.priority)) {
          errors.push(`${fileLabel}: tasks[${i}].priority = "${t.priority}" not in valid set`);
        }
      });
    }
    return errors;
  }

  function builtInProject() {
    const phases = window.PHASES.map(p => ({
      id: p.id,
      label: p.label,
      name: p.name,
      key: p.key,
      data: window.PHASE_DATA[p.key],
    }));
    return {
      id: 'builtin',
      name: window.AGENTARIUM_RELEASE?.demoName || 'Digital Twin (sample)',
      builtin: true,
      schema: null,
      phases,
    };
  }

  function sanitizeImportWarnings(warnings) {
    if (!warnings || !warnings.length) return [];
    if (window.pmLoader && window.pmLoader.filterUserWarnings) {
      return window.pmLoader.filterUserWarnings(warnings);
    }
    if (window.helpers && window.helpers.filterDisplayWarnings) {
      return window.helpers.filterDisplayWarnings(warnings);
    }
    return warnings;
  }

  function sanitizeStoredProject(project) {
    if (!project || typeof project !== 'object') return project;
    if (Array.isArray(project.importWarnings) && project.importWarnings.length) {
      project.importWarnings = sanitizeImportWarnings(project.importWarnings);
    }
    return project;
  }

  function scrubStoredImportWarnings() {
    const all = loadUserProjects();
    saveUserProjects(all);
    return all;
  }

  function loadUserProjects() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      return JSON.parse(raw).map(sanitizeStoredProject);
    } catch (e) { return []; }
  }

  function saveUserProjects(arr) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(arr)); }
    catch (e) { console.warn('saveUserProjects failed', e); }
  }

  function getActiveProjectId() {
    // Guarded like getActingPersona above: storage can throw when blocked, and
    // this runs during React state init — an unguarded throw blanks the app.
    try {
      return localStorage.getItem(ACTIVE_KEY) || 'builtin';
    } catch (e) {
      return 'builtin';
    }
  }
  function setActiveProjectId(id) {
    try { localStorage.setItem(ACTIVE_KEY, id); }
    catch (e) { /* storage unavailable — session-only active project */ }
  }

  function getAllProjects() {
    return [builtInProject(), ...loadUserProjects()];
  }

  function getProject(id) {
    return getAllProjects().find(p => p.id === id) || builtInProject();
  }

  function newProjectId() {
    return 'proj-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  }

  function inferPhaseLabel(idx) {
    return `Phase ${idx + 1}`;
  }

  // From a list of File objects, parse + validate. Returns { phases, errors, schema }.
  async function importFromFiles(files) {
    let schema = null;
    const phases = [];
    const errors = [];

    for (const f of Array.from(files)) {
      try {
        if (!isPhaseDataFile(f.name) && !isSchemaFile(f.name)) continue;
        const text = await f.text();
        const json = JSON.parse(text);
        if (isSchemaFile(f.name) || (json && json.$schema)) {
          schema = json;
          continue;
        }
        const clean = window.khiraSanitize
          ? window.khiraSanitize.sanitizePhaseData(json)
          : json;
        const errs = validatePhase(clean, f.name);
        if (errs.length > 0) errors.push(...errs);
        phases.push({ filename: f.name, data: clean });
      } catch (e) {
        errors.push(`${f.name}: ${e.message}`);
      }
    }

    phases.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));
    const warnings = collectImportWarnings(phases);
    return { phases, errors, schema, warnings };
  }

  function phaseEntryFromImport(phaseObj, index, prevPhase, writable) {
    const relativePath = phaseObj.filename || phaseObj.relativePath || null;
    const baseName = relativePath ? relativePath.split('/').pop() : null;
    // Phase number comes from the FILENAME (data_p13.json -> 13), NOT the ordinal
    // position. Once phases pass p9 the numeric-sorted order and the array index
    // diverge (data_p10..p13 sort after p9), so an ordinal key mislabels — e.g. "P5"
    // on a Phase 13 file. Filename-derived is correct AND stable across re-imports,
    // so we no longer reuse prevPhase's (possibly stale) ordinal id/key/label.
    const nm = (baseName || relativePath || '').match(/_p(\d+)/i) || (baseName || '').match(/(\d+)\.json$/i);
    const phaseNum = nm ? parseInt(nm[1], 10) : (index + 1);
    return {
      id: 'p' + phaseNum,
      key: 'P' + phaseNum,
      label: inferPhaseLabel(phaseNum - 1),
      name: (phaseObj.data && phaseObj.data.title) || (prevPhase && prevPhase.name) || ('Phase ' + phaseNum),
      data: phaseObj.data,
      etag: phaseObj.etag || null,
      filename: baseName || relativePath,
      relativePath,
      writable: !!(writable && relativePath),
    };
  }

  function buildProject(name, phaseObjs, schema, options) {
    const opts = options || {};
    const prevPhases = opts.prevPhases || [];
    const byPath = new Map();
    for (const p of prevPhases) {
      if (p.relativePath) byPath.set(p.relativePath, p);
      else if (p.filename) byPath.set(p.filename, p);
    }
    const writableDefault = opts.writable !== false && !!opts.dirLinked;
    return {
      id: opts.preserveId || newProjectId(),
      name: name || 'Untitled project',
      builtin: false,
      schema,
      dirLinked: !!opts.dirLinked,
      phases: phaseObjs.map((p, i) => {
        const rel = p.filename || p.relativePath;
        const prev = rel ? byPath.get(rel) : prevPhases[i];
        return phaseEntryFromImport(p, i, prev, writableDefault);
      }).sort((a, b) => {
        // Order phases by their real (filename-derived) number so P2 precedes P10
        // and the dropdown order matches the labels, regardless of the input/file sort.
        const n = x => parseInt(String(x.key || '').replace(/\D/g, ''), 10) || 0;
        return n(a) - n(b);
      }),
    };
  }

  function addProject(project) {
    const all = loadUserProjects();
    all.push(project);
    saveUserProjects(all);
    return project;
  }

  function deleteProject(id) {
    const all = loadUserProjects().filter(p => p.id !== id);
    saveUserProjects(all);
    // Best-effort: drop any directory handle linked to this project.
    deleteDirHandle(id).catch(() => {});
  }

  // ─── File System Access API + IndexedDB (Refresh-from-disk) ────────────────
  // Directory handles can't go in localStorage (only strings). IndexedDB
  // serializes FileSystemDirectoryHandle objects natively.

  const IDB_NAME = 'khira-handles';
  const IDB_STORE = 'handles';

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveDirHandle(projectId, handle) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(handle, projectId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getDirHandle(projectId) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const r = tx.objectStore(IDB_STORE).get(projectId);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error);
    });
  }

  async function deleteDirHandle(projectId) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(projectId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  const PERMISSION_TIMEOUT_MS = 45000;
  const WRITE_TIMEOUT_MS = 30000;
  const HANDLE_LOOKUP_TIMEOUT_MS = 10000;
  const QUERY_PERMISSION_TIMEOUT_MS = 10000;
  // Hard ceiling for an entire savePhaseToDir() call. Even if every inner
  // guard somehow fails to fire, the Save UI is released by this bound.
  const SAVE_OVERALL_TIMEOUT_MS = 90000;

  function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  // ─── API Workspace source mode (AG-P8.4 client / AG-P8.6) ──────────────────
  // The API save + source detection use fetch (not the File System Access API),
  // so they are the over-HTTP twin of savePhaseToDir. The same idle/saving/
  // saved/error Save states drive both; the API path returns the same
  // { ok, code, error } contract and is bounded so a dead server never hangs.
  const API_HEALTH_TIMEOUT_MS = 4000;
  const API_WRITE_TIMEOUT_MS = 15000;

  // Cached health probe so we don't re-hit /api/health on every render. null =
  // not yet probed; resolved object = last known capability.
  let _apiHealth = null; // { ok, writeEnabled, sourceMode, version } | { ok:false, ... }
  let _apiHealthProbedAt = 0;
  // Bounded staleness: successes are trusted briefly, failures almost not at
  // all, so a server started (or stopped) after page load is adopted on the
  // next refresh instead of requiring a full reload. Callers on the refresh
  // path pass force=true to always re-probe.
  const API_HEALTH_TTL_OK_MS = 30000;
  const API_HEALTH_TTL_FAIL_MS = 3000;

  function getApiSourceState() {
    return _apiHealth;
  }

  function isApiWorkspaceActive() {
    return !!(_apiHealth && _apiHealth.ok && _apiHealth.writeEnabled);
  }

  // Bound the health probe; AbortController stops the socket so a slow/dead
  // server resolves to "not API mode" inside the window rather than hanging.
  async function probeApiHealth(force) {
    if (window.AGENTARIUM_RELEASE?.staticHosting) {
      return { ok: false, writeEnabled: false, reason: 'Browser workspace' };
    }
    if (_apiHealth && !force) {
      const ttl = _apiHealth.ok ? API_HEALTH_TTL_OK_MS : API_HEALTH_TTL_FAIL_MS;
      if (Date.now() - _apiHealthProbedAt < ttl) return _apiHealth;
    }
    let controller = null;
    let timer = null;
    if (typeof AbortController === 'function') {
      controller = new AbortController();
      timer = setTimeout(() => controller.abort(), API_HEALTH_TIMEOUT_MS);
    }
    try {
      const r = await withTimeout(
        fetch('/api/health', {
          cache: 'no-store',
          signal: controller ? controller.signal : undefined,
        }),
        API_HEALTH_TIMEOUT_MS,
        'API health probe'
      );
      if (!r.ok) {
        _apiHealth = { ok: false, writeEnabled: false, reason: `health ${r.status}` };
        _apiHealthProbedAt = Date.now();
        return _apiHealth;
      }
      const j = await r.json();
      _apiHealth = {
        ok: !!j.ok,
        writeEnabled: !!j.writeEnabled,
        sourceMode: j.sourceMode || null,
        version: j.version || null,
      };
      _apiHealthProbedAt = Date.now();
      return _apiHealth;
    } catch (e) {
      // No server / aborted / offline → degrade to snapshot+local cleanly.
      _apiHealth = { ok: false, writeEnabled: false, reason: e.message || String(e) };
      _apiHealthProbedAt = Date.now();
      return _apiHealth;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Map an HTTP status (+ parsed error body) to the recoverable-error contract
  // the Save state machine already understands. Draft is always preserved by
  // the caller; we only translate the failure into { ok:false, code, error }.
  function apiErrorResult(status, bodyObj) {
    const body = bodyObj || {};
    if (status === 409) {
      return {
        ok: false,
        code: 'conflict',
        error: 'The phase changed on the server (409). Your draft is preserved. Reload the latest phase to reconcile before saving again.',
      };
    }
    if (status === 401) {
      return {
        ok: false,
        code: 'unauthorized',
        error: body.error || 'No acting persona accepted by the server (401). Your draft is kept.',
      };
    }
    if (status === 403) {
      const who = body.persona ? `Persona "${body.persona}"` : 'This persona';
      const missing = body.missingPermission ? ` lacks ${body.missingPermission}` : ' lacks permission for this action';
      return {
        ok: false,
        code: 'forbidden',
        persona: body.persona || null,
        missingPermission: body.missingPermission || null,
        error: `${who}${missing} (403). Draft preserved — switch persona or get approval.`,
      };
    }
    if (status === 400 || status === 422) {
      const detail = Array.isArray(body.errors) && body.errors.length
        ? ` ${body.errors.slice(0, 3).join('; ')}`
        : (body.error ? ` ${body.error}` : '');
      return {
        ok: false,
        code: 'invalid',
        error: `Server rejected the save (${status}); draft kept.${detail}`,
      };
    }
    return {
      ok: false,
      code: 'api-failed',
      error: (body.error || `Save failed (${status})`) + ' — draft preserved.',
    };
  }

  async function parseJsonSafe(response) {
    try { return await response.json(); } catch (e) { return null; }
  }

  // PUT /api/status/:phase — the API twin of savePhaseToDirImpl. Same contract,
  // bounded by withTimeout + AbortController; draft survives every failure.
  async function savePhaseViaApi(phaseId, phaseData, persona, etag) {
    const phaseParam = String(phaseId || '').replace(/[^a-z0-9]/gi, '');
    if (!phaseParam) {
      return { ok: false, code: 'missing-path', error: 'Phase has no API id; draft kept.' };
    }
    if (typeof etag !== 'string' || !etag.trim()) {
      return { ok: false, code: 'missing-etag', error: 'This phase has no authoritative ETag. Reload the phase before saving; draft preserved.' };
    }
    const actingPersona = persona || getActingPersona();
    let controller = null;
    let timer = null;
    if (typeof AbortController === 'function') {
      controller = new AbortController();
      timer = setTimeout(() => controller.abort(), API_WRITE_TIMEOUT_MS);
    }
    try {
      const r = await withTimeout(
        fetch(`/api/status/${encodeURIComponent(phaseParam)}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-Agentarium-Persona': actingPersona,
            'If-Match': etag,
          },
          body: JSON.stringify(phaseData),
          cache: 'no-store',
          signal: controller ? controller.signal : undefined,
        }),
        API_WRITE_TIMEOUT_MS,
        'API hard save'
      );
      if (r.ok) {
        const body = await parseJsonSafe(r);
        const nextEtag = (body && body.etag) || r.headers.get('ETag');
        if (!nextEtag) {
          return { ok: false, code: 'missing-etag', error: 'Save response omitted its ETag. Draft preserved; reload the phase to reconcile.' };
        }
        if (!body || !body.data || !Array.isArray(body.data.tasks)) {
          return { ok: false, code: 'missing-data', error: 'Save response omitted authoritative phase data. Draft preserved; reload the phase to reconcile.' };
        }
        return {
          ok: true,
          via: 'api',
          persona: actingPersona,
          etag: nextEtag,
          data: body.data,
          savedAt: (body && body.savedAt) || new Date().toISOString(),
          ignoredProtectedChanges: (body && body.ignoredProtectedChanges) || [],
        };
      }
      const body = await parseJsonSafe(r);
      return apiErrorResult(r.status, body);
    } catch (e) {
      // Network down / aborted / timeout → recoverable, draft intact.
      return {
        ok: false,
        code: 'timeout',
        error: `${e.message || String(e)} — save outcome is uncertain. Draft preserved; reload the latest phase to reconcile before saving again.`,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // POST /api/messages — append-only handoff write (AG-P8.6 acceptance surface).
  async function appendMessageViaApi(filename, markdownBody, persona, requestId) {
    const actingPersona = persona || getActingPersona();
    const stableRequestId = requestId || (window.crypto && window.crypto.randomUUID
      ? window.crypto.randomUUID() : `message-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    let controller = null;
    let timer = null;
    if (typeof AbortController === 'function') {
      controller = new AbortController();
      timer = setTimeout(() => controller.abort(), API_WRITE_TIMEOUT_MS);
    }
    try {
      const r = await withTimeout(
        fetch('/api/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Agentarium-Persona': actingPersona,
          },
          body: JSON.stringify({ filename: filename || undefined, body: markdownBody, requestId: stableRequestId }),
          cache: 'no-store',
          signal: controller ? controller.signal : undefined,
        }),
        API_WRITE_TIMEOUT_MS,
        'API message append'
      );
      const body = await parseJsonSafe(r);
      if (r.ok) return { ok: true, via: 'api', file: body && body.file, persona: actingPersona };
      return apiErrorResult(r.status, body);
    } catch (e) {
      return { ok: false, code: 'timeout', error: e.message || String(e) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // PATCH /api/status/:phase/tasks/:id — owner_id assignment (Crews) over the
  // API. Part of the AG-P8.6 acceptance surface so assignment has a write path.
  async function assignTaskOwnerViaApi(phaseId, taskId, ownerId, persona) {
    const phaseParam = String(phaseId || '').replace(/[^a-z0-9]/gi, '');
    if (!phaseParam || !taskId) {
      return { ok: false, code: 'missing-path', error: 'Missing phase or task id.' };
    }
    const actingPersona = persona || getActingPersona();
    let controller = null;
    let timer = null;
    if (typeof AbortController === 'function') {
      controller = new AbortController();
      timer = setTimeout(() => controller.abort(), API_WRITE_TIMEOUT_MS);
    }
    try {
      const phaseRead = await withTimeout(
        fetch(`/api/status/${encodeURIComponent(phaseParam)}`, {
          headers: { 'X-Agentarium-Persona': actingPersona },
          cache: 'no-store', signal: controller ? controller.signal : undefined,
        }), API_WRITE_TIMEOUT_MS, 'API phase read before assignment');
      const phaseBody = await parseJsonSafe(phaseRead);
      if (!phaseRead.ok) return apiErrorResult(phaseRead.status, phaseBody);
      const etag = phaseRead.headers.get('ETag') || (phaseBody && phaseBody.etag);
      if (!etag) return { ok: false, code: 'missing-etag', error: 'Phase has no ETag; reload and retry assignment.' };
      const r = await withTimeout(
        fetch(`/api/status/${encodeURIComponent(phaseParam)}/tasks/${encodeURIComponent(taskId)}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'X-Agentarium-Persona': actingPersona,
            'If-Match': etag,
          },
          body: JSON.stringify({ owner_id: ownerId }),
          cache: 'no-store',
          signal: controller ? controller.signal : undefined,
        }),
        API_WRITE_TIMEOUT_MS,
        'API owner assignment'
      );
      const body = await parseJsonSafe(r);
      if (r.ok) return { ok: true, via: 'api', persona: actingPersona };
      return apiErrorResult(r.status, body);
    } catch (e) {
      return { ok: false, code: 'timeout', error: e.message || String(e) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Source-mode router: hard Save goes to the API when the active project is in
  // API-workspace mode, else to the unchanged local-folder path. The local
  // File System Access path (savePhaseToDir) is never altered by this.
  function projectIsApiWorkspace(project) {
    // BEHAVIOR CHANGE (owner-approved): API-workspace membership is a
    // per-project property — the apiWorkspace flag set by registerFixtureProject —
    // not a global capability probe. Previously ANY project was routed to the
    // API whenever /api/health said ok, which (a) made projectCanHardSave demand
    // access.state === 'api-workspace' for folder-linked projects whose real
    // state is 'linked' (silently disabling their hard-save) and (b) would have
    // misrouted their saves away from the linked folder. To revert: return
    // `!!(project && project.apiWorkspace) || isApiWorkspaceActive()`.
    return !!(project && project.apiWorkspace);
  }

  async function savePhase(projectId, phaseId, phaseData, options) {
    const opts = options || {};
    // Built-in sample project: never stored in userProjects → null here, and
    // projectIsApiWorkspace(null) is false, so a save attempt degrades to the
    // local path's clean "Project not found" error instead of PUTting sample
    // data at the repo's real status files.
    const project = loadUserProjects().find((p) => p.id === projectId);
    const apiProject = projectIsApiWorkspace(project);
    if (opts.forceApi && !apiProject) {
      return { ok: false, code: 'source-mismatch', error: 'This project is not an API workspace; no API save was sent.' };
    }
    if (apiProject) {
      // Compatibility for the legacy app path: the token still comes from the
      // project's paired authoritative phase read, never from a later GET.
      const phase = project && (project.phases || []).find(ph => ph.id === phaseId);
      const etag = Object.prototype.hasOwnProperty.call(opts, 'etag')
        ? opts.etag
        : (phase && phase.etag);
      const result = await savePhaseViaApi(phaseId, phaseData, opts.persona, etag);
      if (result.ok) {
        const all = loadUserProjects();
        const pi = all.findIndex(p => p.id === projectId);
        if (pi >= 0) {
          const phases = (all[pi].phases || []).map(ph => ph.id === phaseId
            ? { ...ph, data: result.data, etag: result.etag }
            : ph);
          all[pi] = { ...all[pi], phases };
          saveUserProjects(all);
        }
      }
      return result;
    }
    return savePhaseToDir(projectId, phaseId, phaseData);
  }

  // Deliberate conflict reconciliation: fetch the authoritative phase data and
  // its token together, then replace both in the same stored project update.
  async function reloadApiPhase(projectId, phaseId) {
    const phaseParam = String(phaseId || '').replace(/[^a-z0-9]/gi, '');
    if (!phaseParam) return { ok: false, error: 'Phase has no API id.' };
    const initialProjects = loadUserProjects();
    const initialProject = initialProjects.find(p => p.id === projectId);
    if (!projectIsApiWorkspace(initialProject)) {
      return { ok: false, code: 'source-mismatch', error: 'This project is not an API workspace; no API reload was sent.' };
    }
    if (!(initialProject.phases || []).some(ph => ph.id === phaseId)) {
      return { ok: false, error: 'Phase is not part of this API workspace.' };
    }
    let controller = null;
    let timer = null;
    if (typeof AbortController === 'function') {
      controller = new AbortController();
      timer = setTimeout(() => controller.abort(), API_WRITE_TIMEOUT_MS);
    }
    try {
      const r = await withTimeout(
        fetch(`/api/status/${encodeURIComponent(phaseParam)}`, {
          cache: 'no-store',
          signal: controller ? controller.signal : undefined,
        }),
        API_WRITE_TIMEOUT_MS,
        'API phase reload'
      );
      const body = await parseJsonSafe(r);
      if (!r.ok) return { ok: false, error: (body && body.error) || `Reload failed (${r.status}).` };
      const etag = (body && body.etag) || r.headers.get('ETag');
      if (!body || !body.data || !etag) return { ok: false, error: 'Authoritative reload omitted phase data or ETag.' };
      const all = loadUserProjects();
      const pi = all.findIndex(p => p.id === projectId);
      if (pi < 0) return { ok: false, error: 'Project changed during reload.' };
      if (!projectIsApiWorkspace(all[pi])) {
        return { ok: false, code: 'source-mismatch', error: 'Project source changed during reload; no data was replaced.' };
      }
      let matched = false;
      const phases = (all[pi].phases || []).map(ph => {
        if (ph.id !== phaseId) return ph;
        matched = true;
        return { ...ph, data: body.data, etag };
      });
      if (!matched) return { ok: false, error: 'Phase is not part of this API workspace.' };
      all[pi] = { ...all[pi], phases };
      saveUserProjects(all);
      return { ok: true, etag };
    } catch (e) {
      return { ok: false, error: `${e.message || String(e)}. Draft preserved; reload can be retried.` };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function getProjectPhase(projectId, phaseId) {
    const project = loadUserProjects().find(p => p.id === projectId);
    return project && (project.phases || []).find(ph => ph.id === phaseId) || null;
  }

  async function verifyDirPermission(handle, mode) {
    const opts = { mode: mode || 'read' };
    let current;
    try {
      current = await withTimeout(
        Promise.resolve(handle.queryPermission(opts)),
        QUERY_PERMISSION_TIMEOUT_MS,
        'Folder permission query'
      );
    } catch (e) {
      console.warn('verifyDirPermission query', e);
      return false;
    }
    if (current === 'granted') return true;
    if (current === 'denied') return false;
    try {
      const result = await withTimeout(
        Promise.resolve(handle.requestPermission(opts)),
        PERMISSION_TIMEOUT_MS,
        'Folder permission request'
      );
      return result === 'granted';
    } catch (e) {
      console.warn('verifyDirPermission', e);
      return false;
    }
  }

  async function verifyDirWritePermission(handle) {
    return verifyDirPermission(handle, 'readwrite');
  }

  function isSafePhaseRelativePath(relativePath) {
    if (!relativePath || typeof relativePath !== 'string') return false;
    if (relativePath.includes('..') || relativePath.startsWith('/') || relativePath.includes('\\')) {
      return false;
    }
    const base = relativePath.split('/').pop();
    return isPhaseDataFile(base);
  }

  async function resolveFileHandleForPath(rootHandle, relativePath) {
    const parts = relativePath.split('/').filter(Boolean);
    if (parts.length === 0) throw new Error('Empty relative path.');
    let dir = rootHandle;
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i]);
    }
    return dir.getFileHandle(parts[parts.length - 1], { create: true });
  }

  function updatePhaseDataInProject(projectId, phaseId, phaseData, meta) {
    const all = loadUserProjects();
    const i = all.findIndex(p => p.id === projectId);
    if (i < 0) return null;
    const proj = { ...all[i] };
    const pi = proj.phases.findIndex(p => p.id === phaseId);
    if (pi < 0) return null;
    proj.phases = proj.phases.slice();
    proj.phases[pi] = {
      ...proj.phases[pi],
      data: phaseData,
      ...(meta || {}),
    };
    if (meta && meta.lastSavedAt) {
      proj.lastSaveAt = meta.lastSavedAt;
      proj.lastSaveError = null;
    }
    all[i] = proj;
    saveUserProjects(all);
    return proj;
  }

  // Core write path. Every await that can hang (IDB lookup, permission
  // query/request, file resolution, createWritable/write/close) is wrapped in
  // withTimeout. Returns a result object; never resolves with the UI stuck.
  async function savePhaseToDirImpl(projectId, phaseId, phaseData) {
    if (!isDirPickerSupported()) {
      return { ok: false, error: 'Folder picker unsupported in this browser.', code: 'unsupported' };
    }
    const proj = loadUserProjects().find(p => p.id === projectId);
    if (!proj) return { ok: false, error: 'Project not found.', code: 'missing-project' };
    if (!proj.dirLinked) {
      return { ok: false, error: 'Snapshot-only project — use Export instead of Save.', code: 'snapshot' };
    }
    const phase = (proj.phases || []).find(p => p.id === phaseId);
    if (!phase) return { ok: false, error: 'Phase not found.', code: 'missing-phase' };
    const relativePath = phase.relativePath;
    if (!relativePath) {
      return { ok: false, error: 'Phase has no linked file path.', code: 'missing-path' };
    }
    if (!isSafePhaseRelativePath(relativePath)) {
      return { ok: false, error: 'Unsafe or invalid phase path.', code: 'invalid-path' };
    }

    // IndexedDB reads can hang if the connection is blocked — bound it.
    let handle;
    try {
      handle = await withTimeout(
        getDirHandle(projectId),
        HANDLE_LOOKUP_TIMEOUT_MS,
        'Look up linked folder'
      );
    } catch (e) {
      const msg = e.message || String(e);
      patchUserProject(projectId, { accessState: 'reconnect', lastSaveError: msg });
      return { ok: false, error: `${msg} Reconnect the folder and try again.`, code: 'reconnect' };
    }
    if (!handle) {
      patchUserProject(projectId, {
        accessState: 'reconnect',
        lastSaveError: 'No directory linked to this project.',
      });
      return { ok: false, error: 'No directory linked. Reconnect folder first.', code: 'reconnect' };
    }

    const granted = await verifyDirWritePermission(handle);
    if (!granted) {
      patchUserProject(projectId, {
        accessState: 'permission-needed',
        lastSaveError: 'Write permission was denied or timed out.',
      });
      return {
        ok: false,
        error: 'Cannot write to this folder. Click Reconnect folder and pick the project again (read/write access).',
        code: 'permission-needed',
      };
    }

    let writable = null;
    try {
      const fileHandle = await withTimeout(
        resolveFileHandleForPath(handle, relativePath),
        WRITE_TIMEOUT_MS,
        'Resolve file path'
      );
      writable = await withTimeout(
        fileHandle.createWritable(),
        WRITE_TIMEOUT_MS,
        'Open file for writing'
      );
      await withTimeout(
        writable.write(JSON.stringify(phaseData, null, 2) + '\n'),
        WRITE_TIMEOUT_MS,
        'Write file'
      );
      await withTimeout(writable.close(), WRITE_TIMEOUT_MS, 'Close file');
      writable = null;
      const now = new Date().toISOString();
      const updated = updatePhaseDataInProject(projectId, phaseId, phaseData, {
        lastSavedAt: now,
      });
      patchUserProject(projectId, {
        lastSaveAt: now,
        lastSaveError: null,
        accessState: 'linked',
      });
      return { ok: true, project: updated, relativePath };
    } catch (e) {
      const msg = e.message || String(e);
      // Best-effort: abort a writable we opened but never closed so the OS
      // releases the lock; ignore failures so cleanup can't itself hang.
      if (writable && typeof writable.abort === 'function') {
        withTimeout(Promise.resolve(writable.abort()), WRITE_TIMEOUT_MS, 'Abort write')
          .catch(() => {});
      }
      // Permission can be revoked mid-write; reflect that as a recoverable state.
      const lostPermission = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      if (lostPermission) {
        patchUserProject(projectId, { accessState: 'permission-needed', lastSaveError: msg });
        return {
          ok: false,
          error: 'Write permission was lost. Click Reconnect folder and pick the project again (read/write access).',
          code: 'permission-needed',
        };
      }
      patchUserProject(projectId, { lastSaveError: msg });
      return { ok: false, error: msg, code: 'write-failed' };
    }
  }

  async function savePhaseToDir(projectId, phaseId, phaseData) {
    try {
      return await withTimeout(
        savePhaseToDirImpl(projectId, phaseId, phaseData),
        SAVE_OVERALL_TIMEOUT_MS,
        'Save'
      );
    } catch (e) {
      // Absolute backstop: if the whole save exceeds the ceiling, never leave
      // the UI spinning — surface a recoverable timeout error.
      const msg = e.message || String(e);
      try { patchUserProject(projectId, { lastSaveError: msg }); } catch (_) {}
      return {
        ok: false,
        error: `${msg}. The folder may need to be reconnected — click Reconnect folder and try again.`,
        code: 'timeout',
      };
    }
  }

  function projectCanHardSave(project, access) {
    if (!project || project.builtin) return false;
    if (projectIsApiWorkspace(project)) {
      return !!(access && access.state === 'api-workspace' && access.canSave);
    }
    if (project.fixture || project.httpLinked) return false;
    if (!project.dirLinked) return false;
    if (!access || access.state !== 'linked' || !access.canSave) return false;
    return (project.phases || []).some(p => p.writable && p.relativePath);
  }

  // Read status/data_p*.json (+ schema) from repo root or project-management/ root (not status/ alone).
  async function readPhasesFromDir(handle) {
    const phases = [];
    const errors = [];
    let schema = null;
    let resolved;
    try {
      resolved = await resolvePmRoot(handle);
    } catch (e) {
      return { phases, errors: [e.message || String(e)], schema: null, warnings: [] };
    }
    if (resolved.statusOnly) {
      return {
        phases: [],
        errors: [
          'Select the project-management/ folder (or repo root), not status/ alone. ' +
          'Status is a child folder of project-management/.',
        ],
        schema: null,
        warnings: [],
        statusOnly: true,
      };
    }
    const statusDir = await resolved.pmRoot.getDirectoryHandle('status');
    const prefix = resolved.relativePrefix || '';
    for await (const [name, entry] of statusDir.entries()) {
      if (entry.kind !== 'file') continue;
      if (!isPhaseDataFile(name) && !isSchemaFile(name)) continue;
      try {
        const file = await entry.getFile();
        const text = await file.text();
        const json = JSON.parse(text);
        const fileLabel = prefix + name;
        if (isSchemaFile(name) || (json && json.$schema)) {
          schema = json;
          continue;
        }
        const clean = window.khiraSanitize
          ? window.khiraSanitize.sanitizePhaseData(json)
          : json;
        const errs = validatePhase(clean, fileLabel);
        if (errs.length > 0) errors.push(...errs);
        phases.push({ filename: fileLabel, data: clean });
      } catch (e) {
        errors.push(`${prefix}${name}: ${e.message}`);
      }
    }
    phases.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));
    const warnings = collectImportWarnings(phases);
    return {
      phases,
      errors,
      schema,
      warnings,
      sourceRoot: resolved.sourceRoot,
      pmRootLinked: true,
    };
  }

  async function inspectProjectAccess(projectId) {
    if (projectId === 'builtin') {
      return { state: 'builtin', label: 'Built-in', canRefresh: false, canReconnect: false };
    }
    const proj = loadUserProjects().find(p => p.id === projectId);
    if (!proj) {
      return { state: 'unknown', label: 'Unknown', canRefresh: false, canReconnect: false };
    }
    if (proj.apiWorkspace) {
      const writable = isApiWorkspaceActive();
      return {
        state: 'api-workspace',
        label: writable ? 'API workspace (writable)' : 'API workspace (unavailable)',
        canRefresh: true,
        canReconnect: false,
        canSave: writable,
        dirName: proj.sourceRoot || 'project-management/',
        sourceRoot: proj.sourceRoot || 'project-management/',
      };
    }
    if (proj.fixture) {
      return {
        state: 'fixture',
        label: 'Fixture (export only)',
        canRefresh: true,
        canReconnect: false,
        canSave: false,
        dirName: proj.dirName || 'project-management/',
      };
    }
    if (proj.httpLinked) {
      return {
        state: 'http-linked',
        label: 'HTTP linked (read-only)',
        canRefresh: true,
        canReconnect: isDirPickerSupported(),
        canSave: false,
        dirName: proj.sourceRoot || 'project-management/',
        lastRefreshAt: proj.lastRefreshAt || null,
        lastRefreshError: proj.lastRefreshError || null,
      };
    }
    if (!proj.dirLinked) {
      return {
        state: 'snapshot',
        label: 'Snapshot (export only)',
        canRefresh: false,
        canReconnect: false,
        canSave: false,
        dirName: proj.dirName || null,
      };
    }
    const handle = await getDirHandle(projectId);
    if (!handle) {
      return {
        state: 'reconnect',
        label: 'Reconnect needed',
        canRefresh: false,
        canReconnect: isDirPickerSupported(),
        dirName: proj.dirName || null,
        lastRefreshAt: proj.lastRefreshAt || null,
        lastRefreshError: proj.lastRefreshError || null,
      };
    }
    const readPerm = await handle.queryPermission({ mode: 'read' });
    const writePerm = await handle.queryPermission({ mode: 'readwrite' });
    const dirName = handle.name || proj.dirName || null;
    const canWrite = writePerm === 'granted';
    if (readPerm === 'granted') {
      return {
        state: canWrite ? 'linked' : 'read-only',
        label: canWrite ? 'Folder linked (writable)' : 'Folder linked (read-only)',
        canRefresh: true,
        canReconnect: true,
        canSave: canWrite && !!proj.dirLinked && !proj.httpLinked,
        dirName,
        sourceRoot: proj.sourceRoot || 'project-management/',
        lastRefreshAt: proj.lastRefreshAt || null,
        lastKnownFileCount: proj.lastKnownFileCount,
        lastRefreshError: proj.lastRefreshError || null,
        lastSaveAt: proj.lastSaveAt || null,
        lastSaveError: proj.lastSaveError || null,
      };
    }
    return {
      state: 'permission-needed',
      label: 'Permission needed',
      canRefresh: false,
      canReconnect: isDirPickerSupported(),
      canSave: false,
      dirName,
      lastRefreshAt: proj.lastRefreshAt || null,
    };
  }

  async function reconnectProjectFolder(projectId) {
    if (!isDirPickerSupported()) {
      return { ok: false, error: 'Folder picker unsupported in this browser.' };
    }
    let handle;
    try {
      handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (e) {
      // User cancelled the picker — not an error worth surfacing as a failure.
      if (e && e.name === 'AbortError') return { ok: false, cancelled: true };
      throw e;
    }
    const resolved = await resolvePmRoot(handle);
    if (resolved.statusOnly) {
      return {
        ok: false,
        error: 'Select the project-management/ folder (or repo root), not status/ alone.',
      };
    }
    const writeOk = await verifyDirWritePermission(handle);
    if (!writeOk) {
      return { ok: false, error: 'Write permission was not granted. Pick the folder again with read/write access.' };
    }
    await saveDirHandle(projectId, handle);
    const now = new Date().toISOString();
    patchUserProject(projectId, {
      dirLinked: true,
      dirName: handle.name,
      sourceRoot: resolved.sourceRoot,
      pmRootLinked: true,
      httpLinked: false,
      fixture: false,
      linkedAt: now,
      lastRefreshError: null,
      accessState: 'linked',
    });
    return refreshProjectFromDir(projectId);
  }

  // Re-read a previously-linked directory and update the project in place.
  // Returns { ok, project?, errors?, error? }.
  async function refreshProjectFromDir(projectId) {
    const handle = await getDirHandle(projectId);
    if (!handle) {
      patchUserProject(projectId, {
        accessState: 'reconnect',
        lastRefreshError: 'No directory linked to this project.',
      });
      return { ok: false, error: 'No directory linked to this project.' };
    }
    const granted = await verifyDirPermission(handle);
    if (!granted) {
      patchUserProject(projectId, {
        accessState: 'permission-needed',
        lastRefreshError: 'Permission to read the directory was denied.',
      });
      return { ok: false, error: 'Permission to read the directory was denied.' };
    }
    let resolved;
    try {
      resolved = await resolvePmRoot(handle);
    } catch (e) {
      const err = e.message || String(e);
      patchUserProject(projectId, { lastRefreshError: err });
      return { ok: false, error: err };
    }
    if (resolved.statusOnly) {
      const err =
        'Select the project-management/ folder (or repo root), not status/ alone.';
      patchUserProject(projectId, { lastRefreshError: err });
      return { ok: false, error: err };
    }
    const { phases, errors, schema, warnings } = await readPhasesFromDir(handle);
    if (phases.length === 0) {
      const err =
        errors[0] ||
        'No status/data_p*.json files found under project-management/status/.';
      patchUserProject(projectId, { lastRefreshError: err, accessState: 'linked' });
      return { ok: false, error: err };
    }
    const all = loadUserProjects();
    const i = all.findIndex(p => p.id === projectId);
    if (i < 0) return { ok: false, error: 'Project not found in user projects.' };
    const prev = all[i];
    const rebuilt = buildProject(prev.name, phases, schema, {
      preserveId: prev.id,
      prevPhases: prev.phases,
      dirLinked: true,
      writable: true,
    });
    const now = new Date().toISOString();
    rebuilt.dirLinked = true;
    rebuilt.httpLinked = false;
    rebuilt.fixture = false;
    rebuilt.sourceRoot = resolved.sourceRoot;
    rebuilt.pmRootLinked = true;
    rebuilt.dirName = handle.name || prev.dirName;
    rebuilt.linkedAt = prev.linkedAt || now;
    rebuilt.lastRefreshAt = now;
    rebuilt.lastKnownFileCount = phases.length;
    rebuilt.lastRefreshError = errors.length
      ? errors.slice(0, 3).join('; ')
      : (warnings.length ? `${warnings.length} import warning(s)` : null);
    rebuilt.accessState = errors.length ? 'stale-snapshot' : 'linked';
    rebuilt.importWarnings = sanitizeImportWarnings(warnings);
    all[i] = rebuilt;
    saveUserProjects(all);
    if (window.pmLoader && window.pmLoader.loadArtifactBundleFromHandle) {
      try {
        const bundle = await window.pmLoader.loadArtifactBundleFromHandle(resolved.pmRoot);
        bundle.sourceLabel = `${resolved.sourceRoot} (folder linked)`;
        window.pmLoader.applyToAgentarium(bundle);
      } catch (e) {
        console.warn('Folder-linked PM artifact refresh failed', e);
      }
    }
    return { ok: true, project: rebuilt, errors, warnings };
  }

  function isDirPickerSupported() {
    return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
  }

  // HTTP-linked project-management/ (same files as fixture, for refresh + source acceptance without FS picker).
  async function refreshHttpLinkedProject(projectId) {
    if (!window.pmLoader) return { ok: false, error: 'pmLoader unavailable' };
    const bundle = await window.pmLoader.loadArtifactBundle();
    window.pmLoader.applyToAgentarium(bundle);
    const all = loadUserProjects();
    const i = all.findIndex((p) => p.id === projectId);
    if (i < 0) return { ok: false, error: 'Project not found.' };
    const prev = all[i];
    const phaseObjs = bundle.statusPhases.map((p) => ({
      filename: (p.filename || '').replace(/^project-management\/status\//, '') || p.filename,
      data: p.data,
    }));
    const rebuilt = buildProject(prev.name || 'Repo (HTTP linked)', phaseObjs, bundle.schema, {
      preserveId: projectId,
      prevPhases: prev.phases,
      dirLinked: false,
      writable: false,
    });
    const now = new Date().toISOString();
    rebuilt.httpLinked = true;
    rebuilt.sourceRoot = 'project-management/';
    rebuilt.fixture = false;
    rebuilt.builtin = false;
    rebuilt.accessState = 'linked';
    rebuilt.lastRefreshAt = now;
    rebuilt.lastKnownFileCount = phaseObjs.length;
    rebuilt.importWarnings = [];
    if (window.edits && window.edits.pruneStaleTaskEdits) {
      window.edits.saveAll(window.edits.pruneStaleTaskEdits(window.edits.loadAll(), projectId, rebuilt.phases));
    }
    all[i] = rebuilt;
    saveUserProjects(all);
    return { ok: true, project: rebuilt };
  }

  async function registerHttpLinkedProjectManagement(options) {
    const opts = options || {};
    const id = opts.preserveId || 'repo-http-linked-pm';
    const setActive = opts.setActive !== false;
    const prevActive = getActiveProjectId();
    if (!window.pmLoader) throw new Error('pmLoader unavailable');
    // Load FIRST: a failed bundle load must never have already deleted the
    // stored registration (load-first ordering, mirroring
    // refreshHttpLinkedProject). The delete is a same-id swap that only makes
    // sense once the rebuild below has succeeded.
    const bundle = await window.pmLoader.loadArtifactBundle();
    window.pmLoader.applyToAgentarium(bundle);
    const phaseObjs = bundle.statusPhases.map((p) => ({
      filename: (p.filename || '').replace(/^project-management\/status\//, '') || p.filename,
      data: p.data,
    }));
    const sourceTitle = String(phaseObjs[0]?.data?.title || 'Project').split(/\s+[—-]\s+/)[0];
    const built = buildProject(`${sourceTitle} (repo HTTP linked)`, phaseObjs, bundle.schema, {
      preserveId: id,
      dirLinked: false,
      writable: false,
    });
    built.httpLinked = true;
    built.sourceRoot = 'project-management/';
    built.accessState = 'linked';
    built.lastRefreshAt = new Date().toISOString();
    built.lastKnownFileCount = phaseObjs.length;
    built.importWarnings = [];
    // Same-id swap: clear any stale registration only now that the rebuild
    // succeeded, then add the fresh one.
    try { deleteProject(id); } catch (e) { /* first run */ }
    addProject(built);
    if (setActive) {
      setActiveProjectId(id);
    } else if (prevActive && getAllProjects().some((p) => p.id === prevActive)) {
      setActiveProjectId(prevActive);
    }
    return built;
  }

  function isHttpLinkedSourceProject(project) {
    return !!(project && project.httpLinked && project.sourceRoot);
  }

  migrateStoredProjects();

  return {
    builtInProject, getAllProjects, getProject,
    getActiveProjectId, setActiveProjectId,
    importFromFiles, buildProject, addProject, deleteProject,
    // disk-sync (File System Access API)
    saveDirHandle, getDirHandle, deleteDirHandle,
    readPhasesFromDir, resolvePmRoot, refreshProjectFromDir, reconnectProjectFolder,
    savePhaseToDir, verifyDirWritePermission, projectCanHardSave,
    // API Workspace source mode (AG-P8.4 client / AG-P8.6)
    probeApiHealth, getApiSourceState, isApiWorkspaceActive, projectIsApiWorkspace,
    savePhase, savePhaseViaApi, reloadApiPhase, getProjectPhase, appendMessageViaApi, assignTaskOwnerViaApi,
    getActingPersona, setActingPersona,
    inspectProjectAccess, isDirPickerSupported, migrateStoredProjects,
    validatePhase, collectImportWarnings,
    sanitizeImportWarnings, scrubStoredImportWarnings,
    refreshHttpLinkedProject, registerHttpLinkedProjectManagement, isHttpLinkedSourceProject,
  };
})();
