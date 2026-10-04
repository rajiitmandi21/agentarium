// Agentarium — Maestro EXECUTION RUNTIME (AG-P11.3 · KEYSTONE).
//
// This file IMPLEMENTS window.MaestroRuntime — the run engine the conduct
// console (AG-P11.2, agentarium/maestro.jsx) hands a validated run to via
// window.MaestroRuntime.dispatch(run). It is the verb under Maestro: it takes a
// dispatched run and drives it through a run LIFECYCLE STATE MACHINE via a
// SWAPPABLE ADAPTER, pausing at HUMAN APPROVAL GATES (owner-gate acceptance and
// cross-scope escalation) so nothing progresses past a gate without an explicit
// operator decision (human-in-the-loop).
//
// ── WHAT IS REAL HERE (the shippable slice — the MOCK-ADAPTER CORE) ──────────
//   1. ADAPTER SEAM   — a narrow, stable interface { start, pause, resume, abort,
//                        onProgress, onComplete } so the external runner is
//                        swappable. A real adapter (LangGraph.js, decision
//                        2026-06-13-maestro-runtime-langgraph.md) drops in later
//                        WITHOUT touching the lifecycle.
//   2. PURE REDUCER   — reduce(state, event) -> state implementing the AG-P7.12
//                        spike's state set (runtime-spike §3). NO Date.now /
//                        new Date / Math.random inside the reducer — all timing
//                        and scheduling live in the ADAPTER, so transitions are
//                        deterministic and unit-testable (scripts/test-maestro-
//                        runtime.js asserts the reducer source is clock/random
//                        free).
//   3. GATES          — await-owner-gate (owner_gate:true) and escalated pause
//                        the run; ONLY an explicit operator accept/approve event
//                        advances it. A UNIVERSAL human override from any state.
//   4. MOCK ADAPTER   — drives the lifecycle + UI with NO real model calls. It
//                        uses timers (in the adapter, never the reducer) to
//                        advance steps and emits onProgress. It resolves the
//                        performing agent + model_config per step via the
//                        dispatch resolver (window.CrewsResolver, read-only) /
//                        tier defaults, and accrues SIMULATED EFFORT only —
//                        representational units, NEVER money (no money strings).
//   5. FACADE         — window.MaestroRuntime.dispatch(run) drives the mock
//                        lifecycle; getRun / listRuns / subscribe expose run
//                        state for the UI; acceptGate / approveEscalation /
//                        override are the operator's gate controls.
//
// ── WHAT IS DEFERRED (explicitly, with reasons) ─────────────────────────────
//   • The REAL LangGraph.js adapter (decision-of-record) is the NEXT INCREMENT,
//     gated on the integration-host decision (node-side in-process server.js
//     runtime vs. an ESM CDN) — because this is a NO-BUILD babel-in-browser SPA
//     we CANNOT npm-import @langchain/langgraph here. The seam below is exactly
//     the shape that adapter implements (graph = this state machine; pause/
//     resume = checkpointer + interrupt()/Command({resume}); onProgress =
//     streamMode:"updates"). We DO NOT attempt to import LangGraph.
//   • DURABLE PERSISTENCE (P8 append-only run/engagement records) is AG-P11.5.
//     Here persistence is a SEAM ONLY: run state is in-memory and a documented
//     persistHook(snapshot) is invoked on every transition but defaults to a
//     no-op. This task does NOT write records or call the P8 write API.

(function () {
  'use strict';

  // ── Tier → representational model class (mirror of the console's register).
  // Used only to LABEL the performer's model per step; Maestro makes no model
  // call. Kept in sync with maestro.jsx MAESTRO_TIER_MODEL.
  var TIER_MODEL = {
    owner: 'operator (human)',
    ceo: 'frontier', cxo: 'frontier',
    lead: 'frontier', senior: 'balanced', junior: 'fast',
  };

  // ── SIMULATED EFFORT (NEVER money). Representational units accrued per step,
  // keyed off the tier of the performer (heavier tiers = more units of thought,
  // not currency). These are dimensionless "effort units" — there is no money
  // string anywhere in this file by construction.
  var TIER_EFFORT = { owner: 5, ceo: 5, cxo: 4, lead: 3, senior: 2, junior: 1 };
  function effortForTier(tier) {
    return TIER_EFFORT[tier] != null ? TIER_EFFORT[tier] : 2;
  }

  // ════════════════════════════════════════════════════════════════════════
  // 1) THE RUN LIFECYCLE STATE MACHINE — a PURE REDUCER.
  //
  // The state set re-grounds the AG-P7.12 spike's 12-state dispatch machine
  // (runtime-spike §3) on an adapter-mediated executor. The names below are the
  // task's mandated set (queued, authority-resolved, running, coordinating,
  // escalated, await-owner-gate, overridden, paused, done, failed) plus the
  // spike's selecting-agent (= "dispatched"/agent-pick) and the genuine
  // dead-end blocked — twelve states total:
  //
  //   queued · authority-resolved · selecting-agent · running · coordinating ·
  //   escalated · await-owner-gate · paused · overridden · done · failed · blocked
  //
  // CRITICAL INVARIANT: this reducer is PURE. It reads (state, event) and
  // returns the next state. It NEVER reads a clock (Date.now/new Date), NEVER
  // calls Math.random, NEVER schedules a timer, NEVER mutates external data.
  // Every timestamp/step-index/effort number it stores comes IN on the event
  // (the adapter stamps them). That is what makes transitions deterministic and
  // the whole machine unit-testable from a fixed event list.
  // ════════════════════════════════════════════════════════════════════════

  var STATES = [
    'queued', 'authority-resolved', 'selecting-agent', 'running', 'coordinating',
    'escalated', 'await-owner-gate', 'paused', 'overridden', 'done', 'failed', 'blocked',
  ];
  var TERMINAL = { done: true, failed: true, blocked: true };

  // Build the initial reducer state from a dispatched run object (no clock).
  // The run carries its attached tasks + per-task contract (required_authority /
  // owner_gate / domain) + the resolver preview from the console.
  function initialState(run) {
    var tasks = (run && run.tasks) || [];
    // The run is owner-gated iff ANY attached task is owner_gate:true OR its
    // resolver preview said the owner is touched. The gate parks the run before
    // done (the human must accept) — no silent progression.
    var ownerGated = tasks.some(function (t) {
      return (t.contract && t.contract.owner_gate === true) ||
        (t.preview && t.preview.owner_gated === true);
    });
    return {
      runId: (run && run.runId) || null,
      status: 'queued',
      // The ladder of step rungs the run walks. Populated on 'authority-resolved'
      // by the adapter (which consulted the resolver); the reducer just stores it.
      steps: [],
      stepIndex: -1,
      ownerGated: ownerGated,
      // human-in-the-loop bookkeeping (all set by explicit operator events):
      gate: null,            // { kind:'owner'|'escalation', at, by } when parked at a gate
      escalationTier: null,  // current rung while climbing (escalated/coordinating)
      override: null,        // last operator override injection
      // representational accrual (NEVER money):
      effortUnits: 0,
      // progress log the UI renders; entries are { at, kind, text, ... } stamped
      // by the adapter on the inbound event (the reducer copies, never stamps).
      progress: [],
      // resume target: the state to return to after a pause/gate is cleared.
      resumeTo: null,
      // the dispatch timestamp handed in ON the run object by the facade
      // (dispatch seeds it from run.staged_at) — persisted readers consume it.
      dispatchedAt: (run && run.dispatchedAt) || null,
      lastEventAt: (run && run.dispatchedAt) || null,
      tasks: tasks,
      conductor: (run && run.conductor) || null,
    };
  }

  // Append a progress entry without mutating the input array (pure).
  function withProgress(state, entry) {
    if (!entry) return state.progress;
    return state.progress.concat([entry]);
  }

  // The reducer. Unknown (state,event) pairs are a NO-OP (return state
  // unchanged) so the machine never crashes on an out-of-order event — an
  // invalid transition is simply ignored, which keeps the adapter and the UI
  // decoupled from strict event ordering.
  function reduce(state, event) {
    if (!state || !event || !event.type) return state;
    var s = state;
    var t = event.type;

    // ── UNIVERSAL human override + abort, valid from ANY non-terminal state. ──
    // The override is the one injection that always wins (spike §4.4): the
    // operator forces the machine somewhere (e.g. force-complete a sign-off, or
    // resume past a stuck step). 'abort' is the universal kill → failed.
    if (t === 'abort') {
      if (TERMINAL[s.status]) return s;
      return Object.assign({}, s, {
        status: 'failed',
        gate: null,
        resumeTo: null,
        lastEventAt: event.at || s.lastEventAt,
        progress: withProgress(s, event.entry || { at: event.at, kind: 'abort', text: 'Run aborted by operator.' }),
      });
    }
    if (t === 'override') {
      if (TERMINAL[s.status]) return s;
      var forced = event.to && STATES.indexOf(event.to) >= 0 ? event.to : 'overridden';
      return Object.assign({}, s, {
        status: forced,
        override: { at: event.at || null, by: event.by || null, to: forced, note: event.note || null },
        gate: null,
        resumeTo: event.resumeTo || null,
        lastEventAt: event.at || s.lastEventAt,
        progress: withProgress(s, event.entry || { at: event.at, kind: 'override', text: 'Operator override.' }),
      });
    }

    switch (s.status) {
      case 'queued':
        // The adapter resolved the authority/handler chain for each attached
        // task and hands the step ladder in. (queued → authority-resolved)
        if (t === 'authority-resolved') {
          return Object.assign({}, s, {
            status: 'authority-resolved',
            steps: event.steps || [],
            lastEventAt: event.at || s.lastEventAt,
            progress: withProgress(s, event.entry),
          });
        }
        return s;

      case 'authority-resolved':
        // Pick the lowest model-appropriate agent (the adapter consulted the
        // resolver). (authority-resolved → selecting-agent)
        if (t === 'agent-selected') {
          return Object.assign({}, s, {
            status: 'selecting-agent',
            stepIndex: event.stepIndex != null ? event.stepIndex : 0,
            lastEventAt: event.at || s.lastEventAt,
            progress: withProgress(s, event.entry),
          });
        }
        // No in-scope agent here → climb one reports_to edge. (→ escalated)
        if (t === 'escalate') {
          return Object.assign({}, s, {
            status: 'escalated',
            escalationTier: event.tier || s.escalationTier,
            resumeTo: 'authority-resolved',
            lastEventAt: event.at || s.lastEventAt,
            progress: withProgress(s, event.entry),
          });
        }
        return s;

      case 'selecting-agent':
        // Engagement opened; the agent (its resolved model_config) runs. The
        // first step's simulated effort accrues here (the effort number arrives
        // ON the event — the adapter computed it; the reducer only sums).
        if (t === 'start-step' || t === 'progress') {
          return Object.assign({}, s, {
            status: 'running',
            stepIndex: event.stepIndex != null ? event.stepIndex : s.stepIndex,
            effortUnits: s.effortUnits + (event.effort || 0),
            lastEventAt: event.at || s.lastEventAt,
            progress: withProgress(s, event.entry),
          });
        }
        // The operator can pause before the first step even ticks.
        if (t === 'pause') {
          return Object.assign({}, s, {
            status: 'paused',
            resumeTo: 'running',
            lastEventAt: event.at || s.lastEventAt,
            progress: withProgress(s, event.entry || { at: event.at, kind: 'pause', text: 'Run paused.' }),
          });
        }
        // AUTHORITY GATE DURING A RUN (AG-P11.6): the FIRST step is over the
        // performer's scope → climb one reports_to edge AND PARK. A cross-scope
        // escalation is a human-approval gate (no silent climb, no self-authorize).
        // On approval it resumes to 'running' (the step proceeds at the higher rung).
        if (t === 'escalate') {
          return Object.assign({}, s, {
            status: 'escalated',
            escalationTier: event.tier || s.escalationTier,
            gate: { kind: 'escalation', at: event.at || null, by: null },
            resumeTo: 'running',
            lastEventAt: event.at || s.lastEventAt,
            progress: withProgress(s, event.entry),
          });
        }
        return s;

      case 'running':
        // Incremental progress + simulated-effort accrual. The effort number
        // arrives ON the event (adapter computed it); the reducer only sums.
        if (t === 'progress') {
          return Object.assign({}, s, {
            stepIndex: event.stepIndex != null ? event.stepIndex : s.stepIndex,
            effortUnits: s.effortUnits + (event.effort || 0),
            lastEventAt: event.at || s.lastEventAt,
            progress: withProgress(s, event.entry),
          });
        }
        // Agent hit cross-domain confusion → lateral meet before any climb.
        if (t === 'coordinate') {
          return Object.assign({}, s, {
            status: 'coordinating',
            resumeTo: 'running',
            lastEventAt: event.at || s.lastEventAt,
            progress: withProgress(s, event.entry),
          });
        }
        // Agent hit ambiguity ABOVE its authority → climb one edge AND PARK:
        // a cross-scope escalation is a human-approval gate (no silent climb).
        if (t === 'escalate') {
          return Object.assign({}, s, {
            status: 'escalated',
            escalationTier: event.tier || s.escalationTier,
            gate: { kind: 'escalation', at: event.at || null, by: null },
            resumeTo: 'running',
            lastEventAt: event.at || s.lastEventAt,
            progress: withProgress(s, event.entry),
          });
        }
        // Operator paused the live run (spike — held until resume).
        if (t === 'pause') {
          return Object.assign({}, s, {
            status: 'paused',
            resumeTo: 'running',
            lastEventAt: event.at || s.lastEventAt,
            progress: withProgress(s, event.entry || { at: event.at, kind: 'pause', text: 'Run paused.' }),
          });
        }
        // All steps done. If the run is owner-gated, PARK at await-owner-gate —
        // the human must accept before 'done' (NO silent progression). Else done.
        if (t === 'steps-complete') {
          if (s.ownerGated) {
            return Object.assign({}, s, {
              status: 'await-owner-gate',
              gate: { kind: 'owner', at: event.at || null, by: null },
              resumeTo: 'done',
              lastEventAt: event.at || s.lastEventAt,
              progress: withProgress(s, event.entry || { at: event.at, kind: 'gate', text: 'Build complete — awaiting owner acceptance.' }),
            });
          }
          return Object.assign({}, s, {
            status: 'done',
            gate: null,
            lastEventAt: event.at || s.lastEventAt,
            progress: withProgress(s, event.entry || { at: event.at, kind: 'done', text: 'Run complete.' }),
          });
        }
        if (t === 'fail') {
          return Object.assign({}, s, {
            status: 'failed',
            lastEventAt: event.at || s.lastEventAt,
            progress: withProgress(s, event.entry || { at: event.at, kind: 'fail', text: 'Run failed.' }),
          });
        }
        return s;

      case 'coordinating':
        // Peers agreed → resume running at the same tier (human never touched).
        if (t === 'resume' || t === 'coordinated') {
          return Object.assign({}, s, {
            status: s.resumeTo || 'running',
            resumeTo: null,
            lastEventAt: event.at || s.lastEventAt,
            progress: withProgress(s, event.entry),
          });
        }
        // Peers can't agree / call is above them → climb (becomes a gate).
        if (t === 'escalate') {
          return Object.assign({}, s, {
            status: 'escalated',
            escalationTier: event.tier || s.escalationTier,
            gate: { kind: 'escalation', at: event.at || null, by: null },
            resumeTo: 'running',
            lastEventAt: event.at || s.lastEventAt,
            progress: withProgress(s, event.entry),
          });
        }
        return s;

      case 'escalated':
        // HUMAN-APPROVAL GATE: a cross-scope escalation PARKS here. Only an
        // explicit operator approve advances it. On approve it re-enters at the
        // HIGHER tier (the spike's "re-enters authority-resolved at the higher
        // tier" — the climb resumes one rung up).
        if (t === 'approve-escalation') {
          return Object.assign({}, s, {
            status: s.resumeTo || 'authority-resolved',
            gate: null,
            escalationTier: event.tier || s.escalationTier,
            resumeTo: null,
            lastEventAt: event.at || s.lastEventAt,
            progress: withProgress(s, event.entry || { at: event.at, kind: 'approve', text: 'Operator approved escalation.' }),
          });
        }
        // Escalation reached the owner with no path → genuine dead-end.
        if (t === 'blocked') {
          return Object.assign({}, s, {
            status: 'blocked',
            lastEventAt: event.at || s.lastEventAt,
            progress: withProgress(s, event.entry || { at: event.at, kind: 'blocked', text: 'Dead-end: no authority below the owner holds this.' }),
          });
        }
        return s;

      case 'await-owner-gate':
        // HUMAN-APPROVAL GATE: only an explicit operator accept advances to
        // done. NO event other than accept (or a redirect/abort) moves it — this
        // is the one state that consumes the owner's attention by design.
        if (t === 'accept-gate') {
          return Object.assign({}, s, {
            status: 'done',
            gate: null,
            resumeTo: null,
            lastEventAt: event.at || s.lastEventAt,
            progress: withProgress(s, event.entry || { at: event.at, kind: 'accept', text: 'Owner accepted — run complete.' }),
          });
        }
        // The owner can send it back for changes (→ running) instead of accept.
        if (t === 'request-changes') {
          return Object.assign({}, s, {
            status: 'running',
            gate: null,
            resumeTo: null,
            lastEventAt: event.at || s.lastEventAt,
            progress: withProgress(s, event.entry || { at: event.at, kind: 'changes', text: 'Owner requested changes.' }),
          });
        }
        return s;

      case 'paused':
        // Held until the operator resumes — resumes at the captured resumeTo.
        if (t === 'resume') {
          return Object.assign({}, s, {
            status: s.resumeTo || 'running',
            resumeTo: null,
            lastEventAt: event.at || s.lastEventAt,
            progress: withProgress(s, event.entry || { at: event.at, kind: 'resume', text: 'Run resumed.' }),
          });
        }
        return s;

      case 'overridden':
        // An override that didn't itself name a target resumes on a resume event.
        if (t === 'resume') {
          return Object.assign({}, s, {
            status: s.resumeTo || 'running',
            resumeTo: null,
            lastEventAt: event.at || s.lastEventAt,
            progress: withProgress(s, event.entry),
          });
        }
        return s;

      // done / failed / blocked are terminal — every event is a no-op.
      default:
        return s;
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // 2) THE ADAPTER SEAM.
  //
  // A narrow, stable interface the runtime calls so the external runner is
  // SWAPPABLE. A real adapter (LangGraph.js) implements this same shape and
  // drops in WITHOUT touching the reducer or the facade:
  //
  //   start(run, emit)   -> begin executing `run`; call emit(event) to push
  //                         lifecycle events INTO the reducer. The adapter owns
  //                         ALL timing (Date.now, setTimeout) — the reducer never
  //                         schedules. Returns an opaque handle.
  //   pause(runId)       -> hold the run (the adapter stops scheduling steps).
  //   resume(runId)      -> continue from where it parked.
  //   abort(runId)       -> stop and discard.
//   acceptGate(runId)  -> the operator cleared an owner-gate; the adapter may
//                         resume scheduling (the gate transition itself is the
//                         reducer's 'accept-gate' event).
//   requestChanges(runId) [OPTIONAL] -> the owner sent a gated run back for
//                         changes; a multi-pass adapter clears its completion
//                         latch and re-walks the ladder (effort already accrued
//                         is NOT re-counted). Absent on single-pass adapters,
//                         the facade falls back to resume(runId).
  //
  // The seam carries NO lifecycle knowledge — it only schedules work and emits
  // events; the reducer is the single source of truth for state. That is the
  // swap point: LangGraph's graph/checkpointer/stream map onto start/pause/
  // resume/emit with zero reducer changes (decision-of-record §"How it maps").
  // ════════════════════════════════════════════════════════════════════════

  // ── THE MOCK / NO-OP ADAPTER (the first adapter). ──────────────────────────
  // Drives the full lifecycle + UI with NO real model calls. It uses timers
  // (HERE, in the adapter — never in the reducer) to advance steps and emits
  // onProgress. It resolves the performing agent + model_config per step via the
  // dispatch resolver (window.CrewsResolver, READ-ONLY) / tier defaults, and
  // accrues SIMULATED EFFORT only (representational units, NEVER money).
  function createMockAdapter(opts) {
    opts = opts || {};
    // step cadence — short so the UI animates; configurable for tests/demo.
    var STEP_MS = opts.stepMs != null ? opts.stepMs : 700;
    // runId -> { timer, emit, paused, steps, i, done, gateHold, gen }. Handles
    // are freed on abort and on owner-gate acceptance (the two terminal exits);
    // a non-gated natural completion retains its handle until one of those.
    var handles = {};

    // Resolve the per-step ladder for a run from the console's resolver preview
    // (READ-ONLY). Each attached task contributes its handler-chain rungs; we
    // label each rung with the performer tier + representational model class +
    // the simulated effort it accrues. NO model call, NO money.
    function resolveSteps(run) {
      var steps = [];
      var tasks = (run && run.tasks) || [];
      for (var ti = 0; ti < tasks.length; ti++) {
        var task = tasks[ti];
        var preview = task.preview || null;
        // The chain is a list of persona ids (lead→…→junior) from resolveHandler.
        var chain = (preview && preview.chain) || [];
        if (!chain.length) {
          // No preview chain (resolver offline) — fall back to a single rung at
          // the task's required authority tier so the run still drives.
          var tier = (task.contract && task.contract.required_authority) || 'senior';
          steps.push({
            taskId: task.id, tier: tier, performer: null,
            // carried exactly as on chain-built rungs so the AG-P11.6 authority
            // gate evaluates uniformly (the performer here is null, so the gate
            // itself stays a pass-through until a real performer resolves).
            requiredAuthority: (task.contract && task.contract.required_authority) || null,
            model: TIER_MODEL[tier] || 'balanced', effort: effortForTier(tier),
          });
          continue;
        }
        // One step per rung; resolve each persona's tier + model_config label.
        var byId = lookupPersonas();
        // The task's declared authority demand (AG-P11.6 authority-gate-during-
        // run): a step whose performer sits BELOW this demand is over-scope and
        // must pause to escalation rather than self-authorize. Read-only off the
        // console's inferred contract; absent ⇒ no over-scope demand.
        var reqAuthority = (task.contract && task.contract.required_authority) || null;
        for (var ci = 0; ci < chain.length; ci++) {
          var pid = chain[ci];
          var persona = byId[pid] || null;
          var ptier = (persona && (persona.tier || persona.level)) || 'senior';
          steps.push({
            taskId: task.id,
            tier: ptier,
            performer: pid,
            // carried so the authority gate (maestro-intervention.overScope-
            // Escalation) can decide, mid-run, if this step is over the
            // performer's scope. NEVER self-authorized — an over-scope step climbs.
            requiredAuthority: reqAuthority,
            model: modelLabelFor(persona, ptier),
            effort: effortForTier(ptier),
          });
        }
      }
      return steps;
    }

    return {
      name: 'mock',
      start: function (run, emit) {
        var runId = run.runId;
        var steps = resolveSteps(run);
        // A re-dispatched EXPLICIT duplicate runId replaces the prior
        // incarnation: kill its pending timer first or the stale tick would
        // double-drive this new handle. (Custom adapters own their equivalent
        // teardown.)
        if (handles[runId]) clearTimer(handles[runId]);
        // gen counts LADDER WALKS: 0 on the first pass; request-changes bumps it
        // and rewinds i so the run re-drives (a multi-pass adapter).
        var h = { emit: emit, paused: false, steps: steps, i: 0, done: false, gateHold: false, gen: 0 };
        handles[runId] = h;

        // queued → authority-resolved (hand the step ladder to the reducer).
        emit({ type: 'authority-resolved', at: nowIso(), steps: steps,
          entry: { at: nowIso(), kind: 'resolve', text: 'Authority resolved · ' + steps.length + ' step(s) on the handler chain.' } });
        // authority-resolved → selecting-agent (lowest model-appropriate agent).
        var first = steps[0] || null;
        emit({ type: 'agent-selected', at: nowIso(), stepIndex: 0,
          entry: { at: nowIso(), kind: 'select', text: first
            ? 'Selected performer · ' + (first.performer || first.tier) + ' on ' + first.model + '.'
            : 'No performer resolved.' } });

        scheduleNext(runId);
        return { runId: runId };
      },

      pause: function (runId) {
        var h = handles[runId];
        if (h) { h.paused = true; clearTimer(h); }
      },
      resume: function (runId) {
        var h = handles[runId];
        if (h && !h.done) { h.paused = false; h.gateHold = false; scheduleNext(runId); }
      },
      acceptGate: function (runId) {
        // Owner accepted the gate; nothing left to schedule (the run is done on
        // the reducer's accept-gate event) — release the handle entirely (the
        // facade only calls here after the transition actually happened).
        var h = handles[runId];
        if (h) { h.gateHold = false; clearTimer(h); delete handles[runId]; }
      },
      requestChanges: function (runId) {
        // The owner sent a gated run BACK for changes: clear the completion
        // latch, rewind to step 0, and bump the walk generation so already-
        // counted steps re-animate WITHOUT accruing their effort twice.
        var h = handles[runId];
        if (!h) return;
        h.done = false;
        h.paused = false;
        h.gateHold = false;
        h.gen += 1;
        h.i = 0;
        scheduleNext(runId);
      },
      abort: function (runId) {
        var h = handles[runId];
        if (h) { clearTimer(h); h.done = true; delete handles[runId]; }
      },
    };

    // ── Internal scheduling (the ONLY place timers live). ────────────────────
    function scheduleNext(runId) {
      var h = handles[runId];
      if (!h || h.paused || h.done || h.gateHold) return;
      clearTimer(h);
      h.timer = setTimeout(function () { tick(runId); }, STEP_MS);
    }

    function tick(runId) {
      var h = handles[runId];
      if (!h || h.paused || h.done || h.gateHold) return;
      var step = h.steps[h.i];
      if (!step) {
        // All steps walked → tell the reducer (it decides owner-gate vs done).
        h.done = true;
        h.emit({ type: 'steps-complete', at: nowIso(),
          entry: { at: nowIso(), kind: 'steps', text: 'All steps complete.' } });
        return;
      }
      // ── AUTHORITY GATE DURING A RUN (AG-P11.6 subtask 3). Before running a
      // step, consult the over-scope gate (crews-assign delegationReason, READ-
      // ONLY, via maestro-intervention). An over-scope step does NOT self-
      // authorize: it PAUSES TO ESCALATION (climb one reports_to edge) and HOLDS
      // until the operator approves. We mark the handle gateHold so the adapter
      // stops scheduling; resume() (after approve-escalation) clears the demand on
      // THIS step so the climb resumes one rung up without re-parking forever.
      if (!step.__escalated) {
        var esc = overScopeFor(step);
        if (esc) {
          step.__escalated = true; // climbed once; on resume it proceeds at the higher tier
          h.gateHold = true;       // stop scheduling — the escalation is a human-approval gate
          h.emit({
            type: 'escalate', at: nowIso(), tier: esc.tier,
            entry: {
              at: nowIso(), kind: 'escalate',
              text: 'Over-scope step · ' + (step.performer || step.tier) +
                ' cannot decide at ' + (step.requiredAuthority || '?') +
                ' — escalating up to ' + (esc.manager || esc.tier) +
                (esc.terminal ? ' (owner backstop).' : '.'),
              escalation: esc, taskId: step.taskId, performer: step.performer,
            },
          });
          return;
        }
      }
      // Emit a running/progress event for this step + its simulated effort.
      // A step re-walked by a LATER generation (after request-changes) emits
      // effort 0 — its units were already accrued on the first walk — so the
      // run's accrual stays monotonic and truthful across re-drives. Re-walks
      // also emit 'progress' from index 0 (the reducer only consumes
      // 'start-step' while selecting-agent).
      var counted = typeof step.__effortGen === 'number' && step.__effortGen < h.gen;
      var eff = counted ? 0 : step.effort;
      h.emit({
        type: (h.gen === 0 && h.i === 0) ? 'start-step' : 'progress',
        at: nowIso(),
        stepIndex: h.i,
        effort: eff,
        entry: {
          at: nowIso(), kind: 'step',
          text: 'Step ' + (h.i + 1) + '/' + h.steps.length + ' · ' +
            (step.performer || step.tier) + ' (' + step.model + ') · +' +
            eff + ' effort unit' + (eff === 1 ? '' : 's'),
          tier: step.tier, model: step.model, taskId: step.taskId, performer: step.performer,
          stepIndex: h.i,
          // the effort ACTUALLY emitted for this walk (0 on re-walks) — the
          // monitor attributes from these entries, so tallies always reconcile
          // with run.effortUnits.
          effort: eff,
        },
      });
      step.__effortGen = h.gen;
      h.i += 1;
      scheduleNext(runId);
    }

    function clearTimer(h) { if (h && h.timer) { clearTimeout(h.timer); h.timer = null; } }
    // The adapter's clock — ISOLATED here, never in the reducer.
    function nowIso() { return new Date().toISOString(); }

    // The authority gate (AG-P11.6). Consults maestro-intervention's READ-ONLY
    // over-scope check (which reuses crews-assign delegationReason) — null when
    // the step is in scope, an escalation descriptor when it is over-scope. The
    // adapter NEVER self-authorizes; it only routes an over-scope step to the
    // escalation gate. Absent the intervention module (e.g. a partial load) the
    // gate is a no-op, so the run still drives.
    function overScopeFor(step) {
      var MI = (opts && opts.intervention) ||
        (typeof window !== 'undefined' && window.MaestroIntervention) || null;
      if (!MI || typeof MI.overScopeEscalation !== 'function') return null;
      try {
        var ctx = (opts && opts.gateCtx) || {
          index: (typeof AG !== 'undefined' && AG.CREWS) ||
            (typeof window !== 'undefined' && window.AG && window.AG.CREWS) || null,
          agents: (typeof window !== 'undefined' && window.CrewsAgents &&
            window.CrewsAgents.listAgents) ? (window.CrewsAgents.listAgents() || []) : [],
        };
        return MI.overScopeEscalation(step, ctx);
      } catch (e) { return null; }
    }
  }

  // ── Persona lookup helpers (READ-ONLY off AG.CREWS / the resolver). ────────
  function lookupPersonas() {
    var crews = (typeof AG !== 'undefined' && AG.CREWS) ||
      (typeof window !== 'undefined' && window.AG && window.AG.CREWS) || { personas: [] };
    var byId = {};
    var personas = (crews && crews.personas) || [];
    for (var i = 0; i < personas.length; i++) {
      if (personas[i] && personas[i].id) byId[personas[i].id] = personas[i];
    }
    return byId;
  }
  function modelLabelFor(persona, tier) {
    if (persona && persona.model_config && typeof persona.model_config === 'object') {
      var mc = persona.model_config;
      return mc.model || mc.tier || mc.provider || TIER_MODEL[tier] || 'balanced';
    }
    return TIER_MODEL[tier] || 'balanced';
  }

  // ════════════════════════════════════════════════════════════════════════
  // 3) THE RUNTIME FACADE — window.MaestroRuntime.
  //
  // Owns the in-memory run table, wires the adapter's emitted events through the
  // PURE REDUCER, notifies subscribers (onProgress) so the UI reflects state,
  // and exposes the operator's gate controls (accept / approve / pause / resume /
  // abort / override). PERSISTENCE IS A SEAM: persistHook(snapshot) fires on
  // every transition but defaults to a no-op — durable P8 records are AG-P11.5.
  // ════════════════════════════════════════════════════════════════════════

  function createRuntime(config) {
    config = config || {};
    var adapter = config.adapter || createMockAdapter(config.adapterOpts);
    // PERSISTENCE SEAM (AG-P11.5 — now FILLED). The hook fires on every transition
    // and appends durable, APPEND-ONLY run/engagement records through the P8 write
    // API (window.MaestroRecords). This is a SIDE-EFFECT at the FACADE boundary —
    // the reducer stays pure (no clock/IO). Resolution order: an explicit
    // config.persistHook (tests) → window.MaestroRecords.createPersistHook()
    // (the real append-only writer; degrades to in-memory representational when
    // there is no write server) → a no-op (records module not loaded).
    var persistHook;
    if (typeof config.persistHook === 'function') {
      persistHook = config.persistHook;
    } else if (typeof window !== 'undefined' && window.MaestroRecords &&
      typeof window.MaestroRecords.createPersistHook === 'function') {
      persistHook = window.MaestroRecords.createPersistHook({ via: 'maestro-runtime' });
    } else {
      persistHook = function () {};
    }

    var runs = {};          // runId -> reducer state
    var subscribers = [];   // onProgress callbacks
    var seq = 0;            // monotonic run counter (NOT a clock — pure counter)

    function notify(runId) {
      var snap = runs[runId];
      // persistence seam — fires every transition (no-op until AG-P11.5).
      try { persistHook(cloneState(snap)); } catch (e) { /* seam must never break the run */ }
      for (var i = 0; i < subscribers.length; i++) {
        try { subscribers[i](cloneState(snap), runId); } catch (e) { /* a bad listener can't break the loop */ }
      }
    }

    // Apply an event through the reducer, store, and notify. The single choke
    // point: ALL state changes flow through here, so the reducer stays the only
    // place state is computed.
    function apply(runId, event) {
      var prev = runs[runId];
      if (!prev) return;
      runs[runId] = reduce(prev, event);
      notify(runId);
    }

    // GATE-CONSENT GUARD helper: did the run actually leave its previous state?
    // The reducer no-ops invalid events by design (out-of-order tolerance);
    // operator controls use this to decide whether the gesture may reach the
    // adapter at all (see the gate controls below).
    function transitioned(runId, prev) {
      var now = runs[runId];
      return !!(now && now.status !== prev);
    }

    // SINGLE RECONCILIATION POINT: after any consent-guarded transition, sync
    // the adapter to the RESULTING status so holds/latches can never desync:
    //   terminal ('done'/'failed'/'blocked')  → abort  (free the handle)
    //   flowing ('running'/'selecting-agent') → resume (the only states whose
    //                                            reducers consume tick events)
    //   everything else                       → pause  (paused / gates /
    //                                            coordinating / queued / …)
    // Forwarding based only on "did it transition" is unsound when the
    // destination is unconstrained (override-planted resumeTo values): resuming
    // into a parked state burns through events the reducer ignores, latches
    // done under the parked run, and later strands a legitimate Resume.
    function syncAdapterToStatus(runId) {
      var now = runs[runId] && runs[runId].status;
      if (!now) return;
      if (now === 'done' || now === 'failed' || now === 'blocked') {
        if (adapter.abort) adapter.abort(runId);
      } else if (now === 'running' || now === 'selecting-agent') {
        if (adapter.resume) adapter.resume(runId);
      } else if (adapter.pause) {
        adapter.pause(runId);
      }
    }

    return {
      // The reducer + states are exposed for tests + advanced adapters.
      reduce: reduce,
      STATES: STATES.slice(),
      adapterName: adapter.name || 'custom',

      // ── dispatch(run): the entry the conduct console calls. Assigns a run id,
      // seeds the initial reducer state, and starts the adapter. NO auto-accept:
      // the adapter only schedules steps; gates wait for the operator.
      dispatch: function (run) {
        seq += 1;
        var runId = (run && run.runId) || ('run-' + seq);
        var seeded = Object.assign({}, run, { runId: runId, dispatchedAt: run && run.staged_at || null });
        runs[runId] = initialState(seeded);
        notify(runId);
        // Hand to the adapter; it emits events back through apply().
        try {
          adapter.start(seeded, function (event) { apply(runId, event); });
        } catch (e) {
          apply(runId, { type: 'fail', entry: { kind: 'fail', text: 'Adapter failed to start: ' + (e && e.message || e) } });
        }
        return { runId: runId, status: runs[runId] && runs[runId].status };
      },

      // ── Run-state exposure for the UI. ──
      getRun: function (runId) { return cloneState(runs[runId]); },
      listRuns: function () {
        return Object.keys(runs).map(function (id) { return cloneState(runs[id]); });
      },
      // onProgress(cb) — subscribe to every transition; returns an unsubscribe.
      onProgress: function (cb) {
        if (typeof cb !== 'function') return function () {};
        subscribers.push(cb);
        return function () {
          var i = subscribers.indexOf(cb);
          if (i >= 0) subscribers.splice(i, 1);
        };
      },

      // ── HUMAN APPROVAL GATE controls (the operator's hands). ──
      // GATE-CONSENT GUARD + UNIFIED RECONCILIATION: every control captures the
      // run's status BEFORE applying its event, and only a REAL transition may
      // touch the adapter — via syncAdapterToStatus() (above), which reconciles
      // the adapter with whatever state the run LANDED in. Without this, a
      // transition that lands on a parked/gated state could leave the adapter
      // running (burning through ignored events and latching done), after
      // which a legitimate control forwards into the dead latch and strands
      // the run. Unknown runIds are inert. abort is the exception: as the
      // universal kill it ALWAYS reaches the adapter (freeing the handle even
      // off a terminal state).
      // Owner-gate acceptance — the only path past await-owner-gate.
      acceptGate: function (runId, by) {
        var prev = runs[runId] && runs[runId].status;
        if (!prev) return;
        apply(runId, { type: 'accept-gate', at: isoNow(), by: by || null });
        if (transitioned(runId, prev)) syncAdapterToStatus(runId);
      },
      requestChanges: function (runId, by) {
        var prev = runs[runId] && runs[runId].status;
        if (!prev) return;
        apply(runId, { type: 'request-changes', at: isoNow(), by: by || null });
        if (!transitioned(runId, prev)) return;
        // Destination is always flowing ('running'): prefer the multi-pass
        // re-walk; single-pass adapters fall back to resume (which they may
        // no-op once their completion latch is set).
        if (adapter.requestChanges) adapter.requestChanges(runId);
        else syncAdapterToStatus(runId);
      },
      // Cross-scope escalation approval — the only path past escalated.
      approveEscalation: function (runId, by) {
        var prev = runs[runId] && runs[runId].status;
        if (!prev) return;
        apply(runId, { type: 'approve-escalation', at: isoNow(), by: by || null });
        if (transitioned(runId, prev)) syncAdapterToStatus(runId);
      },

      // ── pause / resume / abort (intervention; full set lands in AG-P11.6). ──
      pause: function (runId) {
        var prev = runs[runId] && runs[runId].status;
        if (!prev) return;
        apply(runId, { type: 'pause', at: isoNow() });
        if (transitioned(runId, prev)) syncAdapterToStatus(runId);
      },
      resume: function (runId) {
        var prev = runs[runId] && runs[runId].status;
        if (!prev) return;
        apply(runId, { type: 'resume', at: isoNow() });
        if (transitioned(runId, prev)) syncAdapterToStatus(runId);
      },
      abort: function (runId, by) {
        var prev = runs[runId] && runs[runId].status;
        if (!prev) return;
        if (adapter.abort) adapter.abort(runId);
        apply(runId, { type: 'abort', at: isoNow(), by: by || null });
      },

      // ── UNIVERSAL human override (from any state). ──
      // The override forces the REDUCER anywhere; the adapter is then synced to
      // the POST-override status via syncAdapterToStatus() so holds/latches can
      // never desync (see its rule above). Forcing a PARKED state captures
      // where we came from as the resume target (unless the caller supplied
      // one) — otherwise the gate's exit path (`resumeTo ||
      // 'authority-resolved'`) would strand the run after the operator clears
      // the gate. Unknown runIds are inert.
      override: function (runId, to, opts) {
        opts = opts || {};
        var prev = runs[runId] && runs[runId].status;
        if (!prev) return;
        var resumeTo = opts.resumeTo ||
          ((to === 'paused' || to === 'escalated' || to === 'await-owner-gate') ? prev : null);
        apply(runId, { type: 'override', at: isoNow(), to: to, by: opts.by || null, note: opts.note || null, resumeTo: resumeTo });
        if (transitioned(runId, prev)) syncAdapterToStatus(runId);
      },

      // For tests/advanced hosts: inject a raw event through the reducer.
      _emit: function (runId, event) { apply(runId, event); },
    };
  }

  // Facade-level clock (the facade may stamp operator-action times) — this is
  // NOT the reducer; the reducer remains clock-free. Kept here so the reducer
  // source is provably free of new Date / Date.now.
  function isoNow() { return new Date().toISOString(); }

  // Shallow-clone a reducer state for handing OUT (so a subscriber can't mutate
  // the runtime's internal state). progress/steps are copied by reference value
  // arrays (already immutable-by-convention).
  function cloneState(s) {
    if (!s) return null;
    return Object.assign({}, s, {
      progress: s.progress ? s.progress.slice() : [],
      steps: s.steps ? s.steps.slice() : [],
      tasks: s.tasks ? s.tasks.slice() : [],
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // 4) A MINIMAL IN-PANE RUN-STATE READOUT (MaestroRunPanel).
  //
  // The full monitoring board is AG-P11.4 — this is the minimal readout the
  // conduct console mounts so the operator SEES the mock lifecycle drive
  // (queued→running→…→done), the gate controls when parked, the simulated-effort
  // accrual, and a progress log. It SUBSCRIBES via onProgress and re-renders.
  // ════════════════════════════════════════════════════════════════════════

  var STATE_LABEL = {
    queued: 'Queued', 'authority-resolved': 'Authority resolved', 'selecting-agent': 'Selecting agent',
    running: 'Running', coordinating: 'Coordinating', escalated: 'Escalated — approval needed',
    'await-owner-gate': 'Awaiting owner acceptance', paused: 'Paused', overridden: 'Overridden',
    done: 'Done', failed: 'Failed', blocked: 'Blocked — dead-end',
  };

  function MaestroRunPanel(props) {
    var runtime = props.runtime || (typeof window !== 'undefined' && window.MaestroRuntime);
    var runId = props.runId;
    var R = (typeof React !== 'undefined') ? React : null;
    if (!R || !runtime || !runId) return null;

    var stateHook = R.useState(function () { return runtime.getRun(runId); });
    var run = stateHook[0]; var setRun = stateHook[1];

    R.useEffect(function () {
      // Pull the latest immediately + subscribe to every transition.
      setRun(runtime.getRun(runId));
      var off = runtime.onProgress(function (snap, id) {
        if (id === runId) setRun(snap);
      });
      return off;
    }, [runId]);

    if (!run) return null;

    var st = run.status;
    var atGate = st === 'await-owner-gate' || st === 'escalated';
    var live = st !== 'done' && st !== 'failed' && st !== 'blocked';

    return R.createElement('section', { className: 'maestro-run dept-reg', 'data-state': st, role: 'status', 'aria-label': 'Run ' + runId + ' lifecycle' },
      R.createElement('div', { className: 'maestro-run-head' },
        R.createElement('span', { className: 'maestro-run-id' }, runId),
        R.createElement('span', { className: 'maestro-run-state state-' + st }, STATE_LABEL[st] || st),
        R.createElement('span', { className: 'maestro-run-effort', title: 'Representational simulated effort — never money' },
          run.effortUnits + ' effort unit' + (run.effortUnits === 1 ? '' : 's'))
      ),
      // Gate controls — NO silent progression: the operator must act here.
      atGate ? R.createElement('div', { className: 'maestro-run-gate' },
        R.createElement('span', { className: 'maestro-run-gate-lab' },
          st === 'await-owner-gate'
            ? 'Owner gate — the build is done; approve to complete.'
            : 'Escalation — a step exceeded its authority; approve to climb.'),
        R.createElement('div', { className: 'maestro-run-gate-actions' },
          st === 'await-owner-gate'
            ? [
                R.createElement('button', { key: 'acc', type: 'button', className: 'maestro-btn primary',
                  onClick: function () { runtime.acceptGate(runId, props.actor || 'operator'); } }, 'Accept'),
                R.createElement('button', { key: 'chg', type: 'button', className: 'maestro-btn ghost',
                  onClick: function () { runtime.requestChanges(runId, props.actor || 'operator'); } }, 'Request changes'),
              ]
            : R.createElement('button', { type: 'button', className: 'maestro-btn primary',
                onClick: function () { runtime.approveEscalation(runId, props.actor || 'operator'); } }, 'Approve escalation'))
      ) : null,
      // Live intervention controls.
      live ? R.createElement('div', { className: 'maestro-run-controls' },
        st === 'paused'
          ? R.createElement('button', { type: 'button', className: 'maestro-btn ghost',
              onClick: function () { runtime.resume(runId); } }, 'Resume')
          : (st === 'running'
              ? R.createElement('button', { type: 'button', className: 'maestro-btn ghost',
                  onClick: function () { runtime.pause(runId); } }, 'Pause')
              : null),
        R.createElement('button', { type: 'button', className: 'maestro-btn ghost danger',
          onClick: function () { runtime.abort(runId, props.actor || 'operator'); } }, 'Abort')
      ) : null,
      // Progress log (most recent last).
      R.createElement('ul', { className: 'maestro-run-log' },
        (run.progress || []).slice(-8).map(function (e, i) {
          return R.createElement('li', { key: i, className: 'maestro-run-logitem kind-' + (e.kind || 'step') },
            R.createElement('span', { className: 'maestro-run-logtext' }, e.text || e.kind));
        }))
    );
  }

  // ── Exports. ───────────────────────────────────────────────────────────────
  // window.MaestroRuntime is the live facade the conduct console dispatches to.
  // MaestroRuntimeKit exposes the pure pieces (reduce, states, adapter factory,
  // initialState) for tests + the real-adapter increment.
  var runtime = createRuntime();

  if (typeof window !== 'undefined') {
    window.MaestroRuntime = runtime;
    // ── AG-P11.6 INTERVENTION WIRING. Wrap the live facade so EVERY operator
    // gesture (pause/resume/abort/approve-escalation/override/accept/changes)
    // emits an append-only, provenance-stamped audit record (acting persona +
    // timestamp) via the AG-P11.5 P8 write API. The wrapper is a SIDE EFFECT at
    // the facade boundary — the reducer above stays pure. maestro-intervention.js
    // loads BEFORE this babel module (head plain script), so it is present here;
    // the wrap is idempotent. Absent (partial load) the runtime works unwrapped.
    try {
      if (window.MaestroIntervention &&
        typeof window.MaestroIntervention.wireInterventions === 'function') {
        window.MaestroIntervention.wireInterventions(runtime, {});
      }
    } catch (e) { /* never break runtime load on the audit seam */ }
    window.MaestroRunPanel = MaestroRunPanel;
    window.MaestroRuntimeKit = {
      reduce: reduce,
      STATES: STATES.slice(),
      TERMINAL: Object.assign({}, TERMINAL),
      initialState: initialState,
      createMockAdapter: createMockAdapter,
      createRuntime: createRuntime,
      effortForTier: effortForTier,
    };
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      reduce: reduce,
      STATES: STATES.slice(),
      TERMINAL: Object.assign({}, TERMINAL),
      initialState: initialState,
      createMockAdapter: createMockAdapter,
      createRuntime: createRuntime,
      effortForTier: effortForTier,
    };
  }
})();
