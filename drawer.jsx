// Task Detail Drawer

const HH = window.helpers;
const { PMChip, FlagBadges, RichText } = window;

// ── Blocker accessors (backward-compat for string OR structured-object items) ──
// A blockers[] item may be a plain string (legacy data) OR an object
// { text, needs, severity, raised_at?, owner_id? } (AG-P12.7 structured blocker).
// Prefer the shared window.helpers implementation when present (single source of
// truth once helpers.js exports them); fall back to a local impl so the drawer
// renders correctly on its own.
const blockerText = (HH && HH.blockerText)
  ? HH.blockerText
  : (b) => (typeof b === 'string') ? b : ((b && b.text) || '');
const isStructuredBlocker = (HH && HH.isStructuredBlocker)
  ? HH.isStructuredBlocker
  : (b) => !!b && typeof b === 'object';
const blockerNeeds = (HH && HH.blockerNeeds)
  ? HH.blockerNeeds
  : (b) => (b && typeof b === 'object') ? b.needs : undefined;
const blockerSeverity = (HH && HH.blockerSeverity)
  ? HH.blockerSeverity
  : (b) => (b && typeof b === 'object') ? b.severity : undefined;
const blockerRaisedAt = (HH && HH.blockerRaisedAt)
  ? HH.blockerRaisedAt
  : (b) => (b && typeof b === 'object') ? b.raised_at : undefined;
const blockerOwnerId = (HH && HH.blockerOwnerId)
  ? HH.blockerOwnerId
  : (b) => (b && typeof b === 'object') ? b.owner_id : undefined;

const STATUSES = ['todo', 'in_progress', 'blocked', 'completed'];
const PRIORITIES = ['p0', 'p1', 'p2', 'pl'];
const PM_STATUSES = ['', 'needs-review', 'done', 'tested', 'rejected', 'superseded'];
const REVIEW_TYPES = ['BUG', 'PLAN', 'NOTE', 'CLEANUP'];

function TaskDetailDrawer({ task, onClose, editMode, onUpdate, onAddReview, onOpenArtifact }) {
  const [showCompleted, setShowCompleted] = React.useState(false);
  const [addingReview, setAddingReview] = React.useState(false);
  const [reviewType, setReviewType] = React.useState('NOTE');
  const [reviewText, setReviewText] = React.useState('');
  const [editingRemark, setEditingRemark] = React.useState(false);
  const [remarkText, setRemarkText] = React.useState(task ? (task.pm_remark || '') : '');

  React.useEffect(() => {
    setRemarkText(task ? (task.pm_remark || '') : '');
    setEditingRemark(false);
    setAddingReview(false);
    setReviewText('');
  }, [task && task.id]);

  if (!task) return null;

  const open = (task.subtasks || []).filter(s => s.status !== 'completed');
  const done = (task.subtasks || []).filter(s => s.status === 'completed');
  const p = HH.subtaskProgress(task);
  const codeStale = task.code_updated_at && task.pm_updated_at && new Date(task.code_updated_at) > new Date(task.pm_updated_at);
  const planIds = task.plan_ids || [];
  const linkedPlans = (window.AGENTARIUM && window.AGENTARIUM.PLANS)
    ? planIds.map((pid) => (window.AGENTARIUM.PLANS.find((pl) => pl.id === pid) || { id: pid, title: pid }))
    : planIds.map((pid) => ({ id: pid, title: pid }));
  const linkedMsgs = (window.AGENTARIUM && window.AGENTARIUM.MESSAGES)
    ? window.AGENTARIUM.MESSAGES.filter((m) => (m.linkedTasks || []).includes(task.id)).slice(0, 8)
    : [];

  function submitReview() {
    const t = reviewText.trim();
    if (!t) return;
    onAddReview({ type: reviewType, text: t });
    setReviewText('');
    setReviewType('NOTE');
    setAddingReview(false);
  }

  function saveRemark() {
    onUpdate({ pm_remark: remarkText });
    setEditingRemark(false);
  }

  return (
    <aside className="drawer">
      <div className="drawer-head">
        <div className="drawer-meta-row">
          <span className="drawer-id">{task.id}</span>
          <span className="drawer-badges">
            {editMode ? (
              <>
                <InlineSelect label="Status" value={task.status} options={STATUSES.map(s => ({ v: s, l: s.replace('_',' ') }))}
                  onChange={(v) => onUpdate({ status: v })}
                  className={`tr-pm ${task.status}`} />
                <InlineSelect label="Priority" value={task.priority || 'p2'} options={PRIORITIES.map(p => ({ v: p, l: p.toUpperCase() }))}
                  onChange={(v) => onUpdate({ priority: v })}
                  className={`tr-priority ${task.priority || ''}`} />
                <InlineSelect label="PM" value={task.pm_status || ''} options={PM_STATUSES.map(s => ({ v: s, l: s || '— (none)' }))}
                  onChange={(v) => onUpdate({ pm_status: v })}
                  className={`tr-pm ${task.pm_status || ''}`} />
              </>
            ) : (
              <>
                <span className={`tr-priority ${task.priority || ''}`}>{(task.priority || '').toUpperCase()}</span>
                <span className={`tr-pm ${task.pm_status || ''}`} style={{ background: 'var(--surface-2)' }}>
                  {task.status.replace('_',' ')}
                </span>
                {task.pm_status && <PMChip s={task.pm_status} />}
              </>
            )}
            <FlagBadges task={task} compact />
            {task.needs && (
              <span
                className={`needs-badge ${task.needs}`}
                title={task.waiting_on ? `Waiting on ${task.waiting_on}` : `Needs ${task.needs}`}
              >
                {task.needs === 'help' ? 'needs help' : task.needs}
                {task.waiting_on && <span className="needs-badge-on"> · {task.waiting_on}</span>}
              </span>
            )}
          </span>
          <button className="drawer-close" onClick={onClose} aria-label="Close detail panel">×</button>
        </div>
        <h2 className="drawer-title">
          {task.title}
          {editMode && <span className="locked-tag" title="Engineering metadata is locked">locked</span>}
        </h2>
        {task.description && <p className="drawer-desc">{task.description}</p>}
      </div>

      <div className="drawer-body">

        {/* Metadata */}
        <div className="drawer-section">
          <h4>Metadata</h4>
          <dl className="kv-grid">
            <dt>Code updated</dt>
            <dd>
              {HH.fmtDate(task.code_updated_at)} · <span style={{ color: 'var(--text-3)' }}>{HH.relTime(task.code_updated_at)}</span>
            </dd>
            <dt>PM reviewed</dt>
            <dd>
              {HH.fmtDate(task.pm_updated_at)} · <span style={{ color: 'var(--text-3)' }}>{HH.relTime(task.pm_updated_at)}</span>
              {codeStale && <span className="stale-tag">PM review stale</span>}
            </dd>
            <dt>Status</dt>
            <dd style={{ fontFamily: 'var(--font-sans)' }}>{task.status.replace('_',' ')}</dd>
            {p.total > 0 && <><dt>Progress</dt><dd>{p.done}/{p.total} subtasks · {p.pct}%</dd></>}
          </dl>
        </div>

        {(linkedPlans.length > 0 || linkedMsgs.length > 0) && onOpenArtifact && (
          <div className="drawer-section">
            <h4>Linked artifacts</h4>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {linkedPlans.map((pl) => (
                <span key={pl.id} className="afc" data-kind="plan" role="button" tabIndex={0}
                      onClick={() => onOpenArtifact('plan', pl.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenArtifact('plan', pl.id); } }}
                      title={pl.title || pl.id}>
                  <span className="afc-kind">PLN</span>
                  <span>{pl.id}</span>
                </span>
              ))}
              {linkedMsgs.map((m) => (
                <span key={m.id} className="afc" data-kind="message" role="button" tabIndex={0}
                      onClick={() => onOpenArtifact('message', m.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenArtifact('message', m.id); } }}
                      title={m.subject || m.id}>
                  <span className="afc-kind">MSG</span>
                  <span>{m.subject ? m.subject.slice(0, 36) : m.id}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Blockers */}
        {task.blockers && task.blockers.length > 0 && (
          <div className="drawer-section">
            <h4 style={{ color:'var(--st-blocked)' }}>Blockers</h4>
            <div className="blocker-box">
              <ul>{task.blockers.map((b, i) => {
                const text = blockerText(b);
                if (!isStructuredBlocker(b)) return <li key={i}>{text}</li>;
                const needs = blockerNeeds(b);
                const severity = blockerSeverity(b);
                const owner = blockerOwnerId(b);
                const raisedAt = blockerRaisedAt(b);
                return (
                  <li key={i} className="blocker-item">
                    <span className="blocker-text">{text}</span>
                    <span className="blocker-tags">
                      {needs && <span className={`blocker-tag needs ${needs}`}>{needs}</span>}
                      {severity && <span className={`blocker-tag sev ${severity}`}>{severity}</span>}
                      {owner && <span className="blocker-tag owner">{owner}</span>}
                      {raisedAt && <span className="blocker-raised">{HH.relTime(raisedAt)}</span>}
                    </span>
                  </li>
                );
              })}</ul>
            </div>
          </div>
        )}

        {/* Assignee (Crews authority-gated assignment) */}
        <AssigneeSection task={task} editMode={editMode} onUpdate={onUpdate} />

        {/* PM remark */}
        <div className="drawer-section">
          <h4>PM note {editMode && !editingRemark && (
            <button className="inline-edit-btn" onClick={() => setEditingRemark(true)}>
              {task.pm_remark ? 'Edit' : '+ Add note'}
            </button>
          )}</h4>
          {editingRemark ? (
            <div className="inline-edit-form">
              <textarea autoFocus value={remarkText} onChange={(e) => setRemarkText(e.target.value)} rows={5}
                placeholder="Write a PM note…" />
              <div className="inline-edit-actions">
                <button className="hr-btn-secondary" onClick={() => { setEditingRemark(false); setRemarkText(task.pm_remark || ''); }}>Cancel</button>
                <button className="hr-btn-primary" onClick={saveRemark}>Save</button>
              </div>
            </div>
          ) : task.pm_remark ? (
            <div className="pm-remark"><RichText html={task.pm_remark} /></div>
          ) : (
            <div className="empty-inline">No PM note.</div>
          )}
        </div>

        {/* Subtasks (locked) */}
        {(task.subtasks && task.subtasks.length > 0) && (
          <div className="drawer-section">
            <h4>Subtasks · {p.done}/{p.total} {editMode && <span className="locked-mini">locked</span>}</h4>
            <div className="bar" style={{ marginBottom: 12 }}>
              <div className="bar-seg completed" style={{ width: p.pct + '%' }}></div>
            </div>
            {open.length > 0 && (
              <div>
                {open.map((s, i) => <SubtaskRow key={'o'+i} sub={s} />)}
              </div>
            )}
            {done.length > 0 && (
              <>
                <button className="subtask-group-toggle" onClick={() => setShowCompleted(v => !v)}>
                  {showCompleted ? '▾' : '▸'} {done.length} completed
                </button>
                {showCompleted && done.map((s, i) => <SubtaskRow key={'d'+i} sub={s} />)}
              </>
            )}
          </div>
        )}

        {/* Reviews */}
        <div className="drawer-section">
          <h4>
            Reviews · {(task.reviews || []).length}
            {editMode && !addingReview && (
              <button className="inline-edit-btn" onClick={() => setAddingReview(true)}>+ Add review</button>
            )}
          </h4>

          {addingReview && (
            <div className="inline-edit-form review-add">
              <div className="review-type-picker">
                {REVIEW_TYPES.map(t => (
                  <button key={t}
                    className={`review-type-btn ${t} ${reviewType === t ? 'active' : ''}`}
                    onClick={() => setReviewType(t)}>
                    {t}
                  </button>
                ))}
              </div>
              <textarea autoFocus value={reviewText} onChange={(e) => setReviewText(e.target.value)} rows={3}
                placeholder="Write your review…" />
              <div className="inline-edit-actions">
                <button className="hr-btn-secondary" onClick={() => { setAddingReview(false); setReviewText(''); }}>Cancel</button>
                <button className="hr-btn-primary" disabled={!reviewText.trim()} onClick={submitReview}>Post {reviewType}</button>
              </div>
            </div>
          )}

          {(task.reviews && task.reviews.length > 0) ? (
            <div>
              {[...task.reviews]
                .sort((a,b) => new Date(b.at || 0) - new Date(a.at || 0))
                .map((r, i) => (
                <div key={i} className="review-item">
                  <div className="rv-rail">
                    <span className={`rv-dot ${r.type}`}></span>
                  </div>
                  <div>
                    <div className="review-meta">
                      <span className={`review-type-tag ${r.type}`}>{r.type}</span>
                      {HH.isStale(r.at, task.code_updated_at) && <span className="review-stale">STALE</span>}
                      {r._user && <span className="review-user-tag">YOU</span>}
                      <span className="review-date">{r.at ? HH.fmtDate(r.at) : '—'} · {HH.relTime(r.at)}</span>
                    </div>
                    <div className="review-body"><RichText html={r.text} /></div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-inline">No reviews yet.</div>
          )}
        </div>

      </div>
    </aside>
  );
}

function InlineSelect({ value, options, onChange, className, label }) {
  return (
    <select
      className={`inline-select ${className || ''}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
    >
      {options.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
    </select>
  );
}

// ── Assignee — Crews authority-gated task assignment (AG-P7.8) ───────────────
// Resolves the current owner_id (concrete agent = direct, persona = delegated /
// pending-staffing) and, in Edit Mode, offers a keyboard-operable picker gated
// by window.CrewsAssign.canDelegate. owner_id persists as a draft edit (edits.js
// TASK_FIELDS_EDITABLE) via onUpdate.
const ASSIGN_ACTOR_ID = 'executive-owner'; // runtime will supply a real actor later (AG-P7.12)

function AssigneeSection({ task, editMode, onUpdate }) {
  const [rejectHint, setRejectHint] = React.useState('');

  // Guard: render nothing if the Crews engine / index are not available.
  if (typeof window === 'undefined' || !window.CrewsAssign || !window.AG || !window.AG.CREWS) {
    return null;
  }
  const CrewsAssign = window.CrewsAssign;
  const index = window.AG.CREWS;

  let agents = [];
  try {
    agents = (window.CrewsAgents && window.CrewsAgents.listAgents)
      ? (window.CrewsAgents.listAgents() || [])
      : [];
  } catch (e) { agents = []; }

  // resolveOwner() predates the canonical flat-role ids used by Khira
  // (`fe`, `be`, `tl`, `spm`, `sdp`, `human-raj`) and classifies them as
  // unknown. Prefer the AG-P13.2 identity resolver so the drawer uses the same
  // role→persona join as Atlas, Crews, and Maestro.
  const legacyResolved = CrewsAssign.resolveOwner(task.owner_id, index, agents);
  const resolved = typeof CrewsAssign.resolveOwnerId === 'function'
    ? CrewsAssign.resolveOwnerId(task.owner_id, index, agents)
    : legacyResolved;

  // ── Current assignee read-out (shown in both view + edit mode). ──
  let current;
  if (resolved.kind === 'agent') {
    const codename = (legacyResolved.agent && legacyResolved.agent.name) || task.owner_id;
    const personaTitle = resolved.persona ? resolved.persona.title : null;
    current = (
      <div className="assignee-current is-direct">
        <span className="assignee-label">Assigned (direct)</span>
        <span className="assignee-name">{codename}</span>
        {personaTitle && <span className="assignee-sub">{personaTitle}</span>}
      </div>
    );
  } else if (resolved.kind === 'flat-role') {
    const persona = resolved.persona || {};
    current = (
      <div className="assignee-current is-delegated">
        <span className="assignee-label">Role owner</span>
        <span className="assignee-name">{task.owner_id}</span>
        {persona.title && <span className="assignee-sub">{persona.title}</span>}
      </div>
    );
  } else if (resolved.kind === 'persona') {
    const persona = resolved.persona || {};
    const leaderId = CrewsAssign.leaderFor(persona.id, index);
    const leader = (index.personas || []).find((p) => p.id === leaderId);
    current = (
      <div className="assignee-current is-delegated">
        <span className="assignee-label">Delegated</span>
        <span className="assignee-name">{persona.title || persona.id}</span>
        <span className="assignee-pill pending">pending staffing</span>
        {leader && <span className="assignee-sub">triage: {leader.title || leader.id}</span>}
      </div>
    );
  } else {
    current = (
      <div className="assignee-current is-unassigned">
        <span className="assignee-name muted">Unassigned</span>
      </div>
    );
  }

  // ── Picker (edit mode only). ──
  // Build a stable, keyed value space: '' (unassign), 'A:<agentId>', 'P:<personaId>'.
  let picker = null;
  if (editMode) {
    const liveAgents = agents.filter((a) => a && a.status !== 'retired');
    const personas = (index.personas || []);
    const personaTitleById = {};
    for (const p of personas) personaTitleById[p.id] = p.title || p.id;

    let selectValue = !task.owner_id
      ? ''
      : (resolved.kind === 'agent' ? 'A:' + task.owner_id
        : (resolved.kind === 'persona' ? 'P:' + task.owner_id
          : (resolved.kind === 'flat-role' && resolved.personaId ? 'P:' + resolved.personaId : '')));

    // Catch-all: owners that resolve to nothing renderable (unknown ids,
    // retired agents) get an explicit sentinel option so the select reflects
    // reality instead of implying "Unassigned".
    const selectable = new Set(['']);
    for (const a of liveAgents) selectable.add('A:' + a.id);
    for (const p of personas) selectable.add('P:' + p.id);
    let unresolvedOwner = null;
    if (task.owner_id && (selectValue === '' || !selectable.has(selectValue))) {
      unresolvedOwner = task.owner_id;
      selectValue = 'X:' + task.owner_id;
    }

    function applySelection(raw) {
      setRejectHint('');
      if (raw === '') { onUpdate({ owner_id: '' }); return; }
      if (raw.startsWith('X:')) return; // sentinel — current owner not in roster; no-op
      if (raw.startsWith('A:')) {
        const id = raw.slice(2);
        const agent = liveAgents.find((a) => a.id === id);
        if (!agent) { setRejectHint('Unknown agent.'); return; }
        if (!CrewsAssign.canDelegateToAgent(ASSIGN_ACTOR_ID, agent, index)) {
          setRejectHint('Authority denied — not in your chain.');
          return;
        }
        onUpdate({ owner_id: agent.id });
        return;
      }
      if (raw.startsWith('P:')) {
        const id = raw.slice(2);
        if (!CrewsAssign.canDelegate(ASSIGN_ACTOR_ID, id, index)) {
          setRejectHint('Authority denied — not in your chain.');
          return;
        }
        onUpdate({ owner_id: id });
        return;
      }
    }

    // Group agents under their persona's title; personas grouped by department.
    const agentsByPersona = {};
    for (const a of liveAgents) {
      const key = a.persona_id || '—';
      (agentsByPersona[key] = agentsByPersona[key] || []).push(a);
    }
    const personasByDept = {};
    for (const p of personas) {
      (personasByDept[p.department || 'other'] = personasByDept[p.department || 'other'] || []).push(p);
    }
    const deptKeys = Object.keys(personasByDept).sort();

    picker = (
      <div className="assignee-picker">
        <label className="assignee-picker-label" htmlFor="assignee-select">Reassign</label>
        <select
          id="assignee-select"
          className="assignee-select"
          value={selectValue}
          onChange={(e) => applySelection(e.target.value)}
          aria-label="Assign this task to an agent or persona"
        >
          <option value="">— Unassign</option>
          {unresolvedOwner && (
            <option value={'X:' + unresolvedOwner} disabled>
              Current: {unresolvedOwner} (unresolved)
            </option>
          )}
          {liveAgents.length > 0 && (
            <optgroup label="Agents (direct)">
              {liveAgents.map((a) => (
                <option key={'A:' + a.id} value={'A:' + a.id}>
                  {a.name}{a.persona_id && personaTitleById[a.persona_id] ? ' · ' + personaTitleById[a.persona_id] : ''}
                </option>
              ))}
            </optgroup>
          )}
          {deptKeys.map((dept) => (
            <optgroup key={'dept-' + dept} label={'Delegate to persona · ' + dept}>
              {personasByDept[dept].map((p) => (
                <option key={'P:' + p.id} value={'P:' + p.id}>{p.title || p.id}</option>
              ))}
            </optgroup>
          ))}
        </select>
        {rejectHint && <div className="assignee-reject">{rejectHint}</div>}
      </div>
    );
  }

  return (
    <div className="drawer-section assignee-section">
      <h4>Assignee</h4>
      {current}
      {picker}
    </div>
  );
}

function SubtaskRow({ sub }) {
  const reviewClass = sub.review ? (sub.review.type || 'NOTE') : '';
  return (
    <div className="subtask">
      <span className={`subtask-check ${sub.status}`}></span>
      <div>
        <div className={`subtask-text ${sub.status === 'completed' ? 'completed' : ''}`}>{sub.text}</div>
        {sub.review && (
          <div className={`subtask-review ${reviewClass}`}>
            <span className="rv-tag">{sub.review.type}</span>
            <RichText html={sub.review.text} />
          </div>
        )}
      </div>
    </div>
  );
}

Object.assign(window, { TaskDetailDrawer });
