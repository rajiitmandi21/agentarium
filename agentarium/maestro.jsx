// Agentarium — Maestro (orchestration pane: conduct & run the crew live)
//
// AG-P11.1 — SHELL ONLY. Maestro is the verb that completes the pipeline
//   Crews (who exists) → Atelier (compose a crew member) → Maestro (deploy,
//   conduct & run the crew live). The human is the conductor; the AI agents are
//   the performers. This file stands up the tab/route, the conduct-model empty
//   state, source-mode awareness (live conduct needs the API write server; local
//   snapshot degrades read-only), and a READ-ONLY crew preview of the crew it
//   WOULD conduct.
//
// AG-P11.2 — DISPATCH & CONDUCT CONSOLE (this slice). The conduct surface mounts
//   INTO the shell: pick a crew subtree or individual agents (performers), attach
//   one or more Khira tasks, AUTHORITY-GATE the dispatch by REUSING crews-assign
//   delegationReason (no new gating rule), PREVIEW the handler chain / model tier
//   / reviewer / owner-gate by REUSING the dispatch resolver (resolveHandler), and
//   dispatch a RUN only on a DELIBERATE operator gesture (no auto-run). The run is
//   handed to a NARROW runtime seam (window.MaestroRuntime?.dispatch) — the runtime
//   itself is AG-P11.3; absent a seam the run is STAGED ("runtime lands in AG-P11.3").
//   NO execution / lifecycle / records here — strictly select → gate → preview →
//   stage. Engines are consumed READ-ONLY; nothing is mutated, no model is called.

// Maestro hue (cyan/teal) — adjacent to Crews (150) in the pipeline but its own
// register. Soft tints only (persona register), consistent with AG-P14.4.
const MAESTRO_HUE = 175;

// ── Source-mode / write-capability signal (read-only). ─────────────────────
// Live conduct requires the P8 write server (api-workspace + writeEnabled). We
// read the cached api-health probe off window.projects WITHOUT triggering a
// dispatch or write. Two conditions must BOTH hold, per the plan's source-mode
// gate (§2/§3.7): (a) the operator has DELIBERATELY selected an API/hybrid
// write lane — the local snapshot lane always degrades read-only even if a
// write server happens to be reachable — and (b) that server reports
// writeEnabled. "local" is never live; that is the opt-in invariant.
function maestroWriteState(sourceMode) {
  const lane = sourceMode || "local";
  // Only the api / hybrid lanes are write-capable; local is snapshot-only.
  const laneAllowsWrite = lane === "api" || lane === "hybrid";

  let health = null;
  try {
    if (window.projects && typeof window.projects.getApiSourceState === "function") {
      health = window.projects.getApiSourceState();
    }
  } catch (e) { health = null; }
  let active = false;
  try {
    if (window.projects && typeof window.projects.isApiWorkspaceActive === "function") {
      active = !!window.projects.isApiWorkspaceActive();
    }
  } catch (e) { active = false; }

  const serverWritable = !!(active || (health && health.ok && health.writeEnabled));
  const writeEnabled = laneAllowsWrite && serverWritable;
  return {
    writeEnabled,
    serverWritable,           // a write server is reachable (informational)
    laneAllowsWrite,          // the selected lane permits writes
    sourceMode: lane,
    apiOk: !!(health && health.ok),
    version: (health && health.version) || null,
  };
}

// Read the live crew (read-only) — the crew Maestro WOULD conduct.
function maestroCrews() {
  const crews = (typeof AG !== "undefined" && AG.CREWS)
    || (window.AG && window.AG.CREWS)
    || { count: 0, personas: [], root: null };
  return crews;
}

// Read the agent roster (AG-P7.10) read-only — the named performers a run would
// draw from. Guarded; empty when the store isn't present.
function maestroAgents() {
  try {
    return (window.CrewsAgents && window.CrewsAgents.listAgents)
      ? (window.CrewsAgents.listAgents() || [])
      : [];
  } catch (e) { return []; }
}

// Is the dispatch resolver / authority engine present? (read-only capability
// probe for the preview.)
function maestroEngineReady() {
  return !!(window.CrewsAssign && typeof window.CrewsAssign.delegationReason === "function");
}

// ── Conduct-console engine access (AG-P11.2). ───────────────────────────────
// All READ-ONLY. The authority engine (crews-assign) and the dispatch resolver
// (window.CrewsResolver — attached by the SAME isomorphic
// scripts/crews-dispatch-resolver.js that node require()s, loaded directly in
// index.html; no browser mirror) are consumed, never modified.
function maestroAuthEngine() {
  return (typeof window !== "undefined" && window.CrewsAssign) || null;
}
function maestroResolver() {
  return (typeof window !== "undefined" && window.CrewsResolver) || null;
}

// The acting persona is the ACTOR for the authority gate. The operator conducts
// AS a persona; owner override = the human owner (executive-owner). We map the
// Crews flat-role actor (actingAs) to its persona id via crews-assign's
// resolveOwnerId so e.g. acting-as 'sdp' resolves to executive-cpo. Default to
// the owner only when nothing resolves (universal override is the conductor's).
const MAESTRO_OWNER_PERSONA = "executive-owner";
function maestroActorPersonaId(actingAs, crews, agents) {
  const CA = maestroAuthEngine();
  if (!CA || typeof CA.resolveOwnerId !== "function") return MAESTRO_OWNER_PERSONA;
  try {
    const r = CA.resolveOwnerId(actingAs, crews || null, agents || []);
    return (r && r.personaId) || MAESTRO_OWNER_PERSONA;
  } catch (e) { return MAESTRO_OWNER_PERSONA; }
}

// reason → reasoned-reject chiplet copy. The REAL delegationReason vocabulary
// (out-of-subtree / junior-cannot-assign / retired / seat-open / unknown-target),
// mirroring the Crews reject copy register so the operator reads the same words.
const MAESTRO_REJECT_COPY = {
  "out-of-subtree": "authority denied — not in your chain",
  "junior-cannot-assign": "juniors can't conduct a dispatch",
  "retired": "retired — cannot dispatch to",
  "seat-open": "seat-open — staff it first",
  "unknown-target": "unknown target — not in the crew",
  "unknown-agent": "unknown agent — not on the roster",
  "unknown-actor": "authority denied — unknown conductor"
};
function maestroRejectCopy(reason) {
  return MAESTRO_REJECT_COPY[reason] || "dispatch blocked here";
}

// Infer a task's dispatch contract when it is not authored on the task. No task
// in this repo carries required_authority / owner_gate / domain (verified), so the
// console shows INFERRED DEFAULTS per the runtime-spike data contract: senior
// authority, owner_gate from the resolver's heuristic (off by default here — the
// resolver treats missing owner_gate as false), and domain inferred from the
// task owner's department via crews-assign resolveOwnerId. These are clearly
// labelled "inferred" in the UI; the task data is never rewritten.
function maestroTaskContract(task, crews, agents) {
  const authored = {
    required_authority: task && task.required_authority != null ? task.required_authority : null,
    owner_gate: task && task.owner_gate != null ? task.owner_gate : null,
    domain: task && task.domain != null ? task.domain : null,
  };
  let domain = authored.domain;
  if (!domain) {
    const CA = maestroAuthEngine();
    if (CA && typeof CA.resolveOwnerId === "function" && task && task.owner_id) {
      try {
        const r = CA.resolveOwnerId(task.owner_id, crews || null, agents || []);
        if (r && r.persona && r.persona.department) domain = r.persona.department;
      } catch (e) { /* honest fallback: domain-agnostic */ }
    }
  }
  return {
    required_authority: authored.required_authority || "senior",
    owner_gate: authored.owner_gate === true,
    domain: domain || null,
    authored,
  };
}

// Map a persona tier to its model tier label for the preview. Crews personas
// carry model_config; when absent we fall back to a tier→model-class default
// (representational only — Maestro never makes a model call here).
const MAESTRO_TIER_MODEL = {
  owner: "operator (human)",
  ceo: "frontier", cxo: "frontier",
  lead: "frontier", senior: "balanced", junior: "fast",
};
function maestroModelTierFor(persona) {
  if (persona && persona.model_config && typeof persona.model_config === "object") {
    const mc = persona.model_config;
    return mc.model || mc.tier || mc.provider || MAESTRO_TIER_MODEL[persona.tier] || "balanced";
  }
  return (persona && MAESTRO_TIER_MODEL[persona.tier]) || "balanced";
}

// Department hue register (mirror of the Crews soft-tint register) so the crew
// preview chips read in the same persona register.
const MAESTRO_DEPT_HUE = { executive: 285, tech: 255, product: 330, data: 190, ai: 45, it: 125 };
function maestroDeptHue(d) { return MAESTRO_DEPT_HUE[d] != null ? MAESTRO_DEPT_HUE[d] : 255; }

const MAESTRO_TIER_RANK = { owner: 0, ceo: 1, cxo: 2, lead: 3, senior: 4, junior: 5 };
function maestroTierRank(t) { const r = MAESTRO_TIER_RANK[t === "leader" ? "lead" : t]; return r == null ? 9 : r; }

// ── The runtime seam (AG-P11.2 → AG-P11.3). ─────────────────────────────────
// A NARROW, read-only handoff: the validated run object is handed to
// window.MaestroRuntime.dispatch(run) if the runtime is present. The runtime
// itself (lifecycle / adapter / execution) is AG-P11.3 and NOT built here — so
// when the seam is absent the run is STAGED and we report "runtime lands in
// AG-P11.3". This NEVER auto-runs and NEVER writes a record (records = AG-P11.5).
function maestroRuntimeSeam() {
  const rt = (typeof window !== "undefined" && window.MaestroRuntime) || null;
  return (rt && typeof rt.dispatch === "function") ? rt : null;
}

// ── The conduct console (AG-P11.2). Mounts INTO the shell below the empty-state.
// Pure compose: select performers → attach Khira tasks → authority-gate via
// delegationReason → preview via resolveHandler → dispatch on a deliberate gesture.
function MaestroConsole({ actingAs, crews, personas, agents, tasks, write, onOpenArtifact }) {
  const CA = maestroAuthEngine();
  const RES = maestroResolver();
  const tree = React.useMemo(() => (RES ? RES.buildTree(crews) : null), [RES, crews]);

  const livePersonas = React.useMemo(
    () => personas.filter(p => p && (p.status || "active") === "active"), [personas]);
  const liveAgents = React.useMemo(
    () => (agents || []).filter(a => a && a.status !== "retired"), [agents]);
  const allTasks = React.useMemo(() => (tasks || []).filter(t => t && t.id), [tasks]);

  // The conductor (actor) for the authority gate — the acting persona; owner
  // override available because the human conducts. Resolved read-only.
  const actorId = React.useMemo(
    () => maestroActorPersonaId(actingAs, crews, agents), [actingAs, crews, agents]);
  const actorPersona = (tree && tree.byId && tree.byId.get(actorId)) || null;

  // ── Selection state. Performers = crew-subtree lead(s) and/or named agents.
  const [performerIds, setPerformerIds] = React.useState([]); // persona ids (subtree heads)
  const [agentIds, setAgentIds] = React.useState([]);         // agent ids
  const [taskIds, setTaskIds] = React.useState([]);           // attached Khira task ids
  const [staged, setStaged] = React.useState(null);           // last staged/dispatched run

  const ctx = React.useMemo(() => ({ index: crews || null, agents: liveAgents }), [crews, liveAgents]);

  // Crew subtree options: the in-domain LEAD personas (the heads an operator
  // would send a crew from). One per (department, lead). Stable, read-only.
  const crewLeads = React.useMemo(() => {
    const leads = livePersonas.filter(p => (p.tier === "lead" || p.level === "lead"));
    return leads.sort((a, b) =>
      String(a.department).localeCompare(String(b.department)) ||
      String(a.title).localeCompare(String(b.title)));
  }, [livePersonas]);

  const togglePerformer = (id) =>
    setPerformerIds(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  const toggleAgent = (id) =>
    setAgentIds(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  const toggleTask = (id) =>
    setTaskIds(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);

  // ── Per-task authority gate + resolver preview. The CORE of the console.
  // For each attached task: (1) infer its contract, (2) gate the dispatch with
  // delegationReason(actor → target) using the FIRST selected performer/agent as
  // the delegated target (the run's lead performer), (3) preview the would-be
  // handler chain via resolveHandler. All read-only.
  const targetForGate = React.useMemo(() => {
    // The gate confirms the conductor may delegate the work DOWN to the chosen
    // performer. Prefer a selected agent (concrete body), else a selected crew lead.
    if (agentIds.length) {
      const a = liveAgents.find(x => x.id === agentIds[0]);
      return a ? { kind: "agent", agent: a, id: a.id, label: a.name || a.id } : null;
    }
    if (performerIds.length) {
      const p = (tree && tree.byId && tree.byId.get(performerIds[0])) || null;
      return p ? { kind: "persona", persona: p, id: p.id, label: p.title || p.id } : null;
    }
    return null;
  }, [agentIds, performerIds, liveAgents, tree]);

  const rows = React.useMemo(() => {
    if (!CA) return [];
    return taskIds.map(tid => {
      const task = allTasks.find(t => t.id === tid) || { id: tid };
      const contract = maestroTaskContract(task, crews, agents);
      // ── (3) AUTHORITY GATE — reuse crews-assign delegationReason. ──
      let gate = { ok: false, reason: "unknown-target" };
      if (targetForGate) {
        if (targetForGate.kind === "agent" && typeof CA.agentDelegationReason === "function") {
          gate = CA.agentDelegationReason(actorId, targetForGate.agent, ctx);
        } else {
          gate = CA.delegationReason(actorId, targetForGate.id, ctx);
        }
      } else {
        gate = { ok: false, reason: "unknown-target" }; // no performer selected yet
      }
      // ── (4) DISPATCH PREVIEW — reuse the resolver resolveHandler. ──
      let preview = null;
      if (RES && tree) {
        try {
          const r = RES.resolveHandler({
            id: task.id,
            required_authority: contract.required_authority,
            owner_gate: contract.owner_gate,
            domain: contract.domain,
          }, tree);
          const chain = (r.path || []).map(pid => tree.byId.get(pid)).filter(Boolean);
          const handler = chain.length ? chain[chain.length - 1] : null; // execution bottom
          // Reviewer = the handler's leader when resolvable; fall back to the
          // chain head — never leave the reviewer undefined just because
          // leaderFor returned nothing.
          const lid = (CA && typeof CA.leaderFor === "function" && handler)
            ? CA.leaderFor(handler.id, crews) : null;
          const reviewer = (lid && tree.byId.get(lid)) || chain[0] || null;
          preview = {
            chain, handler, reviewer,
            decidingTier: r.decidingTier,
            ownerTouched: r.ownerTouched,
            modelTier: maestroModelTierFor(handler),
          };
        } catch (e) { preview = null; }
      }
      return { task, contract, gate, preview };
    });
  }, [taskIds, allTasks, CA, RES, tree, targetForGate, actorId, ctx, crews, agents]);

  const blockedRows = rows.filter(r => !r.gate.ok);
  const okRows = rows.filter(r => r.gate.ok);
  const performerCount = performerIds.length + agentIds.length;
  // Dispatch is allowed ONLY when: a performer is chosen, ≥1 task attached, EVERY
  // attached task passes the authority gate, and live conduct is enabled. A single
  // blocked task blocks the whole run (no partial dispatch past a denied gate).
  const canDispatch = performerCount > 0 && rows.length > 0 && blockedRows.length === 0 && write.writeEnabled;
  // Why the deliberate gesture is unavailable (so the operator knows what to fix).
  const dispatchHint =
    performerCount === 0 ? "Select a performer (a crew lead or a named agent) first."
    : rows.length === 0 ? "Attach at least one Khira task to dispatch."
    : blockedRows.length > 0 ? `${blockedRows.length} task${blockedRows.length === 1 ? "" : "s"} blocked by the authority gate — resolve before dispatching.`
    : !write.writeEnabled ? "Read-only source — connect the API workspace to raise the baton."
    : null;

  // ── (5) EXPLICIT CONDUCT ACTION. Assemble a VALIDATED run object and hand it
  // to the runtime seam. NO auto-run: this only fires on a deliberate click. If
  // the seam is absent the run is STAGED with an honest "runtime lands in AG-P11.3".
  const dispatchRun = () => {
    if (!canDispatch) return;
    const run = {
      // a client-side staging id (NOT a persisted record — records are AG-P11.5)
      staged_at: new Date().toISOString(),
      conductor: actorId,
      acting_as: actingAs,
      performers: {
        personas: performerIds.slice(),
        agents: agentIds.slice(),
      },
      tasks: okRows.map(r => ({
        id: r.task.id,
        owner_id: r.task.owner_id || null,
        contract: {
          required_authority: r.contract.required_authority,
          owner_gate: r.contract.owner_gate,
          domain: r.contract.domain,
          inferred: !(r.contract.authored.required_authority || r.contract.authored.owner_gate != null),
        },
        gate: r.gate,
        preview: r.preview ? {
          handler: r.preview.handler ? r.preview.handler.id : null,
          chain: r.preview.chain.map(p => p.id),
          reviewer: r.preview.reviewer ? r.preview.reviewer.id : null,
          model_tier: r.preview.modelTier,
          owner_gated: r.preview.ownerTouched,
        } : null,
      })),
      // explicit human-in-the-loop provenance: this run exists because the
      // operator clicked Dispatch, not because anything auto-ran.
      via: "maestro-conduct-console",
      gesture: "operator-dispatch-click",
    };
    const seam = maestroRuntimeSeam();
    if (seam) {
      let res = null;
      try { res = seam.dispatch(run); } catch (e) { res = { error: String(e && e.message || e) }; }
      // handed means the runtime ACCEPTED the run (a runId came back). A throw
      // is a FAILED handoff and must render as a failure, never as a success.
      setStaged({ run, handed: !!(res && res.runId), failed: !!(res && res.error), result: res });
    } else {
      setStaged({ run, handed: false, failed: false, result: null }); // staged; runtime lands in AG-P11.3
    }
  };

  const clearRun = () => { setPerformerIds([]); setAgentIds([]); setTaskIds([]); setStaged(null); };

  // The runtime's live run-state readout (AG-P11.3), bound to a capitalized local
  // so JSX renders it as a component. Absent until maestro-runtime.jsx loads.
  const RunPanel = (typeof window !== "undefined" && typeof window.MaestroRunPanel === "function")
    ? window.MaestroRunPanel : null;

  return (
    <section className="maestro-console" style={{ "--maestro-hue": MAESTRO_HUE }} aria-label="Dispatch & conduct console">
      <div className="maestro-console-head">
        <h3>Conduct console</h3>
        <span className="maestro-console-actor">
          Conducting as <strong>{actorPersona ? actorPersona.title : actingAs}</strong>
          {actorId === MAESTRO_OWNER_PERSONA ? <span className="maestro-tag owner">owner override</span> : null}
        </span>
      </div>

      <div className="maestro-console-grid">
        {/* ── 1) Crew / agent selector. ── */}
        <div className="maestro-panel">
          <div className="maestro-panel-head">
            <span className="maestro-panel-no">1</span> Performers
            <span className="maestro-panel-sub">{performerCount} selected</span>
          </div>
          <div className="maestro-panel-lab">Crew subtree (send a lead's crew)</div>
          <div className="maestro-pickrow">
            {crewLeads.length ? crewLeads.map(p => (
              <button key={p.id} type="button"
                className={`maestro-pick dept-reg${performerIds.includes(p.id) ? " is-on" : ""}`}
                data-dept={p.department}
                style={{ "--dept-hue": maestroDeptHue(p.department) }}
                onClick={() => togglePerformer(p.id)}
                title={`${p.title} — ${p.department} · ${p.tier}`}>
                <span className="maestro-pick-name">{p.title}</span>
                <span className="maestro-pick-meta">{p.department} · {p.tier}</span>
              </button>
            )) : <span className="maestro-panel-empty">No crew leads in the roster.</span>}
          </div>
          <div className="maestro-panel-lab">Named agents (AG-P7.10 roster)</div>
          <div className="maestro-pickrow">
            {liveAgents.length ? liveAgents.map(a => (
              <button key={a.id} type="button"
                className={`maestro-pick is-agent${agentIds.includes(a.id) ? " is-on" : ""}`}
                onClick={() => toggleAgent(a.id)}
                title={`${a.name || a.id}${a.persona_id ? " — " + a.persona_id : ""}`}>
                <span className="maestro-pick-name">{a.name || a.id}</span>
                <span className="maestro-pick-meta">{a.persona_id || "agent"}</span>
              </button>
            )) : <span className="maestro-panel-empty">No instanced agents yet — hire one in Crews.</span>}
          </div>
        </div>

        {/* ── 2) Attach-work picker. ── */}
        <div className="maestro-panel">
          <div className="maestro-panel-head">
            <span className="maestro-panel-no">2</span> Attach work
            <span className="maestro-panel-sub">{taskIds.length} task{taskIds.length === 1 ? "" : "s"}</span>
          </div>
          <div className="maestro-panel-lab">Khira tasks (by task id / owner_id)</div>
          <div className="maestro-tasklist">
            {allTasks.length ? allTasks.slice(0, 60).map(t => {
              const c = maestroTaskContract(t, crews, agents);
              const on = taskIds.includes(t.id);
              const inferred = !(c.authored.required_authority || c.authored.owner_gate != null);
              return (
                <button key={t.id} type="button"
                  className={`maestro-taskrow${on ? " is-on" : ""}`}
                  onClick={() => toggleTask(t.id)}
                  title={t.title || t.id}>
                  <span className="maestro-taskrow-id">{t.id}</span>
                  <span className="maestro-taskrow-owner">{t.owner_id || "—"}</span>
                  <span className="maestro-taskrow-auth">
                    {c.required_authority}{c.owner_gate ? " · owner-gate" : ""}
                    {inferred ? <span className="maestro-tag inferred">inferred</span> : null}
                  </span>
                </button>
              );
            }) : <span className="maestro-panel-empty">No Khira tasks in this project.</span>}
          </div>
          {allTasks.length > 60 ? (
            <div className="maestro-panel-foot">Showing first 60 of {allTasks.length} tasks.</div>
          ) : null}
        </div>
      </div>

      {/* ── 3) Authority gate + 4) Dispatch preview, per attached task. ── */}
      <div className="maestro-dispatch">
        <div className="maestro-dispatch-head">
          <h4>Gate &amp; preview</h4>
          <span className="maestro-dispatch-sub">
            {targetForGate
              ? <>delegating to <strong>{targetForGate.label}</strong></>
              : "select a performer to gate the dispatch"}
          </span>
        </div>
        {rows.length === 0 ? (
          <div className="maestro-dispatch-empty">
            Attach a Khira task above to authority-gate it (via <code>delegationReason</code>) and preview its
            handler chain (via <code>resolveHandler</code>) before you commit.
          </div>
        ) : (
          <ul className="maestro-rowlist">
            {rows.map(r => (
              <li key={r.task.id} className={`maestro-row${r.gate.ok ? " is-ok" : " is-blocked"}`}>
                <div className="maestro-row-main">
                  <span className="maestro-row-id">{r.task.id}</span>
                  <span className="maestro-row-contract">
                    {r.contract.required_authority}{r.contract.owner_gate ? " · owner-gate" : ""}
                    {r.contract.domain ? ` · ${r.contract.domain}` : " · domain-agnostic"}
                  </span>
                  {r.gate.ok ? (
                    <span className="maestro-chip ok"><span className="maestro-chip-mark" aria-hidden="true">✓</span> dispatch allowed</span>
                  ) : (
                    <span className="maestro-chip reject" title={`delegationReason: ${r.gate.reason}`}>
                      <span className="maestro-chip-mark" aria-hidden="true">✕</span> {maestroRejectCopy(r.gate.reason)}
                      <code className="maestro-reason">{r.gate.reason}</code>
                    </span>
                  )}
                </div>
                {r.gate.ok && r.preview ? (
                  <div className="maestro-row-preview">
                    <span className="maestro-prev-lab">handler chain</span>
                    <span className="maestro-prev-chain">
                      {r.preview.chain.map((p, i) => (
                        <React.Fragment key={p.id}>
                          {i > 0 ? <span className="maestro-prev-arrow">→</span> : null}
                          <button type="button" className="maestro-prev-node"
                            onClick={() => { if (typeof onOpenArtifact === "function") onOpenArtifact("role", p.id); }}
                            title={`${p.title} · ${p.tier}`}>
                            {p.tier}
                          </button>
                        </React.Fragment>
                      ))}
                    </span>
                    <span className="maestro-prev-meta">
                      <span><span className="maestro-prev-lab">tier</span> {r.preview.decidingTier}</span>
                      <span><span className="maestro-prev-lab">model</span> {r.preview.modelTier}</span>
                      <span><span className="maestro-prev-lab">reviewer</span> {r.preview.reviewer ? r.preview.reviewer.title : "—"}</span>
                      <span className={r.preview.ownerTouched ? "maestro-prev-gate on" : "maestro-prev-gate"}>
                        <span className="maestro-prev-lab">owner-gate</span> {r.preview.ownerTouched ? "yes — human approves" : "no"}
                      </span>
                    </span>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── 5) Explicit conduct action (NO auto-run) + staged state. ── */}
      <div className="maestro-conduct-bar">
        <div className="maestro-conduct-status">
          {dispatchHint
            ? <span className="maestro-conduct-hint">{dispatchHint}</span>
            : <span className="maestro-conduct-ready">
                Ready — {okRows.length} task{okRows.length === 1 ? "" : "s"} pass the gate ·
                {" "}{performerCount} performer{performerCount === 1 ? "" : "s"}.
                {maestroRuntimeSeam() ? " Runtime seam connected." : " Runtime lands in AG-P11.3 (run will be staged)."}
              </span>}
        </div>
        <div className="maestro-conduct-actions">
          {(performerCount || taskIds.length) ? (
            <button type="button" className="maestro-btn ghost" onClick={clearRun}>Clear</button>
          ) : null}
          <button type="button"
            className="maestro-btn primary"
            disabled={!canDispatch}
            onClick={dispatchRun}
            title={canDispatch ? "Dispatch the run (deliberate gesture — nothing auto-runs)" : (dispatchHint || "")}>
            <Glyph name="send" size={14} /> Dispatch run
          </button>
        </div>
      </div>

      {staged ? (
        <div className={`maestro-staged${staged.failed ? " is-failed" : staged.handed ? " is-handed" : " is-staged"}`} role="status">
          <div className="maestro-staged-head">
            <span className="maestro-staged-mark" aria-hidden="true">{staged.failed ? "✕" : staged.handed ? "✓" : "▣"}</span>
            {staged.failed
              ? <strong>Dispatch failed — the runtime rejected the handoff. Nothing is running.</strong>
              : staged.handed
                ? <strong>Run dispatched — the runtime is driving the lifecycle.</strong>
                : <strong>Run staged — runtime lands in AG-P11.3.</strong>}
          </div>
          <div className="maestro-staged-body">
            {staged.failed
              ? <>The handoff threw inside <code>window.MaestroRuntime.dispatch(run)</code>:
                  <code>{staged.result && staged.result.error}</code>. No run was started — fix the seam and dispatch again.</>
              : staged.handed
                ? <>The validated run was handed to <code>window.MaestroRuntime.dispatch(run)</code> (the AG-P11.3
                    runtime, currently the <strong>mock adapter</strong> — no real model calls). The run-state readout
                    below reflects the live lifecycle; the durable P8 records are AG-P11.5.</>
                : <>No runtime adapter is present (<code>window.MaestroRuntime</code> absent), so the validated run
                    is staged client-side. The conduct console does not execute or persist — that is AG-P11.3 (runtime)
                    and AG-P11.5 (records). The run below is what WOULD be handed off.</>}
          </div>
          {/* Live run-state readout (AG-P11.3). Minimal in-pane lifecycle view —
              the full monitoring board is AG-P11.4. Mounts the runtime's panel
              when the run was handed off and a runId came back. */}
          {staged.handed && staged.result && staged.result.runId && RunPanel ? (
            <RunPanel
              runtime={maestroRuntimeSeam()}
              runId={staged.result.runId}
              actor={actorId} />
          ) : null}
          <details className="maestro-staged-details">
            <summary>Dispatched run object</summary>
            <pre className="maestro-staged-json">{JSON.stringify(staged.run, null, 2)}</pre>
          </details>
        </div>
      ) : null}
    </section>
  );
}

function MaestroView({ actingAs, onNavigate, onOpenArtifact, activeProject, sourceMode, tasks, agents: agentsProp }) {
  const crews = maestroCrews();
  const personas = (crews && crews.personas) || [];
  // Prefer the roster passed from app.jsx (live, retire-aware); self-source from
  // the CrewsAgents store when absent. Tasks come from app.jsx's cross-phase memo.
  const agents = Array.isArray(agentsProp) ? agentsProp : maestroAgents();
  const conductTasks = Array.isArray(tasks) ? tasks : [];
  const engineReady = maestroEngineReady();
  const resolverReady = !!maestroResolver();
  const write = maestroWriteState(sourceMode);

  // The AG-P11.4 live monitoring board, bound to a capitalized local so JSX
  // renders it as a component. Absent until agentarium/maestro-monitor.jsx loads.
  const Monitor = (typeof window !== "undefined" && typeof window.MaestroMonitor === "function")
    ? window.MaestroMonitor : null;

  // A small, stable crew preview: the top of the authority tree (one per tier,
  // up to a handful) so the operator sees the crew it WOULD conduct without any
  // dispatch. Read-only; sorted by tier then title.
  const previewPersonas = React.useMemo(() => {
    const live = personas.filter(p => p && (p.status || "active") !== "retired");
    const seenTier = new Set();
    const lead = [];
    const sorted = [...live].sort((a, b) => {
      const ra = maestroTierRank(a.tier || a.level), rb = maestroTierRank(b.tier || b.level);
      return ra - rb || String(a.title || a.id).localeCompare(String(b.title || b.id));
    });
    for (const p of sorted) {
      const t = p.tier || p.level || "";
      if (!seenTier.has(t)) { seenTier.add(t); lead.push(p); }
      if (lead.length >= 6) break;
    }
    return lead.length ? lead : sorted.slice(0, 6);
  }, [personas]);

  const liveAgents = agents.filter(a => a && a.status !== "retired");

  // Back-links degrade gracefully: Crews exists as a module; Atelier does NOT
  // yet (AG-P7.9 deferred) — it is composed inside Crews today, so the Atelier
  // link routes to Crews with an explanatory note rather than a dead route.
  const goCrews = () => { if (typeof onNavigate === "function") onNavigate("crews"); };
  const goAtelier = () => { if (typeof onNavigate === "function") onNavigate("crews"); };

  return (
    <div className="modbody maestro" data-screen-label="Maestro">
      <ModuleHeader
        roomNo="11"
        eyebrow="Maestro · Conduct & Run"
        title="Send the crew to Maestro"
        subtitle="Simulation preview · real agent execution upcoming"
        editPolicy={{ mode: "conduct", fields: ["select crew/agents · attach Khira tasks · authority-gated dispatch · live runtime"] }}
        actions={
          <span className="maestro-head-note">
            <Glyph name="crew" size={13} /> Conduct console below · dispatch is authority-gated &amp; human-in-the-loop
          </span>
        }
      />
      <PmSourceBanner readOnly />

      {/* ── Source-mode awareness: live conduct gates behind the write server. ── */}
      <div className={`maestro-modebar dept-reg${write.writeEnabled ? " is-live" : " is-readonly"}`}
           style={{ "--maestro-hue": MAESTRO_HUE }}
           role="status">
        <span className="maestro-mode-dot" />
        {write.writeEnabled ? (
          <span className="maestro-mode-text">
            <strong>Live conduct enabled.</strong> API workspace is connected
            ({write.sourceMode}{write.version ? ` · ${write.version}` : ""}) — dispatch &amp; run land in AG-P11.2/.3.
          </span>
        ) : write.serverWritable ? (
          <span className="maestro-mode-text">
            <strong>Read-only — connect API to conduct.</strong> API workspace active, write capability unverified;
            the active source lane is <code>{write.sourceMode}</code> (snapshot). Switch the source to the API workspace
            with writes enabled to raise the baton; until then Maestro previews the crew but cannot dispatch or run.
          </span>
        ) : (
          <span className="maestro-mode-text">
            <strong>Read-only — connect API to conduct.</strong> Source <code>{write.sourceMode}</code> has no write
            server, so Maestro previews the crew but cannot dispatch or run. Switch to the API workspace to raise the baton.
          </span>
        )}
      </div>

      {/* ── Empty-state: the conduct model + the pipeline, with back-links. ── */}
      <section className="maestro-empty dept-reg" style={{ "--maestro-hue": MAESTRO_HUE }}>
        <div className="maestro-empty-head">
          <span className="maestro-empty-glyph"><Glyph name="maestro" size={26} /></span>
          <div>
            <h2 className="maestro-empty-title">The conductor raises the baton</h2>
            <p className="maestro-empty-lede">
              Maestro is where Agentarium stops being a place you <em>read about</em> agent work and becomes a place
              you <em>direct</em> it. You — the human — are the conductor: you choose the crew, attach the work, raise
              the baton, and decide when a passage needs intervention. The AI agents are the performers: they execute
              within their authority scope, escalate at the edge of what they may decide, and surface back to you only
              what genuinely needs a human call.
            </p>
          </div>
        </div>

        <div className="maestro-pipeline" aria-label="Crews to Atelier to Maestro pipeline">
          <button type="button" className="maestro-stage" onClick={goCrews} title="Open Crews — who exists">
            <span className="maestro-stage-no">01</span>
            <span className="maestro-stage-name"><Glyph name="crew" size={14} /> Crews</span>
            <span className="maestro-stage-sub">who exists</span>
          </button>
          <span className="maestro-stage-arrow" aria-hidden="true">→</span>
          <button type="button" className="maestro-stage" onClick={goAtelier}
                  title="Atelier — compose a crew member (lives in Crews today; AG-P7.9 deferred)">
            <span className="maestro-stage-no">02</span>
            <span className="maestro-stage-name"><Glyph name="plus" size={14} /> Atelier</span>
            <span className="maestro-stage-sub">compose a crew member</span>
          </button>
          <span className="maestro-stage-arrow" aria-hidden="true">→</span>
          <div className="maestro-stage is-here" aria-current="step">
            <span className="maestro-stage-no">03</span>
            <span className="maestro-stage-name"><Glyph name="maestro" size={14} /> Maestro</span>
            <span className="maestro-stage-sub">deploy, conduct &amp; run</span>
          </div>
        </div>

        <div className="maestro-backlinks">
          <span className="maestro-backlinks-lab">Start from</span>
          <button type="button" className="maestro-backlink" onClick={goCrews}>
            <Glyph name="crew" size={13} /> Crews — the roster &amp; authority tree
          </button>
          <button type="button" className="maestro-backlink" onClick={goAtelier}>
            <Glyph name="plus" size={13} /> Atelier — compose a crew member
          </button>
          <span className="maestro-backlink-note">
            Atelier (AG-P7.9) is composed inside Crews today — this link opens Crews where a crew member is assembled.
          </span>
        </div>
      </section>

      {/* ── Read-only crew preview: the crew Maestro WOULD conduct. ── */}
      <section className="maestro-preview">
        <div className="maestro-preview-head">
          <h3>The crew you would conduct</h3>
          <span className="maestro-preview-count">
            {crews.count || personas.length} personas · {liveAgents.length} instanced agent{liveAgents.length === 1 ? "" : "s"}
            {engineReady ? " · authority engine ready" : " · authority engine offline"}
          </span>
        </div>

        {personas.length ? (
          <>
            <div className="maestro-crewchips">
              {previewPersonas.map(p => (
                <button key={p.id} type="button"
                     className="maestro-crewchip dept-reg"
                     data-dept={p.department}
                     style={{ "--dept-hue": maestroDeptHue(p.department), textAlign: "left" }}
                     onClick={() => { if (typeof onOpenArtifact === "function") onOpenArtifact("role", p.id); }}
                     title={`${p.title} — ${p.department} · ${p.level || p.tier}`}>
                  <span className="maestro-crewchip-name">{p.title}</span>
                  <span className="maestro-crewchip-meta">{p.department} · {p.level || p.tier}</span>
                </button>
              ))}
            </div>
            <div className="maestro-preview-foot">
              Maestro reads <code>AG.CREWS</code>, the agent roster, and the dispatch resolver read-only.
              The conduct console below selects performers, attaches Khira tasks, authority-gates the dispatch via{" "}
              <code>delegationReason</code>, and previews the handler chain via <code>resolveHandler</code>. The live
              runtime executes only after a deliberate, authority-gated dispatch.
            </div>
          </>
        ) : (
          <div className="note-card" style={{ marginTop: 4 }}>
            No crew loaded. Maestro conducts the crew from{" "}
            <code>project-management/roles/crews-index.json</code> (via <code>AG.CREWS</code>).{" "}
            <button type="button" className="maestro-inline-link" onClick={goCrews}>Open Crews</button> to assemble one.
          </div>
        )}
      </section>

      {/* ── AG-P11.2 — the conduct console mounts INTO the shell. ── */}
      {personas.length && engineReady && resolverReady ? (
        <MaestroConsole
          actingAs={actingAs}
          crews={crews}
          personas={personas}
          agents={agents}
          tasks={conductTasks}
          write={write}
          onOpenArtifact={onOpenArtifact} />
      ) : personas.length ? (
        <section className="maestro-console">
          <div className="note-card">
            Conduct console offline — the authority engine (<code>CrewsAssign</code>) or the dispatch resolver
            (<code>CrewsResolver</code>) is not loaded. The console authority-gates and previews via those engines;
            it cannot open without them.
          </div>
        </section>
      ) : null}

      {/* ── AG-P11.4 — the LIVE MONITORING board mounts INTO the shell, below the
          console. It OBSERVES the runtime (window.MaestroRuntime) across ALL
          runs — a run status board, per-agent state rolled up to the crew,
          streaming progress off onProgress, and a live simulated-effort accrual
          feeding the Crews Usage view. It does NOT dispatch or intervene. */}
      {Monitor ? (
        <Monitor
          tasks={conductTasks}
          agents={agents}
          runtime={(typeof window !== "undefined" && window.MaestroRuntime) || null} />
      ) : null}
    </div>
  );
}

// Expose for the shell switch in app.jsx (mirrors window.CrewsView).
window.MaestroView = MaestroView;
