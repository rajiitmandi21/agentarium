// ─────────────────────────────────────────────────────────────────────────
// Crews — Usage / engagement aggregation engine (AG-P7.8, Slice 4)
//
// READ / AGGREGATE ONLY. PURE functions: each takes its inputs and returns a
// roll-up. NOTHING here reads disk at runtime, mutates an input, calls the DOM,
// React, an LLM, or localStorage. (A lazy, READ-ONLY load of crews-index.json
// is provided for node convenience only — never used to mutate anything.)
//
// LOCKED SEMANTICS (plan §4 / views spec §8.2 — HARD REQUIREMENT):
//   Everything this engine measures is REPRESENTATIONAL "effort" — simulated
//   load to help balance crews. It is NEVER money — no currency or financial
//   concept of any kind appears anywhere in this file.
//
// EFFORT MODEL — token/run INTENT BANDS (the decided scale):
//   Map each engagement/assignment's model_config to an intent BAND by model
//   name: contains 'haiku' -> 'low', 'sonnet' -> 'med', 'opus' -> 'high'.
//   Each unit of work contributes effort UNITS by band via a single named,
//   tunable weight table (default { low:1, med:2, high:3 }).
//
// DEGRADED behaviour: when there are no engagement records, roll-ups still
// compute from live `owner_id` counts — each OPEN assignment = 1 unit in the
// owning agent/persona's band (band from its model_config). An owner_id that
// starts 'agent-' resolves through the agent roster to its persona; otherwise
// the owner_id is itself a persona id.
//
// Dual-export: attaches `window.CrewsUsage` for the browser AND exports via
// `module.exports` for node (mirrors agentarium/crews-agents.js).
// ─────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ── The three intent bands and the default, tunable weight table. ─────────
  var BANDS = ['low', 'med', 'high'];
  var DEFAULT_WEIGHTS = { low: 1, med: 2, high: 3 };

  function emptyBandMap() {
    return { low: 0, med: 0, high: 0 };
  }

  /**
   * Map a model_config (or a bare model string) to an intent band by model
   * name. 'haiku' -> 'low', 'sonnet' -> 'med', 'opus' -> 'high'. Anything
   * unknown / missing falls back to 'med' (a neutral middle estimate) so a
   * roll-up never silently drops work.
   *
   * @param {object|string|null} model_config
   * @returns {'low'|'med'|'high'}
   */
  function modelToBand(model_config) {
    var name = '';
    if (model_config == null) {
      name = '';
    } else if (typeof model_config === 'string') {
      name = model_config;
    } else if (typeof model_config === 'object') {
      name = model_config.model || model_config.band_model || '';
    }
    name = String(name).toLowerCase();
    if (name.indexOf('haiku') !== -1) return 'low';
    if (name.indexOf('sonnet') !== -1) return 'med';
    if (name.indexOf('opus') !== -1) return 'high';
    return 'med';
  }

  /**
   * Effort units a single band contributes, per the (tunable) weight table.
   * Unknown bands contribute 0.
   *
   * @param {'low'|'med'|'high'} band
   * @param {object} [weights]   defaults to DEFAULT_WEIGHTS
   * @returns {number}
   */
  function bandUnits(band, weights) {
    var w = weights && typeof weights === 'object' ? weights : DEFAULT_WEIGHTS;
    var v = w[band];
    return typeof v === 'number' && isFinite(v) ? v : 0;
  }

  // ── Internal: build agentId -> persona lookups from the inputs. ───────────
  function indexAgents(agents) {
    var byId = Object.create(null);
    var list = Array.isArray(agents) ? agents : [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (a && a.id) byId[a.id] = a;
    }
    return byId;
  }

  function indexPersonas(index) {
    var byId = Object.create(null);
    var personas = (index && Array.isArray(index.personas)) ? index.personas : [];
    for (var i = 0; i < personas.length; i++) {
      var p = personas[i];
      if (p && p.id) byId[p.id] = p;
    }
    return byId;
  }

  /**
   * Resolve an owner_id (agent or persona) to the bits a roll-up needs:
   * the persona id it counts against, the band (from model_config), and
   * whether the owner is a concrete agent or a delegated persona.
   *
   * @returns {{ ownerKind:'agent'|'persona'|'unknown', agentId:?string,
   *             personaId:?string, band:'low'|'med'|'high', model_config:?object,
   *             name:?string }}
   */
  function resolveOwner(owner_id, agentsById, personasById) {
    var out = {
      ownerKind: 'unknown',
      agentId: null,
      personaId: null,
      band: 'med',
      model_config: null,
      name: null
    };
    if (!owner_id) return out;
    var idStr = String(owner_id);

    var agent = agentsById[idStr] || null;
    var looksLikeAgent = agent || idStr.indexOf('agent-') === 0;

    if (looksLikeAgent) {
      out.ownerKind = 'agent';
      out.agentId = idStr;
      if (agent) {
        out.name = agent.name || null;
        out.personaId = agent.persona_id || null;
        // Agent's own model_config wins; else fall back to its persona's.
        var aMc = agent.model_config || null;
        var aPersona = (agent.persona_id && personasById[agent.persona_id]) || null;
        out.model_config = aMc || (aPersona && aPersona.model_config) || null;
      }
      out.band = modelToBand(out.model_config);
      return out;
    }

    var persona = personasById[idStr] || null;
    if (persona) {
      out.ownerKind = 'persona';
      out.personaId = idStr;
      out.name = persona.title || persona.id || null;
      out.model_config = persona.model_config || null;
      out.band = modelToBand(out.model_config);
      return out;
    }

    return out;
  }

  function deptOf(personaId, personasById) {
    var p = personaId && personasById[personaId];
    return (p && p.department) || 'unassigned';
  }

  // ── Flat-role → persona bridge (parity with crews-assign.js ROLE_PERSONA). ─
  // Legacy flat-role owner_ids (fe/be/tl/spm/sdp/human-raj) must resolve into
  // the persona tree so usage roll-ups see them. The CANONICAL map lives in
  // crews-assign.js (ROLE_PERSONA — scripts/validate-crews.js asserts drift).
  // Resolution order: live browser surface -> node require -> mirrored literal.
  function FLAT_ROLE_FALLBACK() {
    return {
      fe: 'tech-software-developer-senior',
      be: 'data-data-engineer-senior',
      tl: 'tech-software-developer-leader',
      spm: 'product-product-manager-senior',
      sdp: 'executive-cpo',
      'human-raj': 'executive-owner'
    };
  }

  function flatRoleMap() {
    try {
      if (typeof window !== 'undefined' && window.CrewsAssign && window.CrewsAssign.ROLE_PERSONA) {
        return window.CrewsAssign.ROLE_PERSONA;
      }
    } catch (e) { /* fall through */ }
    try {
      if (typeof require === 'function' && typeof module !== 'undefined' && module.exports) {
        var CA = require('./crews-assign.js');
        if (CA && CA.ROLE_PERSONA) return CA.ROLE_PERSONA;
      }
    } catch (e2) { /* fall through */ }
    return FLAT_ROLE_FALLBACK();
  }

  // Map a legacy flat-role id to its persona id; anything else passes through
  // untouched (agent ids / real persona ids / unknowns are never rewritten).
  function mapFlatRole(ownerId, fmap) {
    var s = String(ownerId == null ? '' : ownerId);
    return (fmap && Object.prototype.hasOwnProperty.call(fmap, s)) ? fmap[s] : ownerId;
  }

  // Add `units` into a band map under `key` inside `bucketMap`, creating the
  // bucket (with metadata) on first touch via `seed`.
  function bump(bucketMap, key, band, units, seed) {
    if (!key) return;
    var b = bucketMap[key];
    if (!b) {
      b = seed ? seed() : { bands: emptyBandMap(), units: 0 };
      bucketMap[key] = b;
    }
    b.bands[band] = (b.bands[band] || 0) + units;
    b.units += units;
  }

  /**
   * The aggregator. Returns per-department band totals, per-agent and
   * per-persona effort, a "leaning hardest on…" ranking, an idle list, and a
   * `degraded` flag indicating roll-ups were derived from live owner_id counts
   * (no engagement records).
   *
   * @param {object} args
   * @param {Array}  [args.engagements]  append-only engagement records
   * @param {Array}  [args.tasks]        live tasks (carry owner_id), for degraded
   * @param {object} [args.index]        crews-index.json (personas[])
   * @param {Array}  [args.agents]       agent roster (window.CrewsAgents.listAgents())
   * @param {object} [args.weights]      band weight overrides
   * @returns {object} roll-up
   */
  function rollUp(args) {
    args = args || {};
    var engagements = Array.isArray(args.engagements) ? args.engagements : [];
    var tasks = Array.isArray(args.tasks) ? args.tasks : [];
    var index = args.index || (typeof loadIndex === 'function' && canLoadIndex() ? loadIndex() : null);
    var agentsById = indexAgents(args.agents);
    var personasById = indexPersonas(index);
    var weights = args.weights && typeof args.weights === 'object' ? args.weights : DEFAULT_WEIGHTS;

    var byDept = Object.create(null);   // dept   -> { bands, units }
    var byPersona = Object.create(null); // personaId -> { bands, units, name, department }
    var byAgent = Object.create(null);   // agentId   -> { bands, units, name, personaId, department }

    // Legacy flat-role owner_ids resolve through the crews-assign bridge before
    // owner resolution (see mapFlatRole above).
    var fmap = flatRoleMap();

    var totalUnits = 0;
    var degraded = false;

    function seedPersona(personaId) {
      return function () {
        var p = personasById[personaId];
        return {
          bands: emptyBandMap(), units: 0,
          name: (p && (p.title || p.id)) || personaId,
          department: (p && p.department) || 'unassigned'
        };
      };
    }
    function seedAgent(agentId, personaId) {
      return function () {
        var a = agentsById[agentId];
        return {
          bands: emptyBandMap(), units: 0,
          name: (a && a.name) || agentId,
          personaId: personaId || (a && a.persona_id) || null,
          department: deptOf(personaId || (a && a.persona_id), personasById)
        };
      };
    }

    function record(ownerInfo, band, units) {
      var dept = deptOf(ownerInfo.personaId, personasById);
      bump(byDept, dept, band, units);
      if (ownerInfo.personaId) {
        bump(byPersona, ownerInfo.personaId, band, units, seedPersona(ownerInfo.personaId));
      }
      if (ownerInfo.ownerKind === 'agent' && ownerInfo.agentId) {
        bump(byAgent, ownerInfo.agentId, band, units, seedAgent(ownerInfo.agentId, ownerInfo.personaId));
      }
      totalUnits += units;
    }

    if (engagements.length) {
      // ── Live path: aggregate the append-only engagement records. ──────────
      for (var i = 0; i < engagements.length; i++) {
        var e = engagements[i] || {};
        var ownerId = mapFlatRole(e.agent_id || e.persona_id || e.owner_id, fmap);
        var info = resolveOwner(ownerId, agentsById, personasById);
        // A record may carry its own band/model; prefer the record, else owner.
        var band = e.band && BANDS.indexOf(e.band) !== -1
          ? e.band
          : (e.model ? modelToBand(e.model) : info.band);
        // Units: explicit on the record, else derived from the band weight.
        var units = (typeof e.units === 'number' && isFinite(e.units))
          ? e.units
          : bandUnits(band, weights);
        record(info, band, units);
      }
    } else {
      // ── DEGRADED path: roll-ups from live owner_id counts. ────────────────
      // Each OPEN assignment = 1 work-unit in the owner's band; effort = the
      // band weight. "Open" = a task with an owner_id that is not in a
      // terminal status.
      degraded = true;
      for (var t = 0; t < tasks.length; t++) {
        var task = tasks[t] || {};
        var oid = mapFlatRole(task.owner_id, fmap);
        if (!oid) continue;
        if (isClosedStatus(task.status)) continue;
        var oinfo = resolveOwner(oid, agentsById, personasById);
        if (oinfo.ownerKind === 'unknown') continue;
        var b = oinfo.band;
        record(oinfo, b, bandUnits(b, weights));
      }
    }

    // ── "Leaning hardest on…" — personas ranked by total effort, desc. ──────
    var leaningHardest = Object.keys(byPersona).map(function (pid) {
      var b = byPersona[pid];
      return {
        personaId: pid,
        name: b.name,
        department: b.department,
        units: b.units,
        bands: b.bands
      };
    }).sort(function (a, b) {
      return b.units - a.units || String(a.personaId).localeCompare(String(b.personaId));
    });

    // ── Idle list: known personas (with a model_config — instanceable) that ─
    // carry ZERO effort in this roll-up. The human owner / non-instanceable
    // personas are excluded (they are not staffable bodies).
    var idle = [];
    var allPersonas = (index && Array.isArray(index.personas)) ? index.personas : [];
    for (var k = 0; k < allPersonas.length; k++) {
      var p = allPersonas[k];
      if (!p || !p.id) continue;
      if (!p.model_config) continue;            // not instanceable (e.g. owner)
      if (p.tier === 'owner' || p.kind === 'human') continue;
      if (!byPersona[p.id] || byPersona[p.id].units === 0) {
        idle.push({
          personaId: p.id,
          name: p.title || p.id,
          department: p.department || 'unassigned',
          tier: p.tier || null
        });
      }
    }
    idle.sort(function (a, b) {
      return String(a.department).localeCompare(String(b.department))
        || String(a.personaId).localeCompare(String(b.personaId));
    });

    // ── Departments as an ordered array (by total effort, desc). ────────────
    var departments = Object.keys(byDept).map(function (d) {
      return { department: d, bands: byDept[d].bands, units: byDept[d].units };
    }).sort(function (a, b) {
      return b.units - a.units || String(a.department).localeCompare(String(b.department));
    });

    return {
      degraded: degraded,
      weights: { low: bandUnits('low', weights), med: bandUnits('med', weights), high: bandUnits('high', weights) },
      totalUnits: totalUnits,
      bands: BANDS.slice(),
      departments: departments,
      byDepartment: byDept,
      byPersona: byPersona,
      byAgent: byAgent,
      leaningHardest: leaningHardest,
      idle: idle
    };
  }

  // ── status helpers (degraded path) ────────────────────────────────────────
  // A task is "closed"/terminal if its status is one of these; such tasks do
  // not contribute live load.
  var CLOSED_STATUSES = {
    done: true, tested: true, complete: true, completed: true,
    closed: true, superseded: true, rejected: true, cancelled: true, canceled: true
  };
  function isClosedStatus(status) {
    if (!status) return false;
    return !!CLOSED_STATUSES[String(status).toLowerCase()];
  }

  // ── Lazy, READ-ONLY crews-index.json load (node convenience only). ────────
  var _cachedIndex = null;
  function canLoadIndex() {
    return typeof require !== 'undefined' && typeof module !== 'undefined' && typeof __dirname !== 'undefined';
  }
  function loadIndex() {
    if (_cachedIndex) return _cachedIndex;
    if (!canLoadIndex()) return null;
    try {
      var fs = require('fs');
      var path = require('path');
      var indexPath = path.resolve(
        __dirname, '..', 'project-management', 'roles', 'crews-index.json'
      );
      _cachedIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    } catch (e) {
      _cachedIndex = null;
    }
    return _cachedIndex;
  }

  // ── Public surface (shared by browser attach + node export). ──────────────
  var api = {
    BANDS: BANDS,
    DEFAULT_WEIGHTS: DEFAULT_WEIGHTS,
    modelToBand: modelToBand,
    bandUnits: bandUnits,
    resolveOwner: resolveOwner,
    rollUp: rollUp,
    isClosedStatus: isClosedStatus,
    loadIndex: loadIndex
  };

  if (typeof window !== 'undefined') {
    window.CrewsUsage = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
