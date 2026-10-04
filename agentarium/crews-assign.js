// ─────────────────────────────────────────────────────────────────────────
// Crews — Authority-gating + assignment-resolution engine (AG-P7.8, Slice 1)
//
// HEADLESS, pure-function core. NO DOM, NO React, NO LLM calls, NO writes,
// NO localStorage. Gates who may delegate work to whom, and classifies an
// owner_id (concrete agent vs delegated persona vs unknown).
//
// THE LOCKED AUTHORITY RULE (core model, AG-P7.11):
//   An actor may delegate DOWN its reports_to subtree ONLY — never up, never
//   laterally. Juniors / leaves (no descendants) cannot assign. The human
//   owner (`executive-owner`, tier 'owner') may delegate to ANYONE
//   (universal override). A target may be a PERSONA or a concrete AGENT; an
//   agent target is gated by its `persona_id`'s position in the tree.
//
// Personas are the canonical reporting tree (crews-index.json, READ-ONLY here).
// Agents are concrete instances living OUTSIDE the tree (crews-agents.js); they
// inherit their authority position from their `persona_id`.
//
// Dual-export: attaches `window.CrewsAssign` for the browser AND exports via
// `module.exports` for node (mirrors agentarium/crews-agents.js).
// ─────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  var OWNER_TIER = 'owner';

  // ── Static flat-role → lead-persona map (AG-P13.2). ───────────────────────
  // The 6 legacy flat-role owner_id values used across status/data_p*.json map
  // to a real persona id in crews-index.json, so a flat-role owner resolves into
  // the Crews reports_to ladder (owner_id → persona → tier). READ-ONLY: this is a
  // resolution layer; it NEVER rewrites the stored owner_id. Every value here is
  // asserted present in personas[] by scripts/validate-crews.js (drift fails loud).
  var ROLE_PERSONA = {
    fe: 'tech-software-developer-senior',
    be: 'data-data-engineer-senior',
    tl: 'tech-software-developer-leader',
    spm: 'product-product-manager-senior',
    sdp: 'executive-cpo',
    'human-raj': 'executive-owner'
  };

  // ── Lazy, read-only load of the canonical crews index (node only). ────────
  // Resolved relative to this file (agentarium/) -> project-management/roles/.
  // The browser passes `index` explicitly (or sets a default), so we never
  // touch the filesystem there. We do not cache mutable global state beyond
  // this lazy file read.
  var _cachedIndex = null;
  function loadIndex() {
    if (_cachedIndex) return _cachedIndex;
    if (typeof require === 'undefined' || typeof module === 'undefined') {
      throw new Error('CrewsAssign.loadIndex: no index supplied and no node fs available');
    }
    var fs = require('fs');
    var path = require('path');
    var indexPath = path.resolve(
      __dirname, '..', 'project-management', 'roles', 'crews-index.json'
    );
    _cachedIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    return _cachedIndex;
  }

  function resolveIndex(index) {
    if (index && Array.isArray(index.personas)) return index;
    return loadIndex();
  }

  // ── buildTree(index) -> { byId, childrenOf, root }. ───────────────────────
  // byId: personaId -> persona. childrenOf: parentId -> [childId].
  function buildTree(index) {
    var idx = resolveIndex(index);
    var personas = idx.personas || [];
    var byId = Object.create(null);
    var childrenOf = Object.create(null);

    for (var i = 0; i < personas.length; i++) {
      var p = personas[i];
      if (!p || !p.id) continue;
      byId[p.id] = p;
      if (!childrenOf[p.id]) childrenOf[p.id] = [];
    }
    for (var j = 0; j < personas.length; j++) {
      var c = personas[j];
      if (!c || !c.id || !c.reports_to) continue;
      if (!childrenOf[c.reports_to]) childrenOf[c.reports_to] = [];
      childrenOf[c.reports_to].push(c.id);
    }

    var root = (idx.root && byId[idx.root]) ? idx.root : null;
    if (!root) {
      for (var k = 0; k < personas.length; k++) {
        var rp = personas[k];
        if (rp && rp.reports_to == null && rp.tier === OWNER_TIER) { root = rp.id; break; }
      }
    }
    if (!root) {
      for (var m = 0; m < personas.length; m++) {
        if (personas[m] && personas[m].reports_to == null) { root = personas[m].id; break; }
      }
    }

    return { byId: byId, childrenOf: childrenOf, root: root };
  }

  // ── subtreeOf(personaId, index) -> Set of STRICT descendant ids. ──────────
  // Excludes self. Returns an empty Set for unknown ids and for leaves.
  function subtreeOf(personaId, index) {
    var tree = buildTree(index);
    var out = new Set();
    if (!personaId || !tree.byId[personaId]) return out;
    var stack = (tree.childrenOf[personaId] || []).slice();
    while (stack.length) {
      var id = stack.pop();
      if (out.has(id)) continue; // guard against malformed cycles
      out.add(id);
      var kids = tree.childrenOf[id] || [];
      for (var i = 0; i < kids.length; i++) stack.push(kids[i]);
    }
    return out;
  }

  // ── isDescendant(ancestorId, maybeDescId, index) -> boolean (strict). ─────
  function isDescendant(ancestorId, maybeDescId, index) {
    if (!ancestorId || !maybeDescId || ancestorId === maybeDescId) return false;
    return subtreeOf(ancestorId, index).has(maybeDescId);
  }

  function isOwner(personaId, tree) {
    if (!personaId) return false;
    if (personaId === tree.root) return true;
    var p = tree.byId[personaId];
    return !!(p && p.tier === OWNER_TIER);
  }

  // ── ctx normalization ──────────────────────────────────────────────────────
  // delegationReason / agentDelegationReason take an optional `ctx` per §1.3:
  //   ctx = { tree?, index?, agents? }
  // For back-compat the old boolean wrappers still accept a bare `index` as the
  // 3rd arg, so we accept either shape here.
  function normalizeCtx(ctx) {
    if (!ctx) return { index: undefined, agents: [] };
    // A bare index object (has a `personas` array) passed positionally.
    if (Array.isArray(ctx.personas)) return { index: ctx, agents: [] };
    return {
      index: ctx.index,
      agents: Array.isArray(ctx.agents) ? ctx.agents : []
    };
  }

  function findAgent(agents, id) {
    var list = Array.isArray(agents) ? agents : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) return list[i];
    }
    return null;
  }

  // ── delegationReason(actorId, targetId, ctx) -> { ok, reason }. ─────────────
  // The §1.3 contract. EXACT resolution order + reason vocabulary:
  //   1. Normalize TARGET to a persona for the subtree test.
  //        agent target: gate by its persona_id.
  //          unknown agent            -> { ok:false, reason:'unknown-agent' }
  //          agent status 'retired'   -> { ok:false, reason:'retired' }
  //        else persona target.
  //          unknown persona          -> { ok:false, reason:'unknown-target' }
  //        (a 'seat-open' persona is a VALID delegated target — the seat-open
  //         direct-only reject is raised at the agent-vs-persona call site, NOT
  //         here.)
  //   2. Owner override: actor === root -> { ok:true, reason:'owner-override' }.
  //   3. Actor must exist & be non-leaf with authority:
  //        actor unknown                -> { ok:false, reason:'unknown-actor' }
  //        actor tier 'junior' OR no children
  //                                     -> { ok:false, reason:'junior-cannot-assign' }
  //   4. Down-only: targetPersona in subtreeOf(actor) & != actor
  //        not in subtree               -> { ok:false, reason:'out-of-subtree' }
  //   5. otherwise                      -> { ok:true,  reason:'in-subtree' }.
  function delegationReason(actorId, targetId, ctx) {
    var c = normalizeCtx(ctx);
    var tree = buildTree(c.index);

    // ── (1) Normalize the target to a persona id. ──
    var targetPersonaId = targetId;
    if (targetId && /^agent-/.test(String(targetId))) {
      var agent = findAgent(c.agents, targetId);
      if (!agent) return { ok: false, reason: 'unknown-agent' };
      if (agent.status === 'retired') return { ok: false, reason: 'retired' };
      targetPersonaId = agent.persona_id;
      if (!targetPersonaId || !tree.byId[targetPersonaId]) {
        return { ok: false, reason: 'unknown-agent' };
      }
    } else {
      if (!targetId || !tree.byId[targetId]) {
        return { ok: false, reason: 'unknown-target' };
      }
    }

    // ── (2) Owner override (universal). ──
    if (actorId && isOwner(actorId, tree)) {
      return { ok: true, reason: 'owner-override' };
    }

    // ── (3) Actor must exist & hold delegation authority. ──
    if (!actorId || !tree.byId[actorId]) {
      return { ok: false, reason: 'unknown-actor' };
    }
    var actor = tree.byId[actorId];
    var hasChildren = (tree.childrenOf[actorId] || []).length > 0;
    if (actor.tier === 'junior' || !hasChildren) {
      return { ok: false, reason: 'junior-cannot-assign' };
    }

    // ── (4) Down-only: target must be a STRICT descendant of the actor. ──
    if (actorId === targetPersonaId) return { ok: false, reason: 'out-of-subtree' };
    if (!isDescendant(actorId, targetPersonaId, c.index)) {
      return { ok: false, reason: 'out-of-subtree' }; // covers up + lateral
    }

    // ── (5) In-subtree, down delegation: allowed. ──
    return { ok: true, reason: 'in-subtree' };
  }

  // ── agentDelegationReason(actorId, agent, ctx) -> { ok, reason }. ───────────
  // For DIRECT-agent targets (a concrete body). Beyond the shared authority gate
  // this ALSO hard-rejects the two non-bodies at the call site:
  //   - a 'retired' agent           -> { ok:false, reason:'retired' }
  //   - a 'seat-open' persona/agent  -> { ok:false, reason:'seat-open' }
  // (A delegated PERSONA drop to a seat-open persona is fine — that path uses
  //  delegationReason, not this one.)
  function agentDelegationReason(actorId, agent, ctx) {
    if (!agent || !agent.persona_id) return { ok: false, reason: 'unknown-agent' };
    if (agent.status === 'retired') return { ok: false, reason: 'retired' };
    if (agent.status === 'seat-open') return { ok: false, reason: 'seat-open' };
    var c = normalizeCtx(ctx);
    var tree = buildTree(c.index);
    var persona = tree.byId[agent.persona_id];
    if (persona && persona.status === 'seat-open') {
      return { ok: false, reason: 'seat-open' };
    }
    if (persona && persona.status === 'retired') {
      return { ok: false, reason: 'retired' };
    }
    // Gate authority by the agent's persona position in the tree.
    return delegationReason(actorId, agent.persona_id, ctx);
  }

  // ── canDelegate(actorId, targetId, index) -> boolean. ─────────────────────
  // BOOLEAN wrapper over delegationReason (PRESERVED signature/return type so
  // existing callers — e.g. drawer.jsx — keep working unchanged).
  function canDelegate(actorId, targetId, index) {
    return delegationReason(actorId, targetId, index).ok;
  }

  // ── canDelegateToAgent(actorId, agent, index) -> boolean. ─────────────────
  // BOOLEAN wrapper (PRESERVED signature). Gates by the agent's persona_id via
  // delegationReason. NOTE: this is the AUTHORITY-only boolean used by the
  // drawer; the seat-open/retired direct-reject lives in agentDelegationReason.
  function canDelegateToAgent(actorId, agent, index) {
    if (!agent || !agent.persona_id) return false;
    return delegationReason(actorId, agent.persona_id, index).ok;
  }

  // ── resolveOwner(owner_id, index, agents) ->
  //      { kind:'agent'|'persona'|'unknown', agent?, persona? }. ─────────────
  // 'agent'   — owner_id is a concrete agent (present in agents[] or 'agent-*');
  //             its persona is resolved via persona_id when possible.
  // 'persona' — owner_id is a persona id in the index (DELEGATED / pending-
  //             staffing: work is owned by a role, awaiting a concrete agent).
  // 'unknown' — neither.
  function resolveOwner(owner_id, index, agents) {
    var result = { kind: 'unknown' };
    if (!owner_id) return result;
    var tree = buildTree(index);
    var list = Array.isArray(agents) ? agents : [];

    var matchedAgent = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === owner_id) { matchedAgent = list[i]; break; }
    }
    var looksLikeAgent = matchedAgent || /^agent-/.test(String(owner_id));

    if (looksLikeAgent) {
      result.kind = 'agent';
      if (matchedAgent) {
        result.agent = matchedAgent;
        if (matchedAgent.persona_id && tree.byId[matchedAgent.persona_id]) {
          result.persona = tree.byId[matchedAgent.persona_id];
        }
      }
      return result;
    }

    if (tree.byId[owner_id]) {
      result.kind = 'persona';
      result.persona = tree.byId[owner_id];
      return result;
    }

    return result;
  }

  // ── isPendingStaffing(owner_id, index, agents) -> boolean. ────────────────
  // True iff the owner is a delegated persona (awaiting a concrete agent).
  function isPendingStaffing(owner_id, index, agents) {
    return resolveOwner(owner_id, index, agents).kind === 'persona';
  }

  // ── leaderFor(personaId, index) -> routing leader persona id. ─────────────
  // RULE: if the persona itself is tier 'lead', return itself; otherwise walk
  // UP reports_to to the FIRST ancestor with tier 'lead' and return it. If no
  // 'lead' is found before reaching the owner, fall back to the highest
  // non-owner ancestor (e.g. cxo/ceo); if even that is absent, return the
  // owner. Returns null only for an unknown personaId.
  function leaderFor(personaId, index) {
    var tree = buildTree(index);
    if (!personaId || !tree.byId[personaId]) return null;

    var cur = tree.byId[personaId];
    var seen = Object.create(null);
    var lastNonOwner = (cur.tier === OWNER_TIER) ? null : cur.id;

    while (cur && !seen[cur.id]) {
      seen[cur.id] = true;
      if (cur.tier === 'lead') return cur.id;
      if (cur.tier !== OWNER_TIER) lastNonOwner = cur.id;
      cur = cur.reports_to ? tree.byId[cur.reports_to] : null;
    }

    // No 'lead' on the chain: highest non-owner ancestor, else the owner.
    return lastNonOwner || tree.root;
  }

  // ── resolveOwnerId(owner_id, index, agents) -> identity resolution. ───────
  // AG-P13.2. PURE read layer over the personas tree. Resolves a task/plan
  // owner_id string into its persona, tier, and routing leader WITHOUT ever
  // mutating the owner_id. Four resolution paths (deterministic, in order):
  //   1. agent-<slug> (or a match in agents[])  -> kind:'agent'  (via resolveOwner)
  //   2. flat role in ROLE_PERSONA              -> kind:'flat-role'
  //   3. a real persona id in the tree          -> kind:'persona'
  //   4. none of the above                      -> kind:'unknown' (honest fallback)
  // Returns { ownerId, kind, personaId, persona, tier, leaderId, resolved }.
  // No clock / random — reads only static personas + the supplied strings.
  function resolveOwnerId(owner_id, index, agents) {
    var oid = String(owner_id == null ? '' : owner_id).replace(/^role:/i, '').trim();
    var base = {
      ownerId: oid, kind: 'unknown', personaId: null,
      persona: null, tier: null, leaderId: null, resolved: false
    };
    if (!oid) return base;

    var tree = buildTree(index);
    var list = Array.isArray(agents) ? agents : [];

    // (1) concrete agent — agent-<slug> or present in agents[].
    var matchedAgent = findAgent(list, oid);
    if (matchedAgent || /^agent-/.test(oid)) {
      var r = resolveOwner(oid, index, agents); // { kind:'agent', agent?, persona? }
      var persona = r.persona || null;
      var personaId = persona ? persona.id
        : (matchedAgent && matchedAgent.persona_id) || null;
      return {
        ownerId: oid, kind: 'agent', personaId: personaId, persona: persona,
        tier: persona ? (persona.tier || null) : null,
        leaderId: personaId ? leaderFor(personaId, index) : null,
        resolved: !!persona
      };
    }

    // (2) flat role — map to its lead persona.
    if (Object.prototype.hasOwnProperty.call(ROLE_PERSONA, oid)) {
      var fpId = ROLE_PERSONA[oid];
      var fp = tree.byId[fpId] || null;
      return {
        ownerId: oid, kind: 'flat-role', personaId: fpId, persona: fp,
        tier: fp ? (fp.tier || null) : null,
        leaderId: fp ? leaderFor(fpId, index) : null,
        resolved: !!fp
      };
    }

    // (3) a real persona id stored directly.
    if (tree.byId[oid]) {
      var dp = tree.byId[oid];
      return {
        ownerId: oid, kind: 'persona', personaId: oid, persona: dp,
        tier: dp.tier || null, leaderId: leaderFor(oid, index), resolved: true
      };
    }

    // (4) honest fallback.
    return base;
  }

  // ── Public surface (shared by browser attach + node export). ──────────────
  var api = {
    ROLE_PERSONA: ROLE_PERSONA,
    resolveOwnerId: resolveOwnerId,
    OWNER_TIER: OWNER_TIER,
    loadIndex: loadIndex,
    buildTree: buildTree,
    subtreeOf: subtreeOf,
    isDescendant: isDescendant,
    delegationReason: delegationReason,
    agentDelegationReason: agentDelegationReason,
    canDelegate: canDelegate,
    canDelegateToAgent: canDelegateToAgent,
    resolveOwner: resolveOwner,
    isPendingStaffing: isPendingStaffing,
    leaderFor: leaderFor
  };

  // ── Attach to window (browser only). ──────────────────────────────────────
  if (typeof window !== 'undefined') {
    window.CrewsAssign = api;
  }

  // ── Node export (make the engine require()-able from the test). ───────────
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
