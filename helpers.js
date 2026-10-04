// Helpers — pure data utilities

window.helpers = (function(){
  const STATUS_LABEL = {
    blocked: 'Blocked',
    in_progress: 'In progress',
    todo: 'Todo',
    completed: 'Completed',
  };
  const PRIORITY_LABEL = { p0: 'P0', p1: 'P1', p2: 'P2', pl: 'PL' };
  const PRIORITY_ORDER = ['p0', 'p1', 'p2', 'pl'];

  function isStale(reviewAt, codeAt) {
    if (!reviewAt || !codeAt) return false;
    return new Date(reviewAt) < new Date(codeAt);
  }

  // --- Structured-blocker accessors (backward-compatible) ---------------------
  // A blockers[] item is EITHER a plain string (legacy) OR an object
  // { text, needs, severity, raised_at?, owner_id? } (structured signal).
  // Every place that reads a blocker MUST go through these so an object item
  // never renders as "[object Object]" and id-scans read .text, not String(obj).
  function isStructuredBlocker(b) { return !!b && typeof b === 'object'; }
  function blockerText(b) { return (typeof b === 'string') ? b : ((b && b.text) || ''); }
  function blockerNeeds(b) { return isStructuredBlocker(b) ? b.needs : undefined; }
  function blockerSeverity(b) { return isStructuredBlocker(b) ? b.severity : undefined; }
  function blockerRaisedAt(b) { return isStructuredBlocker(b) ? b.raised_at : undefined; }
  function blockerOwnerId(b) { return isStructuredBlocker(b) ? b.owner_id : undefined; }

  function getTaskCounts(tasks) {
    const c = { total: tasks.length, completed: 0, in_progress: 0, todo: 0, blocked: 0, p0: 0, p1: 0, p2: 0, pl: 0, needsReview: 0, hasBlockers: 0, blockedOrAtRisk: 0, stale: 0, bugs: 0, cleanups: 0, needsHelp: 0 };
    for (const t of tasks) {
      c[t.status] = (c[t.status] || 0) + 1;
      if (t.priority) c[t.priority] = (c[t.priority] || 0) + 1;
      const isBlocked = t.status === 'blocked';
      const hasBlockers = t.blockers && t.blockers.length > 0 && t.status !== 'completed';
      // Deduped headline metric: a blocked task carrying blockers counts once.
      if (isBlocked || hasBlockers) c.blockedOrAtRisk++;
      if (t.pm_status === 'needs-review') c.needsReview++;
      if (hasBlockers) c.hasBlockers++;
      // Soft-help triage signal (additive; does not affect blocked/hasBlockers tallies).
      if (t.needs === 'help' && t.status !== 'completed') c.needsHelp++;
      // Stale unit is per-task: at most one increment even with several stale reviews.
      for (const r of (t.reviews || [])) {
        if (isStale(r.at, t.code_updated_at)) { c.stale++; break; }
      }
      // count review types
      for (const r of (t.reviews || [])) {
        if (r.type === 'BUG') c.bugs++;
        if (r.type === 'CLEANUP') c.cleanups++;
      }
    }
    return c;
  }

  function subtaskProgress(task) {
    const subs = task.subtasks || [];
    if (subs.length === 0) return { pct: task.status === 'completed' ? 100 : 0, done: 0, total: 0 };
    const done = subs.filter(s => s.status === 'completed').length;
    return { pct: Math.round(done / subs.length * 100), done, total: subs.length };
  }

  function taskFlags(task) {
    const flags = [];
    let bugs = 0, cleanups = 0, plans = 0, hasStale = false;
    for (const r of (task.reviews || [])) {
      if (r.type === 'BUG') bugs++;
      else if (r.type === 'CLEANUP') cleanups++;
      else if (r.type === 'PLAN') plans++;
      if (isStale(r.at, task.code_updated_at)) hasStale = true;
    }
    if (task.blockers && task.blockers.length > 0 && task.status !== 'completed') flags.push({ kind: 'blocked', label: 'Blocked', n: task.blockers.length });
    if (bugs > 0) flags.push({ kind: 'bug', label: 'Bug', n: bugs });
    if (cleanups > 0) flags.push({ kind: 'cleanup', label: 'Cleanup', n: cleanups });
    // Per-task flag (n is 0/1) so row badges agree with the per-task stale counts.
    if (hasStale) flags.push({ kind: 'stale', label: 'Stale', n: 1 });
    return flags;
  }

  function attentionScore(task) {
    let score = 0;
    if (task.status === 'blocked') score += 50;
    if (task.priority === 'p0') score += 30;
    if (task.priority === 'p1') score += 15;
    if (task.pm_status === 'needs-review') score += 25;
    if (task.pm_status === 'rejected') score += 35;
    for (const r of (task.reviews || [])) {
      if (r.type === 'BUG') score += 10;
      if (isStale(r.at, task.code_updated_at)) score += 5;
    }
    if (task.blockers && task.blockers.length > 0 && task.status !== 'completed') score += 20;
    // Soft, non-blocking triage signals — low weight so the task ranks into the
    // Khira "Needs attention" view (khira-wrap hides attentionScore===0) without
    // being treated as blocked. Mirrors the structured-blocker `needs` vocabulary.
    if (task.needs === 'help') score += 15;
    if (task.needs === 'crew') score += 10;
    if (task.needs === 'decision') score += 25;
    return score;
  }

  function relTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '—';
    const now = new Date();
    const diff = (now - d) / 1000; // seconds
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff/60) + 'm ago';
    if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
    if (diff < 86400*30) return Math.floor(diff/86400) + 'd ago';
    if (diff < 86400*365) return Math.floor(diff/86400/30) + 'mo ago';
    return Math.floor(diff/86400/365) + 'y ago';
  }

  function fmtDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // Build activity timeline: collect all reviews + code updates across tasks
  function buildActivity(tasks, limit = 20) {
    const items = [];
    for (const t of tasks) {
      for (const r of (t.reviews || [])) {
        if (r.at) items.push({ ts: r.at, type: r.type, taskId: t.id, taskTitle: t.title, text: r.text });
      }
      if (t.code_updated_at) items.push({ ts: t.code_updated_at, type: 'CODE', taskId: t.id, taskTitle: t.title });
    }
    items.sort((a,b) => new Date(b.ts) - new Date(a.ts));
    return items.slice(0, limit);
  }

  // Escape a plain string for safe interpolation as HTML text or an attribute
  // value. This is the no-sanitizer fallback used by <RichText> — it escapes,
  // it never passes markup through.
  function safeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Phase status: honor explicit `phase.data.status` (or `phase_status`) when present,
  // else infer from task mix. Valid values: 'todo' | 'in_progress' | 'done' | 'closed'.
  const PHASE_STATUS_LABEL = {
    todo: 'Todo',
    in_progress: 'In progress',
    done: 'Done',
    closed: 'Closed',
  };
  const VALID_PHASE_STATUS = new Set(Object.keys(PHASE_STATUS_LABEL));

  function phaseStatus(phase) {
    const d = phase && phase.data;
    const explicit = d && (d.status || d.phase_status);
    if (explicit && VALID_PHASE_STATUS.has(explicit)) return explicit;
    const tasks = (d && d.tasks) || [];
    if (tasks.length === 0) return 'todo';
    let done = 0, started = 0;
    for (const t of tasks) {
      if (t.status === 'completed') { done++; started++; }
      else if (t.status === 'in_progress' || t.status === 'blocked') started++;
    }
    if (done === tasks.length) return 'done';
    if (started > 0) return 'in_progress';
    return 'todo';
  }

  // Derived task metrics for phase switcher — not a phase_status enum (todo|in_progress|done|closed).
  function phaseTaskSignals(phase) {
    const tasks = (phase && phase.data && phase.data.tasks) || [];
    let blockedTasks = 0;
    let needsReview = 0;
    let openP0 = 0;
    for (const t of tasks) {
      if (t.status === 'blocked' || (t.blockers && t.blockers.length > 0)) blockedTasks++;
      if (t.pm_status === 'needs-review' || t.pm_status === 'rejected') needsReview++;
      if (t.priority === 'p0' && t.status !== 'completed') openP0++;
    }
    const atRisk = needsReview > 0 || openP0 > 0;
    let label = null;
    if (blockedTasks > 0) label = blockedTasks === 1 ? '1 blocked' : `${blockedTasks} blocked`;
    else if (atRisk) label = 'at risk';
    return { blockedTasks, needsReview, openP0, atRisk, label };
  }

  // Board column spec — keep in sync with VALID_STATUSES in projects.js.
  // Order here is the visual left-to-right order on the Board view.
  const BOARD_COLUMNS = [
    { key: 'todo',        name: 'Todo',        color: 'var(--text-4)' },
    { key: 'in_progress', name: 'In progress', color: 'var(--st-progress)' },
    { key: 'blocked',     name: 'Blocked',     color: 'var(--st-blocked)' },
    { key: 'completed',   name: 'Completed',   color: 'var(--st-completed)' },
  ];

  // Message phase-link gaps are inferred in pm-loader; hide from user-facing panels.
  const MESSAGE_PHASE_LINK_RE = /^Message\s+".+"\s+has no phase link(\s+\(non-blocking\))?$/i;

  function filterDisplayWarnings(warnings) {
    if (!warnings || !warnings.length) return [];
    return warnings.filter((w) => {
      if (typeof w !== 'string') return true;
      return !MESSAGE_PHASE_LINK_RE.test(w.trim());
    });
  }

  function mergeDisplayWarnings(...lists) {
    const seen = new Set();
    const out = [];
    for (const list of lists) {
      for (const w of filterDisplayWarnings(list)) {
        if (!seen.has(w)) {
          seen.add(w);
          out.push(w);
        }
      }
    }
    return out;
  }

  // Stable priority sort: lower PRIORITY_ORDER index first, tiebreak on id.
  function comparePriorityThenId(a, b) {
    const ai = PRIORITY_ORDER.indexOf(a.priority);
    const bi = PRIORITY_ORDER.indexOf(b.priority);
    const aRank = ai === -1 ? PRIORITY_ORDER.length : ai;
    const bRank = bi === -1 ? PRIORITY_ORDER.length : bi;
    if (aRank !== bRank) return aRank - bRank;
    return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
  }

  return {
    STATUS_LABEL, PRIORITY_LABEL, PRIORITY_ORDER,
    PHASE_STATUS_LABEL, BOARD_COLUMNS,
    isStale, getTaskCounts, subtaskProgress, taskFlags, attentionScore,
    relTime, fmtDate, buildActivity, safeHtml, phaseStatus, phaseTaskSignals,
    comparePriorityThenId,
    filterDisplayWarnings,
    mergeDisplayWarnings,
    isStructuredBlocker, blockerText, blockerNeeds, blockerSeverity,
    blockerRaisedAt, blockerOwnerId,
  };
})();
