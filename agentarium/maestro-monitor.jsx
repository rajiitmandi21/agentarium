// Agentarium — Maestro LIVE MONITORING & TELEMETRY (AG-P11.4)
//
// The OBSERVABILITY surface over active runs. This is the read-out over the
// AG-P11.3 runtime (window.MaestroRuntime): a run status board, per-agent live
// state rolled up to the crew, streaming progress consumed off the runtime's
// onProgress stream, and a LIVE simulated-effort accrual that feeds the existing
// AG-P7.8 Crews Usage view (the reader, re-pointed at real records by AG-P11.5).
//
// ── WHAT THIS FILE IS (and is NOT) ──────────────────────────────────────────
//   IT OBSERVES. It SUBSCRIBES to the runtime's onProgress stream and renders
//   whatever state the runtime reports. It is a pure read-out.
//
//   IT DOES NOT DISPATCH and DOES NOT MUTATE A RUN. There is NO call to
//   window.MaestroRuntime.dispatch / pause / resume / abort / override / accept
//   anywhere in this file — dispatch is AG-P11.2 (the conduct console) and the
//   intervention controls (pause/resume/abort/gate accept) are AG-P11.6 + the
//   minimal in-pane MaestroRunPanel; the board only WATCHES. It writes NO run /
//   engagement record (that is AG-P11.5) and never sets pm_* / verdict fields.
//
// ── THE FOUR SUBTASKS ───────────────────────────────────────────────────────
//   1) RUN STATUS BOARD — one lane/card per active run keyed to its lifecycle
//      state (queued / authority-resolved / selecting-agent / running /
//      coordinating / escalated / await-owner-gate / paused / overridden / done
//      / failed / blocked) and the attached task(s).
//   2) PER-AGENT LIVE STATE — which performer is engaged on which step and its
//      derived state (idle / running / blocked / escalated), rolled up to the
//      crew (by department).
//   3) STREAMING PROGRESS — consume the runtime's onProgress stream in a
//      useEffect, update component state on EACH event (incremental, no full
//      refresh), and clean up the subscription on unmount.
//   4) SIMULATED-EFFORT ACCRUAL — units per agent/persona/department, accruing
//      LIVE as runs progress, feeding the existing Crews Usage view (the
//      AG-P7.8 reader). Locked copy: "simulated effort, never money" — there is
//      NO money string anywhere in this file by construction.
//
// Dual-mount: window.MaestroMonitor is the board the Maestro pane mounts.

(function () {
  const R = (typeof React !== "undefined") ? React : null;

  // ── State labels (mirror of maestro-runtime.jsx STATE_LABEL). ──────────────
  const MM_STATE_LABEL = {
    queued: "Queued", "authority-resolved": "Authority resolved",
    "selecting-agent": "Selecting agent", running: "Running",
    coordinating: "Coordinating", escalated: "Escalated — approval needed",
    "await-owner-gate": "Awaiting owner acceptance", paused: "Paused",
    overridden: "Overridden", done: "Done", failed: "Failed",
    blocked: "Blocked — dead-end",
  };
  const MM_TERMINAL = { done: true, failed: true, blocked: true };
  const MM_LIVE_FLOWING = { running: true, "selecting-agent": true, coordinating: true };

  // ── Per-agent derived state from a run snapshot. The reducer carries the run
  // status; we project the PERFORMER's live state from it: a step running ⇒
  // running; an escalation gate ⇒ escalated; a dead-end ⇒ blocked; a paused /
  // gated / terminal run ⇒ the performer is no longer actively engaged (idle on
  // that run). Read-only derivation — never a mutation. ──────────────────────
  function mmAgentStateFor(runStatus) {
    if (runStatus === "escalated") return "escalated";
    if (runStatus === "blocked" || runStatus === "failed") return "blocked";
    if (MM_LIVE_FLOWING[runStatus]) return "running";
    return "idle"; // queued / paused / await-owner-gate / done / overridden
  }

  // Steps ACTUALLY EXECUTED — for progress bars and effort attribution.
  // Terminality is not completeness: only 'done' implies every step ran; a
  // failed/blocked run froze where it died, so its bar and its credited effort
  // stop at the last executed step instead of claiming the whole ladder. (The
  // reducer's stepIndex points at the last step whose progress event landed,
  // so executed = stepIndex + 1 everywhere else.)
  function mmExecutedSteps(run) {
    const steps = Array.isArray(run.steps) ? run.steps : [];
    const total = steps.length;
    if (!total) return 0;
    if (run.status === "done") return total;
    const idx = (typeof run.stepIndex === "number") ? run.stepIndex : -1;
    return Math.max(0, Math.min(idx + 1, total));
  }

  // Precedence when one performer appears across several runs (worst wins).
  const MM_AGENT_RANK = { escalated: 0, blocked: 1, running: 2, idle: 3 };
  function mmWorse(a, b) {
    if (!a) return b;
    if (!b) return a;
    return MM_AGENT_RANK[a] <= MM_AGENT_RANK[b] ? a : b;
  }

  // Department hue register (mirror of crews-usage / maestro soft-tint register).
  function mmDeptHue(d) {
    const map = { executive: 285, tech: 255, product: 330, data: 190, ai: 45, it: 125 };
    return map[d] != null ? map[d] : 255;
  }
  function mmDeptLabel(d) {
    if (!d) return "Unassigned";
    return d.charAt(0).toUpperCase() + d.slice(1);
  }

  // Persona lookup (READ-ONLY off AG.CREWS) so a performer id resolves to its
  // title + department + tier for the per-agent roll-up.
  function mmPersonaIndex() {
    const byId = {};
    try {
      const crews = (typeof AG !== "undefined" && AG.CREWS)
        || (typeof window !== "undefined" && window.AG && window.AG.CREWS) || null;
      const personas = (crews && crews.personas) || [];
      for (const p of personas) if (p && p.id) byId[p.id] = p;
    } catch (e) { /* ignore */ }
    return byId;
  }
  // Agent roster lookup (READ-ONLY) so an agent-* performer resolves its persona.
  function mmAgentIndex() {
    const byId = {};
    try {
      if (typeof window !== "undefined" && window.CrewsAgents && window.CrewsAgents.listAgents) {
        for (const a of (window.CrewsAgents.listAgents() || [])) if (a && a.id) byId[a.id] = a;
      }
    } catch (e) { /* ignore */ }
    return byId;
  }

  // Resolve a performer id (a persona id OR an agent-* id) to a display record:
  // { id, name, department, tier }. Agents resolve through their persona_id.
  function mmResolvePerformer(pid, personaById, agentById) {
    if (!pid) return { id: pid, name: "—", department: null, tier: null };
    const agent = agentById[pid] || null;
    if (agent) {
      const persona = agent.persona_id ? personaById[agent.persona_id] : null;
      return {
        id: pid,
        name: agent.name || pid,
        department: (persona && persona.department) || null,
        tier: (persona && (persona.tier || persona.level)) || null,
      };
    }
    const persona = personaById[pid] || null;
    return {
      id: pid,
      name: (persona && persona.title) || pid,
      department: (persona && persona.department) || null,
      tier: (persona && (persona.tier || persona.level)) || null,
    };
  }

  // ── Per-run card (subtask 1). Lane keyed to the lifecycle state, showing the
  // attached task(s), the current performer/step, the live effort tally, and a
  // short streaming progress tail. OBSERVE-ONLY: no action buttons. ──────────
  function MmRunCard({ run, personaById, agentById }) {
    const st = run.status;
    const live = !MM_TERMINAL[st];
    const tasks = Array.isArray(run.tasks) ? run.tasks : [];
    const steps = Array.isArray(run.steps) ? run.steps : [];
    const stepIndex = (typeof run.stepIndex === "number") ? run.stepIndex : -1;
    const curStep = (stepIndex >= 0 && steps[stepIndex]) ? steps[stepIndex] : null;
    const performer = curStep
      ? mmResolvePerformer(curStep.performer || curStep.tier, personaById, agentById)
      : null;
    const totalSteps = steps.length;
    const doneSteps = mmExecutedSteps(run);
    const pct = totalSteps > 0 ? Math.round((doneSteps / totalSteps) * 100) : (MM_TERMINAL[st] ? 100 : 0);
    const tail = (run.progress || []).slice(-4);

    return R.createElement(
      "article",
      { className: "mm-run dept-reg", "data-state": st, role: "group",
        "aria-label": "Run " + run.runId + " — " + (MM_STATE_LABEL[st] || st) },
      // Head: run id · state pill · live/terminal dot.
      R.createElement("header", { className: "mm-run-head" },
        R.createElement("span", { className: "mm-run-id" }, run.runId),
        R.createElement("span", { className: "mm-run-state state-" + st }, MM_STATE_LABEL[st] || st),
        live
          ? R.createElement("span", { className: "mm-run-pulse" + (MM_LIVE_FLOWING[st] ? " is-flowing" : ""),
              title: "Live run", "aria-hidden": "true" })
          : null
      ),
      // Attached tasks (subtask 1 — the run is keyed to its attached task[s]).
      R.createElement("div", { className: "mm-run-tasks" },
        R.createElement("span", { className: "mm-run-lab" }, "tasks"),
        tasks.length
          ? tasks.map(function (t) {
              return R.createElement("span", { key: t.id, className: "mm-run-task", title: (t.owner_id || "—") },
                t.id);
            })
          : R.createElement("span", { className: "mm-run-none" }, "—")
      ),
      // Current performer + step (per-run slice of subtask 2).
      R.createElement("div", { className: "mm-run-now" },
        R.createElement("span", { className: "mm-run-lab" }, "now"),
        performer
          ? R.createElement("span", { className: "mm-run-performer dept-reg",
              "data-dept": performer.department || "",
              style: { "--dept-hue": mmDeptHue(performer.department) } },
              R.createElement("span", { className: "mm-run-performer-name" }, performer.name),
              curStep && curStep.model
                ? R.createElement("span", { className: "mm-run-performer-model" }, curStep.model)
                : null)
          : R.createElement("span", { className: "mm-run-none" },
              st === "queued" ? "resolving authority…" : "—")
      ),
      // Progress bar (streaming — width follows stepIndex; subtask 3).
      R.createElement("div", { className: "mm-run-progress" },
        R.createElement("div", { className: "mm-run-progress-track" },
          R.createElement("div", { className: "mm-run-progress-fill state-" + st,
            style: { width: pct + "%" } })),
        R.createElement("span", { className: "mm-run-progress-meta" },
          totalSteps > 0
            ? (Math.min(doneSteps, totalSteps) + "/" + totalSteps + " steps")
            : (MM_STATE_LABEL[st] || st))
      ),
      // Live simulated-effort tally for this run (subtask 4 — NEVER money).
      R.createElement("div", { className: "mm-run-effort",
        title: "Representational simulated effort — never money" },
        R.createElement("span", { className: "mm-run-lab" }, "effort"),
        R.createElement("strong", null, run.effortUnits || 0),
        " ",
        R.createElement("span", { className: "mm-run-effort-unit" },
          "effort unit" + ((run.effortUnits || 0) === 1 ? "" : "s"))
      ),
      // Streaming progress tail — incremental, most-recent-last (subtask 3).
      tail.length
        ? R.createElement("ul", { className: "mm-run-stream" },
            tail.map(function (e, i) {
              return R.createElement("li", { key: i, className: "mm-run-streamitem kind-" + (e.kind || "step") },
                e.text || e.kind);
            }))
        : null
    );
  }

  // ── Per-agent roll-up panel (subtask 2). Every performer engaged across ALL
  // active runs, with its derived state (idle / running / blocked / escalated),
  // grouped by department (rolled up to the crew). Live effort per performer is
  // shown too (subtask 4 slice). Read-only. ─────────────────────────────────
  function MmAgentRollup({ runs, personaById, agentById }) {
    // Aggregate by performer across runs: worst state wins; effort sums.
    const byPerformer = {};
    for (const run of runs) {
      const steps = Array.isArray(run.steps) ? run.steps : [];
      const rState = mmAgentStateFor(run.status);
      const stepIndex = (typeof run.stepIndex === "number") ? run.stepIndex : -1;
      const curId = (stepIndex >= 0 && steps[stepIndex]) ? (steps[stepIndex].performer || steps[stepIndex].tier) : null;
      for (const st of steps) {
        const pid = st.performer || st.tier;
        if (!pid) continue;
        if (!byPerformer[pid]) byPerformer[pid] = { id: pid, state: "idle", effort: 0, runs: 0, engagedRuns: {} };
        const rec = byPerformer[pid];
        // This performer is "the live one" only when it is the CURRENT step of a
        // live run; otherwise it has been/will be engaged but is idle right now.
        const isCurrent = pid === curId && !MM_TERMINAL[run.status];
        rec.state = mmWorse(rec.state, isCurrent ? rState : "idle");
        if (!rec.engagedRuns[run.runId]) { rec.engagedRuns[run.runId] = true; rec.runs += 1; }
      }
      // Live accrued effort: attribute EXACTLY what accrued by summing the
      // emitted effort ON each step's progress entry (the adapter stamps it).
      // Re-walked generations emit effort 0 and aborted/failed runs simply stop
      // emitting, so performer tallies always reconcile with run.effortUnits —
      // positional ladder attribution would double-count during re-walks.
      const progress = Array.isArray(run.progress) ? run.progress : [];
      for (const ev of progress) {
        if (!ev || ev.kind !== "step") continue;
        const pid = ev.performer || ev.tier;
        if (!pid) continue;
        if (!byPerformer[pid]) byPerformer[pid] = { id: pid, state: "idle", effort: 0, runs: 0, engagedRuns: {} };
        byPerformer[pid].effort += (typeof ev.effort === "number" ? ev.effort : 0);
      }
    }

    const performers = Object.keys(byPerformer).map(function (pid) {
      const meta = mmResolvePerformer(pid, personaById, agentById);
      return Object.assign({}, byPerformer[pid], meta);
    });

    if (!performers.length) {
      return R.createElement("div", { className: "mm-rollup-empty" },
        "No performer is engaged yet — dispatch a run from the conduct console to see live agent state.");
    }

    // Group by department (rolled up to the crew).
    const byDept = {};
    for (const p of performers) {
      const d = p.department || "unassigned";
      (byDept[d] = byDept[d] || []).push(p);
    }
    const depts = Object.keys(byDept).sort();
    const stateOrder = { escalated: 0, blocked: 1, running: 2, idle: 3 };

    return R.createElement("div", { className: "mm-rollup" },
      depts.map(function (d) {
        const group = byDept[d].slice().sort(function (a, b) {
          return (stateOrder[a.state] - stateOrder[b.state]) || String(a.name).localeCompare(String(b.name));
        });
        const deptEffort = group.reduce(function (s, p) { return s + (p.effort || 0); }, 0);
        return R.createElement("div", { key: d, className: "mm-rollup-dept dept-reg",
          "data-dept": d, style: { "--dept-hue": mmDeptHue(d === "unassigned" ? null : d) } },
          R.createElement("div", { className: "mm-rollup-dept-head" },
            R.createElement("span", { className: "mm-rollup-dept-name" }, mmDeptLabel(d === "unassigned" ? null : d)),
            R.createElement("span", { className: "mm-rollup-dept-effort",
              title: "Representational simulated effort — never money" },
              deptEffort + " effort unit" + (deptEffort === 1 ? "" : "s"))),
          R.createElement("ul", { className: "mm-rollup-agents" },
            group.map(function (p) {
              return R.createElement("li", { key: p.id, className: "mm-rollup-agent state-" + p.state,
                title: p.id + " — " + p.state },
                R.createElement("span", { className: "mm-rollup-agent-dot state-" + p.state, "aria-hidden": "true" }),
                R.createElement("span", { className: "mm-rollup-agent-name" }, p.name),
                p.tier ? R.createElement("span", { className: "mm-rollup-agent-tier" }, p.tier) : null,
                R.createElement("span", { className: "mm-rollup-agent-state" }, p.state),
                R.createElement("span", { className: "mm-rollup-agent-effort",
                  title: "Representational simulated effort — never money" },
                  (p.effort || 0) + "u"));
            })));
      })
    );
  }

  // ── THE BOARD. Subscribes to the runtime's onProgress stream (subtask 3) and
  // renders the run lanes (1), the per-agent roll-up (2), the live effort
  // accrual + the existing Crews Usage view (4). OBSERVE-ONLY. ──────────────
  function MaestroMonitor(props) {
    props = props || {};
    if (!R) return null;
    const runtime = props.runtime
      || (typeof window !== "undefined" && window.MaestroRuntime) || null;

    // The board's live model: a map of runId → snapshot, updated on EACH
    // onProgress event WITHOUT a full refresh. We seed from listRuns() on mount.
    const runsHook = R.useState(function () {
      try { return runtime && runtime.listRuns ? indexRuns(runtime.listRuns()) : {}; }
      catch (e) { return {}; }
    });
    const runsMap = runsHook[0];
    const setRunsMap = runsHook[1];

    R.useEffect(function () {
      if (!runtime || typeof runtime.onProgress !== "function") return undefined;
      // Pull the current set immediately (covers any run dispatched before mount).
      try { if (runtime.listRuns) setRunsMap(indexRuns(runtime.listRuns())); } catch (e) {}
      // STREAMING: on each transition, merge just THAT run's snapshot into the
      // map — an incremental update, never a full reload of the board.
      const off = runtime.onProgress(function (snap, id) {
        if (!snap || !id) return;
        setRunsMap(function (prev) {
          const next = Object.assign({}, prev);
          next[id] = snap;
          return next;
        });
      });
      // Clean up the subscription on unmount (no leaked listener).
      return function () { if (typeof off === "function") off(); };
    }, [runtime]);

    const personaById = R.useMemo(mmPersonaIndex, [runsMap]);
    const agentById = R.useMemo(mmAgentIndex, [runsMap]);

    const allRuns = Object.keys(runsMap).map(function (id) { return runsMap[id]; })
      .filter(Boolean)
      .sort(function (a, b) {
        // Live runs first, then by run id (stable).
        const al = MM_TERMINAL[a.status] ? 1 : 0, bl = MM_TERMINAL[b.status] ? 1 : 0;
        return (al - bl) || String(a.runId).localeCompare(String(b.runId));
      });
    const liveRuns = allRuns.filter(function (r) { return !MM_TERMINAL[r.status]; });
    const totalEffort = allRuns.reduce(function (s, r) { return s + (r.effortUnits || 0); }, 0);

    // The Crews Usage view (AG-P7.8 reader; re-pointed at real records by
    // AG-P11.5). The board is the LIVE writer/observer; this is the reader. It
    // self-pulls engagements on each run-terminal transition (its own effect).
    const UsageView = (typeof window !== "undefined" && typeof window.CrewsUsageView === "function")
      ? window.CrewsUsageView : null;

    if (!runtime) {
      return R.createElement("section", { className: "mm-board" },
        R.createElement("div", { className: "note-card" },
          "Live monitoring is offline — the runtime (",
          R.createElement("code", null, "window.MaestroRuntime"),
          ") is not loaded. The board observes the runtime; it cannot open without it."));
    }

    return R.createElement(
      "section",
      { className: "mm-board", "aria-label": "Live run monitoring" },

      // Board header — observe-only framing + live counts.
      R.createElement("div", { className: "mm-board-head" },
        R.createElement("h3", { className: "mm-board-title" }, "Live monitoring"),
        R.createElement("span", { className: "mm-board-sub" },
          R.createElement("span", { className: "mm-board-count" },
            liveRuns.length + " live"),
          " · ",
          allRuns.length + " run" + (allRuns.length === 1 ? "" : "s"),
          " · ",
          R.createElement("span", { title: "Representational simulated effort — never money" },
            totalEffort + " effort unit" + (totalEffort === 1 ? "" : "s")))
      ),
      R.createElement("p", { className: "mm-board-observe" },
        "This board ", R.createElement("strong", null, "observes"),
        " the runtime — it does not dispatch or intervene. Dispatch is the conduct console; ",
        "pause / resume / abort are the run readout. Effort shown is ",
        R.createElement("strong", null, "representational simulated effort, never money"), "."),

      // ── 1) RUN STATUS BOARD — a lane/card per run. ──
      R.createElement("div", { className: "mm-section" },
        R.createElement("h4", { className: "mm-section-head" }, "Run status board"),
        allRuns.length
          ? R.createElement("div", { className: "mm-lanes" },
              allRuns.map(function (run) {
                return R.createElement(MmRunCard, { key: run.runId, run: run,
                  personaById: personaById, agentById: agentById });
              }))
          : R.createElement("div", { className: "mm-empty" },
              R.createElement("span", { className: "mm-empty-glyph", "aria-hidden": "true" }, "◍"),
              R.createElement("p", { className: "mm-empty-title" }, "No runs yet."),
              R.createElement("p", { className: "mm-empty-coach" },
                "Dispatch a run from the conduct console above — each run appears here as its own lane, ",
                "transitioning through its lifecycle as the runtime streams progress."))
      ),

      // ── 2) PER-AGENT LIVE STATE — rolled up to the crew. ──
      R.createElement("div", { className: "mm-section" },
        R.createElement("h4", { className: "mm-section-head" }, "Per-agent live state",
          R.createElement("span", { className: "mm-section-sub" }, "rolled up to the crew")),
        R.createElement(MmAgentRollup, { runs: allRuns, personaById: personaById, agentById: agentById })
      ),

      // ── 4) SIMULATED-EFFORT ACCRUAL → the Crews Usage view (the reader). ──
      R.createElement("div", { className: "mm-section mm-usage-section" },
        R.createElement("h4", { className: "mm-section-head" }, "Simulated-effort accrual",
          R.createElement("span", { className: "mm-section-sub" }, "feeds the Crews Usage view")),
        R.createElement("p", { className: "mm-usage-note" },
          "As runs progress the runtime accrues ",
          R.createElement("strong", null, "simulated effort"),
          " (units per agent / persona / department). The board is the live observer; ",
          "the Crews Usage panel below is the reader — it ",
          R.createElement("strong", null, "never processes or reflects real money"), "."),
        UsageView
          ? R.createElement("div", { className: "mm-usage-embed" },
              R.createElement(UsageView, {
                tasks: props.tasks || null,
                agents: props.agents || null,
                index: (typeof AG !== "undefined" && AG.CREWS) || null,
              }))
          : R.createElement("div", { className: "note-card" },
              "Crews Usage view (", R.createElement("code", null, "window.CrewsUsageView"),
              ") is not loaded — the simulated-effort reader is unavailable.")
      )
    );
  }

  // Index a listRuns() array into a runId → snapshot map.
  function indexRuns(arr) {
    const map = {};
    for (const r of (arr || [])) if (r && r.runId) map[r.runId] = r;
    return map;
  }

  if (typeof window !== "undefined") {
    window.MaestroMonitor = MaestroMonitor;
  }
})();
