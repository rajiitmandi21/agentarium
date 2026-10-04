// Editable shadow layer over PHASE_DATA.
// Edits live in React state + localStorage. Apply on top of the immutable
// loaded data to produce the "effective" phase data we render.

window.edits = (function(){
  const STORAGE_KEY = 'dt-status-edits-v1';

  // FIELDS_LOCKED — these are NEVER editable in Edit Mode.
  // Code timestamps and structural fields belong to engineering.
  const TASK_FIELDS_EDITABLE = new Set(['status', 'priority', 'pm_status', 'pm_remark', 'owner_id']);

  function loadAll() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      // Storage is an external boundary: a valid-JSON but non-object value
      // (e.g. literal `null`) must not reach consumers as-is.
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        ? parsed
        : {};
    } catch (e) { return {}; }
  }

  function saveAll(edits) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(edits));
    } catch (e) { console.warn('Persist edits failed', e); }
  }

  function isEditable(field) { return TASK_FIELDS_EDITABLE.has(field); }

  // Apply edits onto a single phase's data, producing a new (deep-copied for
  // mutated parts) object so React state updates correctly.
  function applyPhaseEdits(baseData, edits) {
    if (!edits) return baseData;
    const taskEdits = edits.tasks || {};
    const out = { ...baseData };

    // Tasks: spread edits onto base (tolerate a phase payload without tasks)
    out.tasks = (baseData.tasks || []).map(t => {
      const e = taskEdits[t.id];
      if (!e) return t;
      const next = { ...t };
      for (const f of TASK_FIELDS_EDITABLE) {
        if (f in e) next[f] = e[f];
      }
      // Extra reviews appended by the user (not part of code base)
      if (e.extra_reviews && e.extra_reviews.length > 0) {
        next.reviews = [...(t.reviews || []), ...e.extra_reviews];
      }
      // PM updated at (if pm_status / pm_remark changed)
      if (e.pm_updated_at) next.pm_updated_at = e.pm_updated_at;
      return next;
    });

    // Add user-added reviews to project-level human_reviews
    if (edits.extra_human_reviews && edits.extra_human_reviews.length > 0) {
      out.human_reviews = [...(baseData.human_reviews || []), ...edits.extra_human_reviews];
    } else if (!out.human_reviews) {
      out.human_reviews = [];
    }
    return out;
  }

  function countEdits(edits) {
    if (!edits) return 0;
    let n = 0;
    const t = edits.tasks || {};
    for (const id in t) {
      const e = t[id];
      for (const f of TASK_FIELDS_EDITABLE) if (f in e) n++;
      if (e.extra_reviews) n += e.extra_reviews.length;
    }
    if (edits.extra_human_reviews) n += edits.extra_human_reviews.length;
    return n;
  }

  function stripUserMarkers(value) {
    if (value == null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(stripUserMarkers);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === '_user') continue;
      out[k] = stripUserMarkers(v);
    }
    return out;
  }

  function taskHasPmEdits(taskEdit) {
    if (!taskEdit) return false;
    if ('pm_status' in taskEdit || 'pm_remark' in taskEdit) return true;
    return false;
  }

  // Canonical JSON payload for hard save to disk (engineering fields preserved).
  function preparePhaseForSave(baseData, edits, savedAt) {
    const merged = applyPhaseEdits(baseData, edits);
    const out = JSON.parse(JSON.stringify(merged));
    out.last_updated = savedAt;
    out.human_reviews = stripUserMarkers(out.human_reviews || []);
    out.tasks = (out.tasks || []).map((t) => {
      const task = stripUserMarkers(t);
      task.reviews = stripUserMarkers(task.reviews || []);
      delete task.extra_reviews;
      return task;
    });
    const taskEdits = (edits && edits.tasks) || {};
    for (const t of out.tasks) {
      const e = taskEdits[t.id];
      if (taskHasPmEdits(e) || (e && e.pm_updated_at)) {
        if (!t.pm_updated_at) t.pm_updated_at = savedAt;
      }
    }
    if (window.khiraSanitize && window.khiraSanitize.sanitizePhaseData) {
      return window.khiraSanitize.sanitizePhaseData(out);
    }
    return out;
  }

  // Drop overlay edits superseded by fresher source task timestamps (fixture refresh).
  function pruneStaleTaskEdits(allEdits, projectId, phases) {
    if (!allEdits || !projectId || !phases || !phases.length) return allEdits || {};
    const proj = allEdits[projectId];
    if (!proj) return allEdits;
    const next = { ...allEdits, [projectId]: { ...proj } };
    let changed = false;
    for (const ph of phases) {
      const phaseKey = ph.key;
      const phaseEdit = next[projectId][phaseKey];
      if (!phaseEdit || !phaseEdit.tasks) continue;
      const baseById = new Map(((ph.data && ph.data.tasks) || []).map((t) => [t.id, t]));
      const tasks = { ...phaseEdit.tasks };
      for (const taskId of Object.keys(tasks)) {
        const edit = tasks[taskId];
        const base = baseById.get(taskId);
        if (!base) {
          delete tasks[taskId];
          changed = true;
          continue;
        }
        const srcAt = base.code_updated_at || base.pm_updated_at || '';
        // Freshness marker: PM edits stamp pm_updated_at; non-PM overlays stamp
        // edited_at. Both count as "when this overlay was written".
        const editAt = edit.pm_updated_at || edit.edited_at || '';
        if (srcAt && editAt && srcAt > editAt) {
          delete tasks[taskId];
          changed = true;
        }
      }
      if (Object.keys(tasks).length === 0) {
        const phCopy = { ...next[projectId][phaseKey] };
        delete phCopy.tasks;
        if (Object.keys(phCopy).length === 0) delete next[projectId][phaseKey];
        else next[projectId][phaseKey] = phCopy;
      } else {
        next[projectId][phaseKey] = { ...phaseEdit, tasks };
      }
    }
    if (Object.keys(next[projectId]).length === 0) delete next[projectId];
    return changed ? next : allEdits;
  }

  function clearPhaseEdits(allEdits, projectId, phaseKey) {
    const next = { ...allEdits };
    const proj = { ...(next[projectId] || {}) };
    delete proj[phaseKey];
    if (Object.keys(proj).length === 0) delete next[projectId];
    else next[projectId] = proj;
    return next;
  }

  // A save may finish after the user has made more edits. Remove only the
  // submitted values; keep newer fields and reviews in the local draft.
  function clearSavedPhaseEdits(allEdits, projectId, phaseKey, submitted) {
    const phase = allEdits?.[projectId]?.[phaseKey];
    if (!phase || !submitted) return allEdits;
    function remaining(current, saved) {
      if (JSON.stringify(current) === JSON.stringify(saved)) return undefined;
      if (Array.isArray(current) && Array.isArray(saved)) {
        const prefix = current.slice(0, saved.length);
        return JSON.stringify(prefix) === JSON.stringify(saved) ? current.slice(saved.length) : current;
      }
      if (current && saved && typeof current === 'object' && typeof saved === 'object') {
        const out = { ...current };
        for (const key of Object.keys(saved)) {
          if (!(key in out)) continue;
          const value = remaining(out[key], saved[key]);
          if (value === undefined || (Array.isArray(value) && value.length === 0)) delete out[key];
          else out[key] = value;
        }
        return Object.keys(out).length ? out : undefined;
      }
      return current;
    }
    const kept = remaining(phase, submitted);
    const next = { ...allEdits, [projectId]: { ...allEdits[projectId] } };
    if (kept) next[projectId][phaseKey] = kept;
    else delete next[projectId][phaseKey];
    if (Object.keys(next[projectId]).length === 0) delete next[projectId];
    return next;
  }

  // The API phase route saves ordinary task fields. Reviewer edits remain in
  // the draft until the dedicated Verdicts action persists them.
  function apiSaveablePhaseEdits(phaseEdits) {
    const tasks = {};
    for (const [id, edit] of Object.entries((phaseEdits && phaseEdits.tasks) || {})) {
      const saved = {};
      for (const key of ['status', 'priority', 'owner_id', 'edited_at']) {
        if (key in edit) saved[key] = edit[key];
      }
      if (Object.keys(saved).length) tasks[id] = saved;
    }
    return Object.keys(tasks).length ? { tasks } : {};
  }

  function hasReviewerEdits(phaseEdits) {
    if (!phaseEdits) return false;
    if (phaseEdits.extra_human_reviews?.length) return true;
    return Object.values(phaseEdits.tasks || {}).some((edit) =>
      'pm_status' in edit || 'pm_remark' in edit || 'pm_updated_at' in edit ||
      (edit.extra_reviews && edit.extra_reviews.length));
  }

  return {
    loadAll, saveAll, applyPhaseEdits, preparePhaseForSave, clearPhaseEdits, clearSavedPhaseEdits,
    apiSaveablePhaseEdits, hasReviewerEdits, pruneStaleTaskEdits,
    isEditable, countEdits, TASK_FIELDS_EDITABLE,
  };
})();
