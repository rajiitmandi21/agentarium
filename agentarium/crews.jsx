// Agentarium — Crews (role stations + authority org chart)

// Department hue register (persona register, soft only) — spec §1.1/1.4.
const CREWS_DEPT_HUE = { executive: 285, tech: 255, product: 330, data: 190, ai: 45, it: 125 };
function crewsDeptHue(d) { return CREWS_DEPT_HUE[d] != null ? CREWS_DEPT_HUE[d] : 255; }

// Authority tiers (core model §2) — labels for the chart/drawer.
const CREWS_TIER_LABEL = { owner: "Owner", ceo: "CEO", cxo: "CXO", lead: "Lead", senior: "Senior", junior: "Junior" };
const CREWS_TIER_SHORT = { owner: "OWNER", ceo: "CEO", cxo: "CXO", lead: "LEAD", senior: "SR", junior: "JR" };

const CREWS_LEVEL_WORDS = /^(senior|junior|lead|leader|chief|the|of|and|for)$/i;
function crewsInitials(p) {
  const src = p.title || p.id || "";
  const words = src.split(/[\s./-]+/).filter(w => w && !CREWS_LEVEL_WORDS.test(w));
  const pick = (words.length ? words : src.split(/[\s./-]+/).filter(Boolean)).slice(0, 2);
  return (pick.map(w => w[0]).join("") || src.slice(0, 2)).toUpperCase();
}

// Reconstruct the skill.md source path from the persona id (read-only display).
function crewsSourcePath(p) {
  if (p.department === "executive" || /^executive-/.test(p.id)) {
    return `project-management/roles/crews/executive/${p.id.replace(/^executive-/, "")}/skill.md`;
  }
  // Boundary defaults: never render literal "undefined" for partial frontmatter.
  const dept = p.department || "unknown";
  const role = p.role || "unassigned";
  const level = p.level || "any";
  return `project-management/roles/crews/${dept}/${role}/${level}/skill.md`;
}

function CrewsStatusPill({ status }) {
  const s = status || "active";
  const cls = s === "engaged" ? "engaged"
    : s === "seat-open" ? "seat"
    : s === "retired" ? "retired"
    : "active";
  const label = s === "seat-open" ? "seat open" : s;
  return (
    <span className={`org-pill ${cls}`}><span className="dot" />{label}</span>
  );
}

// ── Crews authority-gated assignment (AG-P7.8, Slice 3) ─────────────────────
// DnD assignment is ADDITIVE to the Khira status board. A persona/agent drop
// writes owner_id ONLY — it must NEVER mutate Khira task `status` (§7.1 build-
// fix). The Khira board carries the dragged task id under this MIME type; we
// read the same key so a card dragged off the board can land on a Crews node.
const CREWS_TASK_MIME = "application/x-khira-task";
const CREWS_ASSIGN_ACTOR_ID = "executive-owner"; // runtime supplies a real actor later (AG-P7.12)

// Degraded per-tier capacity defaults (SDP-approved for this draft phase; spec
// §10 build-fix #5). Live `engagement.capacity` frontmatter will override once it
// lands. Uncapped tiers (owner/ceo/cxo) report Infinity → "uncapped".
const CREWS_TIER_CAPACITY = { junior: 2, senior: 3, lead: 5, cxo: 8, ceo: Infinity, owner: Infinity };
function crewsCapacityFor(p) {
  const t = (p && (p.tier || p.level)) || "";
  const c = CREWS_TIER_CAPACITY[t === "leader" ? "lead" : t];
  return c == null ? 3 : c;
}

// Terminal-status register — MIRROR of crews-usage.js CLOSED_STATUSES (that
// file is canonical; keep both lists identical). A task in a terminal status
// contributes NO open load: not to capacity meters, free-capacity filters,
// pending-staffing inboxes, or roster-board columns.
const CREWS_CLOSED_STATUSES = {
  done: true, tested: true, complete: true, completed: true,
  closed: true, superseded: true, rejected: true, cancelled: true, canceled: true
};
function crewsTaskOpen(task) {
  const s = task && task.status;
  return !(s && CREWS_CLOSED_STATUSES[String(s).toLowerCase()]);
}

// reason → reasoned-reject chiplet copy (§3.4). Maps every engine reason code
// (delegationReason / agentDelegationReason) + the call-site rejects.
const CREWS_REJECT_COPY = {
  "seat-open": "seat-open — staff it first",
  "retired": "retired — cannot assign",
  "out-of-subtree": "authority denied — not in your chain",
  "junior-cannot-assign": "juniors can't assign",
  "unknown-actor": "authority denied — unknown actor",
  "unknown-target": "cannot assign — unknown target",
  "unknown-agent": "cannot assign — unknown agent",
  "engine-unavailable": "authority denied — engine unavailable"
};
function crewsRejectCopy(reason) {
  return CREWS_REJECT_COPY[reason] || "cannot assign here";
}

// ── THE SINGLE GATED ASSIGNMENT ROUTINE (fail-CLOSED). ──────────────────────
// Every Crews drop surface routes through here: org-chart persona chips,
// drawer agent mini-chips, roster-board columns, and leader-triage routing.
// Gates via the authority engine, then hands an owner_id-ONLY patch to
// `onAccept` — it NEVER writes ungated and NEVER touches status. When the
// engine or index is missing the assignment is REFUSED with a reasoned-reject
// chiplet ("engine-unavailable") — no best-effort writes. Agent routing clears
// any stale delegated flag (staffing_state:null); persona drops mark
// pending-staffing.
// deps = { CA, index, agents, onReject(chipId, copy), onAccept(taskId, patch) }
function crewsGatedAssign(taskId, target, deps) {
  const d = deps || {};
  const chipId = target.kind === "agent" ? ("agent:" + target.agent.id) : target.persona.id;
  const fail = (copy) => {
    if (typeof d.onReject === "function") d.onReject(chipId, copy);
    return false;
  };
  if (!d.CA || !d.index) return fail(crewsRejectCopy("engine-unavailable"));
  const ctx = { index: d.index, agents: d.agents };
  let res;
  if (target.kind === "agent") {
    res = d.CA.agentDelegationReason(CREWS_ASSIGN_ACTOR_ID, target.agent, ctx);
  } else {
    res = d.CA.delegationReason(CREWS_ASSIGN_ACTOR_ID, target.persona.id, ctx);
  }
  if (!res || !res.ok) return fail(crewsRejectCopy(res ? res.reason : undefined));
  const patch = target.kind === "agent"
    ? { owner_id: target.agent.id, staffing_state: null }
    : { owner_id: target.persona.id, staffing_state: "pending-staffing" };
  if (typeof d.onAccept === "function") d.onAccept(taskId, patch);
  return true;
}

// Skill-fit: overlap of a persona's skills with a task's required_skills.
function crewsTaskSkills(task) {
  if (!task) return [];
  const raw = task.required_skills || task.requiredSkills || task.skills || [];
  return (Array.isArray(raw) ? raw : []).map((s) => String(s).toLowerCase());
}
function crewsSkillFit(personaSkills, task) {
  const req = crewsTaskSkills(task);
  if (!req.length) return 0;
  const have = new Set((personaSkills || []).map((s) => String(s).toLowerCase()));
  let hit = 0;
  for (const r of req) if (have.has(r)) hit += 1;
  return hit / req.length; // 0..1
}

// Read the dragged task id off a DROP event (status-board MIME first).
// NOTE: HTML5 "protected mode" makes dataTransfer.getData() return "" during
// dragenter/dragover — task identity is readable exactly once, at drop. The
// producer (Khira Board card, views.jsx handleDragStart) sets both this MIME
// and a text/plain fallback, so drops assign correctly; hover-time chrome
// therefore keys off crewsDragHasTask(types) instead of getData.
function crewsDraggedTaskId(e) {
  try {
    return e.dataTransfer.getData(CREWS_TASK_MIME) || e.dataTransfer.getData("text/plain") || "";
  } catch (err) {
    return "";
  }
}

// True only when the active drag actually carries a Khira task. Unlike
// getData(), dataTransfer.types IS readable during dragenter/over, making this
// the reliable discriminator: gates ALL Crews hover chrome so native drags
// (text selections, images, links) can no longer masquerade as assignable
// task drags. A real Edit-Mode board-card drag carries CREWS_TASK_MIME in its
// types (set by the producer), so genuine flows are unaffected.
function crewsDragHasTask(e) {
  try {
    const types = e && e.dataTransfer && e.dataTransfer.types;
    if (!types) return false;
    return types.includes
      ? types.includes(CREWS_TASK_MIME)
      : types.contains(CREWS_TASK_MIME); // legacy DOMStringList
  } catch (err) {
    return false;
  }
}

// Resolve the live Crews engine + index off window (guarded; null if absent).
function crewsEngine() {
  if (typeof window === "undefined" || !window.CrewsAssign) return null;
  const index = (window.AG && window.AG.CREWS) || (typeof AG !== "undefined" && AG.CREWS) || null;
  if (!index) return null;
  return { CA: window.CrewsAssign, index };
}
function crewsListAgents() {
  try {
    return (window.CrewsAgents && window.CrewsAgents.listAgents) ? (window.CrewsAgents.listAgents() || []) : [];
  } catch (e) { return []; }
}

// View-mode persistence (spec §"View Modes"): default = Org Chart, persisted
// per project in localStorage. Guarded for SSR / private-mode throwers.
const CREWS_VIEWMODE_KEY = "agentarium.crews.viewMode";
const CREWS_VIEW_MODES = ["orgchart", "stations", "roster-board", "usage"];
// Toolbar tabs in VISUAL order (CREWS_VIEW_MODES above is only the
// persistence vocabulary). Drives the roving-tabindex arrow-key nav.
const CREWS_VIEW_TABS = [
  { mode: "stations", label: "Stations", glyph: "crew" },
  { mode: "orgchart", label: "Org Chart", glyph: "map" },
  { mode: "roster-board", label: "Roster Board", glyph: "crew" },
  { mode: "usage", label: "Usage", glyph: "khira" }
];
function crewsReadViewMode() {
  try {
    const v = window.localStorage.getItem(CREWS_VIEWMODE_KEY);
    return CREWS_VIEW_MODES.includes(v) ? v : "orgchart";
  } catch (e) { return "orgchart"; }
}
function crewsWriteViewMode(v) {
  try { window.localStorage.setItem(CREWS_VIEWMODE_KEY, v); } catch (e) {}
}

function CrewsView({ actingAs, onActAs, onNavigate, onOpenArtifact, editMode, reviewMode, edits, onPatch, tasks, onAssignTask, agents, onRetireAgent, onReleaseAgent }) {
  // Default Org Chart, restored from localStorage; every switch persists.
  const [view, setViewRaw] = React.useState(crewsReadViewMode);
  const setView = React.useCallback((v) => { setViewRaw(v); crewsWriteViewMode(v); }, []);
  // Roving-tabindex arrow-key navigation across the view tabs (tab pattern:
  // only the active tab is tabbable; Left/Right/Home/End move selection+focus).
  const tabRefs = React.useRef({});
  const onTabKeyDown = (e) => {
    const order = CREWS_VIEW_TABS.map(t => t.mode);
    const idx = order.indexOf(view);
    if (idx === -1) return;
    let next = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = order[(idx + 1) % order.length];
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = order[(idx - 1 + order.length) % order.length];
    else if (e.key === "Home") next = order[0];
    else if (e.key === "End") next = order[order.length - 1];
    if (!next) return;
    e.preventDefault();
    setView(next);
    const el = tabRefs.current[next];
    if (el) el.focus();
  };
  const crews = (typeof AG !== "undefined" && AG.CREWS) || { count: 0, personas: [], root: null };
  // Prefer the `agents` prop (post-retire freshness owned by app.jsx); fall
  // back to self-sourcing from the CrewsAgents store when the prop is absent.
  const agentsLive = Array.isArray(agents) ? agents : crewsListAgents();
  return (
    <div className="modbody" data-screen-label="Crews">
      <ModuleHeader
        roomNo="05"
        eyebrow="Crews · Role Stations"
        title="Who is acting on this project"
        subtitle={`${AG.ROLES.length} project roles · ${crews.count} Crews personas`}
        editMode={editMode}
        reviewMode={reviewMode}
        editPolicy={{ mode: "read-only", fields: ["view roles.json · edit via repo"] }}
        actions={
          <>
            <ReadOnlyBtn className="btn"><Glyph name="folder" size={14} /> roles.json</ReadOnlyBtn>
            <ReadOnlyBtn className="btn primary"><Glyph name="plus" size={14} /> Add crew member</ReadOnlyBtn>
          </>
        }
      />
      <PmSourceBanner readOnly />

      <div className="crews-org-toolbar">
        <div className="crews-viewtoggle" role="tablist" aria-label="Crews view" onKeyDown={onTabKeyDown}>
          {CREWS_VIEW_TABS.map(t => (
            <button key={t.mode} role="tab"
                    id={"crews-tab-" + t.mode}
                    aria-selected={view === t.mode}
                    aria-controls="crews-view-panel"
                    tabIndex={view === t.mode ? 0 : -1}
                    className={view === t.mode ? "on" : ""}
                    ref={el => { tabRefs.current[t.mode] = el; }}
                    onClick={() => setView(t.mode)}>
              <Glyph name={t.glyph} size={13} /> {t.label}
            </button>
          ))}
        </div>
        <span className="crews-org-count">
          {view === "stations" ? `${AG.ROLES.length} stations`
            : view === "roster-board" ? `${agentsLive.filter(a => a && a.status !== "retired").length} agents on the roster`
            : view === "usage" ? "simulated effort · representational only"
            : `${crews.count} personas · authority / escalation tree`}
        </span>
      </div>

      <div id="crews-view-panel" role="tabpanel" aria-label="Crews view content">
      {view === "stations" ? (
        <>
          <div className="note-card" style={{ marginBottom: 14 }}>
            <strong style={{ color: "var(--text)" }}>Acting as {roleById(actingAs).name}.</strong>{" "}
            Permissions and scope of every other module reflect this role. Click a station to inspect it; press
            <kbd style={{ margin: "0 4px", fontFamily: "var(--font-mono)", fontSize: 11, padding: "1px 5px", border: "1px solid var(--border-strong)", borderRadius: 3 }}>Switch</kbd>
            to take that station.
          </div>
          <div className="crews-grid">
            {AG.ROLES.map(r => (
              <CrewCard key={r.id}
                        r={r}
                        isActive={r.id === actingAs}
                        onSwitch={() => onActAs(r.id)}
                        onOpenArtifact={onOpenArtifact}
                        onNavigate={onNavigate} />
            ))}
          </div>
        </>
      ) : view === "roster-board" ? (
        <CrewsRosterBoard
          crews={crews}
          tasks={tasks}
          agents={agentsLive}
          onAssignTask={onAssignTask}
          onRetireAgent={onRetireAgent}
          onReleaseAgent={onReleaseAgent} />
      ) : view === "usage" ? (
        window.CrewsUsageView
          ? <CrewsUsageView tasks={tasks} agents={agentsLive} index={(typeof AG !== "undefined" && AG.CREWS) || null} />
          : <div className="note-card" style={{ marginTop: 4 }}>Usage view unavailable.</div>
      ) : (
        <CrewsOrgChart
          crews={crews}
          onOpenArtifact={onOpenArtifact}
          tasks={tasks}
          agents={agentsLive}
          onAssignTask={onAssignTask}
          onRetireAgent={onRetireAgent}
          onReleaseAgent={onReleaseAgent} />
      )}
      </div>
    </div>
  );
}

function CrewsOrgChart({ crews, onOpenArtifact, tasks, onAssignTask, agents, onRetireAgent, onReleaseAgent }) {
  const personas = (crews && crews.personas) || [];
  const allTasks = Array.isArray(tasks) ? tasks : [];

  const tree = React.useMemo(() => {
    const byId = new Map(personas.map(p => [p.id, p]));
    const childrenOf = new Map(personas.map(p => [p.id, []]));
    for (const p of personas) {
      if (p.reports_to && childrenOf.has(p.reports_to)) childrenOf.get(p.reports_to).push(p.id);
    }
    for (const arr of childrenOf.values()) arr.sort((a, b) => a.localeCompare(b));
    const rootId = (crews && crews.root && byId.has(crews.root))
      ? crews.root
      : (personas.find(p => p.reports_to == null) || {}).id || null;
    // Default: juniors collapsed (collapse any node whose children are all juniors).
    const defaultCollapsed = personas
      .filter(p => {
        const kids = childrenOf.get(p.id) || [];
        return kids.length > 0 && kids.every(k => (byId.get(k) || {}).level === "junior");
      })
      .map(p => p.id);
    const descCount = (id) => {
      let n = 0;
      const stack = [...(childrenOf.get(id) || [])];
      while (stack.length) { const c = stack.pop(); n++; stack.push(...(childrenOf.get(c) || [])); }
      return n;
    };
    return { byId, childrenOf, rootId, defaultCollapsed, descCount };
  }, [personas, crews && crews.root]);

  const { byId, childrenOf, rootId, defaultCollapsed, descCount } = tree;

  const [collapsed, setCollapsed] = React.useState(() => new Set());
  const [selId, setSelId] = React.useState(null);
  const [focusId, setFocusId] = React.useState(null);
  const initedRef = React.useRef(false);
  const treeRef = React.useRef(null);
  const rowRefs = React.useRef({});

  // Focus-subtree (spec §"Interaction"): isolate one department/leader's team by
  // re-rooting the tree at a node. null = whole org.
  const [isolateId, setIsolateId] = React.useState(null);

  // Filter bar state (persona register only) — spec §"Browse & Filter".
  const [fDepts, setFDepts] = React.useState(() => new Set()); // multi-select departments
  const [fTier, setFTier] = React.useState("");        // tier/level token or ""
  const [fSkill, setFSkill] = React.useState("");      // skill typeahead substring
  const [fStatus, setFStatus] = React.useState("");    // availability/status or ""
  const [fSearch, setFSearch] = React.useState("");    // text over name/title/id
  const [fFreeCap, setFFreeCap] = React.useState(false); // only personas with free capacity

  // Distinct facet values present in the loaded personas (stable order).
  const facets = React.useMemo(() => {
    const TIER_ORDER = ["owner", "ceo", "cxo", "lead", "senior", "junior"];
    const depts = [], tiers = [], statuses = [], skillSet = new Set();
    for (const p of personas) {
      if (p.department && !depts.includes(p.department)) depts.push(p.department);
      const t = p.tier || p.level;
      if (t && !tiers.includes(t)) tiers.push(t);
      const s = p.status || "active";
      if (!statuses.includes(s)) statuses.push(s);
      for (const sk of (p.skills || [])) if (sk) skillSet.add(String(sk));
    }
    depts.sort((a, b) => a.localeCompare(b));
    tiers.sort((a, b) => {
      const ia = TIER_ORDER.indexOf(a), ib = TIER_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
    });
    statuses.sort((a, b) => a.localeCompare(b));
    // Typeahead list = union of all Core Skills (spec §"Browse & Filter").
    const skills = [...skillSet].sort((a, b) => a.localeCompare(b));
    return { depts, tiers, statuses, skills };
  }, [personas]);

  const filterActive = !!(fDepts.size || fTier || fSkill.trim() || fStatus || fSearch.trim() || fFreeCap);
  const clearFilters = () => { setFDepts(new Set()); setFTier(""); setFSkill(""); setFStatus(""); setFSearch(""); setFFreeCap(false); };
  const toggleDept = (d) => setFDepts(s => { const n = new Set(s); n.has(d) ? n.delete(d) : n.add(d); return n; });

  // Open-task load per persona id (owner_id == persona.id) — feeds the
  // free-capacity filter and the drawer's load meter. Terminal-status tasks
  // (done/tested/…) carry no load (crewsTaskOpen).
  const loadByPersona = React.useMemo(() => {
    const m = Object.create(null);
    for (const t of allTasks) {
      const oid = t && t.owner_id;
      if (!oid || !crewsTaskOpen(t)) continue;
      if (byId.has(oid)) m[oid] = (m[oid] || 0) + 1;
    }
    return m;
  }, [allTasks, byId]);

  // Personas matching the active filters (AND across categories).
  const matches = React.useMemo(() => {
    const skill = fSkill.trim().toLowerCase();
    const q = fSearch.trim().toLowerCase();
    const m = new Set();
    if (!filterActive) return m;
    for (const p of personas) {
      if (fDepts.size && !fDepts.has(p.department)) continue;
      if (fTier && (p.tier || p.level) !== fTier) continue;
      if (fStatus && (p.status || "active") !== fStatus) continue;
      if (skill && !((p.skills || []).some(s => String(s).toLowerCase().includes(skill)))) continue;
      if (q && !([p.title, p.id, p.role, p.department].some(v => String(v || "").toLowerCase().includes(q)))) continue;
      if (fFreeCap) {
        const cap = crewsCapacityFor(p);
        const load = loadByPersona[p.id] || 0;
        if (cap !== Infinity && load >= cap) continue; // no free capacity
      }
      m.add(p.id);
    }
    return m;
  }, [personas, fDepts, fTier, fStatus, fSkill, fSearch, fFreeCap, filterActive, loadByPersona]);

  // ── Assignment state (DnD + reasoned-reject + drag-hint). ──────────────────
  const eng = crewsEngine();
  const [dragActive, setDragActive] = React.useState(false);   // a task is being dragged
  const [dragTask, setDragTask] = React.useState(null);        // resolved dragged task obj
  const [dropTargetId, setDropTargetId] = React.useState(null);// the chip currently hovered
  const [reject, setReject] = React.useState(null);            // { id, copy } reasoned-reject chiplet
  const [shakeId, setShakeId] = React.useState(null);          // chip to shake-back on a denied drop

  // Cancelled/abandoned drags NEVER fire dragend on these surfaces (HTML5 fires
  // it on the drag SOURCE — e.g. a Khira board card), so dragActive/dragTask/
  // dropTargetId would leak and leave stuck skill-fit glows. Reset from
  // document-level dragend/drop as well.
  React.useEffect(() => {
    const resetDnD = () => { setDragActive(false); setDragTask(null); setDropTargetId(null); };
    document.addEventListener("dragend", resetDnD);
    document.addEventListener("drop", resetDnD);
    return () => {
      document.removeEventListener("dragend", resetDnD);
      document.removeEventListener("drop", resetDnD);
    };
  }, []);
  // Prefer the `agents` prop (app.jsx owns post-retire freshness); self-source
  // only when the prop is absent.
  const agentsLive = Array.isArray(agents) ? agents : crewsListAgents();

  // Pending-staffing: tasks whose owner_id resolves to THIS persona id (a
  // delegated, untriaged claim — status register). Computed off live tasks.
  // `pendingByPersona` = counts (chip); `pendingTasksByPersona` = task lists
  // (leader-triage inbox).
  const { pendingByPersona, pendingTasksByPersona } = React.useMemo(() => {
    const counts = Object.create(null);
    const lists = Object.create(null);
    if (!eng) return { pendingByPersona: counts, pendingTasksByPersona: lists };
    for (const t of allTasks) {
      const oid = t && t.owner_id;
      if (!oid || /^agent-/.test(String(oid))) continue;
      if (!crewsTaskOpen(t)) continue; // terminal-status claims are no longer actionable
      if (eng.index && byId.has(oid)) {
        counts[oid] = (counts[oid] || 0) + 1;
        (lists[oid] = lists[oid] || []).push(t);
      }
    }
    return { pendingByPersona: counts, pendingTasksByPersona: lists };
  }, [allTasks, byId, eng]);

  // Agent load (open task count) keyed by agent id — for the capacity meter.
  const loadByAgent = React.useMemo(() => {
    const m = Object.create(null);
    for (const t of allTasks) {
      const oid = t && t.owner_id;
      if (!oid || !crewsTaskOpen(t)) continue;
      if (/^agent-/.test(String(oid))) m[oid] = (m[oid] || 0) + 1;
    }
    return m;
  }, [allTasks]);

  // Resolve a dragged task id to its task object. DORMANT: no caller can
  // supply an id before drop (HTML5 protected mode — see crewsDraggedTaskId).
  // Retained intentionally for a future protocol where hover-time ids become
  // available (richer MIME payload or dragstart event).
  const resolveDragTask = (taskId) => {
    if (!taskId) return null;
    return allTasks.find((t) => t && t.id === taskId) || { id: taskId };
  };

  // ── THE SINGLE ASSIGNMENT CALL POINT. ──────────────────────────────────────
  // Routes through crewsGatedAssign (the ONE fail-closed gate shared with the
  // roster board), then writes owner_id (+ staffing_state for delegated)
  // through onAssignTask — the SAME draft write path the drawer uses
  // (onUpdate({ owner_id })). If onAssignTask is absent, the gate + chiplet UI
  // still run, but NO write occurs (draft-only; see REPORT). NEVER writes status.
  const assignTaskTo = (taskId, target) => {
    // target = { kind:'agent', agent } | { kind:'persona', persona }
    return crewsGatedAssign(taskId, target, {
      CA: eng ? eng.CA : null,
      index: eng ? eng.index : null,
      agents: agentsLive,
      onReject: (chipId, copy) => {
        setReject({ id: chipId, copy });
        setShakeId(chipId);
        setTimeout(() => setShakeId((s) => (s === chipId ? null : s)), 480);
        setTimeout(() => setReject((r) => (r && r.id === chipId ? null : r)), 2600);
      },
      onAccept: (tid, patch) => {
        setReject(null);
        // === SINGLE WRITE CALL POINT (draft path; mirrors drawer onUpdate). ===
        if (typeof onAssignTask === "function") onAssignTask(tid, patch);
      }
    });
  };

  // Generalized drop handlers — used by org chips (persona/delegated) and agent
  // mini-chips (agent/direct). They read the dragged TASK id and route to the
  // assignment gate; they NEVER touch status. status-column drops are owned by
  // the Khira board and never reach these Crews surfaces.
  const onChipDragEnter = (e, persona) => {
    // Chrome ONLY for genuine Khira task drags; ignore every other native drag
    // (text selection, image, link). getData stays unreadable until drop
    // (protected mode), so types-presence is the only reliable signal here.
    if (!crewsDragHasTask(e)) return;
    e.preventDefault();
    if (!dragActive) setDragActive(true);
    setDropTargetId(persona.id);
  };
  const onChipDragOver = (e) => { e.preventDefault(); try { e.dataTransfer.dropEffect = "link"; } catch (err) {} };
  const onChipDragLeave = (e, persona) => { setDropTargetId((d) => (d === persona.id ? null : d)); };
  const onChipDrop = (e, persona) => {
    e.preventDefault();
    e.stopPropagation();
    const tid = crewsDraggedTaskId(e);
    setDragActive(false); setDragTask(null); setDropTargetId(null);
    if (tid) assignTaskTo(tid, { kind: "persona", persona });
  };
  const onAgentDrop = (e, persona, agent) => {
    e.preventDefault();
    e.stopPropagation();
    const tid = crewsDraggedTaskId(e);
    setDragActive(false); setDragTask(null); setDropTargetId(null);
    if (tid) assignTaskTo(tid, { kind: "agent", agent });
  };

  const assignCtx = {
    eng, agentsLive, dragActive, dragTask, dropTargetId, reject, shakeId,
    pendingByPersona, pendingTasksByPersona, loadByAgent,
    onChipDragEnter, onChipDragOver, onChipDragLeave, onChipDrop, onAgentDrop,
    assignTaskTo, onRetireAgent, onReleaseAgent
  };

  React.useEffect(() => {
    if (!initedRef.current && personas.length) {
      setCollapsed(new Set(defaultCollapsed));
      setFocusId(rootId);
      initedRef.current = true;
    }
  }, [personas.length, rootId, defaultCollapsed]);

  React.useEffect(() => {
    if (!treeRef.current || !focusId) return;
    if (!treeRef.current.contains(document.activeElement)) return; // don't grab focus on mount
    const el = rowRefs.current[focusId];
    if (el) el.focus();
  }, [focusId]);

  // The rendered tree root: a focus-subtree isolate (if valid) re-roots here,
  // otherwise the whole org. Tolerates a stale isolateId (falls back to root).
  const subtreeRoot = (isolateId && byId.has(isolateId)) ? isolateId : rootId;

  // matchKeep = matches + their ancestor chains. While filtering we DIM (not
  // hide) non-matching nodes but force-expand the ancestor path to every match
  // so matches surface without losing tree context (spec §"Browse & Filter").
  const matchKeep = React.useMemo(() => {
    if (!filterActive) return null;
    const k = new Set();
    for (const id of matches) {
      let cur = byId.get(id);
      while (cur && !k.has(cur.id)) {
        k.add(cur.id);
        cur = cur.reports_to ? byId.get(cur.reports_to) : null;
      }
    }
    return k;
  }, [filterActive, matches, byId]);

  const toggle = (id) => setCollapsed(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const collapseAll = () => setCollapsed(new Set(personas.filter(p => (childrenOf.get(p.id) || []).length).map(p => p.id)));
  const expandAll = () => setCollapsed(new Set());

  const revealPath = (id) => setCollapsed(s => {
    const n = new Set(s);
    let cur = byId.get(id);
    while (cur && cur.reports_to) { n.delete(cur.reports_to); cur = byId.get(cur.reports_to); }
    return n;
  });
  // Focus-subtree: re-root the tree at a node (isolate a department/leader).
  const focusSubtree = (id) => { if (byId.has(id)) { setIsolateId(id); setSelId(id); setFocusId(id); } };
  const clearIsolate = () => setIsolateId(null);
  // navigate: if the target is outside the current isolate, drop the isolate so
  // the node is reachable, then reveal/select it.
  const navigateTo = (id) => {
    if (!byId.has(id)) return;
    if (isolateId && !isDescendantOf(id, isolateId)) setIsolateId(null);
    revealPath(id); setSelId(id); setFocusId(id);
  };

  // Is `id` within the subtree rooted at `ancestorId` (inclusive)?
  function isDescendantOf(id, ancestorId) {
    let cur = byId.get(id);
    while (cur) { if (cur.id === ancestorId) return true; cur = cur.reports_to ? byId.get(cur.reports_to) : null; }
    return false;
  }

  const visible = React.useMemo(() => {
    const out = [];
    const walk = (id, depth) => {
      if (!byId.has(id)) return;
      out.push({ id, depth });
      // Honor the user's collapsed set; while filtering, force-expand any node
      // on an ancestor path to a match so matches surface (others stay dimmed).
      const forced = matchKeep && matchKeep.has(id);
      const expanded = forced || !collapsed.has(id);
      if (expanded) for (const k of (childrenOf.get(id) || [])) walk(k, depth + 1);
    };
    if (subtreeRoot) walk(subtreeRoot, 0);
    return out;
  }, [byId, childrenOf, subtreeRoot, collapsed, matchKeep]);

  // Keep focus on a node that survives the current view (roving tabindex needs
  // a valid target so keyboard nav keeps working). NOTE: must live BELOW the
  // `visible` memo above — its dep array reads `visible` at render time (TDZ).
  React.useEffect(() => {
    if (!visible.length) return;
    if (!visible.some(n => n.id === focusId)) setFocusId(visible[0].id);
  }, [visible, focusId]);

  const onKeyDown = (e) => {
    if (!focusId) return;
    const idx = visible.findIndex(n => n.id === focusId);
    if (idx === -1) return;
    const kids = childrenOf.get(focusId) || [];
    const forced = matchKeep && matchKeep.has(focusId);
    if (e.key === "ArrowDown") { e.preventDefault(); setFocusId(visible[Math.min(idx + 1, visible.length - 1)].id); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setFocusId(visible[Math.max(idx - 1, 0)].id); }
    else if (e.key === "ArrowRight") { e.preventDefault(); if (kids.length) { if (!forced && collapsed.has(focusId)) toggle(focusId); else setFocusId(kids[0]); } }
    else if (e.key === "ArrowLeft") { e.preventDefault(); if (kids.length && !forced && !collapsed.has(focusId)) toggle(focusId); else { const par = (byId.get(focusId) || {}).reports_to; if (par && byId.has(par) && focusId !== subtreeRoot) setFocusId(par); } }
    else if (e.key === "Enter") { e.preventDefault(); setSelId(focusId); }
    else if (e.key === " ") { e.preventDefault(); if (kids.length) toggle(focusId); }
    else if (e.key === "Home") { e.preventDefault(); setFocusId(visible[0].id); }
    else if (e.key === "End") { e.preventDefault(); setFocusId(visible[visible.length - 1].id); }
  };

  const renderNode = (id, depth) => {
    const p = byId.get(id);
    if (!p) return null;
    const kids = childrenOf.get(id) || [];
    const hasKids = kids.length > 0;
    // While filtering, the path to matches is force-expanded; otherwise honor
    // the collapsed set.
    const forced = matchKeep && matchKeep.has(id);
    const isCollapsed = !forced && collapsed.has(id);
    // Dim (don't hide) non-matching nodes while a filter is active — keeps tree
    // context (spec §"Browse & Filter"). A direct match never dims.
    const isDimmed = filterActive && !matches.has(id);
    // seat-open personas render as dashed placeholder slots (spec §"Nodes").
    const isSeatOpen = (p.status || "") === "seat-open";

    // ── Assignment chrome (status register; advisory + reasoned-reject). ──
    const a = assignCtx;
    const cap = crewsCapacityFor(p);
    const pending = a.pendingByPersona[id] || 0;
    // Skill-fit advisory glow: DORMANT by design. Task identity is readable
    // only at drop (HTML5 protected mode), so dragTask is always null today
    // and fit computes 0 — the scaffolding below is kept intentionally.
    // Reviving it requires a protocol change (richer MIME payload or a
    // dragstart event). NOT missing infrastructure: the Khira producer exists
    // and works; only hover-time identity is unavailable.
    const fit = (a.dragActive && a.dragTask) ? crewsSkillFit(p.skills, a.dragTask) : 0;
    const isDropTarget = a.dragActive && a.dropTargetId === id;
    const isShaking = a.shakeId === id;
    const rej = (a.reject && a.reject.id === id) ? a.reject.copy : null;
    // A delegated drop is allowed unless the engine denies it; preview gate on hover.
    let dropDenied = false;
    if (isDropTarget && a.eng) {
      const r = a.eng.CA.delegationReason(CREWS_ASSIGN_ACTOR_ID, id, { index: a.eng.index, agents: a.agentsLive });
      dropDenied = !r.ok;
    }
    const chipCls = [
      "org-chip", "dept-reg",
      selId === id ? "sel" : "",
      isDimmed ? "org-dim" : "",
      isSeatOpen ? "org-seatopen" : "",
      isDropTarget ? (dropDenied ? "crews-drop-deny" : "crews-drop-ok") : "",
      fit > 0 ? "crews-skillfit" : "",
      isShaking ? "crews-shake" : ""
    ].filter(Boolean).join(" ");
    const canIsolate = hasKids && id !== subtreeRoot;

    return (
      <React.Fragment key={id}>
        <div className="org-row">
          <div className={chipCls}
               data-dept={p.department}
               data-skillfit={fit > 0 ? (fit >= 0.66 ? "strong" : fit >= 0.34 ? "mid" : "weak") : undefined}
               style={{ "--dept-hue": crewsDeptHue(p.department) }}
               role="treeitem"
               aria-level={depth + 1}
               aria-expanded={hasKids ? !isCollapsed : undefined}
               aria-selected={selId === id}
               tabIndex={focusId === id ? 0 : -1}
               ref={el => { rowRefs.current[id] = el; }}
               onClick={() => { setSelId(id); setFocusId(id); }}
               onDragEnter={(e) => a.onChipDragEnter(e, p)}
               onDragOver={a.onChipDragOver}
               onDragLeave={(e) => a.onChipDragLeave(e, p)}
               onDrop={(e) => a.onChipDrop(e, p)}>
            {/* Mouse-only affordances: keyboard users collapse with Space on
                the row itself (treeitem keydown). Removed from the a11y tree +
                tab order because role="treeitem" must not contain interactive
                descendants. Known tradeoff: isolate has no keyboard path yet
                (title tooltip remains for pointer users). */}
            {hasKids
              ? <button className={`org-chev${isCollapsed ? " collapsed" : ""}`}
                        aria-hidden="true"
                        tabIndex={-1}
                        title={isCollapsed ? "Expand" : "Collapse"}
                        onClick={(e) => { e.stopPropagation(); toggle(id); }}>▾</button>
              : <span className="org-chev-spacer" />}
            <div className={`org-av${p.kind === "human" ? " human" : ""}`}>{crewsInitials(p)}</div>
            <div className="org-nm">
              <div className="n">{p.title}</div>
              <div className="r">{p.department} · {p.level || p.role || p.tier}</div>
            </div>
            <span className="org-tierbadge">{CREWS_TIER_SHORT[p.tier] || (p.tier || "").toUpperCase() || "—"}</span>
            {isCollapsed && hasKids ? <span className="org-count">+{descCount(id)}</span> : null}
            {canIsolate ? (
              <button className="org-isolate" title={`Focus ${p.title}'s subtree`}
                      aria-hidden="true"
                      tabIndex={-1}
                      onClick={(e) => { e.stopPropagation(); focusSubtree(id); }}>⤢</button>
            ) : null}
            {pending > 0 ? (
              <span className="crews-pending-chip" title={`${pending} delegated task${pending === 1 ? "" : "s"} awaiting staffing`}>
                ▣ {pending} pending
              </span>
            ) : null}
            <CrewsStatusPill status={p.status} />
            {/* Capacity / parallelism hint (status register) while dragging over. */}
            {isDropTarget ? (
              <span className={`crews-cap-hint${dropDenied ? " deny" : ""}`}>
                {cap === Infinity ? "uncapped" : `${pending}/${cap} — room for ${Math.max(0, cap - pending)}`}
              </span>
            ) : null}
            {rej ? <span className="crews-reject-chip" role="alert">{rej}</span> : null}
          </div>
        </div>
        {hasKids && !isCollapsed ? (
          <div className="org-tree" role="group">{kids.map(k => renderNode(k, depth + 1))}</div>
        ) : null}
      </React.Fragment>
    );
  };

  if (!personas.length) {
    return (
      <div className="note-card" style={{ marginTop: 4 }}>
        This project has no persona index at <code>project-management/roles/crews-index.json</code>.
        Flat roles remain available in Stations and Roster Board.
      </div>
    );
  }

  const sel = selId ? byId.get(selId) : null;

  return (
    <div className="crews-orglayout">
      <div className="crews-orgpane">
        <div className="crews-filterbar dept-reg" role="search" aria-label="Filter crews">
          <div className="crews-filter-field crews-filter-depts">
            <span className="crews-filter-label">Department</span>
            <div className="crews-deptchips" role="group" aria-label="Filter by department (multi-select)">
              {facets.depts.map(d => (
                <button key={d} type="button"
                        className={`crews-deptchip dept-reg${fDepts.has(d) ? " on" : ""}`}
                        data-dept={d}
                        style={{ "--dept-hue": crewsDeptHue(d) }}
                        aria-pressed={fDepts.has(d)}
                        onClick={() => toggleDept(d)}>{d}</button>
              ))}
            </div>
          </div>
          <label className="crews-filter-field">
            <span className="crews-filter-label">Level / tier</span>
            <select className="crews-filter-select" value={fTier} onChange={(e) => setFTier(e.target.value)}>
              <option value="">All</option>
              {facets.tiers.map(t => <option key={t} value={t}>{CREWS_TIER_LABEL[t] || t}</option>)}
            </select>
          </label>
          <label className="crews-filter-field crews-filter-grow">
            <span className="crews-filter-label">Skill</span>
            <input className="crews-filter-input" type="text" value={fSkill}
                   list="crews-skill-options"
                   placeholder="find a skill…"
                   onChange={(e) => setFSkill(e.target.value)} />
            <datalist id="crews-skill-options">
              {facets.skills.map(s => <option key={s} value={s} />)}
            </datalist>
          </label>
          <label className="crews-filter-field crews-filter-grow">
            <span className="crews-filter-label">Search</span>
            <input className="crews-filter-input" type="text" value={fSearch}
                   placeholder="name, title, id…"
                   aria-label="Search by name, title, or id"
                   onChange={(e) => setFSearch(e.target.value)} />
          </label>
          <label className="crews-filter-field">
            <span className="crews-filter-label">Availability</span>
            <select className="crews-filter-select" value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
              <option value="">Any</option>
              {facets.statuses.map(s => <option key={s} value={s}>{s === "seat-open" ? "seat open" : s}</option>)}
            </select>
          </label>
          <label className="crews-filter-field crews-filter-toggle">
            <span className="crews-filter-label">Capacity</span>
            <button type="button" className={`crews-filter-chip${fFreeCap ? " on" : ""}`}
                    aria-pressed={fFreeCap} onClick={() => setFFreeCap(v => !v)}>
              Has free capacity
            </button>
          </label>
          {filterActive ? (
            <button type="button" className="crews-filter-clear" onClick={clearFilters}>Clear filters</button>
          ) : null}
        </div>
        <div className="crews-org-toolbar" style={{ marginTop: 0 }}>
          <button className="btn" onClick={collapseAll} disabled={filterActive}>Collapse all</button>
          <button className="btn" onClick={expandAll} disabled={filterActive}>Expand all</button>
          {isolateId && byId.has(isolateId) ? (
            <button className="btn crews-isolate-out" onClick={clearIsolate}>
              ↥ Focused on {(byId.get(isolateId) || {}).title} · show full tree
            </button>
          ) : null}
          <span className="spacer" />
          <span className="crews-org-count">
            {filterActive ? `${matches.size} of ${personas.length} matched (others dimmed)` : `${visible.length} of ${personas.length} shown`}
          </span>
        </div>
        <div className="org-tree" role="tree" aria-label="Crews authority chart" ref={treeRef} onKeyDown={onKeyDown}
             onDragEnd={() => { setDragActive(false); setDragTask(null); setDropTargetId(null); }}>
          {filterActive && matches.size === 0
            ? <div className="crews-filter-empty">No personas match these filters. <button type="button" className="crews-filter-clear" onClick={clearFilters}>Clear filters</button></div>
            : (subtreeRoot ? renderNode(subtreeRoot, 0) : null)}
        </div>
      </div>
      {sel ? (
        <CrewsPersonaDrawer
          p={sel}
          byId={byId}
          onClose={() => setSelId(null)}
          onNavigate={navigateTo}
          onOpenArtifact={onOpenArtifact}
          assignCtx={assignCtx}
          tasks={allTasks} />
      ) : null}
    </div>
  );
}

function CrewsAgentsSection({ p, assignCtx }) {
  const a = assignCtx || {};

  // The human owner (and any persona without a model_config) is not instanceable.
  const instanceable = !(p.tier === "owner" || p.kind === "human" || !p.model_config);

  // Refresh mechanism: bump re-derives the roster; reset on persona change.
  const [bump, setBump] = React.useState(0);
  React.useEffect(() => { setBump(0); }, [p.id]);

  // Prefer the live roster threaded down from app.jsx (post-retire fresh); fall
  // back to the local store read when the prop chain is absent. Store access is
  // guarded so the hook itself is safe to run even pre-script-load.
  const agents = React.useMemo(() => {
    try {
      const store = (typeof window !== "undefined" && window.CrewsAgents) || null;
      const roster = Array.isArray(a.agentsLive) ? a.agentsLive : (store && store.listAgents ? store.listAgents() : []);
      return roster.filter(x => x && x.persona_id === p.id);
    } catch (e) {
      return [];
    }
  }, [p.id, bump, a.agentsLive]); // eslint-disable-line react-hooks/exhaustive-deps

  // Engine guard — render nothing if the instancing engine isn't present.
  // Checked AFTER every hook above so the hook count can never vary across
  // renders (Rules of Hooks) even if script availability flips mid-session.
  if (typeof window === "undefined" || !window.CrewsAgents) return null;

  const refresh = () => setBump(b => b + 1);
  const hire = () => { window.CrewsAgents.createAgent(p.id); refresh(); };
  // Release (hard remove) and retire (status flip) funnel through the app.jsx
  // callbacks when present so app.jsx owns the roster-refresh; otherwise fall
  // back to the local store mutation + bump.
  const release = (id) => { a.onReleaseAgent ? a.onReleaseAgent(id) : (window.CrewsAgents.removeAgent(id), refresh()); };
  const retire = (id) => { a.onRetireAgent ? a.onRetireAgent(id) : (window.CrewsAgents.retireAgent(id), refresh()); };

  const cap = crewsCapacityFor(p);

  return (
    <div className="crews-drawer-sec">
      <h4>Agents ({agents.length})</h4>

      {agents.length ? (
        <div className="crews-agent-list">
          {agents.map(ag => {
            const amc = ag.model_config || {};
            const chipId = "agent:" + ag.id;
            const load = (a.loadByAgent && a.loadByAgent[ag.id]) || 0;
            const over = cap !== Infinity && load > cap;
            const isShaking = a.shakeId === chipId;
            const isRetired = ag.status === "retired";
            const rej = (a.reject && a.reject.id === chipId) ? a.reject.copy : null;
            return (
              <div key={ag.id}
                   className={`crews-agent-chip dept-reg${isShaking ? " crews-shake" : ""}${over ? " crews-overloaded" : ""}${isRetired ? " crews-retired" : ""}`}
                   data-dept={p.department}
                   style={{ "--dept-hue": crewsDeptHue(p.department), opacity: isRetired ? 0.55 : undefined }}
                   onDragOver={isRetired ? undefined : a.onChipDragOver}
                   onDrop={(!isRetired && a.onAgentDrop) ? (e) => a.onAgentDrop(e, p, ag) : undefined}
                   title={isRetired ? "Retired agent — reassign its tasks via drag" : "Drop a task here to assign directly to this agent"}>
                <div className="crews-agent-main">
                  <span className="crews-agent-name">{ag.name}</span>
                  <span className="crews-agent-model">
                    {amc.model || "—"}{amc.thinking_budget != null ? ` · think ${amc.thinking_budget}` : ""}
                  </span>
                </div>
                <span className={`crews-cap-meter${over ? " over" : (cap !== Infinity && load >= cap ? " at" : "")}`}
                      title={cap === Infinity ? "uncapped" : `${load}/${cap} — room for ${Math.max(0, cap - load)}`}>
                  {cap === Infinity ? "∞" : `${load}/${cap}`}
                </span>
                <CrewsStatusPill status={ag.status} />
                {!isRetired ? (
                  <button className="crews-agent-retire" aria-label={`Retire ${ag.name}`}
                          title="Retire agent (keep record, stop assigning)" onClick={() => retire(ag.id)}>Retire</button>
                ) : null}
                <button className="crews-agent-remove" aria-label={`Release ${ag.name}`}
                        title="Release agent (remove from roster)" onClick={() => release(ag.id)}>×</button>
                {rej ? <span className="crews-reject-chip" role="alert">{rej}</span> : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="crews-agent-empty">No agents yet — Hire to instance one.</div>
      )}

      {instanceable ? (
        <button type="button" className="crews-agent-hire dept-reg"
                data-dept={p.department}
                style={{ "--dept-hue": crewsDeptHue(p.department) }}
                onClick={hire}>+ Hire instance</button>
      ) : (
        <div className="crews-agent-note">Human operator — not instanceable.</div>
      )}

      <CrewsTriageSection p={p} agents={agents} assignCtx={assignCtx} onHired={hire} refresh={refresh} />
    </div>
  );
}

// ── Leader-triage (§2 leader-triage / §7.5). ───────────────────────────────
// The persona's leaderFor leader resolves a pending (delegated) task to a body:
//   (a) route to an EXISTING agent of this persona, or
//   (b) HIRE a new agent (window.CrewsAgents.createAgent) and route to it.
// Both paths are re-gated by the SAME engine (agentDelegationReason). Today the
// only assigner is the human owner, so the gate always passes — but the gate is
// wired so an agent assigner inherits it for free (AG-P7.12).
function CrewsTriageSection({ p, agents, assignCtx, onHired, refresh }) {
  const a = assignCtx || {};
  const eng = a.eng || crewsEngine();
  if (!eng) return null;

  // The leader who triages this persona (leaderFor; a lead is its own leader).
  const leaderId = eng.CA.leaderFor(p.id, eng.index);
  const leader = leaderId ? (eng.index.personas || []).find((x) => x.id === leaderId) : null;
  const liveAgents = (agents || []).filter((ag) => ag && ag.status !== "retired");

  // Pending (delegated, untriaged) tasks claiming THIS persona — the inbox.
  const pending = (a.pendingTasksByPersona && a.pendingTasksByPersona[p.id]) || [];

  if (!pending.length) {
    // Still surface the triage owner so the relationship is legible.
    return (
      <div className="crews-triage" data-empty="true">
        <div className="crews-triage-head">
          <span className="crews-triage-title">Triage inbox</span>
          {leader ? <span className="crews-triage-leader">routes via {leader.title || leader.id}</span> : null}
        </div>
        <div className="crews-triage-empty">No delegated tasks awaiting staffing.</div>
      </div>
    );
  }

  const routeToAgent = (taskId, ag) => { if (a.assignTaskTo) a.assignTaskTo(taskId, { kind: "agent", agent: ag }); };
  const hireAndRoute = (taskId) => {
    const rec = window.CrewsAgents.createAgent(p.id);
    if (onHired) onHired();
    if (rec) {
      // re-gate the freshly hired agent (same engine) and route.
      if (a.assignTaskTo) a.assignTaskTo(taskId, { kind: "agent", agent: rec });
    }
    if (refresh) refresh();
  };

  return (
    <div className="crews-triage">
      <div className="crews-triage-head">
        <span className="crews-triage-title">Triage inbox ({pending.length})</span>
        {leader ? <span className="crews-triage-leader">routes via {leader.title || leader.id}</span> : null}
      </div>
      {pending.map((t) => (
        <div key={t.id} className="crews-triage-row">
          <span className="crews-triage-task">{t.id}{t.title ? " · " + t.title : ""}</span>
          <div className="crews-triage-actions">
            {liveAgents.map((ag) => (
              <button key={ag.id} type="button" className="crews-triage-route"
                      onClick={() => routeToAgent(t.id, ag)}
                      title={`Route ${t.id} to ${ag.name}`}>→ {ag.name}</button>
            ))}
            <button type="button" className="crews-triage-hire dept-reg"
                    data-dept={p.department}
                    style={{ "--dept-hue": crewsDeptHue(p.department) }}
                    onClick={() => hireAndRoute(t.id)}
                    title="Hire a new agent of this persona and route the task to it">
              + Hire &amp; route
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function CrewsPersonaDrawer({ p, byId, onClose, onNavigate, onOpenArtifact, assignCtx, tasks }) {
  const mc = p.model_config;
  const auth = p.authority;
  // A11y: move focus to the Close button when the drawer opens, close on
  // Escape, and restore focus to the invoking node (the org chip that opened
  // the drawer) when it closes.
  const closeButtonRef = React.useRef(null);
  React.useEffect(() => {
    const prevFocus = document.activeElement;
    if (closeButtonRef.current) closeButtonRef.current.focus();
    const onDrawerKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onDrawerKey);
    return () => {
      document.removeEventListener("keydown", onDrawerKey);
      try { if (prevFocus && typeof prevFocus.focus === "function") prevFocus.focus(); } catch (err) {}
    };
  }, []); // mount/unmount scoped — onClose only clears selId (stable setter)
  // Live Khira tasks this persona owns (owner_id == persona.id). Empty until
  // assignment writes persona-id owners — spec §"Assigned tasks". The list is
  // FULL history (done/tested included) so the section stays truthful; only
  // OPEN tasks drive the capacity meter below (openLoad via crewsTaskOpen —
  // mirrors crews-usage.js CLOSED_STATUSES).
  const allTasks = Array.isArray(tasks) ? tasks : [];
  const assignedTasks = React.useMemo(
    () => allTasks.filter(t => t && t.owner_id === p.id),
    [allTasks, p.id]
  );
  // Load & engagement (spec §"Load & engagement"): OPEN assigned vs tier capacity.
  const cap = crewsCapacityFor(p);
  const openLoad = React.useMemo(
    () => assignedTasks.filter(crewsTaskOpen).length,
    [assignedTasks]
  );
  const load = openLoad;
  const free = cap === Infinity ? Infinity : Math.max(0, cap - load);
  const loadPct = cap === Infinity ? Math.min(100, load * 12) : (cap ? Math.min(100, Math.round((load / cap) * 100)) : 0);
  // Open the task in Khira via the artifact opener when present.
  const openTask = (id) => { if (typeof onOpenArtifact === "function") onOpenArtifact("task", id); };
  const NavChip = ({ id, dashed, glyph }) => {
    const t = byId.get(id);
    if (!t) return <span className="crews-skillchip">{id}</span>;
    return (
      <button className={`crews-navchip dept-reg${dashed ? " dashed" : ""}`}
              data-dept={t.department}
              style={{ "--dept-hue": crewsDeptHue(t.department) }}
              onClick={() => onNavigate(id)}>
        {glyph ? <span style={{ opacity: 0.7 }}>{glyph}</span> : null}{t.title}
      </button>
    );
  };
  return (
    <div className="crews-drawer dept-reg" data-dept={p.department} style={{ "--dept-hue": crewsDeptHue(p.department) }}>
      <div className="crews-drawer-head">
        <div className="crews-drawer-headrow">
          <div className={`org-av${p.kind === "human" ? " human" : ""}`} style={{ width: 44, height: 44, fontSize: 13 }}>{crewsInitials(p)}</div>
          <div style={{ minWidth: 0 }}>
            <div className="crews-drawer-name">{p.title}</div>
            <div className="crews-drawer-title">{p.department} · {p.level || p.role}</div>
          </div>
          <button className="crews-drawer-close" aria-label="Close" ref={closeButtonRef} onClick={onClose}>×</button>
        </div>
        <div className="crews-drawer-meta">{p.id} · {p.kind} · tier {CREWS_TIER_LABEL[p.tier] || p.tier || "—"}</div>
        <div style={{ marginTop: 8 }}><CrewsStatusPill status={p.status} /></div>
      </div>

      <div className="crews-drawer-body">
        <div className="crews-drawer-sec">
          <h4>Tier &amp; model</h4>
          {mc ? (
            <div className="crews-modelgrid">
              <span className="k">tier</span><span className="v">{CREWS_TIER_LABEL[p.tier] || p.tier}</span>
              <span className="k">model</span><span className="v">{mc.model}</span>
              <span className="k">thinking_budget</span><span className="v">{mc.thinking_budget}</span>
              <span className="k">temperature</span><span className="v">{mc.temperature}</span>
              <span className="k">max_output_tokens</span><span className="v">{mc.max_output_tokens == null ? "default" : mc.max_output_tokens}</span>
            </div>
          ) : (
            <div className="crews-authrow">Human operator — no model runs this node. Final authority and universal override.</div>
          )}
        </div>

        {auth ? (
          <div className="crews-drawer-sec">
            <h4>Authority scope</h4>
            <div className="crews-authrow"><b>May decide:</b> {auth.may_decide}</div>
            <div className="crews-authrow"><b>Escalates:</b> {auth.escalates}</div>
          </div>
        ) : null}

        <CrewsAgentsSection p={p} assignCtx={assignCtx} />

        {p.summary ? (
          <div className="crews-drawer-sec">
            <h4>Summary</h4>
            <div style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.5 }}>{p.summary}</div>
          </div>
        ) : null}

        {p.skills && p.skills.length ? (
          <div className="crews-drawer-sec">
            <h4>Core skills</h4>
            <div className="crews-chiprow">{p.skills.map((s, i) => <span key={i} className="crews-skillchip dept-reg" data-dept={p.department} style={{ "--dept-hue": crewsDeptHue(p.department) }}>{s}</span>)}</div>
          </div>
        ) : null}

        {p.responsibilities && p.responsibilities.length ? (
          <div className="crews-drawer-sec">
            <h4>Responsibilities</h4>
            <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.5 }}>
              {p.responsibilities.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          </div>
        ) : null}

        {p.reports_to ? (
          <div className="crews-drawer-sec">
            <h4>Reports to</h4>
            <div className="crews-chiprow"><NavChip id={p.reports_to} glyph="↑" /></div>
          </div>
        ) : null}

        {p.reportees && p.reportees.length ? (
          <div className="crews-drawer-sec">
            <h4>Reportees ({p.reportees.length})</h4>
            <div className="crews-chiprow">{p.reportees.map(id => <NavChip key={id} id={id} glyph="↓" />)}</div>
          </div>
        ) : null}

        {p.collaborates_with && p.collaborates_with.length ? (
          <div className="crews-drawer-sec">
            <h4>Collaborates with</h4>
            <div className="crews-chiprow">{p.collaborates_with.map(id => <NavChip key={id} id={id} dashed />)}</div>
          </div>
        ) : null}

        {p.permissions_ref ? (
          <div className="crews-drawer-sec">
            <h4>Permissions</h4>
            <span className="crews-skillchip" style={{ textTransform: "uppercase" }}>{p.permissions_ref}</span>
          </div>
        ) : null}

        <div className="crews-drawer-sec">
          <h4>Load &amp; engagement</h4>
          <div className="crews-loadmeter" title={cap === Infinity ? "uncapped" : `${load}/${cap} open · room for ${free}`}>
            <div className="crews-loadmeter-bar"><i style={{ width: loadPct + "%" }} className={load && cap !== Infinity && load >= cap ? "at" : ""} /></div>
            <div className="crews-loadmeter-nums">
              <strong>{load}</strong> open · {cap === Infinity ? "uncapped capacity" : <>capacity <strong>{cap}</strong> · room for <strong>{free}</strong></>}
            </div>
          </div>
        </div>

        <div className="crews-drawer-sec">
          <h4>Assigned tasks ({assignedTasks.length})</h4>
          {assignedTasks.length ? (
            <div className="crews-assigned-list">
              {assignedTasks.map(t => (
                <button key={t.id} type="button" className="crews-assigned-row"
                        onClick={() => openTask(t.id)} title={`Open ${t.id} in Khira`}>
                  <span className="crews-assigned-id">{t.id}</span>
                  {t.title ? <span className="crews-assigned-title">{t.title}</span> : null}
                  {t.status ? <span className={`crews-assigned-status st-${String(t.status).replace(/[^a-z0-9]+/gi, "-")}`}>{String(t.status).replace(/[-_]/g, " ")}</span> : null}
                </button>
              ))}
            </div>
          ) : (
            <div className="crews-assigned-empty">No Khira tasks assigned to this persona yet.</div>
          )}
        </div>

        <div className="crews-drawer-sec">
          <h4>Source</h4>
          <div className="crews-drawer-source">{crewsSourcePath(p)}</div>
        </div>
      </div>
    </div>
  );
}

function CrewCard({ r, isActive, onSwitch, onOpenArtifact, onNavigate }) {
  const myMsgs = AG.MESSAGES.filter(m => messageFromId(m) === r.id || messageToId(m) === r.id).slice(0, 3);
  const myVerdicts = AG.VERDICTS.filter(v => v.actor === r.id || v.awaiting === r.id);
  return (
    <article className="crew-card" style={{ "--rr-hue": r.hue, borderColor: isActive ? `oklch(70% 0.08 ${r.hue})` : "var(--border)" }}>
      <div className="crew-card-head">
        <RoleAvatar role={r} size="lg" showStatus />
        <div style={{ minWidth: 0 }}>
          <div className="crew-name">{r.name}</div>
          <div className="crew-title">{r.title} · <span style={{ fontFamily: "var(--font-mono)" }}>{r.id}</span></div>
        </div>
        <span className="crew-status">{(r.status || "").replace("-", " ")}</span>
      </div>

      <div className="crew-body">
        <div className="crew-desc">{r.description}</div>

        <div className="crew-stats">
          <div className="crew-stat">
            <div className="l">Owned tasks</div>
            <div className="v">{r.tasks}</div>
          </div>
          <div className="crew-stat">
            <div className="l">Pending</div>
            <div className="v" style={{ color: r.pending > 0 ? "oklch(58% 0.16 70)" : "var(--text)" }}>{r.pending}</div>
          </div>
          <div className="crew-stat">
            <div className="l">Verdicts</div>
            <div className="v">{myVerdicts.length}</div>
          </div>
        </div>

        <div>
          <h4 style={{ margin: "0 0 6px", fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--text-3)", fontWeight: 700 }}>
            Permissions
          </h4>
          <div className="crew-perms">
            {r.permissions.map(p => <span key={p} className="crew-perm" style={{ "--rr-hue": r.hue }}>{p}</span>)}
          </div>
        </div>

        {myMsgs.length > 0 && (
          <div>
            <h4 style={{ margin: "0 0 6px", fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--text-3)", fontWeight: 700 }}>
              Last on the wire
            </h4>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {myMsgs.map(m => {
                // Direction uses the SAME id normalization as the membership
                // filter above (messageFromId/messageToId) so the arrow and
                // emphasis can never contradict which messages are listed.
                const sent = messageFromId(m) === r.id;
                return (
                <button key={m.id}
                        onClick={() => onOpenArtifact("message", m.id)}
                        style={{
                          all: "unset",
                          cursor: "pointer",
                          fontSize: 12,
                          color: "var(--text-2)",
                          padding: "4px 0",
                          borderTop: "1px dashed var(--border)",
                          display: "flex", gap: 8, alignItems: "center",
                        }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-3)", whiteSpace: "nowrap" }}>{relTime(m.date)}</span>
                  <span style={{
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                    flex: 1, fontWeight: sent ? 600 : 400,
                    color: sent ? "var(--text)" : "var(--text-2)",
                  }}>
                    {sent ? "→ " : "← "}
                    {m.subject}
                  </span>
                </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className="crew-foot">
        <span>{r.lastSeen ? `Last updated ${relTime(r.lastSeen)}` : "No activity timestamp"}</span>
        <button onClick={onSwitch}
                disabled={isActive}
                style={{
                  marginLeft: "auto",
                  background: isActive ? "transparent" : `oklch(60% 0.16 ${r.hue})`,
                  color: isActive ? "var(--text-3)" : "oklch(99% 0 0)",
                  border: "1px solid " + (isActive ? "var(--border)" : `oklch(50% 0.16 ${r.hue})`),
                  borderRadius: 5,
                  padding: "4px 10px",
                  fontSize: 11,
                  fontWeight: 700,
                  fontFamily: "var(--font-mono)",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  cursor: isActive ? "default" : "pointer",
                }}>
          {isActive ? "On station" : "Switch"}
        </button>
      </div>
    </article>
  );
}

// ── Roster Board (AG-P7.10) ─────────────────────────────────────────────────
// A staffing board whose COLUMNS are the live (non-retired) agents on the
// CrewsAgents roster. Each column lists the tasks that agent owns
// (owner_id === agent.id) and accepts task drops to reassign directly to that
// agent. Reassignment ALWAYS routes through crewsGatedAssign → onAssignTask:
// owner_id-ONLY patches that CLEAR any stale staffing_state (send null) on
// agent drops (persona drops mark pending-staffing) — NEVER touches status.
// Retire / release per column funnel through onRetireAgent / onReleaseAgent so
// app.jsx owns roster-refresh freshness; the board re-renders from the prop.
function CrewsRosterBoard({ crews, tasks, agents, onAssignTask, onRetireAgent, onReleaseAgent }) {
  const allTasks = Array.isArray(tasks) ? tasks : [];
  // Fallback freshness: when app.jsx callbacks are absent we mutate the
  // CrewsAgents store directly and bump to re-derive the roster (mirrors the
  // drawer's refresh pattern). Memoized so liveAgents identity is stable.
  const [bump, setBump] = React.useState(0);
  const roster = React.useMemo(
    () => (Array.isArray(agents) ? agents : crewsListAgents()),
    [agents, bump]
  );
  const liveAgents = React.useMemo(
    () => roster.filter(a => a && a.status !== "retired"),
    [roster]
  );
  const index = (typeof AG !== "undefined" && AG.CREWS) || null;
  const personas = (crews && crews.personas) || [];
  const personaById = React.useMemo(() => {
    const m = Object.create(null);
    for (const p of personas) if (p && p.id) m[p.id] = p;
    return m;
  }, [personas]);

  const [dropAgentId, setDropAgentId] = React.useState(null);
  const [reject, setReject] = React.useState(null); // { id, copy }

  // Cancelled/abandoned drags never fire dragend on this surface (HTML5 fires
  // it on the drag SOURCE), so dropAgentId would leak and leave a column stuck
  // highlighted (.crews-drop-ok). Reset from document-level events too.
  React.useEffect(() => {
    const resetDrop = () => setDropAgentId(null);
    document.addEventListener("dragend", resetDrop);
    document.addEventListener("drop", resetDrop);
    return () => {
      document.removeEventListener("dragend", resetDrop);
      document.removeEventListener("drop", resetDrop);
    };
  }, []);

  // Tasks an agent owns directly (owner_id === agent.id) — OPEN only, so the
  // column meters reflect live work (crewsTaskOpen).
  const tasksByAgent = React.useMemo(() => {
    const m = Object.create(null);
    for (const t of allTasks) {
      const oid = t && t.owner_id;
      if (!oid || !crewsTaskOpen(t)) continue;
      (m[oid] = m[oid] || []).push(t);
    }
    return m;
  }, [allTasks]);

  // Tasks pointing at an agent id that is no longer live (released or retired)
  // — surfaced as an "orphaned / reassign" lane so they are never lost.
  // Open-only: terminal-status orphans need no reassignment.
  const orphanTasks = React.useMemo(() => {
    const liveIds = new Set(liveAgents.map(a => a.id));
    const out = [];
    for (const t of allTasks) {
      const oid = t && t.owner_id;
      if (!oid || !/^agent-/.test(String(oid))) continue; // personas live in Org Chart
      if (!crewsTaskOpen(t)) continue;
      if (!liveIds.has(oid)) out.push(t);
    }
    return out;
  }, [allTasks, liveAgents]);

  // Single gated write point for agent drops — routes through crewsGatedAssign,
  // the SAME fail-closed gate as CrewsOrgChart.assignTaskTo. If the engine or
  // index is missing the drop is REFUSED with a reasoned-reject chiplet; it is
  // never written ungated. Writes owner_id (+ clears stale staffing_state) only.
  const assignToAgent = (taskId, agent) => {
    if (!taskId || !agent) return;
    crewsGatedAssign(taskId, { kind: "agent", agent }, {
      CA: (typeof window !== "undefined" && window.CrewsAssign) || null,
      index,
      agents: roster,
      onReject: (chipId, copy) => {
        setReject({ id: chipId, copy });
        setTimeout(() => setReject(r => (r && r.id === chipId ? null : r)), 2600);
      },
      onAccept: (tid, patch) => {
        setReject(null);
        if (typeof onAssignTask === "function") onAssignTask(tid, patch);
      }
    });
  };

  const onColDrop = (e, agent) => {
    e.preventDefault();
    e.stopPropagation();
    const tid = crewsDraggedTaskId(e);
    setDropAgentId(null);
    if (tid) assignToAgent(tid, agent);
  };

  const retire = (id) => {
    if (onRetireAgent) onRetireAgent(id);
    else if (window.CrewsAgents && window.CrewsAgents.retireAgent) { window.CrewsAgents.retireAgent(id); setBump(b => b + 1); }
  };
  const release = (id) => {
    if (onReleaseAgent) onReleaseAgent(id);
    else if (window.CrewsAgents && window.CrewsAgents.removeAgent) { window.CrewsAgents.removeAgent(id); setBump(b => b + 1); }
  };

  if (!liveAgents.length) {
    return (
      <div className="note-card" style={{ marginTop: 4 }}>
        No agents hired yet — visit a persona in Org Chart and hire instances.
      </div>
    );
  }

  return (
    <div className="crews-roster-board" role="list" aria-label="Roster board — agents and their tasks">
      {liveAgents.map(ag => {
        const persona = ag.persona_id ? personaById[ag.persona_id] : null;
        const dept = persona ? persona.department : undefined;
        const cap = crewsCapacityFor(persona || {});
        const owned = tasksByAgent[ag.id] || [];
        const load = owned.length;
        const over = cap !== Infinity && load > cap;
        const isDrop = dropAgentId === ag.id;
        const chipId = "agent:" + ag.id;
        const rej = (reject && reject.id === chipId) ? reject.copy : null;
        return (
          <section key={ag.id} role="listitem"
                   className={`crews-roster-col dept-reg${isDrop ? " crews-drop-ok" : ""}${over ? " crews-overloaded" : ""}`}
                   data-dept={dept}
                   style={dept ? { "--dept-hue": crewsDeptHue(dept) } : undefined}
                   onDragEnter={(e) => { if (!crewsDragHasTask(e)) return; e.preventDefault(); setDropAgentId(ag.id); }}
                   onDragOver={(e) => { e.preventDefault(); try { e.dataTransfer.dropEffect = "link"; } catch (err) {} }}
                   onDragLeave={() => setDropAgentId(d => (d === ag.id ? null : d))}
                   onDrop={(e) => onColDrop(e, ag)}>
            <header className="crews-roster-colhead">
              <div className="crews-roster-coltitle">
                <span className="crews-roster-agentname">{ag.name}</span>
                <span className="crews-roster-personatitle">{persona ? (persona.title || persona.id) : "unmapped persona"}</span>
              </div>
              <span className={`crews-cap-meter${over ? " over" : (cap !== Infinity && load >= cap ? " at" : "")}`}
                    title={cap === Infinity ? "uncapped" : `${load}/${cap} — room for ${Math.max(0, cap - load)}`}>
                {cap === Infinity ? `${load}/∞` : `${load}/${cap}`}
              </span>
              <div className="crews-roster-colactions">
                <button type="button" className="crews-agent-retire" title="Retire agent (keep record, stop assigning)"
                        onClick={() => retire(ag.id)}>Retire</button>
                <button type="button" className="crews-agent-remove" aria-label={`Release ${ag.name}`}
                        title="Release agent (remove from roster)" onClick={() => release(ag.id)}>×</button>
              </div>
              {rej ? <span className="crews-reject-chip" role="alert">{rej}</span> : null}
            </header>
            <div className="crews-roster-colbody">
              {owned.length ? owned.map(t => (
                <div key={t.id} className="crews-roster-task" title={t.title || t.id}>
                  <span className="crews-roster-taskid">{t.id}</span>
                  {t.title ? <span className="crews-roster-tasktitle">{t.title}</span> : null}
                </div>
              )) : (
                <div className="crews-roster-empty">Drop a task here to assign it to {ag.name}.</div>
              )}
            </div>
          </section>
        );
      })}

      {orphanTasks.length ? (
        <section role="listitem" className="crews-roster-col crews-roster-orphans">
          <header className="crews-roster-colhead">
            <div className="crews-roster-coltitle">
              <span className="crews-roster-agentname">Needs reassignment</span>
              <span className="crews-roster-personatitle">owner retired or released</span>
            </div>
          </header>
          <div className="crews-roster-colbody">
            {orphanTasks.map(t => (
              <div key={t.id} className="crews-roster-task crews-roster-orphan" title={`${t.title || t.id} — drag onto a live agent column to reassign`}>
                <span className="crews-roster-taskid">{t.id}</span>
                {t.title ? <span className="crews-roster-tasktitle">{t.title}</span> : null}
                <span className="crews-roster-orphanowner">↦ {t.owner_id}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

window.CrewsView = CrewsView;
