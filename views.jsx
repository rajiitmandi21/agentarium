// Views: Overview, List, Board, Focus

const H = window.helpers;

function useColumnCollapse() {
  const [colOverride, setColOverride] = React.useState({});
  const isCollapsed = (key, isEmpty) =>
    colOverride[key] === undefined ? isEmpty : colOverride[key];
  const toggle = (key, isEmpty) => {
    setColOverride((o) => ({
      ...o,
      [key]: !(o[key] === undefined ? isEmpty : o[key]),
    }));
  };
  return { isCollapsed, toggle };
}
const { StatusDot, PriorityChip, PMChip, FlagBadges, ProgressMini, RichText, Icon } = window;

const STATUS_LABEL_SHORT = { blocked: 'Blocked', in_progress: 'In progress', todo: 'Todo', completed: 'Completed' };

/* ─────────────────────────────────────────────────────────────────
   Overview
   ──────────────────────────────────────────────────────────────── */

function OverviewView({ phaseData, onSelectTask, activePhaseName, editMode, onAddHumanReview }) {
  const tasks = phaseData.tasks;
  const c = H.getTaskCounts(tasks);
  const completedPct = c.total > 0 ? Math.round(c.completed / c.total * 100) : 0;

  // Attention card controls
  const [attnSort, setAttnSort] = React.useState('attention');
  const [attnFilter, setAttnFilter] = React.useState('all');
  const [attnLimit, setAttnLimit] = React.useState(8);

  // Compute attention items with sort + filter
  const attentionItems = React.useMemo(() => {
    let items = tasks
      .filter(t => t.status !== 'completed')
      .map(t => ({ t, score: H.attentionScore(t) }));

    // Filter
    if (attnFilter === 'attention') items = items.filter(x => x.score > 0);
    else if (attnFilter === 'p0') items = items.filter(x => x.t.priority === 'p0');
    else if (attnFilter === 'p0p1') items = items.filter(x => x.t.priority === 'p0' || x.t.priority === 'p1');
    else if (attnFilter === 'blocked') items = items.filter(x => x.t.status === 'blocked' || (x.t.blockers && x.t.blockers.length > 0));
    else if (attnFilter === 'needs-review') items = items.filter(x => x.t.pm_status === 'needs-review' || x.t.pm_status === 'rejected');
    else if (attnFilter === 'has-bugs') items = items.filter(x => (x.t.reviews || []).some(r => r.type === 'BUG'));
    else if (attnFilter === 'stale') items = items.filter(x => (x.t.reviews || []).some(r => H.isStale(r.at, x.t.code_updated_at)));

    // Sort
    if (attnSort === 'attention') items.sort((a,b) => b.score - a.score);
    else if (attnSort === 'priority') {
      const order = { p0:0, p1:1, p2:2, pl:3 };
      items.sort((a,b) => (order[a.t.priority] ?? 9) - (order[b.t.priority] ?? 9) || b.score - a.score);
    }
    else if (attnSort === 'recent-code') {
      items.sort((a,b) => new Date(b.t.code_updated_at || 0) - new Date(a.t.code_updated_at || 0));
    }
    else if (attnSort === 'recent-pm') {
      items.sort((a,b) => new Date(b.t.pm_updated_at || 0) - new Date(a.t.pm_updated_at || 0));
    }
    else if (attnSort === 'status') {
      const order = { blocked:0, in_progress:1, todo:2, completed:3 };
      items.sort((a,b) => (order[a.t.status] ?? 9) - (order[b.t.status] ?? 9));
    }
    else if (attnSort === 'id') {
      items.sort((a,b) => a.t.id.localeCompare(b.t.id, undefined, { numeric: true }));
    }

    return items;
  }, [tasks, attnSort, attnFilter]);

  const shownItems = attentionItems.slice(0, attnLimit);

  const activity = H.buildActivity(tasks, 12);

  return (
    <div className="view-pane">
      <div className="overview-grid">

        {/* KPIs */}
        <div className="kpi-row">
          <Kpi label="Total tasks" value={c.total} sub={`${phaseData.tasks.length} planned`} />
          <Kpi tone="ok" label="Completed" value={c.completed} sub={`${completedPct}% of total`} />
          <Kpi label="In progress" value={c.in_progress} sub={`P0: ${tasks.filter(t=>t.priority==='p0'&&t.status==='in_progress').length}`} />
          <Kpi tone={c.blockedOrAtRisk > 0 ? 'alert' : 'ok'} label="Blocked / At risk" value={c.blockedOrAtRisk}
            sub={`${c.blocked} blocked · ${c.hasBlockers} have blockers`} />
          <Kpi tone={c.needsReview + c.stale > 0 ? 'warn' : 'ok'} label="Needs attention" value={c.needsReview + c.stale}
            sub={`${c.needsReview} for PM · ${c.stale} tasks with stale reviews`} />
        </div>

        {/* Health bar (large) */}
        <div className="card row-health">
          <div className="card-header">
            <div>
              <div className="card-eyebrow">Phase health</div>
              <div className="card-title" style={{ marginTop: 4, fontSize: 16 }}>{activePhaseName} · {completedPct}% complete</div>
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-3)' }}>
              {c.completed}/{c.total} done
            </div>
          </div>

          <div className="bar" style={{ height: 14 }}>
            <div className="bar-seg completed" style={{ width: pctOf(c.completed, c.total) }}></div>
            <div className="bar-seg in_progress" style={{ width: pctOf(c.in_progress, c.total) }}></div>
            <div className="bar-seg blocked" style={{ width: pctOf(c.blocked, c.total) }}></div>
            <div className="bar-seg todo" style={{ width: pctOf(c.todo, c.total) }}></div>
          </div>

          <div className="legend">
            <span className="legend-item"><span className="dot" style={{ background:'var(--st-completed)' }}></span>Completed<span className="num">{c.completed}</span></span>
            <span className="legend-item"><span className="dot" style={{ background:'var(--st-progress)' }}></span>In progress<span className="num">{c.in_progress}</span></span>
            <span className="legend-item"><span className="dot" style={{ background:'var(--st-blocked)' }}></span>Blocked<span className="num">{c.blocked}</span></span>
            <span className="legend-item"><span className="dot" style={{ background:'var(--text-4)' }}></span>Todo<span className="num">{c.todo}</span></span>
          </div>

          <div className="divider" style={{ margin: '16px 0' }}></div>

          <div style={{ display: 'flex', gap: 28, fontSize: 12 }}>
            <Stat label="P0 tasks" value={c.p0} />
            <Stat label="P1 tasks" value={c.p1} />
            <Stat label="Bug reviews" value={c.bugs} tone={c.bugs > 0 ? 'alert' : ''} />
            <Stat label="Cleanup notes" value={c.cleanups} />
            <Stat label="Last updated" value={H.relTime(phaseData.last_updated)} mono />
          </div>
        </div>

        {/* Priority breakdown */}
        <div className="card row-prio">
          <div className="card-header">
            <div className="card-title">Priority</div>
            <span className="card-eyebrow">Status</span>
          </div>
          <PriorityBars tasks={tasks} />
        </div>

        {/* Attention list */}
        <div className="card row-attention">
          <div className="card-header" style={{ flexWrap: 'wrap', gap: 12 }}>
            <div style={{ minWidth: 200 }}>
              <div className="card-eyebrow">Top of mind</div>
              <div className="card-title" style={{ marginTop: 4 }}>Tasks needing attention</div>
            </div>
            <div className="attn-controls">
              <MiniSelect label="Filter" value={attnFilter} onChange={setAttnFilter}
                options={[
                  { v: 'attention',    l: 'Needs attention' },
                  { v: 'all',          l: 'All open tasks' },
                  { v: 'p0',           l: 'P0 only' },
                  { v: 'p0p1',         l: 'P0 + P1' },
                  { v: 'blocked',      l: 'Blocked / has blockers' },
                  { v: 'needs-review', l: 'PM needs-review / rejected' },
                  { v: 'has-bugs',     l: 'Has bug reviews' },
                  { v: 'stale',        l: 'Has stale reviews' },
                ]} />
              <MiniSelect label="Sort" value={attnSort} onChange={setAttnSort}
                options={[
                  { v: 'attention',   l: 'Attention score' },
                  { v: 'priority',    l: 'Priority' },
                  { v: 'status',      l: 'Status' },
                  { v: 'recent-code', l: 'Recent code update' },
                  { v: 'recent-pm',   l: 'Recent PM review' },
                  { v: 'id',          l: 'Task ID' },
                ]} />
              <span className="attn-count">{shownItems.length} of {attentionItems.length}</span>
            </div>
          </div>
          {shownItems.length === 0 ? (
            <div className="empty-state"><div className="glyph">✓</div>Nothing matches this filter.</div>
          ) : (
            <div className="attn-list">
              {shownItems.map(({ t, score }) => {
                const flags = H.taskFlags(t);
                const tone = t.status === 'blocked' ? 'var(--st-blocked)'
                  : t.priority === 'p0' ? 'var(--pr-p0)'
                  : t.pm_status === 'needs-review' ? 'var(--pr-p1)' : 'var(--accent)';
                return (
                  <div key={t.id} className="attn-item" role="button" tabIndex={0}
                       onClick={() => onSelectTask(t.id)}
                       onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectTask(t.id); } }}>
                    <span className="attn-marker" style={{ background: tone }}></span>
                    <div className="attn-body">
                      <div className="attn-title">
                        <span className="attn-id">{t.id}</span>
                        <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{t.title}</span>
                      </div>
                      <div className="attn-meta">
                        <strong>{STATUS_LABEL_SHORT[t.status]}</strong>
                        {t.priority && <> · <strong>{t.priority.toUpperCase()}</strong></>}
                        {t.pm_status && <> · PM: <strong>{t.pm_status.replace('-', ' ')}</strong></>}
                        {flags.map(f => <span key={f.kind}> · {f.n} {f.label.toLowerCase()}</span>)}
                      </div>
                    </div>
                    <div className="attn-right">→</div>
                  </div>
                );
              })}
              {attentionItems.length > attnLimit && (
                <button className="attn-show-more" onClick={() => setAttnLimit(n => n + 10)}>
                  Show {Math.min(10, attentionItems.length - attnLimit)} more
                </button>
              )}
              {attnLimit > 8 && attentionItems.length <= attnLimit && (
                <button className="attn-show-more" onClick={() => setAttnLimit(8)}>
                  Collapse
                </button>
              )}
            </div>
          )}
        </div>

        {/* Activity feed */}
        <div className="card row-activity">
          <div className="card-header">
            <div className="card-title">Recent activity</div>
            <span className="card-eyebrow">Last {activity.length}</span>
          </div>
          {activity.length === 0 ? (
            <div className="empty-state">No timestamped activity.</div>
          ) : (
            <div className="activity-list">
              {activity.map((a, i) => {
                const tone = a.type === 'BUG' ? 'var(--rv-bug)'
                  : a.type === 'PLAN' ? 'var(--rv-plan)'
                  : a.type === 'CLEANUP' ? 'var(--rv-cleanup)'
                  : a.type === 'CODE' ? 'var(--accent)' : 'var(--rv-note)';
                const verb = a.type === 'CODE' ? 'code updated' :
                  a.type === 'BUG' ? 'bug filed' :
                  a.type === 'PLAN' ? 'plan note' :
                  a.type === 'CLEANUP' ? 'cleanup note' : 'note';
                return (
                  <div key={i} className="activity-item">
                    <span className="activity-dot" style={{ background: tone }}></span>
                    <div>
                      <div className="activity-text">
                        <a role="button" tabIndex={0}
                           onClick={(e) => { e.preventDefault(); onSelectTask(a.taskId); }}
                           onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectTask(a.taskId); } }}
                           style={{ cursor:'pointer' }}>
                          <span className="code-id">{a.taskId}</span>
                        </a>
                        {' · '}
                        <span>{verb}</span>
                      </div>
                      <div className="activity-time">{H.relTime(a.ts)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Human reviews */}
        <div className="card row-humans">
          <div className="card-header">
            <div>
              <div className="card-eyebrow">Human reviews</div>
              <div className="card-title" style={{ marginTop: 4 }}>Notes from product, eng, QA</div>
            </div>
            <span style={{ fontFamily:'var(--font-mono)', fontSize:12, color:'var(--text-3)' }}>
              {(phaseData.human_reviews || []).length}
            </span>
          </div>
          <HumanReviews items={phaseData.human_reviews || []} editMode={editMode} onAddNote={onAddHumanReview} />
        </div>

      </div>
    </div>
  );
}

function HumanReviews({ items, editMode, onAddNote }) {
  const [adding, setAdding] = React.useState(false);
  const [text, setText] = React.useState('');

  const sorted = [...items].sort((a, b) => new Date(b.at || b.date || 0) - new Date(a.at || a.date || 0));

  function submit() {
    const t = text.trim();
    if (!t) return;
    onAddNote(t);
    setText('');
    setAdding(false);
  }

  return (
    <div>
      {editMode && (
        adding ? (
          <div className="hr-add">
            <textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Add a project-level review note…"
              rows={3}
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(); }}
            />
            <div className="hr-add-actions">
              <button className="hr-btn-secondary" onClick={() => { setAdding(false); setText(''); }}>Cancel</button>
              <button className="hr-btn-primary" disabled={!text.trim()} onClick={submit}>Post note</button>
            </div>
          </div>
        ) : (
          <button className="hr-add-trigger" onClick={() => setAdding(true)}>
            + Add a human review note
          </button>
        )
      )}
      {sorted.length === 0 ? (
        <div className="empty-state" style={{ padding: 24 }}>No human review notes yet.</div>
      ) : (
        <div className="hr-list">
          {sorted.map((r, i) => (
            <div key={i} className={`hr-item ${r._user ? 'is-user' : ''}`}>
              <div className="hr-meta">
                <span className="hr-date">{H.fmtDate(r.at || r.date)}</span>
                <span className="hr-time">· {H.relTime(r.at || r.date)}</span>
                {r._user && <span className="hr-tag-user">YOU</span>}
              </div>
              <div className="hr-text"><RichText html={r.text} /></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function pctOf(n, total) {
  if (!total) return '0%';
  return (n / total * 100).toFixed(2) + '%';
}

function Stat({ label, value, tone, mono }) {
  return (
    <div>
      <div style={{ fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-3)', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, marginTop: 2, color: tone === 'alert' ? 'var(--st-blocked)' : 'var(--text)', fontFamily: mono ? 'var(--font-mono)' : undefined, letterSpacing: '-0.01em' }}>{value}</div>
    </div>
  );
}

function Kpi({ label, value, sub, tone }) {
  return (
    <div className={`kpi ${tone || ''}`}>
      <div className="kpi-eyebrow">
        {tone === 'alert' && <span className="tone-dot" style={{ background: 'var(--st-blocked)' }}></span>}
        {tone === 'warn' && <span className="tone-dot" style={{ background: 'var(--pr-p1)' }}></span>}
        {tone === 'ok' && <span className="tone-dot" style={{ background: 'var(--st-completed)' }}></span>}
        {label}
      </div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-sub">{sub}</div>
    </div>
  );
}

function MiniSelect({ label, value, options, onChange }) {
  return (
    <label className="mini-select">
      <span className="mini-select-lbl">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
      </select>
    </label>
  );
}

function PriorityBars({ tasks }) {
  const by = { p0: {}, p1: {}, p2: {}, pl: {} };
  for (const t of tasks) {
    if (!by[t.priority]) by[t.priority] = {};
    by[t.priority][t.status] = (by[t.priority][t.status] || 0) + 1;
  }
  const order = ['p0','p1','p2','pl'];
  return (
    <div>
      {order.map(p => {
        const total = Object.values(by[p] || {}).reduce((a,b)=>a+b, 0);
        if (total === 0) return null;
        const seg = (s) => total ? ((by[p][s] || 0) / total * 100) + '%' : '0%';
        return (
          <div className="pbar-row" key={p}>
            <span className="pbar-label" style={{ color: `var(--pr-${p})` }}>{p.toUpperCase()}</span>
            <span className="pbar-track">
              <span className="pbar-seg" style={{ background: 'var(--st-completed)', width: seg('completed') }}></span>
              <span className="pbar-seg" style={{ background: 'var(--st-progress)', width: seg('in_progress') }}></span>
              <span className="pbar-seg" style={{ background: 'var(--st-blocked)', width: seg('blocked') }}></span>
              <span className="pbar-seg" style={{ background: 'var(--surface-3)', width: seg('todo') }}></span>
            </span>
            <span className="pbar-num">{total}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
   List View
   ──────────────────────────────────────────────────────────────── */

function ListView({ tasks, selectedId, onSelectTask, groupBy, reviewMode }) {
  const { isCollapsed, toggle } = useColumnCollapse();

  // Build columns
  let cols;
  if (groupBy === 'status') {
    // Single source of truth for status columns (keys, names, color tokens).
    cols = H.BOARD_COLUMNS.map(c => ({
      key: c.key,
      name: c.name,
      color: c.color,
      tasks: tasks.filter(t => t.status === c.key),
    }));
  } else if (groupBy === 'priority') {
    const order = ['p0','p1','p2','pl'];
    cols = order.map(p => ({
      key: p,
      name: p.toUpperCase(),
      color: `var(--pr-${p})`,
      tasks: tasks.filter(t => t.priority === p),
    }));
  } else if (groupBy === 'pm') {
    const order = ['needs-review', 'rejected', 'tested', 'done', '', 'superseded'];
    cols = order.map(k => ({
      key: k || 'unset',
      name: k ? k.replace('-', ' ').toUpperCase() : 'Not reviewed',
      color: k === 'needs-review' ? 'var(--pr-p1)'
           : k === 'rejected' ? 'var(--st-blocked)'
           : k === 'tested' ? 'var(--st-completed)'
           : k === 'done' ? 'var(--accent)'
           : 'var(--text-4)',
      tasks: tasks.filter(t => (t.pm_status || '') === k),
    }));
  } else {
    cols = [{ key: 'all', name: 'All tasks', color: 'var(--accent)', tasks }];
  }

  if (cols.length === 0 || cols.every(c => c.tasks.length === 0)) {
    return (
      <div className="tasks-list-wrap">
        <div className="empty-state" style={{ padding: 60 }}>
          <div style={{ fontSize: 28, marginBottom: 6 }}>—</div>
          No tasks match the current filters.
        </div>
      </div>
    );
  }

  return (
    <div className="task-columns">
      {cols.map(c => {
        const empty = c.tasks.length === 0;
        const collapsed = isCollapsed(c.key, empty);
        if (collapsed) {
          return (
            <div key={c.key} className="task-column task-column-rail collapsed"
                 onClick={() => toggle(c.key, empty)} role="button" tabIndex={0}
                 onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(c.key, empty); } }}>
              <span className="task-column-dot rail-dot" style={{ background: c.color }}></span>
              <span className="cc-vname">{c.name}</span>
              <span className="cc-count">{c.tasks.length}</span>
            </div>
          );
        }
        return (
          <div key={c.key} className="task-column">
            <div className="task-column-head">
              <span className="task-column-dot" style={{ background: c.color }}></span>
              <span className="task-column-name">{c.name}</span>
              <span className="task-column-count">{c.tasks.length}</span>
              <button type="button" className="col-collapse-btn" aria-label="Collapse column"
                      onClick={() => toggle(c.key, empty)}>▾</button>
            </div>
            <div className="task-column-body">
              {empty
                ? <div className="empty-state task-column-empty">— Empty</div>
                : c.tasks.map(t => (
                    <TaskRow key={t.id} task={t} selected={t.id===selectedId} onClick={() => onSelectTask(t.id)} reviewMode={reviewMode} />
                  ))
              }
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TaskRow({ task, selected, onClick, reviewMode }) {
  const reviews = task.reviews || [];
  const hasReviews = reviews.length > 0;
  const hasRemark = !!task.pm_remark;
  const showReviewBlock = reviewMode && (hasReviews || hasRemark);

  return (
    <div className={`task-row-wrap ${selected ? 'selected' : ''} ${showReviewBlock ? 'has-reviews' : ''}`} onClick={onClick}>
      <div className="task-row">
        <StatusDot status={task.status} />
        <span className="tr-id">{task.id}</span>
        <div className="tr-title">{task.title}</div>
        <div className="tr-meta">
          <ProgressMini task={task} />
          <FlagBadges task={task} />
          <PriorityChip p={task.priority} />
          <PMChip s={task.pm_status} />
        </div>
      </div>
      {showReviewBlock && (
        <div className="tr-reviews">
          {hasRemark && (
            <div className="tr-review-line pm">
              <span className="tr-review-tag pm">PM</span>
              <RichText html={trimText(task.pm_remark, 240)} />
            </div>
          )}
          {reviews.slice(0, 2).map((r, i) => {
            const stale = H.isStale(r.at, task.code_updated_at);
            return (
              <div key={i} className={`tr-review-line ${r.type}`}>
                <span className={`tr-review-tag ${r.type}`}>{r.type}</span>
                <RichText html={trimText(r.text, 220)} />
                {stale && <span className="tr-stale-pill">stale</span>}
                {r.at && <span className="tr-review-time">· {H.relTime(r.at)}</span>}
              </div>
            );
          })}
          {reviews.length > 2 && (
            <div className="tr-more">+{reviews.length - 2} more reviews</div>
          )}
        </div>
      )}
    </div>
  );
}

function trimText(s, n) {
  if (!s) return '';
  // strip tags for length calc but keep them in output
  const plain = s.replace(/<[^>]+>/g, '');
  if (plain.length <= n) return s;
  // Walk html until we've consumed n plain chars
  let out = '', count = 0, inTag = false;
  for (const ch of s) {
    if (ch === '<') inTag = true;
    out += ch;
    if (!inTag) count++;
    if (ch === '>') inTag = false;
    if (count >= n) break;
  }
  return out + '…';
}

/* ─────────────────────────────────────────────────────────────────
   Board View (Kanban)
   ──────────────────────────────────────────────────────────────── */

function KCardMoveMenu({ currentStatus, onMove, onClose }) {
  const menuRef = React.useRef(null);

  React.useEffect(() => {
    function onDoc(e) { if (!e.target.closest('.kcard-move-menu')) onClose(); }
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    if (menuRef.current) menuRef.current.focus();
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div ref={menuRef} className="kcard-move-menu" role="menu" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
      {H.BOARD_COLUMNS.filter(c => c.key !== currentStatus).map(c => (
        <button key={c.key} className="kcard-move-item" role="menuitem"
          onClick={() => { onMove(c.key); onClose(); }}>
          <span className="dot" style={{ background: c.color }}></span>
          <span>Move to {c.name}</span>
        </button>
      ))}
    </div>
  );
}

const KCard = React.memo(function KCard({ t, selected, draggable, canEditStatus, onDragStart, onDragEnd, onSelect, onChangeStatus }) {
  const [menuOpen, setMenuOpen] = React.useState(false);

  const onKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); return; }
    if (!canEditStatus) return;
    const idx = H.BOARD_COLUMNS.findIndex(c => c.key === t.status);
    if (idx < 0) return;
    if (e.key === 'ArrowRight' && idx < H.BOARD_COLUMNS.length - 1) {
      e.preventDefault();
      onChangeStatus(H.BOARD_COLUMNS[idx + 1].key);
    } else if (e.key === 'ArrowLeft' && idx > 0) {
      e.preventDefault();
      onChangeStatus(H.BOARD_COLUMNS[idx - 1].key);
    }
  };

  return (
    <div className={`kcard ${draggable ? 'draggable' : ''} ${selected ? 'selected' : ''}`}
         draggable={draggable}
         tabIndex={0}
         onDragStart={onDragStart}
         onDragEnd={onDragEnd}
         onClick={onSelect}
         onKeyDown={onKeyDown}>
      <div className="kcard-row1">
        <span className="kcard-id">{t.id}</span>
        <PriorityChip p={t.priority} />
        {canEditStatus && (
          <button className="kcard-menu-btn" aria-label="Move task"
            onClick={(e) => { e.stopPropagation(); setMenuOpen(v => !v); }}>⋯</button>
        )}
      </div>
      <div className="kcard-title">{t.title}</div>
      <div className="kcard-row2">
        <FlagBadges task={t} compact />
        <PMChip s={t.pm_status} />
        <span style={{ flex: 1 }}></span>
        <ProgressMini task={t} />
      </div>
      {menuOpen && (
        <KCardMoveMenu currentStatus={t.status}
          onMove={onChangeStatus}
          onClose={() => setMenuOpen(false)} />
      )}
    </div>
  );
});

const BoardColumn = React.memo(function BoardColumn({
  col, collapsed, onToggleCollapse, dragOverCol, editMode, selectedId, canEditStatus,
  onDragOver, onDragEnter, onDragLeave, onDrop,
  onCardDragStart, onCardDragEnd, onSelect, onChangeStatus,
}) {
  const dragProps = {
    onDragOver: (e) => onDragOver(e, col.key),
    onDragEnter: (e) => onDragEnter(e, col.key),
    onDragLeave: (e) => onDragLeave(e, col.key),
    onDrop: (e) => onDrop(e, col.key),
  };
  if (collapsed) {
    return (
      <div className={`board-col board-col-rail collapsed ${dragOverCol === col.key ? "drag-over" : ""}`}
           role="button" tabIndex={0}
           onClick={() => onToggleCollapse(col.key)}
           onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggleCollapse(col.key); } }}
           {...dragProps}>
        <span className="dot rail-dot" style={{ background: col.color }}></span>
        <span className="cc-vname">{col.name}</span>
        <span className="cc-count">{col.tasks.length}</span>
      </div>
    );
  }
  return (
    <div className={`board-col ${dragOverCol === col.key ? "drag-over" : ""}`} {...dragProps}>
      <div className="board-col-head">
        <span className="dot" style={{ background: col.color }}></span>
        <span className="name">{col.name}</span>
        <span className="count">{col.tasks.length}</span>
        <button type="button" className="col-collapse-btn" aria-label="Collapse column"
                onClick={(e) => { e.stopPropagation(); onToggleCollapse(col.key); }}>▾</button>
      </div>
      <div className="board-col-body">
        {col.tasks.length === 0 && <div className="board-col-empty">— Drop here</div>}
        {col.tasks.map(t => (
          <KCard key={t.id} t={t}
            selected={selectedId === t.id}
            draggable={editMode}
            canEditStatus={canEditStatus}
            onDragStart={(e) => onCardDragStart(e, t.id)}
            onDragEnd={onCardDragEnd}
            onSelect={() => onSelect(t.id)}
            onChangeStatus={(status) => onChangeStatus(t.id, status)} />
        ))}
      </div>
    </div>
  );
});

function BoardView({ tasks, selectedId, onSelectTask, reviewMode, editMode, onChangeStatus, phaseLocked }) {
  const [dragOverCol, setDragOverCol] = React.useState(null);
  const enterCounts = React.useRef({});   // colKey → enter depth
  const wasDragging = React.useRef(false);
  const cols = H.BOARD_COLUMNS;

  // Memoize per-column task lists so a flip of dragOverCol does NOT re-sort.
  const columns = React.useMemo(() => cols.map(c => {
    const colTasks = tasks.filter(t => t.status === c.key).slice().sort(H.comparePriorityThenId);
    return { ...c, tasks: colTasks };
  }), [tasks, cols]);

  const handleDragStart = (e, taskId) => {
    if (!editMode) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-khira-task', taskId);
    // Fallback only — most desktop browsers require text/plain to keep DnD events firing.
    e.dataTransfer.setData('text/plain', taskId);
    e.currentTarget.classList.add('dragging');
    wasDragging.current = true;
  };
  const handleDragEnd = (e) => {
    e.currentTarget.classList.remove('dragging');
    enterCounts.current = {};
    setDragOverCol(null);
    setTimeout(() => { wasDragging.current = false; }, 0);
  };
  const handleDragOver = (e, colKey) => {
    if (!editMode) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  const handleDragEnter = (e, colKey) => {
    if (!editMode) return;
    const n = (enterCounts.current[colKey] || 0) + 1;
    enterCounts.current[colKey] = n;
    if (n === 1) setDragOverCol(colKey);
  };
  const handleDragLeave = (e, colKey) => {
    if (!editMode) return;
    const n = Math.max(0, (enterCounts.current[colKey] || 0) - 1);
    enterCounts.current[colKey] = n;
    if (n === 0 && dragOverCol === colKey) setDragOverCol(null);
  };
  const handleDrop = (e, colKey) => {
    e.preventDefault();
    const taskId = e.dataTransfer.getData('application/x-khira-task') || e.dataTransfer.getData('text/plain');
    enterCounts.current = {};
    setDragOverCol(null);
    if (!taskId) return;
    const cur = tasks.find(t => t.id === taskId);
    if (cur && cur.status !== colKey && onChangeStatus) onChangeStatus(taskId, colKey);
  };

  const handleCardSelect = React.useCallback((id) => {
    if (wasDragging.current) return;
    onSelectTask(id);
  }, [onSelectTask]);

  const canEditStatus = editMode && !phaseLocked;
  const { isCollapsed, toggle } = useColumnCollapse();

  return (
    <div className="view-pane" style={{ padding: '16px 24px', display: 'flex', flexDirection: 'column' }}>
      {phaseLocked && (
        <div className="board-readonly-banner">
          <Icon name="check" size={14} />
          <span>Phase is closed — board is read-only.</span>
        </div>
      )}
      {!phaseLocked && editMode && (
        <div className="edit-hint">
          <Icon name="tweaks" size={14} />
          <span>Drag cards between columns to change status. Engineering metadata (id · title · code timestamps · subtasks) is locked.</span>
        </div>
      )}
      <div className="board" style={{ flex: 1, minHeight: 0 }}>
        {columns.map(col => (
          <BoardColumn key={col.key} col={col}
            collapsed={isCollapsed(col.key, col.tasks.length === 0)}
            onToggleCollapse={(key) => toggle(key, col.tasks.length === 0)}
            dragOverCol={dragOverCol}
            editMode={editMode}
            canEditStatus={canEditStatus}
            selectedId={selectedId}
            onDragOver={handleDragOver}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onCardDragStart={handleDragStart}
            onCardDragEnd={handleDragEnd}
            onSelect={handleCardSelect}
            onChangeStatus={onChangeStatus} />
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
   Focus View
   ──────────────────────────────────────────────────────────────── */

function FocusView({ tasks, onSelectTask }) {
  const { isCollapsed, toggle } = useColumnCollapse();

  const blocked = tasks.filter(t => t.status === 'blocked' || (t.blockers && t.blockers.length > 0 && t.status !== 'completed'));
  const p0 = tasks.filter(t => t.priority === 'p0' && t.status !== 'completed');
  const needsReview = tasks.filter(t => t.pm_status === 'needs-review' || t.pm_status === 'rejected');

  const bugItems = [];
  for (const t of tasks) {
    if (t.status === 'completed' && t.pm_status === 'tested') continue;
    for (const r of (t.reviews || [])) {
      if (r.type === 'BUG') {
        bugItems.push({ task: t, review: r, stale: H.isStale(r.at, t.code_updated_at) });
      }
    }
  }
  bugItems.sort((a, b) => new Date(b.review.at || 0) - new Date(a.review.at || 0));

  const staleItems = [];
  for (const t of tasks) {
    // Mirror the bugs bucket: completed+tested work is not actionable triage.
    if (t.status === 'completed' && t.pm_status === 'tested') continue;
    for (const r of (t.reviews || [])) {
      if (H.isStale(r.at, t.code_updated_at)) {
        staleItems.push({ task: t, review: r });
      }
    }
  }
  staleItems.sort((a, b) => new Date(b.review.at || 0) - new Date(a.review.at || 0));

  const sections = [
    { key: 'blocked', icon: 'block', title: 'Blocked or has blockers', sub: 'Cannot progress until cleared', tasks: blocked },
    { key: 'p0', icon: 'p0', title: 'P0 tasks not done', sub: 'Highest priority open work', tasks: p0 },
    { key: 'needs-review', icon: 'needs-review', title: 'Awaiting PM review', sub: 'Needs-review or rejected by PM', tasks: needsReview },
    { key: 'bugs', icon: 'bug', title: 'Open bug reviews', sub: 'BUG-typed reviews on open tasks', bugItems },
    { key: 'stale', icon: 'stale', title: 'Stale reviews', sub: 'Code was updated after review was written', staleItems },
  ];

  const renderIcon = (icon) => {
    if (icon === 'block') return <Icon name="block" size={14} />;
    if (icon === 'p0') return <Icon name="alert" size={14} />;
    if (icon === 'needs-review') return <Icon name="check" size={14} />;
    if (icon === 'bug') return <Icon name="bug" size={14} />;
    if (icon === 'stale') return <Icon name="clock" size={14} />;
    return null;
  };

  return (
    <div className="view-pane">
      <div className="focus-stack">
        {sections.map((s) => {
          // Stale bucket counts per-task (one task may own several stale reviews).
          const count = s.tasks ? s.tasks.length
            : s.bugItems ? s.bugItems.length
            : s.staleItems ? new Set(s.staleItems.map(it => it.task.id)).size
            : 0;
          const empty = count === 0;
          const collapsed = isCollapsed(s.key, empty);
          return (
            <section className={`focus-section ${collapsed ? "collapsed" : ""}`} key={s.key}>
              <header className="focus-section-head"
                      onClick={() => toggle(s.key, empty)}
                      role="button" tabIndex={0}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(s.key, empty); } }}>
                <span className={`icon-pill ${s.icon}`}>{renderIcon(s.icon)}</span>
                <div>
                  <h3>{s.title}</h3>
                  <div className="sub">{s.sub}</div>
                </div>
                <span className="sec-chevron" aria-hidden>▾</span>
                <span className="count">{count}</span>
              </header>
              {!collapsed && empty && (
                <div className="empty-state"><div className="glyph">✓</div>Nothing in this bucket.</div>
              )}
              {!collapsed && s.tasks && s.tasks.length > 0 && (
                <div className="focus-list">
                  {s.tasks.map(t => <FocusTaskRow key={t.id} task={t} onSelect={onSelectTask} />)}
                </div>
              )}
              {!collapsed && s.bugItems && s.bugItems.length > 0 && (
                <div className="focus-list">
                  {s.bugItems.slice(0, 10).map((bi, i) => (
                    <div key={i} className="focus-row" role="button" tabIndex={0}
                         onClick={() => onSelectTask(bi.task.id)}
                         onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectTask(bi.task.id); } }}>
                      <span style={{ width: 8, height: 8, borderRadius: 50, background: 'var(--rv-bug)' }}></span>
                      <div style={{ minWidth: 0 }}>
                        <div className="title-line">
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)', marginRight: 8 }}>{bi.task.id}</span>
                          {bi.task.title}
                          {bi.stale && <span className="review-stale" style={{ marginLeft: 8 }}>STALE</span>}
                        </div>
                        <RichText className="body-line" html={bi.review.text} />
                      </div>
                      <span className="meta">{H.relTime(bi.review.at)}</span>
                    </div>
                  ))}
                </div>
              )}
              {!collapsed && s.staleItems && s.staleItems.length > 0 && (
                <div className="focus-list">
                  {s.staleItems.slice(0, 10).map((it, i) => (
                    <div key={i} className="focus-row" role="button" tabIndex={0}
                         onClick={() => onSelectTask(it.task.id)}
                         onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectTask(it.task.id); } }}>
                      <span style={{ width: 8, height: 8, borderRadius: 50, background: 'var(--pr-p1)' }}></span>
                      <div style={{ minWidth: 0 }}>
                        <div className="title-line">
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)', marginRight: 8 }}>{it.task.id}</span>
                          {it.task.title}
                          <span style={{ marginLeft: 8, fontSize: 10, padding: '1px 5px', borderRadius: 3, background: 'var(--surface-2)', color: 'var(--text-3)', fontFamily: 'var(--font-mono)', fontWeight: 600, letterSpacing: '0.06em' }}>{it.review.type}</span>
                        </div>
                        <RichText className="body-line" html={it.review.text} />
                      </div>
                      <span className="meta">review {H.relTime(it.review.at)}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function FocusTaskRow({ task, onSelect }) {
  const p = H.subtaskProgress(task);
  return (
    <div className="focus-row" role="button" tabIndex={0}
         onClick={() => onSelect(task.id)}
         onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(task.id); } }}>
      <StatusDot status={task.status} />
      <div style={{ minWidth: 0 }}>
        <div className="title-line">
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)', marginRight: 8 }}>{task.id}</span>
          {task.title}
        </div>
        <div className="sub-meta-row">
          <span><strong>{STATUS_LABEL_SHORT[task.status]}</strong></span>
          {task.priority && <span>· <strong>{task.priority.toUpperCase()}</strong></span>}
          {task.pm_status && <span>· PM <strong>{task.pm_status.replace('-', ' ')}</strong></span>}
          {p.total > 0 && <span>· <strong>{p.done}/{p.total}</strong> subtasks</span>}
          {task.blockers && task.blockers.length > 0 && <span>· <strong style={{ color:'var(--st-blocked)' }}>{task.blockers.length} blocker{task.blockers.length>1?'s':''}</strong></span>}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <FlagBadges task={task} compact />
        <PriorityChip p={task.priority} />
      </div>
    </div>
  );
}

Object.assign(window, { OverviewView, ListView, BoardView, FocusView });
