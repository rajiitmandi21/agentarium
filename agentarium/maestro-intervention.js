// ─────────────────────────────────────────────────────────────────────────
// Agentarium — Maestro GUARDRAILS, ESCALATION & INTERVENTION (AG-P11.6)
//
// The operator's hands on the podium. Everything here is human-in-the-loop
// REINFORCEMENT over the AG-P11.3 runtime: no run proceeds past a gate or an
// escalation without an explicit operator decision, and EVERY intervention is
// recorded. This module adds the three things the keystone runtime (AG-P11.3)
// and the records store (AG-P11.5) left for the intervention layer:
//
//   1. AUTHORITY GATE DURING A RUN (subtask 3) — overScopeEscalation(step, ctx)
//      reuses crews-assign delegationReason (READ-ONLY) to decide, mid-run,
//      whether a step is INSIDE the performer's authority scope or OVER it. An
//      over-scope step must PAUSE TO ESCALATION (climb one reports_to edge) and
//      wait for an explicit operator approval — it NEVER self-authorizes. The
//      next manager up the reports_to edge is computed read-only too.
//
//   2. INTERVENTION AUDIT TRAIL (subtask 4) — buildInterventionRecord(...) turns
//      a pause/resume/abort/escalation/override (+ acting persona + timestamp)
//      into a clearly-TYPED, append-only record, and recordIntervention(...)
//      POSTs it through the AG-P11.5 P8 write API (POST /api/runs — the SAME
//      append-only, provenance-stamped store the run trail uses; each
//      intervention gets its OWN immutable record_id so none overwrites another).
//      When no write server is reachable it degrades to an in-memory
//      representational store — the run NEVER crashes for lack of a server. NO
//      no money string; NO pm_*/verdict field (the server rejects those at the door).
//
//   3. WIRING (subtasks 1+2) — wireInterventions(runtime, opts) wraps the
//      AG-P11.3 facade so every operator gesture (pause / resume / abort /
//      approveEscalation / override / acceptGate / requestChanges) emits an
//      audit record AS A SIDE EFFECT at the facade boundary. The pure reducer is
//      untouched; the wrapper only observes the gesture and appends a record.
//      The pause/resume/abort/approve transitions themselves are AG-P11.3's —
//      this layer reinforces them (HITL) and records them; it invents NO new
//      reducer state.
//
// GUARDRAILS (constitution):
//   • PURE REDUCER UNTOUCHED — this is a side-effect module; it never reaches
//     into maestro-runtime.jsx's reducer. The clock lives HERE (the boundary),
//     never in the reducer.
//   • READ-ONLY ENGINE REUSE — crews-assign delegationReason is consumed, never
//     modified. No new gating rule is invented.
//   • SIMULATED EFFORT, NEVER MONEY — intervention records carry no effort value
//     and there is no currency/money string anywhere in this file.
//   • REVIEWER-ONLY VERDICTS — this module NEVER writes pm_*/verdict fields.
//   • APPEND-ONLY PROVENANCE — every record is immutable; a distinct record_id
//     per intervention means an append-only TRAIL, never an overwrite.
//
// Dual-export: attaches window.MaestroIntervention for the browser AND exports
// via module.exports for node tests (mirrors agentarium/maestro-records.js).
// ─────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // The full set of operator gestures this layer audits. Each is human-in-the-
  // loop: it exists in the trail ONLY because the operator made the gesture.
  var INTERVENTION_ACTIONS = [
    'pause', 'resume', 'abort', 'approve-escalation', 'override',
    'accept-gate', 'request-changes', 'escalate',
  ];

  // ── crews-assign (READ-ONLY) resolution. The over-scope authority gate REUSES
  // delegationReason; we never modify the engine. Node require()s it; the browser
  // reads window.CrewsAssign.
  function authEngine(opts) {
    if (opts && opts.crewsAssign) return opts.crewsAssign;
    if (typeof window !== 'undefined' && window.CrewsAssign) return window.CrewsAssign;
    if (typeof require === 'function') {
      try { return require('./crews-assign.js'); } catch (e) { /* browser / not found */ }
    }
    return null;
  }

  // ════════════════════════════════════════════════════════════════════════
  // 1) AUTHORITY GATE DURING A RUN (subtask 3).
  //
  // A step is described by { performer, tier, requiredAuthority, taskId }. The
  // performer is a persona id (or agent persona). The step is OVER-SCOPE when the
  // performer may NOT, per crews-assign, hold/decide work at the required
  // authority — i.e. the work needs a delegation the performer cannot make from
  // where it sits in the reports_to tree. We model that exactly as the spike does:
  // the performer would have to delegate the over-scope decision DOWN to itself
  // from a higher tier — which it cannot — so it must CLIMB one reports_to edge.
  //
  // overScopeEscalation(step, ctx) -> null (in scope) | { reason, tier, manager }
  //   ctx = { index, agents, crewsAssign? }  (all read-only)
  //   • null            — the step is inside the performer's scope; run continues.
  //   • { manager, tier } — the step is OVER scope; the run must PAUSE TO
  //     ESCALATION and climb to `manager` (one reports_to edge up), at tier `tier`.
  //
   // The decision is made WITHOUT self-authorizing: we ask delegationReason
   // whether the performer's MANAGER could delegate this step down to the
   // performer. If the performer has NO manager that holds it (already at or
   // above the owner) the climb terminates at the human owner (the backstop).
  // ════════════════════════════════════════════════════════════════════════
  function overScopeEscalation(step, ctx) {
    if (!step) return null;
    ctx = ctx || {};
    var CA = authEngine(ctx);
    if (!CA || typeof CA.buildTree !== 'function') return null; // engine absent → cannot gate
    var tree = CA.buildTree(ctx.index || null);
    var performerId = step.performer || null;
    // An agent performer (agent-*) is gated by its persona position; resolve it.
    if (performerId && /^agent-/.test(String(performerId)) && typeof CA.resolveOwner === 'function') {
      var r = CA.resolveOwner(performerId, ctx.index || null, ctx.agents || []);
      performerId = (r && r.persona && r.persona.id) || performerId;
    }
    var persona = performerId ? tree.byId[performerId] : null;
    if (!persona) return null; // unknown performer → leave to the resolver, don't invent

    // Is the step over the performer's scope? It is over-scope iff the step
    // explicitly declares a required authority tier HIGHER than the performer's
    // tier (the performer cannot decide above its own authority — spike §4.1b).
    var reqTier = step.requiredAuthority || step.required_authority || null;
    if (!reqTier) return null; // no declared over-scope demand → in scope
    var perfRank = TIER_RANK[persona.tier];
    var reqRank = TIER_RANK[reqTier];
    if (perfRank == null || reqRank == null) return null;
    // Lower rank number = higher authority. Over-scope = the requirement sits at a
    // HIGHER authority (smaller rank) than the performer holds.
    if (reqRank >= perfRank) return null; // performer holds enough authority → in scope

    // OVER-SCOPE: climb exactly one reports_to edge to the performer's manager.
    var managerId = persona.reports_to || null;
    var manager = managerId ? tree.byId[managerId] : null;
    // If there is no manager (already owner / detached), terminate at the owner.
    if (!manager) {
      var ownerId = tree.root || null;
      return {
        reason: 'over-scope',
        performer: performerId,
        required_authority: reqTier,
        tier: ownerId ? (tree.byId[ownerId] && tree.byId[ownerId].tier) || 'owner' : 'owner',
        manager: ownerId,
        terminal: true, // the human owner is the backstop
      };
    }
    return {
      reason: 'over-scope',
      performer: performerId,
      required_authority: reqTier,
      tier: manager.tier || null,
      manager: managerId,
      terminal: false,
    };
  }

  // Lower number = higher authority (mirror of the console's MAESTRO_TIER_RANK).
  // Intentionally divergent: this mirror ALSO maps 'leader' → 3 directly, where
  // the console normalizes tier 'leader' to 'lead' at call time — same rank,
  // two spellings accepted.
  var TIER_RANK = { owner: 0, ceo: 1, cxo: 2, lead: 3, leader: 3, senior: 4, junior: 5 };

  // ════════════════════════════════════════════════════════════════════════
  // 2) INTERVENTION AUDIT TRAIL (subtask 4).
  //
  // A clearly-typed, append-only record of ONE operator gesture. It is written
  // through the SAME AG-P11.5 P8 append-only store the run trail uses (POST
  // /api/runs) so the whole audit trail — run-state transitions AND interventions
  // — lives in one provenance-stamped, never-overwritten place. Each intervention
  // carries its OWN record_id so it appends (never overwrites) under its run_id.
  // ════════════════════════════════════════════════════════════════════════

  // Pure builder — deterministic for tests (the caller stamps `at`). Returns a
  // plain record object; carries NO money value and NO pm_*/verdict field.
  function buildInterventionRecord(info) {
    info = info || {};
    var runId = info.runId || info.run_id || null;
    var action = info.action || null;
    var at = info.at || null;
    // record_id: the run, the action, and a per-action sequence so repeated
    // interventions of the same kind on the same run never collide (append-only).
    var seq = info.seq != null ? info.seq : 0;
    var recordId = info.recordId ||
      ((runId || 'run') + '-intervention-' + (action || 'act') + '-' + seq);
    return {
      kind: 'intervention',
      // run_id is the GROUP id the server links the trail by; the intervention is
      // an entry ON the run's trail (append-only), not a separate run record.
      run_id: runId,
      record_id: recordId,
      // the typed action + the acting persona + when (the provenance the subtask
      // mandates: acting persona + timestamp).
      action: action,
      acting_persona: info.actingPersona || info.acting_persona || info.by || null,
      // the run's lifecycle state at the moment of the gesture (context for audit).
      from_status: info.fromStatus || info.from_status || null,
      to_status: info.toStatus || info.to_status || null,
      // for an escalation: which reports_to edge it climbed + why (read-only,
      // from overScopeEscalation). Null for a plain pause/resume/abort.
      escalation: info.escalation || null,
      // free-form operator note (e.g. why they aborted). Never a pm_*/verdict.
      note: info.note || null,
      // explicit human-in-the-loop provenance — this record exists ONLY because
      // the operator made the gesture (no silent/auto intervention).
      via: info.via || 'maestro-intervention',
      gesture: 'operator-intervention',
      at: at,
    };
  }

  // ── In-memory representational store (local/snapshot mode, or any failed
  // write). Every record here carries representational:true so a reader can tell
  // durable from in-memory. ─────────────────────────────────────────────────
  var memInterventions = [];

  function isApiWritable() {
    try {
      return !!(typeof window !== 'undefined' && window.projects &&
        typeof window.projects.isApiWorkspaceActive === 'function' &&
        window.projects.isApiWorkspaceActive());
    } catch (e) { return false; }
  }

  // The write-auth persona the P8 API authorizes the append against — must be a
  // roles.json-resolvable persona that holds runs:append (e.g. human-raj / be).
  // DISTINCT from the record's acting_persona field (the crew-tree conductor).
  function writePersonaFor(opts) {
    if (opts && opts.persona) return opts.persona;
    try {
      if (typeof window !== 'undefined' && window.projects &&
        typeof window.projects.getActingPersona === 'function') {
        return window.projects.getActingPersona();
      }
    } catch (e) { /* ignore */ }
    return 'human-raj';
  }

  // POST a single intervention record append-only through the P8 API. Returns a
  // Promise resolving to a result contract { ok, via, code?, error? } that NEVER
  // throws — the audit seam must never break a run. Records are written to
  // /api/runs (the run trail), gated on runs:append, provenance-stamped server-
  // side. A 409 (duplicate) means the record is already durable — not an error.
  function recordIntervention(info, opts) {
    opts = opts || {};
    var record = buildInterventionRecord(info);
    var persona = writePersonaFor(opts);
    if (typeof fetch !== 'function' || !isApiWritable()) {
      var mem = Object.assign({}, record, { representational: true });
      memInterventions.push(mem);
      return Promise.resolve({ ok: true, via: 'memory', representational: true });
    }
    return fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agentarium-Persona': persona },
      body: JSON.stringify(record),
      cache: 'no-store',
    }).then(function (r) {
      if (r.ok) return { ok: true, via: 'api' };
      if (r.status === 409) return { ok: true, via: 'api', code: 'exists' };
      // A non-409 refusal (403 unauthorized persona, 500, …) still leaves a
      // representational copy in memory: EVERY intervention stays recorded
      // somewhere even when the durable append is refused. ok:false so callers
      // can see the durable write did not land.
      memInterventions.push(Object.assign({}, record,
        { representational: true, code: 'http-' + r.status }));
      return { ok: false, via: 'api', code: 'http-' + r.status };
    }).catch(function (e) {
      var mem2 = Object.assign({}, record, { representational: true });
      memInterventions.push(mem2);
      return { ok: true, via: 'memory', representational: true, code: 'network', error: String(e && e.message || e) };
    });
  }

  function nowIso() {
    try { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }
    catch (e) { return null; }
  }

  // ════════════════════════════════════════════════════════════════════════
  // 3) WIRING (subtasks 1+2) — wrap the AG-P11.3 facade so every operator gesture
  // emits an audit record. The wrapper DELEGATES to the underlying facade method
  // (the real pause/resume/abort/approve transition) and records the gesture as a
  // side effect. It invents NO reducer state and changes NO transition — it
  // reinforces HITL and writes the trail.
  //
  // wireInterventions(runtime, opts) -> the SAME runtime, with its intervention
  // methods wrapped. Idempotent (a second wrap is a no-op). opts:
  //   { persona, actorOf(runId)->personaId, ctx }  (all optional / read-only)
  // ════════════════════════════════════════════════════════════════════════
  function wireInterventions(runtime, opts) {
    if (!runtime || runtime.__interventionWired) return runtime;
    opts = opts || {};
    var seqByRun = {}; // runId -> { action -> count } for per-action append ids

    function nextSeq(runId, action) {
      var byAction = seqByRun[runId] || (seqByRun[runId] = {});
      var n = byAction[action] || 0;
      byAction[action] = n + 1;
      return n;
    }

    // Resolve the acting persona for the record's provenance: an explicit
    // by-argument → the run's conductor → opts.actorOf → opts.persona → operator.
    function actorFor(runId, by) {
      if (by) return by;
      try {
        var run = runtime.getRun && runtime.getRun(runId);
        if (run && run.conductor) return run.conductor;
      } catch (e) { /* ignore */ }
      if (typeof opts.actorOf === 'function') {
        try { var a = opts.actorOf(runId); if (a) return a; } catch (e) { /* ignore */ }
      }
      return opts.persona || 'operator';
    }

    // Append an intervention record for a gesture (fire-and-forget; never blocks
    // the run, never throws).
    function audit(runId, action, by, extra) {
      try {
        var statusNow = null;
        try { var rr = runtime.getRun && runtime.getRun(runId); statusNow = rr && rr.status; } catch (e) {}
        var seq = nextSeq(runId, action);
        var at = nowIso();
        recordIntervention(Object.assign({
          runId: runId,
          action: action,
          actingPersona: actorFor(runId, by),
          at: at,
          seq: seq,
          toStatus: statusNow,
          // OCCURRENCE ID — `seq` is page-session-local, so after a reload the
          // same (run, action) pair recomposes an identical deterministic id
          // and the append-only server 409s the second write into a silent
          // drop. Stamping the boundary clock here keeps every gesture's id
          // unique end-to-end while buildInterventionRecord stays deterministic
          // for tests (it still honours an explicit caller-supplied recordId).
          recordId: (runId || 'run') + '-intervention-' + (action || 'act') + '-' + seq + '-' + at,
        }, extra || {}), { persona: opts.persona }).catch(function () {});
      } catch (e) { /* audit must never break a run */ }
    }

    // Wrap one facade method so it records AFTER delegating to the real method
    // (so to_status reflects the post-transition state).
    function wrap(name, action, extraOf) {
      var orig = runtime[name];
      if (typeof orig !== 'function') return;
      runtime[name] = function (runId, arg2, arg3) {
        var res = orig.call(runtime, runId, arg2, arg3);
        // Per-method `by` resolution — the facade signatures differ:
        //   pause/resume(runId)                 → no explicit actor (the run's
        //                                          conductor resolves instead).
        //   abort / acceptGate / approveEscalation / requestChanges(runId, by)
        //                                       → the actor IS the 2nd argument.
        //   override(runId, to, opts)           → the actor is opts.by (arg3);
        //     arg2 here is the forced TARGET STATE ('done', 'overridden', …) and
        //     must NEVER be recorded as the acting persona.
        var by;
        if (name === 'pause' || name === 'resume') by = null;
        else if (name === 'override') by = (arg3 && arg3.by) || null;
        else by = arg2 || null;
        audit(runId, action, by, extraOf ? extraOf(runId, arg2, arg3) : null);
        return res;
      };
    }

    wrap('pause', 'pause');
    wrap('resume', 'resume');
    wrap('abort', 'abort');
    wrap('approveEscalation', 'approve-escalation');
    wrap('acceptGate', 'accept-gate');
    wrap('requestChanges', 'request-changes');
    wrap('override', 'override', function (runId, to, optsArg) {
      return { toStatus: to, note: (optsArg && optsArg.note) || null,
        by: (optsArg && optsArg.by) || null };
    });

    runtime.__interventionWired = true;
    // Expose the recorder + over-scope gate on the runtime for the adapter/UI.
    runtime.recordIntervention = recordIntervention;
    runtime.overScopeEscalation = overScopeEscalation;
    return runtime;
  }

  // For tests: snapshot + reset the in-memory representational store.
  function _memory() { return memInterventions.slice(); }
  function _resetMemory() { memInterventions.length = 0; }

  var api = {
    INTERVENTION_ACTIONS: INTERVENTION_ACTIONS.slice(),
    overScopeEscalation: overScopeEscalation,
    buildInterventionRecord: buildInterventionRecord,
    recordIntervention: recordIntervention,
    wireInterventions: wireInterventions,
    isApiWritable: isApiWritable,
    _memory: _memory,
    _resetMemory: _resetMemory,
  };

  // Auto-wire the live runtime in the browser so the conduct console's existing
  // controls (MaestroRunPanel) record interventions with ZERO call-site changes.
  // NOTE: under the shipped index.html order this plain script executes BEFORE
  // maestro-runtime.jsx (a babel module), so window.MaestroRuntime does not
  // exist yet and the ACTUAL wiring happens inside maestro-runtime.jsx. This
  // block stays as load-order insurance (if the script order ever flips) and is
  // safe + idempotent either way (guarded by __interventionWired).
  if (typeof window !== 'undefined') {
    window.MaestroIntervention = api;
    if (window.MaestroRuntime) {
      try { wireInterventions(window.MaestroRuntime, {}); } catch (e) { /* never break load */ }
    }
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
