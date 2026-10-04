// ─────────────────────────────────────────────────────────────────────────
// Agentarium — Maestro RUN + ENGAGEMENT RECORDS (AG-P11.5)
//
// The durable, APPEND-ONLY audit trail of a conducted run. This is the task
// that FULFILLS the engagement records AG-P7.8 stubbed: the Crews Usage view
// reads representational/draft data today; this module writes the canonical
// append-only store and the Usage view re-points at it.
//
// WHAT THIS FILE IS (a side-effect boundary, NOT in the reducer):
//   1. RECORD SHAPES — pure builders that turn a runtime snapshot (the PURE
//      reducer's state, AG-P11.3) into:
//        • a RUN RECORD     — run id, attached task(s), performing agent(s) +
//          resolved model_config, lifecycle transitions, escalation/coordination
//          path, owner-gate acceptances, simulated-effort units.
//        • ENGAGEMENT RECORDS — persona/agent ↔ task ↔ run with started_at /
//          ended_at, one per performer-step engagement.
//   2. PERSISTENCE — POST through the P8 persona-gated write API (append-only:
//      POST /api/runs, POST /api/engagements — messages/decisions semantics, never
//      overwritten, provenance-stamped server-side). When NO write server is
//      reachable (local/snapshot mode), records are kept IN-MEMORY and clearly
//      marked representational — the run NEVER crashes for lack of a server.
//   3. persistHook FACTORY — createPersistHook() returns the function the runtime
//      facade invokes on every lifecycle transition. The hook is throttled to the
//      meaningful moments (status change + terminal) so a run leaves exactly one
//      run record (updated append on terminal) and an engagement per step.
//
// GUARDRAILS (constitution):
//   • SIMULATED EFFORT, NEVER MONEY — records carry dimensionless effort units
//     only. There is no currency/money string anywhere in this file.
//   • REVIEWER-ONLY VERDICTS — this module NEVER writes pm_*/verdict fields. A
//     verdict seam is carried as a read-only pointer ONLY (verdict_ref), never a
//     pm_* write. The server also rejects any record bearing pm_*/verdict.
//   • PURE REDUCER UNTOUCHED — persistence is a side-effect at the adapter/facade
//     boundary; this file is loaded as a plain side-effect module and the reducer
//     in maestro-runtime.jsx stays clock/IO-free.
//
// Dual-export: attaches window.MaestroRecords for the browser AND exports via
// module.exports for node tests (mirrors agentarium/crews-usage.js).
// ─────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // Representational simulated-effort label — dimensionless units, NEVER money.
  var EFFORT_UNITS = 'effort';

  // ── Write-auth persona resolution (read-only). This is the persona the P8
  // write API authorizes the append against — it MUST be a roles.json-defined
  // persona that holds runs:append (e.g. human-raj / be). It is DISTINCT from the
  // run's CONDUCTOR (a crew-tree persona id like 'executive-owner' that is NOT in
  // roles.json) — the conductor is carried as a record FIELD, not the auth header.
  // Order: explicit opts.persona → the project's acting persona → operator default.
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

  // ── The record's acting_persona field — the conductor of the run (provenance on
  // the record body), falling back to the write persona. NOT the auth header.
  function actingPersonaFor(snapshot, opts) {
    if (snapshot && snapshot.conductor) return snapshot.conductor;
    return writePersonaFor(opts);
  }

  // ── 1) RECORD SHAPES ──────────────────────────────────────────────────────

  // Build the RUN RECORD from a runtime snapshot (the reducer state handed out by
  // the facade). Pure — reads the snapshot, returns a plain object. The snapshot
  // already carries every field we need (the reducer accrued them); we project
  // them into the durable shape. `at` is supplied by the caller (the side-effect
  // boundary owns the clock — this builder stays deterministic for tests).
  function buildRunRecord(snapshot, opts) {
    opts = opts || {};
    var s = snapshot || {};
    var tasks = Array.isArray(s.tasks) ? s.tasks : [];
    var progress = Array.isArray(s.progress) ? s.progress : [];
    var steps = Array.isArray(s.steps) ? s.steps : [];

    // Lifecycle transitions: the ordered status-bearing progress entries +
    // the current status. Each is { at, kind, text }.
    var transitions = progress
      .filter(function (e) { return e && (e.kind || e.text); })
      .map(function (e) {
        return { at: e.at || null, kind: e.kind || 'step', text: e.text || '' };
      });

    // Escalation / coordination path: the rungs the run climbed/met on, drawn
    // from the escalation-flavoured progress entries.
    var escalationPath = progress
      .filter(function (e) { return e && (e.kind === 'escalate' || e.kind === 'coordinate' || e.kind === 'approve'); })
      .map(function (e) { return { at: e.at || null, kind: e.kind, text: e.text || '' }; });

    // Owner-gate acceptances: the accept/changes entries (human-in-the-loop).
    var ownerGateAcceptances = progress
      .filter(function (e) { return e && (e.kind === 'accept' || e.kind === 'gate' || e.kind === 'changes'); })
      .map(function (e) { return { at: e.at || null, kind: e.kind, text: e.text || '' }; });

    // Performing agents + resolved model_config, projected from the step ladder.
    var performers = steps.map(function (st) {
      return {
        task_id: st.taskId || null,
        performer: st.performer || null,
        tier: st.tier || null,
        model_config: st.model || null,   // representational model label (no call)
        effort_units: typeof st.effort === 'number' ? st.effort : 0,
      };
    });

    return {
      kind: 'run',
      run_id: s.runId || opts.runId || null,
      // The record's OWN unique id (the filename key). A run emits one record per
      // lifecycle transition; each is immutable + append-only. The group is run_id;
      // record_id distinguishes the rungs of the trail so none overwrites another.
      record_id: opts.recordId ||
        ((s.runId || opts.runId || 'run') + '-' + (s.status || 'state')),
      status: s.status || null,
      conductor: s.conductor || null,
      acting_persona: actingPersonaFor(s, opts),
      attached_tasks: tasks.map(function (t) {
        return {
          id: t.id || null,
          owner_id: t.owner_id || null,
          contract: t.contract || null,
        };
      }),
      performers: performers,
      lifecycle_transitions: transitions,
      escalation_path: escalationPath,
      owner_gate_acceptances: ownerGateAcceptances,
      owner_gated: !!s.ownerGated,
      // SIMULATED EFFORT — representational units, NEVER money.
      effort_units: typeof s.effortUnits === 'number' ? s.effortUnits : 0,
      effort_unit_label: EFFORT_UNITS,
      // Reviewer-only sign-off seam: a READ-ONLY pointer the Reviewer (Verdicts)
      // can later attach to; the runtime NEVER writes a pm_* / verdict value.
      verdict_ref: null,
      started_at: opts.startedAt || (transitions[0] && transitions[0].at) || null,
      ended_at: opts.endedAt || (isTerminal(s.status) ? (s.lastEventAt || null) : null),
      via: opts.via || 'maestro-runtime',
      at: opts.at || null,
    };
  }

  // Build the ENGAGEMENT RECORDS for a snapshot: one per performer-step, linking
  // persona/agent ↔ task ↔ run with started_at / ended_at and its band/effort.
  // Pure — the caller stamps `at`/timestamps from the snapshot's own event times.
  function buildEngagementRecords(snapshot, opts) {
    opts = opts || {};
    var s = snapshot || {};
    var steps = Array.isArray(s.steps) ? s.steps : [];
    var progress = Array.isArray(s.progress) ? s.progress : [];
    var runId = s.runId || opts.runId || null;
    var persona = actingPersonaFor(s, opts);

    // A selected step has not necessarily run. Only a step progress event
    // proves execution; repeat events from a later walk keep one engagement.
    var executed = {};
    var legacyIndex = 0;
    for (var i = 0; i < progress.length; i++) {
      var e = progress[i];
      if (!e || e.kind !== 'step') continue;
      var idx = Number.isInteger(e.stepIndex) ? e.stepIndex : legacyIndex;
      legacyIndex++;
      if (idx >= 0 && idx < steps.length && !executed[idx]) executed[idx] = e;
    }

    return Object.keys(executed).map(Number).sort(function (a, b) { return a - b; }).map(function (idx) {
      var st = steps[idx];
      var event = executed[idx];
      // Engagement id is deterministic from run + step so a re-emit is idempotent
      // (the append-only server 409s a duplicate — never a silent overwrite).
      var eid = runId ? (runId + '-eng-' + idx) : ('eng-' + idx);
      return {
        kind: 'engagement',
        engagement_id: eid,
        run_id: runId,
        task_id: st.taskId || null,
        // performer link: an agent id OR a persona id (the performer field).
        agent_id: (st.performer && String(st.performer).indexOf('agent-') === 0) ? st.performer : null,
        persona_id: (st.performer && String(st.performer).indexOf('agent-') !== 0) ? st.performer : null,
        performer: st.performer || null,
        tier: st.tier || null,
        // model_config carried so the Usage roll-up can band it (haiku/sonnet/opus
        // → low/med/high) exactly as it does for owner_id-derived load.
        model: st.model || null,
        model_config: st.model || null,
        // representational simulated effort — NEVER money.
        units: typeof event.effort === 'number' ? event.effort :
          (typeof st.effort === 'number' ? st.effort : 0),
        acting_persona: persona,
        // per-step start when known (the step's own log entry), else an
        // explicit per-step stamp, else the run-level start handed in.
        started_at: (st && st.startedAt) || event.at || opts.startedAt || null,
        ended_at: opts.endedAt || null,
        via: opts.via || 'maestro-runtime',
        at: opts.at || null,
      };
    });
  }

  function isTerminal(status) {
    return status === 'done' || status === 'failed' || status === 'blocked';
  }

  // ── 2) PERSISTENCE (P8 append-only write API; degrade to in-memory) ─────────

  // In-memory representational store (local/snapshot mode, or any failed write).
  // Clearly marked: every record carries representational:true here so a reader
  // can tell durable from in-memory.
  var memRuns = [];
  var memEngagements = [];

  function isApiWritable() {
    try {
      return !!(typeof window !== 'undefined' && window.projects &&
        typeof window.projects.isApiWorkspaceActive === 'function' &&
        window.projects.isApiWorkspaceActive());
    } catch (e) { return false; }
  }

  // POST a single record append-only. Returns a Promise resolving to a result
  // contract { ok, via, code?, error? } that NEVER throws (the persistence seam
  // must never break a run). `kind` is 'runs' | 'engagements'.
  function postRecord(kind, record, persona) {
    var acting = persona || record.acting_persona || 'human-raj';
    if (typeof fetch !== 'function' || !isApiWritable()) {
      // Degrade: keep representational, in-memory. No server → no durable write.
      var mem = Object.assign({}, record, { representational: true });
      if (kind === 'runs') memRuns.push(mem); else memEngagements.push(mem);
      return Promise.resolve({ ok: true, via: 'memory', representational: true });
    }
    return fetch('/api/' + kind, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agentarium-Persona': acting },
      body: JSON.stringify(record),
      cache: 'no-store',
    }).then(function (r) {
      if (r.ok) return r.json().then(function (b) { return { ok: true, via: 'api', file: b && b.file }; },
        function () { return { ok: true, via: 'api' }; });
      // 409 = already exists (append-only) → not an error, the record is durable.
      if (r.status === 409) return { ok: true, via: 'api', code: 'exists' };
      // Any other refusal (401/403 persona-gate, 422 rejected field, 500, …)
      // still leaves a representational copy in memory — the local trail never
      // loses a record just because the durable append was refused. ok:false so
      // callers can see the durable write did not land.
      var memFail = Object.assign({}, record, { representational: true, code: 'http-' + r.status });
      if (kind === 'runs') memRuns.push(memFail); else memEngagements.push(memFail);
      return r.json().then(function (b) {
        return { ok: false, via: 'api', code: 'http-' + r.status, error: (b && b.error) || ('HTTP ' + r.status) };
      }, function () {
        return { ok: false, via: 'api', code: 'http-' + r.status };
      });
    }).catch(function (e) {
      // Network down → degrade to in-memory representational; never crash.
      var mem2 = Object.assign({}, record, { representational: true });
      if (kind === 'runs') memRuns.push(mem2); else memEngagements.push(mem2);
      return { ok: true, via: 'memory', representational: true, code: 'network', error: String(e && e.message || e) };
    });
  }

  // Persist a full snapshot: append the run record + one engagement per step.
  // Idempotent by construction (deterministic ids; the server 409s duplicates).
  function persistSnapshot(snapshot, opts) {
    opts = opts || {};
    var at = opts.at || nowIso();
    // The WRITE-AUTH persona (roles.json-resolvable, holds runs:append) — distinct
    // from the record's conductor field (a crew-tree id like executive-owner).
    var persona = writePersonaFor(opts);
    var runRecord = buildRunRecord(snapshot, Object.assign({ at: at }, opts));
    var engagements = buildEngagementRecords(snapshot, Object.assign({ at: at }, opts));
    var results = { run: null, engagements: [] };
    var p = postRecord('runs', runRecord, persona).then(function (res) { results.run = res; });
    var chain = p;
    engagements.forEach(function (eng) {
      chain = chain.then(function () {
        return postRecord('engagements', eng, persona).then(function (res) { results.engagements.push(res); });
      });
    });
    return chain.then(function () { return results; });
  }

  function nowIso() {
    try { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }
    catch (e) { return null; }
  }

  // ── 3) persistHook FACTORY ──────────────────────────────────────────────────
  // The runtime facade calls persistHook(snapshot) on EVERY transition. We append
  // a fresh run record at meaningful moments: the FIRST time a run is seen, on a
  // status CHANGE, and on the TERMINAL transition. Each append is a NEW append-only
  // record (the trail is the sequence) — we never overwrite. Engagements are written
  // once the step ladder is known + on terminal (their started/ended_at fill in).
  function createPersistHook(opts) {
    opts = opts || {};
    var seen = {};       // runId -> last status appended
    var engineEnded = {}; // runId -> true once terminal engagements written
    var occurrence = {}; // runId -> status -> append count (occurrence ordinal)

    // Per-(run, status) ordinal. The builder's default record_id is
    // `runId-status`, which COLLIDES whenever a run revisits a status
    // (pause→resume→pause…, a second escalation) — the append-only server
    // would 409 the second append into a silent drop of that trail entry.
    // The hook owns this counter so every appended record is distinct while
    // buildRunRecord itself stays deterministic for tests.
    function nextOccurrence(runId, status) {
      var byStatus = occurrence[runId] || (occurrence[runId] = {});
      var n = byStatus[status] || 0;
      byStatus[status] = n + 1;
      return n;
    }

    return function persistHook(snapshot) {
      if (!snapshot || !snapshot.runId) return;
      var runId = snapshot.runId;
      var status = snapshot.status;
      var prev = seen[runId];
      var changed = prev !== status;
      var terminal = isTerminal(status);
      // Append on a status change OR the first sighting OR a terminal.
      if (!changed && !(terminal && !engineEnded[runId])) return;
      seen[runId] = status;

      var hookOpts = {
        at: nowIso(),
        // distinct occurrence id per appended trail entry (see nextOccurrence).
        recordId: runId + '-' + status + '-' + nextOccurrence(runId, status),
        startedAt: snapshot.dispatchedAt || (snapshot.progress && snapshot.progress[0] && snapshot.progress[0].at) || null,
        endedAt: terminal ? (snapshot.lastEventAt || nowIso()) : null,
        persona: opts.persona,
        via: opts.via || 'maestro-runtime',
      };
      // Append the run record for this transition. On terminal, also write the
      // engagements (now that started/ended are known). Fire-and-forget: the
      // promise is swallowed so the run is never blocked on the write.
      try {
        if (terminal && !engineEnded[runId]) {
          engineEnded[runId] = true;
          persistSnapshot(snapshot, hookOpts).catch(function () {});
        } else {
          var rec = buildRunRecord(snapshot, hookOpts);
          postRecord('runs', rec, writePersonaFor(hookOpts)).catch(function () {});
        }
      } catch (e) { /* seam must never break the run */ }
    };
  }

  // Read-back helpers for the Usage repoint + Ledgers tie-in. Pull the durable
  // engagement/run records over the API when available, else the in-memory store.
  function loadEngagements() {
    if (typeof fetch !== 'function' || !isApiWritable()) {
      return Promise.resolve(memEngagements.slice());
    }
    return fetch('/api/engagements', { cache: 'no-store' })
      // Non-ok responses REJECT so the catch degrades to the local
      // representational trail (mirroring the write path) instead of silently
      // reporting empty data during server errors.
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('http-' + r.status)); })
      .then(function (j) { return (j && j.records) || []; })
      .catch(function () { return memEngagements.slice(); });
  }
  function loadRuns() {
    if (typeof fetch !== 'function' || !isApiWritable()) {
      return Promise.resolve(memRuns.slice());
    }
    return fetch('/api/runs', { cache: 'no-store' })
      // Same degrade contract as loadEngagements above.
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('http-' + r.status)); })
      .then(function (j) { return (j && j.records) || []; })
      .catch(function () { return memRuns.slice(); });
  }

  // For tests: snapshot the in-memory representational store + reset it.
  function _memory() { return { runs: memRuns.slice(), engagements: memEngagements.slice() }; }
  function _resetMemory() { memRuns.length = 0; memEngagements.length = 0; }

  var api = {
    EFFORT_UNITS: EFFORT_UNITS,
    buildRunRecord: buildRunRecord,
    buildEngagementRecords: buildEngagementRecords,
    isTerminal: isTerminal,
    persistSnapshot: persistSnapshot,
    postRecord: postRecord,
    createPersistHook: createPersistHook,
    loadEngagements: loadEngagements,
    loadRuns: loadRuns,
    isApiWritable: isApiWritable,
    _memory: _memory,
    _resetMemory: _resetMemory,
  };

  if (typeof window !== 'undefined') {
    window.MaestroRecords = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
