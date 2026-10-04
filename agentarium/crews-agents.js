// ─────────────────────────────────────────────────────────────────────────
// Crews — Agent instancing engine (AG-P7.10)
//
// Personas are reusable TEMPLATES (the canonical 97-node library in
// crews-index.json). Work is staffed by instantiating a persona into a NAMED
// AGENT. Many agents may share one persona (e.g. 3 SDE, 2 SPM). Agents live
// OUTSIDE the canonical reporting tree — this engine NEVER mutates personas,
// skill.md, or crews-index.json. Persistence is draft-only in localStorage
// (P2 hard-save will give agents a real store later).
//
// This file is intentionally split:
//   1. Pure, node-testable helpers (no DOM / no localStorage inside them).
//   2. A thin browser store wrapper (guarded so it never runs under node).
//
// Spec: project-management/plans/2026-06-06-crews-views-design-spec.md §12
//       project-management/plans/2026-06-06-crews-authority-model-tier-core-model.md §3
// ─────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ── Model-config fields carried on a persona template (resolved). ────────
  // Persona base <- agent-instance override (override wins per-field).
  var MODEL_CONFIG_KEYS = [
    'model',
    'thinking_budget',
    'temperature',
    'max_output_tokens'
  ];

  /**
   * Merge a persona's resolved `model_config` with an optional agent-level
   * `override`. Precedence (lowest -> highest): persona base, then agent
   * override per-field. Returns a NEW object (never mutates inputs).
   *
   * If `personaModelConfig` is null/undefined (e.g. the human owner, who is
   * not instanceable), returns null — callers should treat that persona as
   * not-instanceable.
   *
   * @param {object|null} personaModelConfig
   * @param {object|null} [override]
   * @returns {object|null}
   */
  function resolveAgentModelConfig(personaModelConfig, override) {
    if (personaModelConfig == null || typeof personaModelConfig !== 'object') {
      return null;
    }
    var resolved = {};
    // Start from the persona base (copy every own field, not just the known
    // four, so a persona carrying extra config still flows through).
    for (var k in personaModelConfig) {
      if (Object.prototype.hasOwnProperty.call(personaModelConfig, k)) {
        resolved[k] = personaModelConfig[k];
      }
    }
    if (override && typeof override === 'object') {
      for (var ok in override) {
        if (!Object.prototype.hasOwnProperty.call(override, ok)) continue;
        // An override of `undefined` means "don't touch" — inherit persona.
        if (override[ok] === undefined) continue;
        resolved[ok] = override[ok];
      }
    }
    return resolved;
  }

  // ── Curated celestial codename pool (stars + astronomers). ───────────────
  // New agents auto-receive the first unused name; reroll draws a different
  // unused one; dedupe is case-insensitive across the live roster.
  var CODENAME_POOL = [
    'Vega', 'Altair', 'Rigel', 'Nova', 'Kepler', 'Lyra',
    'Orion', 'Cygnus', 'Polaris', 'Atlas', 'Sirius', 'Antares',
    'Mira', 'Deneb', 'Capella', 'Procyon', 'Castor', 'Pollux',
    'Spica', 'Regulus', 'Bellatrix', 'Arcturus', 'Aldebaran', 'Fomalhaut',
    'Draco', 'Tycho', 'Halley', 'Lumen', 'Vesper', 'Andromeda',
    'Lyrae', 'Carina', 'Hydra', 'Phoenix', 'Vela', 'Corvus'
  ];

  function normName(s) {
    return String(s == null ? '' : s).trim().toLowerCase();
  }

  function buildUsedSet(usedNames) {
    var set = Object.create(null);
    var list = Array.isArray(usedNames) ? usedNames : [];
    for (var i = 0; i < list.length; i++) {
      var n = normName(list[i]);
      if (n) set[n] = true;
    }
    return set;
  }

  /**
   * First unused codename from the pool (case-insensitive dedupe against
   * `usedNames`). If the whole pool is exhausted, suffixes a number so a name
   * is always returned (e.g. "Vega 2").
   *
   * @param {string[]} usedNames
   * @returns {string}
   */
  function nextCodename(usedNames) {
    var used = buildUsedSet(usedNames);
    for (var i = 0; i < CODENAME_POOL.length; i++) {
      if (!used[normName(CODENAME_POOL[i])]) return CODENAME_POOL[i];
    }
    // Pool exhausted — cycle with numeric suffix until we find a free slot.
    for (var suffix = 2; ; suffix++) {
      for (var j = 0; j < CODENAME_POOL.length; j++) {
        var candidate = CODENAME_POOL[j] + ' ' + suffix;
        if (!used[normName(candidate)]) return candidate;
      }
    }
  }

  /**
   * A different unused codename than `current`. Treats `current` as also used
   * so the result is guaranteed to differ from it. Falls back to the
   * numeric-suffix path on exhaustion.
   *
   * @param {string} current
   * @param {string[]} usedNames
   * @returns {string}
   */
  function rerollCodename(current, usedNames) {
    var base = Array.isArray(usedNames) ? usedNames.slice() : [];
    if (current != null && String(current).trim()) base.push(current);
    return nextCodename(base);
  }

  // ── id / slug helpers ────────────────────────────────────────────────────
  function kebabSlug(s) {
    return String(s == null ? '' : s)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function uniqueAgentId(slug, existingIds) {
    var taken = Object.create(null);
    var list = Array.isArray(existingIds) ? existingIds : [];
    for (var i = 0; i < list.length; i++) {
      taken[String(list[i]).toLowerCase()] = true;
    }
    var base = 'agent-' + (slug || 'agent');
    if (!taken[base.toLowerCase()]) return base;
    for (var n = 2; ; n++) {
      var candidate = base + '-' + n;
      if (!taken[candidate.toLowerCase()]) return candidate;
    }
  }

  /**
   * Build a full agent record from a persona template.
   *
   * @param {object} input
   * @param {string} input.personaId             persona this agent instances
   * @param {string} [input.name]                custom display name; falls back
   *                                             to an auto codename
   * @param {object} [input.modelConfigOverride] raw agent-level override
   * @param {object} persona                     the persona template (carries
   *                                             `model_config`, `id`, etc.)
   * @param {object} [opts]
   * @param {string[]} [opts.usedNames]          live roster names (codename dedupe)
   * @param {string[]} [opts.existingIds]        live roster ids (id de-collision)
   * @returns {object} agent record
   */
  function createAgentRecord(input, persona, opts) {
    input = input || {};
    persona = persona || {};
    // Back-compat: callers may pass the used-names array directly as 3rd arg.
    var usedNames;
    var existingIds;
    if (Array.isArray(opts)) {
      usedNames = opts;
      existingIds = [];
    } else {
      opts = opts || {};
      usedNames = opts.usedNames;
      existingIds = opts.existingIds;
    }

    var personaId = input.personaId || persona.id || null;
    var override = (input.modelConfigOverride && typeof input.modelConfigOverride === 'object')
      ? input.modelConfigOverride
      : null;

    var name = (input.name != null && String(input.name).trim())
      ? String(input.name).trim()
      : nextCodename(usedNames);

    // Prefer the human-meaningful name for the slug; fall back to persona id.
    var slug = kebabSlug(name) || kebabSlug(personaId) || 'agent';
    var id = uniqueAgentId(slug, existingIds);

    var resolved = resolveAgentModelConfig(persona.model_config, override);

    return {
      id: id,
      name: name,
      persona_id: personaId,
      status: 'active',
      model_config: resolved,
      overrides: override,
      created_at: new Date().toISOString()
    };
  }

  // Pure helper bundle (shared by the browser store and node tests).
  var helpers = {
    resolveAgentModelConfig: resolveAgentModelConfig,
    nextCodename: nextCodename,
    rerollCodename: rerollCodename,
    createAgentRecord: createAgentRecord,
    CODENAME_POOL: CODENAME_POOL,
    MODEL_CONFIG_KEYS: MODEL_CONFIG_KEYS
  };

  // ── Browser store wrapper (guarded — never runs under node). ──────────────
  // Draft-only persistence to localStorage. CRUD over an agents array.
  var STORE_KEY = 'ag-crews-agents-v1';

  function makeStore() {
    function getStorage() {
      try {
        return (typeof window !== 'undefined' && window.localStorage) ? window.localStorage : null;
      } catch (e) {
        return null;
      }
    }

    function loadRaw() {
      var ls = getStorage();
      if (!ls) return [];
      try {
        var raw = ls.getItem(STORE_KEY);
        if (!raw) return [];
        var parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        return [];
      }
    }

    function saveRaw(agents) {
      var ls = getStorage();
      if (!ls) return false;
      try {
        ls.setItem(STORE_KEY, JSON.stringify(Array.isArray(agents) ? agents : []));
        return true;
      } catch (e) {
        return false;
      }
    }

    // Loud failure: a store write that cannot persist (private mode, quota)
    // must not vanish silently — the change works this session and is lost on
    // reload. Warn, but never throw; callers keep their in-memory record.
    function warnPersist(op) {
      try {
        console.warn('[CrewsAgents] ' + op + ': change kept in memory only — ' +
          'localStorage is unavailable or full, so it will be LOST on reload.');
      } catch (e2) { /* no console */ }
    }

    function listAgents() {
      return loadRaw();
    }

    // Resolve a persona template by id from the live CREWS library on window.
    function findPersona(personaId) {
      var crews = null;
      try {
        crews = (typeof window !== 'undefined' && window.AGENTARIUM && window.AGENTARIUM.CREWS)
          ? window.AGENTARIUM.CREWS
          : (typeof window !== 'undefined' && window.AG && window.AG.CREWS) ? window.AG.CREWS : null;
      } catch (e) {
        crews = null;
      }
      if (!crews || !Array.isArray(crews.personas)) return null;
      for (var i = 0; i < crews.personas.length; i++) {
        if (crews.personas[i] && crews.personas[i].id === personaId) return crews.personas[i];
      }
      return null;
    }

    function createAgent(personaId, options) {
      options = options || {};
      var agents = loadRaw();
      var persona = options.persona || findPersona(personaId) || { id: personaId };
      var record = createAgentRecord(
        {
          personaId: personaId,
          name: options.name,
          modelConfigOverride: options.modelConfigOverride || options.override || null
        },
        persona,
        {
          usedNames: agents.map(function (a) { return a && a.name; }),
          existingIds: agents.map(function (a) { return a && a.id; })
        }
      );
      agents.push(record);
      if (!saveRaw(agents)) warnPersist('createAgent(' + record.id + ')');
      return record;
    }

    function renameAgent(id, name) {
      var agents = loadRaw();
      var next = String(name == null ? '' : name).trim();
      var updated = null;
      for (var i = 0; i < agents.length; i++) {
        if (agents[i] && agents[i].id === id) {
          if (next) agents[i].name = next;
          updated = agents[i];
          break;
        }
      }
      if (updated) {
        if (!saveRaw(agents)) warnPersist('renameAgent(' + id + ')');
      }
      return updated;
    }

    // Retire keeps the record (and its engagement history) — just flips status.
    function retireAgent(id) {
      var agents = loadRaw();
      var updated = null;
      for (var i = 0; i < agents.length; i++) {
        if (agents[i] && agents[i].id === id) {
          agents[i].status = 'retired';
          updated = agents[i];
          break;
        }
      }
      if (updated) {
        if (!saveRaw(agents)) warnPersist('retireAgent(' + id + ')');
      }
      return updated;
    }

    function removeAgent(id) {
      var agents = loadRaw();
      var next = agents.filter(function (a) { return !(a && a.id === id); });
      var removed = next.length !== agents.length;
      if (removed) {
        if (!saveRaw(next)) warnPersist('removeAgent(' + id + ')');
      }
      return removed;
    }

    return {
      STORE_KEY: STORE_KEY,
      listAgents: listAgents,
      createAgent: createAgent,
      renameAgent: renameAgent,
      retireAgent: retireAgent,
      removeAgent: removeAgent
    };
  }

  // ── Attach to window (browser only). ─────────────────────────────────────
  if (typeof window !== 'undefined') {
    var store = makeStore();
    window.CrewsAgents = {
      // pure helpers
      resolveAgentModelConfig: resolveAgentModelConfig,
      nextCodename: nextCodename,
      rerollCodename: rerollCodename,
      createAgentRecord: createAgentRecord,
      CODENAME_POOL: CODENAME_POOL,
      MODEL_CONFIG_KEYS: MODEL_CONFIG_KEYS,
      // store CRUD
      STORE_KEY: store.STORE_KEY,
      listAgents: store.listAgents,
      createAgent: store.createAgent,
      renameAgent: store.renameAgent,
      retireAgent: store.retireAgent,
      removeAgent: store.removeAgent
    };
  }

  // ── Node export (pure helpers only — make them node-importable). ──────────
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      resolveAgentModelConfig: resolveAgentModelConfig,
      nextCodename: nextCodename,
      rerollCodename: rerollCodename,
      createAgentRecord: createAgentRecord,
      CODENAME_POOL: CODENAME_POOL
    };
  }
})();
