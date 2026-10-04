#!/usr/bin/env node
'use strict';

/*
 * Crews Delegation + Escalation Runtime — Slice 1 (headless, no-execution resolver).
 *
 * Design: project-management/plans/2026-06-06-crews-delegation-escalation-runtime-spike.md
 *   §6.2 Slice 1 — "headless resolver (pure function, no execution)" that regenerates the
 *   §5 worked traces from live data. No model is called; no state is mutated.
 * Paper test: project-management/plans/2026-06-06-crews-authority-model-tier-core-model.md §6
 *   AG-P7.7 -> owner 0, KH-P2.5 -> owner 1, AG-P8.6 -> owner 1 (owner touched twice total).
 *
 * ISOMORPHIC — a SINGLE source of truth for both runtimes (refactor landed under AG-P11.3; supersedes the AG-P11.2 browser mirror, now removed):
 *   - node: require()-able (module.exports) AND runnable as a CLI.
 *   - browser: a plain <script> attaches the SAME pure API to window.CrewsResolver,
 *     the way the repo's other engines dual-export (crews-assign.js / crews-agents.js).
 *   The Maestro conduct console (agentarium/maestro.jsx) consumes window.CrewsResolver;
 *   the paper-test (scripts/test-*) asserts against module.exports. There is NO browser
 *   mirror — this file is loaded directly in the SPA (server.js serves the repo root).
 *
 * Node-only bits (fs / path / __dirname / require.main) are lazily loaded and guarded so
 * the file never references them in the browser. crews-index.json is READ-ONLY here — in
 * node it is loaded from disk; in the browser buildTree() falls back to window.AG.CREWS.
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Tier ladder (core-model §2). Lower rank = lower authority (closer to execution).
  // ---------------------------------------------------------------------------
  const TIER_ORDER = ['junior', 'senior', 'lead', 'cxo', 'ceo', 'owner'];
  const TIER_RANK = TIER_ORDER.reduce((acc, t, i) => {
    acc[t] = i;
    return acc;
  }, {});

  // Department -> CXO short-code, as resolved on personas in crews-index.json
  // (e.g. tech -> cto). Used to route a domain hint to the right CXO subtree.
  const DOMAIN_TO_CXO = {
    tech: 'cto',
    product: 'cpo',
    data: 'cdo',
    ai: 'caio',
    it: 'cio',
  };

  // ---------------------------------------------------------------------------
  // Load the live crews index (resolve relative to __dirname/.., READ-ONLY).
  // Node-only: fs / path / __dirname are lazily referenced so this file also loads
  // in the browser, where loadIndex() is never called (buildTree falls back to
  // window.AG.CREWS). crews-index.json is only loaded, never written.
  // ---------------------------------------------------------------------------
  const INDEX_PATH =
    typeof require !== 'undefined' && typeof __dirname !== 'undefined'
      ? require('path').resolve(__dirname, '..', 'project-management', 'roles', 'crews-index.json')
      : null;

  function loadIndex(indexPath) {
    if (typeof require === 'undefined') {
      throw new Error('crews-dispatch-resolver.loadIndex: no node fs available (browser); pass an index');
    }
    const fs = require('fs');
    const raw = fs.readFileSync(indexPath || INDEX_PATH, 'utf8');
    return JSON.parse(raw);
  }

  // The default index when none is supplied: node reads it from disk; the browser
  // falls back to the app's loaded crews tree (window.AG.CREWS), mirroring how the
  // other browser engines source their data. Empty tree as a last resort.
  function defaultIndex() {
    if (typeof require !== 'undefined') return loadIndex();
    if (typeof window !== 'undefined' && window.AG && window.AG.CREWS) return window.AG.CREWS;
    return { personas: [], root: null };
  }

  // ---------------------------------------------------------------------------
  // Build the persona tree: byId lookup, childrenOf adjacency, and the single
  // human-owner root (executive-owner, the only node with reports_to == null).
  // ---------------------------------------------------------------------------
  function buildTree(index) {
    const idx = index || defaultIndex();
    const personas = idx.personas || [];
    const byId = new Map();
    const childrenOf = new Map();

    for (const p of personas) {
      byId.set(p.id, p);
      if (!childrenOf.has(p.id)) childrenOf.set(p.id, []);
    }
    for (const p of personas) {
      if (p.reports_to) {
        if (!childrenOf.has(p.reports_to)) childrenOf.set(p.reports_to, []);
        childrenOf.get(p.reports_to).push(p.id);
      }
    }

    const root =
      idx.root && byId.has(idx.root)
        ? idx.root
        : personas.find((p) => p.reports_to == null && p.tier === 'owner')?.id ||
          personas.find((p) => p.reports_to == null)?.id;

    return {
      index: idx,
      byId,
      childrenOf,
      root,
      children(id) {
        return (childrenOf.get(id) || []).map((cid) => byId.get(cid));
      },
    };
  }

  // Resolve a task's domain to a CXO short-code (the column the org tree uses).
  function domainToCxo(domain) {
    if (!domain) return null;
    const d = String(domain).toLowerCase();
    return DOMAIN_TO_CXO[d] || d; // accept either a department name or a raw cxo code
  }

  // True when persona p is in the task's domain (matches the resolved cxo column).
  function inDomain(p, cxoCode) {
    if (!cxoCode) return true; // no domain hint -> domain-agnostic
    return p.cxo === cxoCode;
  }

  // ---------------------------------------------------------------------------
  // resolveHandler(task, tree?) -> { taskId, path, decidingTier, ownerTouched }
  //
  //   task: { id, required_authority (tier name), domain?, owner_gate? }
  //
  // Rule: find the LOWEST-tier persona that holds the required authority within the
  // relevant domain by walking the tree, then push the build DOWN the gradient
  // (deciding tier -> ... -> the lowest execution tier in that subtree). The
  // returned `path` is the chain of persona ids that would be touched.
  //
  //   - decidingTier = the required_authority tier (the tier that holds/accepts the
  //     work; the lowest in-scope tier that may decide it).
  //   - The chain terminates at the lowest in-scope tier (work pushed down to junior
  //     where the gradient allows), owner NOT touched, UNLESS...
  //   - owner_gate is true (irreversible/risky): the final accept escalates up to the
  //     human owner, so the owner is appended to the chain and ownerTouched = true.
  // ---------------------------------------------------------------------------
  function resolveHandler(task, tree) {
    const t = tree || buildTree();
    if (!task || !task.id) throw new Error('resolveHandler: task must have an id');

    const requiredAuthority = task.required_authority || 'senior'; // backward-compat default (§2.3)
    if (!(requiredAuthority in TIER_RANK)) {
      throw new Error(`resolveHandler: unknown required_authority "${requiredAuthority}"`);
    }
    const cxoCode = domainToCxo(task.domain);
    const requiredRank = TIER_RANK[requiredAuthority];

    // Candidate deciders: in-domain personas whose tier holds AT LEAST the required
    // authority. Pick the LOWEST such tier (push work down the gradient, core-model §4).
    const candidates = [];
    for (const p of t.byId.values()) {
      if (!inDomain(p, cxoCode)) continue;
      if (TIER_RANK[p.tier] >= requiredRank) candidates.push(p);
    }
    candidates.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]);

    const decider =
      candidates.find((p) => p.tier === requiredAuthority) || candidates[0] || t.byId.get(t.root);
    const decidingTier = decider ? decider.tier : requiredAuthority;

    // The build is owned/signed-off by the lead of the decider's role-subtree (core-model
    // §2: sign-off lives at the lead tier). So the build chain anchors at that in-domain
    // lead — the lowest tier that still HOLDS sign-off — and pushes work DOWN the gradient.
    // (This reproduces §5.1's "lead(tech) confirms scope" even for a senior-authority task.)
    // Walk up from the decider along reports_to to the nearest in-domain lead-or-above whose
    // tier is >= the required authority; that node is the head of the downward build chain.
    let head = decider;
    if (decider) {
      let walk = decider;
      const upSeen = new Set();
      while (walk && !upSeen.has(walk.id)) {
        upSeen.add(walk.id);
        if (TIER_RANK[walk.tier] >= TIER_RANK['lead']) {
          head = walk;
          break;
        }
        const mgr = walk.reports_to ? t.byId.get(walk.reports_to) : null;
        if (!mgr || !inDomain(mgr, cxoCode)) break; // stop at the domain boundary (CXO and up)
        head = mgr;
        walk = mgr;
      }
    }

    // Walk DOWN from the head along reports_to children, staying in-domain and within the
    // decider's role-subtree, following the lowest-tier child each step until execution
    // bottoms out (work pushed down to junior).
    const chain = [];
    let cur = head;
    const seen = new Set();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.push(cur.id);
      const kids = t
        .children(cur.id)
        .filter((c) => c && inDomain(c, cxoCode) && TIER_RANK[c.tier] < TIER_RANK[cur.tier]);
      if (kids.length === 0) break;
      kids.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]); // lowest tier first (push down)
      cur = kids[0];
    }

    // owner_gate: the irreversible/risky acceptance escalates up to the human owner.
    let ownerTouched = false;
    if (task.owner_gate === true) {
      ownerTouched = true;
      if (t.root && chain[chain.length - 1] !== t.root) chain.push(t.root);
    }

    return {
      taskId: task.id,
      path: chain,
      decidingTier,
      ownerTouched,
    };
  }

  // ---------------------------------------------------------------------------
  // trace(task, tree?) -> human-readable one-line trace.
  //   e.g. "AG-P7.7: lead(tech) -> senior -> junior | owner touched: 0"
  // ---------------------------------------------------------------------------
  function trace(task, tree) {
    const t = tree || buildTree();
    const res = resolveHandler(task, t);
    const cxoCode = domainToCxo(task.domain);
    const hops = res.path.map((id, i) => {
      const p = t.byId.get(id);
      const tier = p ? p.tier : '?';
      // annotate the first hop with its domain for readability (matches §5 "lead(tech)")
      if (i === 0 && cxoCode) return `${tier}(${task.domain})`;
      return tier;
    });
    return `${res.taskId}: ${hops.join(' -> ')} | owner touched: ${res.ownerTouched ? 1 : 0}`;
  }

  // ---------------------------------------------------------------------------
  // The three paper-test tasks, encoded as data (core-model §6 / spike §5).
  //   AG-P7.7 — reversible, in-domain FE build, within the locked spec -> senior, no gate.
  //   KH-P2.5 — hard Save acceptance, data-loss capable -> lead + owner gate.
  //   AG-P8.6 — source-mode detection + API write-path acceptance -> lead + owner gate.
  // (Their build domain is the tech subtree — the software-developer chain in §5.)
  // ---------------------------------------------------------------------------
  const PAPER_TEST_TASKS = [
    {
      id: 'AG-P7.7',
      title: 'Crews org-chart and persona detail UI',
      required_authority: 'senior',
      domain: 'tech',
      owner_gate: false,
    },
    {
      id: 'KH-P2.5',
      title: 'Verify hard Save acceptance and failure modes',
      required_authority: 'lead',
      domain: 'tech',
      owner_gate: true,
    },
    {
      id: 'AG-P8.6',
      title: 'Source-mode detection, graceful degradation, and API acceptance',
      required_authority: 'lead',
      domain: 'tech',
      owner_gate: true,
    },
  ];

  // regenerateTraces() -> the 3 resolutions (the §5 traces, generated from live data).
  function regenerateTraces(tree) {
    const t = tree || buildTree();
    return PAPER_TEST_TASKS.map((task) => ({
      ...resolveHandler(task, t),
      trace: trace(task, t),
    }));
  }

  // ---------------------------------------------------------------------------
  // Public surface — shared by the node export AND the browser attach (one source).
  // ---------------------------------------------------------------------------
  const api = {
    TIER_ORDER,
    TIER_RANK,
    DOMAIN_TO_CXO,
    INDEX_PATH,
    loadIndex,
    buildTree,
    resolveHandler,
    trace,
    regenerateTraces,
    PAPER_TEST_TASKS,
  };

  // ── Attach to window (browser only). The SPA reads window.CrewsResolver; this is
  //    the same engine node require()s — no mirror, no drift. ───────────────────
  if (typeof window !== 'undefined') {
    window.CrewsResolver = api;
  }

  // ── Node export (make the engine require()-able from the tests). ─────────────
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  // ---------------------------------------------------------------------------
  // CLI: print each trace + a one-line owner-touch summary (node only).
  // ---------------------------------------------------------------------------
  if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
    const tree = buildTree();
    const results = regenerateTraces(tree);
    console.log('Crews dispatch resolver — Slice 1 (headless, no execution)');
    console.log(`Loaded ${tree.byId.size} personas; root = ${tree.root}`);
    console.log('');
    let ownerTouches = 0;
    for (const r of results) {
      console.log(r.trace);
      if (r.ownerTouched) ownerTouches += 1;
    }
    console.log('');
    console.log(
      `Owner-touch summary: ${ownerTouches} across ${results.length} tasks ` +
        `(${results.map((r) => `${r.taskId}=${r.ownerTouched ? 1 : 0}`).join(', ')})`
    );
  }
})();
