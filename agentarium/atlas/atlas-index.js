// ─────────────────────────────────────────────────────────────────────────
// Atlas — graph index builder (merged engine)
//
// Pure, deterministic. Reads the same runtime data the rest of Agentarium uses
// (window.PHASE_DATA for Khira tasks, window.AGENTARIUM for plans / messages /
// decisions / roles / verdicts / phases) and produces a normalized index:
//
//   { nodes, edges, metrics, attention, decisions, byId, blocksAdj, now }
//
// No rendering, no React. Relationship logic is separated from the views so a
// frontend agent can lift this file as the canonical graph model. Every edge
// carries `confidence: "explicit" | "inferred" | "backfilled"` and a
// human-readable `reason`.
//
// Determinism (P9 M1 invariant): this file NEVER calls Date.now(), new Date(),
// or Math.random(). All "current time" comes from AG.NOW; timestamp comparison
// uses the pure static Date.parse() string→ms parser (no clock access). Grep the
// file for those three APIs to confirm zero occurrences.
// ─────────────────────────────────────────────────────────────────────────

(function () {
  const STALE_MS = 72 * 3600 * 1000;       // 72h — first stale state (CPO rule)
  const SEVERE_STALE_MS = 7 * 24 * 3600 * 1000; // 7d — severe stale (nuance only)

  // Pure string→epoch-ms parse. Date.parse is a static parser (NOT a clock read
  // like Date.now / new Date), so it preserves the no-clock determinism invariant.
  // Returns NaN for unparseable input; callers guard with Number.isNaN.
  function toMs(ts) {
    if (ts == null) return NaN;
    if (typeof ts === "number") return ts;
    return Date.parse(ts);
  }

  // ── Structured-blocker accessors (backward-compatible) ──────────────────
  // A blockers[] item may be a plain string (legacy) OR a structured object
  // { text, needs, severity, raised_at, owner_id }. These accessors are the
  // SINGLE place a blocker is read, so scanIds()/why never call String(object)
  // (which would print "[object Object]" and break id-scanning). For a string
  // blocker the object fields return undefined; blockerText() always yields a
  // string. Pure — no clock / random.
  function isStructuredBlocker(b) { return !!b && typeof b === "object"; }
  function blockerText(b) { return (typeof b === "string") ? b : (b && b.text) || ""; }
  function blockerNeeds(b) { return isStructuredBlocker(b) ? b.needs : undefined; }
  function blockerSeverity(b) { return isStructuredBlocker(b) ? b.severity : undefined; }
  function blockerRaisedAt(b) { return isStructuredBlocker(b) ? b.raised_at : undefined; }
  function blockerOwnerId(b) { return isStructuredBlocker(b) ? b.owner_id : undefined; }

  // ── id-mention scanner (for inferred edges) ───────────────────────────
  // Recognizes task-like ids (W1.5, A2.2, P3.1, AG-P5.10), plan ids (PL-04,
  // PL-AR-01), decision ids (DEC-04), message ids (MSG-2026-..).
  const ID_RE = /\b(AG-P\d+\.\d+|PL-[A-Z0-9-]+|DEC-\d+|MSG-\d{4}-\d{2}-\d{2}-\d{4}|[A-Z]\d+\.\d+|W\d+\.\d+|A\d+\.\d+|P\d+\.\d+)\b/g;
  function scanIds(text) {
    if (!text) return [];
    const out = new Set();
    let m;
    ID_RE.lastIndex = 0;
    while ((m = ID_RE.exec(text)) !== null) out.add(m[1]);
    return [...out];
  }

  function phaseKeyToId(key) {
    const m = String(key || "").match(/p?(\d+)/i);
    return m ? `p${m[1]}` : String(key || "").toLowerCase();
  }

  function pmRootPrefix(project) {
    const root = (project && project.sourceRoot) || "project-management/";
    return root.endsWith("/") ? root : `${root}/`;
  }

  function phaseSourcePath(ph, phaseId, project) {
    const prefix = pmRootPrefix(project);
    if (ph?.relativePath) {
      const rp = ph.relativePath;
      if (rp.startsWith("project-management/")) return rp;
      if (rp.startsWith("status/")) return prefix + rp;
      return `${prefix}status/${rp.split("/").pop()}`;
    }
    if (ph?.filename) {
      const fn = ph.filename;
      if (fn.includes("/")) return fn.startsWith("project-management/") ? fn : prefix + fn;
      return `${prefix}status/${fn}`;
    }
    const n = String(phaseId || "").replace(/^p/i, "");
    return `${prefix}status/data_p${n}.json`;
  }

  function taskOwnerId(t) {
    const raw = t.owner_id || t.owner;
    if (!raw) return null;
    return String(raw).replace(/^role:/i, "").trim();
  }

  function collectTasks(project) {
    const out = [];
    if (project && Array.isArray(project.phases) && project.phases.length) {
      project.phases.forEach((ph, i) => {
        const phaseId = ph.id || `p${i + 1}`;
        const bucket = ph.data || {};
        if (!Array.isArray(bucket.tasks)) return;
        for (const t of bucket.tasks) {
          out.push({ ...t, _phase: phaseId, _sourcePath: phaseSourcePath(ph, phaseId, project) });
        }
      });
      return out;
    }

    const PD = window.PHASE_DATA || {};
    for (const pkey of Object.keys(PD)) {
      const phaseId = phaseKeyToId(pkey);
      const bucket = PD[pkey];
      if (!bucket || !Array.isArray(bucket.tasks)) continue;
      for (const t of bucket.tasks) {
        // G12b: phase ids are lowercase (p1, p2, …) and the on-disk files are
        // data_p1.json etc. — never uppercase the id into the path.
        out.push({ ...t, _phase: phaseId, _sourcePath: `project-management/status/data_${String(phaseId).toLowerCase()}.json` });
      }
    }
    return out;
  }

  // Most recent activity timestamp on a task (reviews + code_updated_at).
  // Returns an ISO string (the original timestamp), or null. Kept as a string so
  // relTime() can render it and so the engine never materializes a Date object.
  function taskLastTouch(t) {
    let latestMs = null;
    let latestIso = null;
    function consider(ts) {
      const ms = toMs(ts);
      if (Number.isNaN(ms)) return;
      if (latestMs == null || ms > latestMs) { latestMs = ms; latestIso = ts; }
    }
    for (const r of (t.reviews || [])) if (r.at) consider(r.at);
    if (t.code_updated_at) consider(t.code_updated_at);
    return latestIso;
  }

  // Best-effort message timestamp as an ISO string (no clock read). Handoff
  // metadata stores the send time on m.date (Courier parser) or m.at; fall back
  // to a date embedded in the id (MSG-2026-06-13-1234 / 2026-06-13_...). Returns
  // null when nothing parses, so the staleness compare guards with Number.isNaN.
  function messageIso(m) {
    if (!m) return null;
    if (m.date) return m.date;
    if (m.at) return m.at;
    const id = String(m.id || "");
    const dm = id.match(/(\d{4}-\d{2}-\d{2})[_-]?(\d{2})(\d{2})/);
    if (dm) return `${dm[1]}T${dm[2]}:${dm[3]}:00Z`;
    const dOnly = id.match(/(\d{4}-\d{2}-\d{2})/);
    if (dOnly) return `${dOnly[1]}T00:00:00Z`;
    return null;
  }

  function staleState(t, nowMs) {
    if (t.status !== "in_progress") return null;
    const last = taskLastTouch(t);
    if (!last) return "stale";              // in progress, no movement recorded
    const age = nowMs - toMs(last);
    if (age >= SEVERE_STALE_MS) return "severe";
    if (age >= STALE_MS) return "stale";
    return null;
  }

  // pm_status / review derived risk for a task
  function taskRisk(t, nowMs) {
    const flags = [];
    if (t.status === "blocked") flags.push("blocked");
    if (t.blockers && t.blockers.length && t.status !== "completed") flags.push("has-blockers");
    if (t.pm_status === "rejected") flags.push("rejected");
    if (t.pm_status === "needs-review") flags.push("needs-review");
    const ss = staleState(t, nowMs);
    if (ss) flags.push(ss === "severe" ? "stale-severe" : "stale");
    for (const r of (t.reviews || [])) if (r.type === "BUG") { flags.push("bug"); break; }
    // ── Collaboration signals (additive) ──────────────────────────────────
    // Soft, non-blocking triage at the task level: needs:"help" / "crew".
    if (t.needs === "help") flags.push("help");
    if (t.needs === "crew") flags.push("crew");
    // Structured-blocker needs (object items only; string items are no-ops).
    for (const b of (t.blockers || [])) {
      const need = blockerNeeds(b);
      if (need === "help" && !flags.includes("help")) flags.push("help");
      else if (need === "crew" && !flags.includes("crew")) flags.push("crew");
      else if (need === "decision" && !flags.includes("decision-needed")) flags.push("decision-needed");
    }
    return flags;
  }

  // ── Build nodes ───────────────────────────────────────────────────────
  function build(options = {}) {
    const AG = options.agentarium || window.AGENTARIUM || {};
    const phases = options.phases || AG.PHASES || [];
    const roles = AG.ROLES || [];
    const plans = AG.PLANS || [];
    const messages = AG.MESSAGES || [];
    const decisionsData = AG.DECISIONS || [];
    const verdicts = AG.VERDICTS || [];
    const nowIso = AG.NOW || null;       // ISO string baked into the index (no clock read)
    const NOW = toMs(nowIso);            // epoch ms for all age comparisons
    const tasks = collectTasks(options.project);
    const pmPrefix = pmRootPrefix(options.project);
    const nodes = [];
    const edges = [];
    const byId = {};
    const taskIds = new Set(tasks.map(t => t.id));

    // ── Owner-identity resolution (AG-P13.2). ──────────────────────────────
    // Feature-detected, READ-ONLY join over the Crews personas tree. The engine
    // must NOT hard-require crews-assign: the node test sandbox builds with a
    // bare `window` and no CrewsAssign, and atlas-index.js loads BEFORE
    // crews-assign.js in index.html — so detection happens at build() time (when
    // both scripts are loaded), never at module-eval time. When CrewsAssign is
    // absent, resolveOwnerIdFor() returns null and every additive
    // ownerPersona*/ownerTier/etc field stays null — back-compat preserved, no
    // throw. Deterministic: reads only static personas (AG.CREWS) + the stored
    // owner_id string (no clock / random).
    const CA = options.crewsAssign ||
      (typeof window !== "undefined" && window.CrewsAssign) || null;
    const crewsIndex = options.crews || AG.CREWS || null;  // { personas: [...] } tree (or null)
    // Concrete agents: options first (tests), else CrewsAgents.listAgents() in the
    // browser, else AG.AGENTS, else []. Flat-role/persona resolution does not need
    // this list; only agent-<slug> matching does.
    const agentsList = options.agents
      || (typeof window !== "undefined" && window.CrewsAgents && window.CrewsAgents.listAgents
        ? (window.CrewsAgents.listAgents() || []) : null)
      || AG.AGENTS || [];
    // Cache identity resolution per raw owner string (deterministic, pure) so the
    // tasks loop + ownerLoad + metrics.crew share one resolution per owner_id.
    const _ownerResCache = {};
    function resolveOwnerIdFor(ownerId) {
      if (!CA || typeof CA.resolveOwnerId !== "function" || !ownerId) return null;
      if (Object.prototype.hasOwnProperty.call(_ownerResCache, ownerId)) return _ownerResCache[ownerId];
      let res = null;
      try {
        res = CA.resolveOwnerId(ownerId, crewsIndex, agentsList);
      } catch (e) {
        res = null; // never let a resolution error break the index build
      }
      _ownerResCache[ownerId] = res;
      return res;
    }

    // ── Single source of per-NODE owner decoration (AG-P13.3). ───────────────
    // The task-node loop AND extend()'s backfill-owner pass MUST stamp the owner*
    // node fields through THIS one function so a task node's join is provably the
    // SAME resolution metrics.crew uses (both go through resolveOwnerIdFor). Phase
    // 13.2 left these set inline only in the task loop; extend() rewrote n.ownerId
    // for unassigned tasks WITHOUT re-decorating, so a backfilled owner kept
    // ownerPersonaId:null. Centralizing the stamp closes that gap and guarantees a
    // resolved owner_id ALWAYS yields a non-null ownerPersonaId at runtime. Pure:
    // reads only static personas + the owner string (no clock / random). Returns
    // the node `n` for chaining. When CrewsAssign is absent every field is null and
    // nothing throws (back-compat — node sandbox path).
    function decorateNodeOwner(n, ownerId) {
      const res = resolveOwnerIdFor(ownerId);
      n.ownerPersonaId = res ? res.personaId : null;
      n.ownerTier = res ? res.tier : null;
      n.ownerKind = res ? res.kind : null;
      n.ownerResolved = res ? !!res.resolved : false;
      n.ownerLeaderId = res ? res.leaderId : null;
      return n;
    }

    function nodeId(type, rawId) {
      const rid = String(rawId);
      const existing = byId[rid];
      if (existing && existing.type !== type) return `${type}:${rid}`;
      return rid;
    }
    function addNode(n) {
      if (byId[n.id]) return byId[n.id];
      nodes.push(n);
      byId[n.id] = n;
      return n;
    }
    let edgeSeq = 0;
    function addEdge(from, to, type, confidence, reason) {
      if (!byId[from] || !byId[to] || from === to) return;
      edges.push({ id: "e" + (edgeSeq++), from, to, type, confidence, reason });
    }

    // Phases
    for (const p of phases) {
      addNode({
        id: p.id, type: "phase", label: p.key, title: p.name,
        status: p.status, phase: p.id, ownerId: p.owner,
        sourcePath: `${pmPrefix}status/`,
        sourceConfidence: "explicit", meta: p,
      });
    }

    // Roles
    for (const r of roles) {
      addNode({
        id: r.id, type: "role", label: r.id, title: `${r.name} · ${r.title}`,
        status: r.status, phase: null, ownerId: r.id, hue: r.hue,
        sourcePath: `${pmPrefix}roles/roles.json`,
        sourceConfidence: "explicit", meta: r,
      });
    }

    // Tasks
    for (const t of tasks) {
      const risk = taskRisk(t, NOW);
      const explicitOwner = taskOwnerId(t);
      // AG-P13.2/.3: ADDITIVE owner-identity decoration via the shared
      // decorateNodeOwner() (same resolveOwnerIdFor path as metrics.crew, so a
      // task node's join is provably the same resolution). NEVER overwrites
      // ownerId/ownerExplicit (owner_id is immutable). When CrewsAssign is absent
      // the resolution is null and the owner* fields stay null.
      const taskNode = addNode({
        id: t.id, type: "task", label: t.id, title: t.title,
        status: t.status, priority: t.priority, pmStatus: t.pm_status,
        phase: t._phase, ownerId: explicitOwner, ownerExplicit: !!explicitOwner, risk,
        stale: staleState(t, NOW), lastTouch: taskLastTouch(t),
        sourcePath: t._sourcePath || `${pmPrefix}status/data_${(t._phase || "").toUpperCase()}.json`,
        sourceConfidence: "explicit", meta: t,
      });
      decorateNodeOwner(taskNode, explicitOwner);
    }

    // Plans
    for (const p of plans) {
      const nid = nodeId("plan", p.id);
      addNode({
        id: nid, canonicalId: p.id, type: "plan", label: p.id, title: p.title,
        status: p.status, verdict: p.verdict, phase: p.phase, ownerId: p.author,
        linkedTaskCount: p.linkedTasks,
        sourcePath: p.path, sourceConfidence: "explicit", meta: p,
      });
    }

    // Messages
    for (const m of messages) {
      addNode({
        id: m.id, type: "message", label: m.id.replace(/^MSG-/, "").slice(0, 10),
        title: m.subject, status: m.status, verdict: m.verdict, phase: m.phase,
        ownerId: m.fromId || m.from, kind: m.kind,
        sourcePath: m.path || `project-management/messages/${m.id}.md`,
        sourceConfidence: "explicit", meta: m,
      });
    }

    // Decisions
    for (const d of decisionsData) {
      const nid = nodeId("decision", d.id);
      addNode({
        id: nid, canonicalId: d.id, type: "decision", label: d.id, title: d.title,
        status: d.status, verdict: d.verdict, phase: d.phase, ownerId: d.owner || d.decidedBy || null,
        sourcePath: d.path || `project-management/decisions/${d.id}.md`,
        sourceConfidence: "explicit", meta: d,
      });
    }

    // ── Verdict index (badges, not nodes by default) ──────────────────────
    // Attach the verdict trail to each target node so the inspector can show it.
    // Sort newest-first by parsed timestamp (Date.parse, not a clock read).
    const verdictsByTarget = {};
    for (const v of verdicts) {
      // G9: tolerate malformed verdict entries — a missing/garbled target skips
      // indexing instead of throwing and killing the whole build.
      const key = v && v.target ? v.target.id : null;
      if (!key) continue;
      (verdictsByTarget[key] = verdictsByTarget[key] || []).push(v);
    }
    for (const n of nodes) {
      if (verdictsByTarget[n.id]) {
        n.verdicts = verdictsByTarget[n.id].slice().sort((a, b) => toMs(b.at) - toMs(a.at));
        // surface latest verdict state as a badge on the node
        n.verdictState = n.verdicts[0].state;
        n.verdictAwaiting = n.verdicts.find(v => v.awaiting)?.awaiting || null;
      }
    }

    // ── EXPLICIT edges ────────────────────────────────────────────────────
    // belongs_to_phase
    for (const n of nodes) {
      if (["task", "plan", "message", "decision"].includes(n.type) && n.phase && byId[n.phase]) {
        addEdge(n.id, n.phase, "belongs_to_phase", "explicit", `${n.label} is in ${byId[n.phase].label}`);
      }
    }
    // plan authored_by role
    for (const p of plans) {
      if (p.author) addEdge(p.id, p.author, "assigned_to", "explicit", `${p.id} authored by ${p.author}`);
      for (const rv of (p.reviewers || [])) addEdge(p.id, rv, "reviewed_by", "explicit", `${rv} reviews ${p.id}`);
    }
    // message from/to roles
    for (const m of messages) {
      const fromId = m.fromId || m.from;
      const toId = m.toId || m.to;
      if (fromId) addEdge(m.id, fromId, "assigned_to", "explicit", `sent by ${fromId}`);
      if (toId) addEdge(m.id, toId, "assigned_to", "explicit", `routed to ${toId}`);
      if (m.linkedPlan) {
        const planNode = byId[m.linkedPlan] || byId[`plan:${m.linkedPlan}`];
        if (planNode) addEdge(m.id, planNode.id, "linked_to_plan", "explicit", `references plan ${m.linkedPlan}`);
      }
      for (const tid of (m.linkedTasks || [])) addEdge(m.id, tid, "mentioned_in_message", "explicit", `mentions task ${tid}`);
      for (const did of (m.linkedDecisions || [])) addEdge(m.id, did, "mentioned_in_message", "explicit", `references decision ${did}`);
    }
    // ── Handoff / evidence-chain edges (AG-P14.2 #31) ──────────────────────
    // A handoff message that names a target task emits a handoff_for edge
    // (message → task). If a LATER message or verdict closes that task (or a
    // later message routed back to the original sender references it), emit a
    // handoff_accepted edge so the trace shows "what happened next". Staleness
    // (72h, the CPO rule reused from STALE_MS) is computed ONLY against the
    // baked NOW (toMs(AG.NOW)) — never a fresh clock — and stamped onto the
    // message node so the inspector/attention can flag "stale handoff — resend".
    // Deterministic: reads only stored message/verdict timestamps + NOW.
    const handoffEdges = [];   // { msgId, taskId } for the trace + attention pass
    for (const m of messages) {
      if (m.kind !== "handoff") continue;
      const mn = byId[m.id];
      if (!mn) continue;
      const sentIso = messageIso(m);
      const sentMs = toMs(sentIso);
      mn.handoffSentAt = sentIso;
      for (const tid of (m.linkedTasks || [])) {
        const tn = byId[tid];
        if (!tn || tn.type !== "task") continue;
        addEdge(m.id, tid, "handoff_for", "explicit", `${m.id} hands off ${tid}`);
        handoffEdges.push({ msgId: m.id, taskId: tid, msg: m, sentMs });
        // handoff_accepted: the target task has been completed → the work the
        // handoff requested actually landed. Evidence the chain closed.
        if (tn.status === "completed") {
          addEdge(m.id, tid, "handoff_accepted", "inferred", `${tid} completed — handoff fulfilled`);
        }
      }
    }
    // A reply that closes the loop: a later message FROM the original recipient
    // (or any message sent after this one) that re-references the same task is
    // evidence the handoff was picked up. Emit handoff_accepted (msg → reply).
    for (const h of handoffEdges) {
      if (Number.isNaN(h.sentMs)) continue;
      const reply = messages.find(r => {
        if (r.id === h.msgId || r.kind !== "handoff") return false;
        if (!(r.linkedTasks || []).includes(h.taskId)) return false;
        const rMs = toMs(messageIso(r));
        return !Number.isNaN(rMs) && rMs > h.sentMs;
      });
      if (reply && byId[reply.id]) {
        addEdge(h.msgId, reply.id, "handoff_accepted", "inferred", `${reply.id} replies to ${h.msgId} re ${h.taskId}`);
      }
    }
    // decision → decidedBy role + affected plans
    for (const d of decisionsData) {
      const dn = byId[d.id] || byId[`decision:${d.id}`];
      if (!dn) continue;
      const did = dn.id;
      if (d.decidedBy) addEdge(did, d.decidedBy, "decided_by", "explicit", `decided by ${d.decidedBy}`);
      for (const w of (d.witnesses || [])) addEdge(did, w, "reviewed_by", "explicit", `${w} witnessed ${d.id}`);
      for (const pl of ((d.affects && d.affects.plans) || [])) {
        const planNode = byId[pl] || byId[`plan:${pl}`];
        if (planNode) addEdge(did, planNode.id, "linked_to_plan", "explicit", `${d.id} affects ${pl}`);
      }
    }
    // verdict target → actor role (reviewed_by)
    for (const v of verdicts) {
      if (v && v.target && byId[v.target.id] && v.actor) {
        addEdge(v.target.id, v.actor, "reviewed_by", "explicit", `${v.actor} marked ${v.state} on ${v.target.id}`);
      }
    }
    // blocked_by — when a blocker (string OR structured-object .text) names a
    // known task id (dependent → blocker). blockerText() yields the scannable
    // string for both shapes so object blockers never become "[object Object]".
    for (const t of tasks) {
      for (const b of (t.blockers || [])) {
        for (const ref of scanIds(blockerText(b))) {
          if (taskIds.has(ref) && ref !== t.id) addEdge(t.id, ref, "blocked_by", "explicit", `${t.id} blocked by ${ref}`);
        }
      }
    }
    // blocks — P9 M1 invariant #2: emit the exact reverse of blocked_by
    // (blocker → dependent) with confidence:"explicit", so impact / red-edges /
    // directional labels work both ways. addEdge guards from===to / missing.
    // This is the SINGLE source for blocksAdj below (kept consistent with the edge set).
    for (const t of tasks) {
      for (const b of (t.blockers || [])) {
        for (const ref of scanIds(blockerText(b))) {
          if (taskIds.has(ref) && ref !== t.id) addEdge(ref, t.id, "blocks", "explicit", `${ref} blocks ${t.id}`);
        }
      }
    }
    // task owner / plan links — explicit schema-backed fields (preferred over inference)
    for (const t of tasks) {
      const oid = taskOwnerId(t);
      if (oid && byId[oid]) {
        addEdge(t.id, oid, "assigned_to", "explicit", `${t.id} owned by ${oid} (task.owner)`);
      }
      for (const pid of (t.plan_ids || [])) {
        // AG-P13.1 edge-emission hardening: the plan↔task link is source-explicit
        // from task.plan_ids, but the orphan-killing edge only lands when a plan
        // NODE exists in byId. When the referenced plan file isn't loaded, create a
        // lightweight 'inferred' STUB plan node FIRST so the link still forms and
        // the task is never an orphan. The EDGE stays confidence:"explicit" (the
        // link is real from the task's own data) even though the stub node is thin.
        let planNode = byId[pid] || byId[`plan:${pid}`];
        if (!planNode) {
          planNode = addNode({
            id: pid, type: "plan", label: pid, title: pid,
            status: "unknown", phase: null, ownerId: null,
            sourceConfidence: "inferred", meta: { id: pid, _stub: true }, _stub: true,
          });
        }
        if (planNode) {
          addEdge(t.id, planNode.id, "linked_to_plan", "explicit", `${t.id} linked to plan ${pid} (task.plan_ids)`);
          // ADDITIVE: satisfy the decision's implements/belongs_to_plan vocabulary
          // for views that want it. Same from/to/confidence; EXCLUDED from degree
          // (mirrors the `blocks` mirror) so it never double-counts connectivity,
          // and the orphan set keys only on linked_to_plan so this is decoration.
          addEdge(t.id, planNode.id, "implements", "explicit", `${t.id} implements plan ${pid} (task.plan_ids)`);
        }
      }
    }
    for (const p of plans) {
      const planNode = byId[p.id] || byId[`plan:${p.id}`];
      if (!planNode) continue;
      for (const tid of (p.task_ids || [])) {
        if (byId[tid]) addEdge(tid, planNode.id, "linked_to_plan", "explicit", `${p.id} lists task ${tid} (plan.task_ids)`);
      }
    }

    // ── INFERRED edges (behind toggle) ────────────────────────────────────
    const explicitPairs = new Set(edges.map(e => e.from + ">" + e.to + ">" + e.type));
    function addInferred(from, to, type, reason) {
      if (explicitPairs.has(from + ">" + to + ">" + type)) return; // don't shadow explicit
      addEdge(from, to, type, "inferred", reason);
    }
    // task ↔ plan bridge: a message links both → infer task linked_to_plan
    for (const m of messages) {
      if (m.linkedPlan) {
        for (const tid of (m.linkedTasks || [])) {
          addInferred(tid, m.linkedPlan, "linked_to_plan", `inferred via ${m.id}: task & plan co-mentioned`);
        }
      }
    }
    // text mentions in plan summaries/sections → mention edges
    for (const p of plans) {
      const text = [p.summary, ...(p.sections || []).map(s => s.title)].join(" ");
      for (const ref of scanIds(text)) {
        if (byId[ref] && ref !== p.id) addInferred(p.id, ref, "mentioned_in_message", `plan text mentions ${ref}`);
      }
    }
    // text mentions in task remarks/descriptions
    for (const t of tasks) {
      const text = [t.pm_remark, t.description].join(" ");
      for (const ref of scanIds(text)) {
        if (byId[ref] && ref !== t.id && byId[ref].type !== "task") {
          addInferred(t.id, ref, "mentioned_in_message", `${t.id} text mentions ${ref}`);
        }
      }
    }
    // text mentions in decision rationale
    for (const d of decisionsData) {
      for (const ref of scanIds(d.why || "")) {
        if (byId[ref] && ref !== d.id) addInferred(d.id, ref, "mentioned_in_message", `${d.id} rationale mentions ${ref}`);
      }
    }
    // supersedes — superseded plan → newest active/shipped plan in same phase
    for (const p of plans) {
      if (p.status === "superseded") {
        const succ = plans.filter(q => q.phase === p.phase && q.status !== "superseded")
          .sort((a, b) => toMs(b.updated) - toMs(a.updated))[0];
        if (succ) addInferred(succ.id, p.id, "supersedes", `${succ.id} likely supersedes ${p.id} (same phase)`);
      }
    }
    // inferred task ownership from verdict actor (task assigned_to its last actor's role)
    for (const v of verdicts) {
      if (v && v.target && v.target.kind === "task" && byId[v.target.id] && v.actor) {
        addInferred(v.target.id, v.actor, "assigned_to", `inferred owner: last verdict actor ${v.actor}`);
        if (!byId[v.target.id].ownerExplicit && !byId[v.target.id].ownerId) {
          byId[v.target.id].ownerId = v.actor;
        }
      }
    }

    // ── Connectivity & owner load ─────────────────────────────────────────
    // P9 M1 invariant #1: "blocks" is the derived reverse-view of "blocked_by"
    // (the same relationship). Exclude it from degree so a single block
    // relationship is not counted twice.
    const degree = {};
    for (const e of edges) {
      // `blocks` mirrors blocked_by; `implements` mirrors linked_to_plan (AG-P13.1).
      // Both are derived reverse/parallel views of an already-counted relationship,
      // so exclude them from degree to avoid double-counting connectivity.
      if (e.type === "blocks" || e.type === "implements") continue;
      degree[e.from] = (degree[e.from] || 0) + 1;
      degree[e.to] = (degree[e.to] || 0) + 1;
    }
    for (const n of nodes) n.degree = degree[n.id] || 0;

    // ── Engine contract: blocks / affects / dependents / impactScore ──────
    // `blocked_by` runs dependent → blocker. The reverse `blocks` relation is
    // blocker → dependents. blocksAdj is derived from the explicit `blocks`
    // edges emitted above (single source of truth). A node's `affects` is the
    // transitive count of tasks that wait on it; its `impactScore =
    // affects*10 + priorityWeight`. These are the EXACT field names the lenses
    // bind to, so the five views render with zero rework. Pure — no Date/random.
    const blocksAdj = {}; // blockerId -> Set(direct dependents)
    for (const e of edges) {
      if (e.type === "blocks") (blocksAdj[e.from] = blocksAdj[e.from] || new Set()).add(e.to);
    }
    const _depCache = {};
    function dependentsOf(id) {
      if (_depCache[id]) return _depCache[id];
      const seen = new Set();
      const stack = [id];
      while (stack.length) {
        const cur = stack.pop();
        const next = blocksAdj[cur];
        if (!next) continue;
        for (const dep of next) {
          if (dep === id || seen.has(dep)) continue;
          seen.add(dep);
          stack.push(dep);
        }
      }
      const arr = [...seen].sort((a, b) => a.localeCompare(b));
      _depCache[id] = arr;
      return arr;
    }

    // Reconciliation: KEEP the designer's impact weighting. The designer UI is
    // calibrated to affects*10 + {p0:40,p1:25,p2:12,pl:6} (e.g. affects 4 + P0 = 80).
    const PRIORITY_WEIGHT = { p0: 40, p1: 25, p2: 12, pl: 6 };
    for (const n of nodes) {
      const deps = dependentsOf(n.id);          // transitive downstream task ids (sorted, distinct)
      n.dependents = deps;                       // ids that wait on this node
      n.affects = deps.length;                   // transitive downstream count
      if (n.type === "plan") n.affects = Math.max(n.affects, n.linkedTaskCount || 0);
      n.impactScore = n.affects * 10 + (PRIORITY_WEIGHT[n.priority] || 0);
      n.blocksDirect = blocksAdj[n.id] ? [...blocksAdj[n.id]] : [];
    }

    // task → plan linkage presence (explicit OR inferred) for orphan detection
    const taskLinkedToPlan = new Set();
    const planLinkedToTask = new Set();
    for (const e of edges) {
      if (e.type === "linked_to_plan") {
        if (byId[e.from]?.type === "task") taskLinkedToPlan.add(e.from);
        if (byId[e.to]?.type === "plan") planLinkedToTask.add(e.to);
      }
    }

    // ── Metrics ───────────────────────────────────────────────────────────
    const byPhase = {};
    for (const p of phases) {
      byPhase[p.id] = { id: p.id, key: p.key, name: p.name, status: p.status, owner: p.owner,
        total: 0, completed: 0, in_progress: 0, todo: 0, blocked: 0 };
    }
    for (const t of tasks) {
      const b = byPhase[t._phase]; if (!b) continue;
      b.total++; b[t.status] = (b[t.status] || 0) + 1;
    }

    const blockedTasks = tasks.filter(t => t.status === "blocked");
    const rejected = nodes.filter(n => n.verdictState === "rejected" || n.pmStatus === "rejected");
    const needsReview = nodes.filter(n => n.verdictState === "needs-review" || n.pmStatus === "needs-review");
    const staleTasks = tasks.filter(t => staleState(t, NOW));
    const unassignedTasks = tasks.filter(t => !byId[t.id].ownerExplicit);
    const orphanTasks = tasks.filter(t => !taskLinkedToPlan.has(t.id));
    const orphanPlans = plans.filter(p => !planLinkedToTask.has(p.id) && (p.linkedTasks || 0) === 0);
    const untargetedMessages = messages.filter(m => !m.linkedPlan && !(m.linkedTasks || []).length && !(m.linkedDecisions || []).length);
    const danglingDecisions = decisionsData.filter(d => !((d.affects && d.affects.plans) || []).length && !((d.affects && d.affects.tasks) || 0));

    // owner load — count of risky/owned items per role. KEYED by the 6 flat role
    // ids (AG.ROLES) so existing lookups (ownerLoad[n.ownerId]) keep hitting. The
    // personaId/tier/leaderId are ADDITIVE decoration from the AG-P13.2 join (null
    // when CrewsAssign is absent); the { id, owns, risky } shape is unchanged.
    const ownerLoad = {};
    for (const r of roles) {
      const res = resolveOwnerIdFor(r.id);
      ownerLoad[r.id] = {
        id: r.id, owns: 0, risky: 0,
        personaId: res ? res.personaId : null,
        tier: res ? res.tier : null,
        leaderId: res ? res.leaderId : null,
      };
    }
    for (const n of nodes) {
      if (n.ownerId && ownerLoad[n.ownerId]) {
        ownerLoad[n.ownerId].owns++;
        const risky = (n.risk && n.risk.length) || n.verdictState === "needs-review" || n.verdictState === "rejected";
        if (risky) ownerLoad[n.ownerId].risky++;
      }
      if (n.verdictAwaiting && ownerLoad[n.verdictAwaiting]) ownerLoad[n.verdictAwaiting].risky++;
    }

    // ── Graph-quality / data-quality macro metrics (AG-P14.2 #29) ──────────
    // Pure counting over the existing edge/node set — trivially deterministic
    // (no clock / random). The denominator EXCLUDES the derived mirror edges
    // (`blocks` mirrors blocked_by, `implements` mirrors linked_to_plan) so a
    // single relationship is counted once — consistent with explicitEdges. The
    // result tells a PM "how much of this graph is real vs. speculated" and where
    // metadata is missing (no-owner tasks, orphan tasks/plans, all-inferred nodes).
    const MIRROR = new Set(["blocks", "implements"]);
    const qEdges = edges.filter(e => !MIRROR.has(e.type));
    const qExplicit = qEdges.filter(e => e.confidence === "explicit").length;
    const qInferred = qEdges.filter(e => e.confidence === "inferred").length;
    const qBackfilled = qEdges.filter(e => e.confidence === "backfilled").length;
    const qTotal = qEdges.length || 0;
    const pct = (n) => qTotal ? Math.round((n / qTotal) * 100) : 0;
    const tasksWithOwner = tasks.filter(t => !!byId[t.id].ownerExplicit).length;
    const ownerCoverage = tasks.length ? Math.round((tasksWithOwner / tasks.length) * 100) : 0;
    // Per-node coverage flags so the "Audit" affordance can filter/highlight the
    // low-coverage nodes: a task with no explicit owner, an orphan (no plan link),
    // or a node whose ONLY connections are inferred/backfilled (nothing explicit).
    const explicitDegree = {};
    for (const e of qEdges) {
      if (e.confidence !== "explicit") continue;
      explicitDegree[e.from] = (explicitDegree[e.from] || 0) + 1;
      explicitDegree[e.to] = (explicitDegree[e.to] || 0) + 1;
    }
    const lowCoverageIds = [];
    for (const n of nodes) {
      if (n.type === "phase" || n.type === "role") continue;
      const flags = [];
      if (n.type === "task" && !n.ownerExplicit) flags.push("no-owner");
      if (n.type === "task" && !taskLinkedToPlan.has(n.id)) flags.push("orphan");
      if (n.type === "plan" && !planLinkedToTask.has(n.id) && !(n.linkedTaskCount || 0)) flags.push("orphan");
      if (n.degree > 0 && !explicitDegree[n.id]) flags.push("all-inferred");
      n.coverageFlags = flags;
      if (flags.length) lowCoverageIds.push(n.id);
    }
    const quality = {
      edges: qTotal,
      explicit: qExplicit, inferred: qInferred, backfilled: qBackfilled,
      explicitPct: pct(qExplicit), inferredPct: pct(qInferred), backfilledPct: pct(qBackfilled),
      tasks: tasks.length, tasksWithOwner, ownerCoverage,
      orphanTasks: orphanTasks.length, orphanPlans: orphanPlans.length,
      noOwnerTasks: unassignedTasks.length,
      lowCoverageIds: lowCoverageIds.sort((a, b) => a.localeCompare(b)),
      lowCoverageCount: lowCoverageIds.length,
    };

    const metrics = {
      byPhase,
      quality,
      byStatus: {
        blocked: tasks.filter(t => t.status === "blocked").length,
        in_progress: tasks.filter(t => t.status === "in_progress").length,
        todo: tasks.filter(t => t.status === "todo").length,
        completed: tasks.filter(t => t.status === "completed").length,
      },
      totals: {
        tasks: tasks.length, plans: plans.length, messages: messages.length,
        decisions: decisionsData.length, roles: roles.length, phases: phases.length,
        edges: edges.length,
        // P9 M1 invariant #1: a reverse `blocks` edge must NOT inflate the
        // "explicit edges" count (it mirrors blocked_by, same relationship). The
        // `implements` edge (AG-P13.1) likewise mirrors linked_to_plan — exclude it.
        explicitEdges: edges.filter(e => e.confidence === "explicit" && e.type !== "blocks" && e.type !== "implements").length,
        inferredEdges: edges.filter(e => e.confidence === "inferred").length,
      },
      blocked: blockedTasks.length,
      rejected: rejected.length,
      needsReview: needsReview.length,
      stale: staleTasks.length,
      unassigned: unassignedTasks.length,
      orphanTasks: orphanTasks.length,
      orphanPlans: orphanPlans.length,
      untargetedMessages: untargetedMessages.length,
      danglingDecisions: danglingDecisions.length,
      ownerLoad,
    };

    // ── Attention items (curated, sorted by severity) ─────────────────────
    const attention = [];
    const SEV = { critical: 3, high: 2, medium: 1 };
    // G4 dedupe: one id surfaces ONCE across all severity bands. flaggedIds is
    // seeded/maintained by push() itself so every producer loop below can guard
    // with has() regardless of ordering (e.g. a rejected task that is also stale
    // lists only as rejected — the first band to claim it wins).
    const flaggedIds = new Set(attention.map(a => a.id));

    // Normalized human-attention item shape. push() backfills the three
    // additive fields (raised_at / needs / link) with nulls when a producer
    // omits them, so every item — legacy or new — lands in the inbox/badge
    // contract with one shape. `link` defaults to the node's sourcePath (the
    // project-management/... path the operator opens). All values are existing
    // strings; nothing is generated (no clock / random). Also records the id in
    // flaggedIds so later bands skip it (G4 dedupe).
    function push(item) {
      if (item.raised_at === undefined) item.raised_at = null;
      if (item.needs === undefined) item.needs = null;
      if (item.link === undefined) item.link = (item.node && item.node.sourcePath) || null;
      attention.push(item);
      flaggedIds.add(item.id);
    }

    for (const t of blockedTasks) {
      const n = byId[t.id];
      const firstBlocker = (t.blockers && t.blockers.length) ? t.blockers[0] : null;
      // A structured blocker carries needs/severity/raised_at/owner; the legacy
      // string path leaves them null. needs:"decision"/"access" or severity:"p0"
      // keeps critical band; the blocked item itself stays kind:"blocked".
      const bNeeds = blockerNeeds(firstBlocker) || null;
      push({ id: t.id, kind: "blocked", severity: "critical", node: n,
        label: t.title, owner: blockerOwnerId(firstBlocker) || n.ownerId,
        why: firstBlocker ? blockerText(firstBlocker) : "Marked blocked",
        action: "Unblock or escalate",
        needs: bNeeds,
        raised_at: blockerRaisedAt(firstBlocker) || null,
        link: n.sourcePath || null });
    }
    for (const n of rejected) {
      if (flaggedIds.has(n.id)) continue;
      if (n.type === "task" && byId[n.id].status === "blocked") continue; // already shown
      push({ id: n.id, kind: "rejected", severity: "critical", node: n,
        label: n.title, owner: n.ownerId,
        why: (n.verdicts && n.verdicts[0]?.note) || "Review rejected",
        action: "Address rejection & re-submit" });
    }
    for (const t of staleTasks) {
      if (flaggedIds.has(t.id)) continue; // e.g. already listed as rejected (G4)
      const n = byId[t.id];
      const lastMs = n.lastTouch ? toMs(n.lastTouch) : NaN;
      const days = Number.isNaN(lastMs) ? null : Math.round((NOW - lastMs) / 86400000);
      push({ id: t.id, kind: n.stale === "severe" ? "stale-severe" : "stale",
        severity: n.stale === "severe" ? "high" : "medium", node: n,
        label: t.title, owner: n.ownerId,
        why: days != null ? `In progress, no movement for ${days}d` : "In progress, no recorded movement",
        action: "Nudge owner or re-scope" });
    }
    for (const n of needsReview) {
      if (flaggedIds.has(n.id)) continue;
      if (n.stale || n.status === "blocked") continue;
      push({ id: n.id, kind: "needs-review", severity: "high", node: n,
        label: n.title, owner: n.verdictAwaiting || n.ownerId,
        why: (n.verdicts && n.verdicts[0]?.note) || "Awaiting verdict",
        action: n.verdictAwaiting ? `Awaiting ${n.verdictAwaiting}` : "Route for verdict" });
    }
    // ── Collaboration signals: help / crew / decision-pending (additive) ───
    // Pushed BEFORE the enrichment loop, so the loop stamps
    // impactScore/affects/dependents on them too. DETERMINISTIC: reads only
    // stored strings (blocker.raised_at / decision dates) — no Date.now/new
    // Date/Math.random. flaggedIds is maintained by push() itself (G4).

    // (a) Soft-help — task.needs === "help" OR a structured blocker needs:"help".
    // Soft-help is the whole point: it surfaces a task that is MOVING (status may
    // be anything) but whose owner wants attention. Dedupe so a task already in
    // the queue (e.g. shown as blocked) is not double-listed as help.
    for (const t of tasks) {
      if (flaggedIds.has(t.id)) continue;
      const structHelp = (t.blockers || []).find(b => blockerNeeds(b) === "help");
      const wantsHelp = t.needs === "help" || !!structHelp;
      if (!wantsHelp) continue;
      const sev = blockerSeverity(structHelp) === "p0" ? "high" : "high"; // help → high band
      push({ id: t.id, kind: "help", severity: sev, node: byId[t.id],
        label: t.title, owner: blockerOwnerId(structHelp) || byId[t.id].ownerId,
        why: t.waiting_on ? `Help requested — waiting on ${t.waiting_on}` : "Help requested",
        action: "Assist owner",
        needs: "help",
        raised_at: blockerRaisedAt(structHelp) || null });
    }

    // (b) Crew/staffing — task.needs === "crew" OR a structured blocker needs:"crew".
    for (const t of tasks) {
      if (flaggedIds.has(t.id)) continue;
      const structCrew = (t.blockers || []).find(b => blockerNeeds(b) === "crew");
      const wantsCrew = t.needs === "crew" || !!structCrew;
      if (!wantsCrew) continue;
      const sev = blockerSeverity(structCrew) === "p0" ? "high" : "medium";
      push({ id: t.id, kind: "crew", severity: sev, node: byId[t.id],
        label: t.title, owner: blockerOwnerId(structCrew) || byId[t.id].ownerId,
        why: "Crew/staffing requested",
        action: "Staff or delegate",
        needs: "crew",
        raised_at: blockerRaisedAt(structCrew) || null });
    }

    // (c) Decision-pending — a Ledgers decision with Status: proposed (pm-loader
    // emits d.status === "proposed"). The decision node already exists in byId
    // from the decisions loop above. raised_at reuses the decision's stored Date.
    for (const d of decisionsData) {
      if (d.status !== "proposed") continue;
      const dn = byId[d.id] || byId[`decision:${d.id}`];
      if (!dn || flaggedIds.has(dn.id)) continue;
      push({ id: dn.id, kind: "decision-pending", severity: "high", node: dn,
        label: d.title, owner: d.approver || null,
        why: d.title, action: `Approve or reject ${d.id}`,
        needs: "decision",
        raised_at: d.at || d.date || null,
        link: dn.sourcePath || d.path || null });
    }

    // high-priority tasks with no recent movement (and not already flagged)
    for (const t of tasks) {
      if (flaggedIds.has(t.id)) continue;
      if ((t.priority === "p0" || t.priority === "p1") && t.status === "in_progress") {
        push({ id: t.id, kind: "hi-pri-idle", severity: "medium", node: byId[t.id],
          label: t.title, owner: byId[t.id].ownerId,
          why: `${t.priority.toUpperCase()} in progress`, action: "Confirm it's moving" });
      }
    }
    for (const t of orphanTasks) {
      if (flaggedIds.has(t.id) || t.status === "completed") continue;
      push({ id: t.id, kind: "orphan-task", severity: "medium", node: byId[t.id],
        label: t.title, owner: byId[t.id].ownerId,
        why: "No linked plan", action: "Link to a plan" });
    }
    for (const p of orphanPlans) {
      const pn = byId[p.id] || byId[`plan:${p.id}`];
      if (pn && flaggedIds.has(pn.id)) continue; // e.g. already listed as rejected (G4)
      push({ id: pn ? pn.id : p.id, kind: "orphan-plan", severity: "medium", node: pn,
        label: p.title, owner: p.author,
        why: "No linked tasks", action: "Cut tasks or archive" });
    }
    // unresolved handoffs: handoff messages whose linked task isn't completed.
    // Staleness (>72h) is computed against the BAKED NOW (toMs(AG.NOW)) — never a
    // fresh clock — using STALE_MS (the same 72h CPO rule the engine already uses
    // for stale tasks). A stale open handoff bumps to severity:"high" and surfaces
    // a "resend" action; the message node carries handoffStale/handoffAgeMs/
    // handoffTargetId/handoffTargetStatus so the inspector can render the trace.
    for (const m of messages) {
      if (m.kind !== "handoff") continue;
      const openTask = (m.linkedTasks || []).map(id => byId[id]).find(t => t && t.status !== "completed");
      const mn = byId[m.id];
      if (openTask) {
        const sentMs = toMs(mn ? mn.handoffSentAt : messageIso(m));
        const ageMs = Number.isNaN(sentMs) ? null : (NOW - sentMs);
        const stale = ageMs != null && ageMs >= STALE_MS;
        const ageDays = ageMs != null ? Math.round(ageMs / 86400000) : null;
        if (mn) {
          mn.handoffStale = stale;
          mn.handoffAgeMs = ageMs;
          mn.handoffTargetId = openTask.id;
          mn.handoffTargetStatus = openTask.status;
        }
        push({ id: m.id, kind: "open-handoff", severity: stale ? "high" : "medium", node: mn,
          label: m.subject, owner: m.toId || m.to,
          why: stale
            ? `Stale handoff — ${openTask.id} still ${openTask.status.replace("_", " ")} after ${ageDays}d`
            : `Handoff → ${openTask.id} still ${openTask.status.replace("_", " ")}`,
          action: stale ? `Resend handoff for ${openTask.id}` : `Close out ${openTask.id}`,
          needs: stale ? "resend" : null,
          raised_at: mn ? mn.handoffSentAt : null });
      }
    }
    // overloaded owners
    for (const id of Object.keys(ownerLoad)) {
      const l = ownerLoad[id];
      if (l.risky >= 3) {
        push({ id, kind: "overloaded", severity: l.risky >= 5 ? "high" : "medium", node: byId[id],
          label: `${byId[id].title}`, owner: id,
          why: `${l.risky} risky / awaiting items`, action: "Rebalance load" });
      }
    }

    // For every attention item, surface the same node-level impact fields the
    // lenses read (affects / impactScore / dependents), used to re-rank WITHIN a
    // severity band. Mirrors the node's transitive blast radius.
    for (const item of attention) {
      const deps = dependentsOf(item.id);
      item.dependents = deps;
      item.affects = deps.length;
      item.impactScore = item.affects * 10 + (PRIORITY_WEIGHT[item.node && item.node.priority] || 0);
    }

    attention.sort((a, b) =>
      (SEV[b.severity] - SEV[a.severity]) ||
      (b.impactScore - a.impactScore) ||
      (b.affects - a.affects) ||
      a.id.localeCompare(b.id));

    // ── Decisions queue ────────────────────────────────────────────
    // Exception-first → the verdicts gating the most work, ranked by
    // impactScore, so the operator clears the highest-leverage decision first.
    const decisions = [];
    for (const n of needsReview) {
      const latest = (n.verdicts && n.verdicts[0]) || null;
      const awaiting = n.verdictAwaiting || (latest && latest.awaiting) || null;
      decisions.push({
        id: n.id, node: n, awaiting,
        affects: n.affects, impactScore: n.impactScore, dependents: n.dependents,
        ownerId: n.type === "task" ? n.ownerId : null,
        why: (latest && latest.note) || "Awaiting verdict",
        latestVerdict: latest,
        kind: n.type,
      });
    }
    // Pending Ledgers decisions (Status: proposed) ride the SAME queue so Atlas
    // Decisions surfaces them ranked by impactScore alongside needs-review
    // verdicts. The node already carries affects/impactScore/dependents from the
    // enrichment loop above. awaiting = the approver the operator must act as.
    for (const d of decisionsData) {
      if (d.status !== "proposed") continue;
      const dn = byId[d.id] || byId[`decision:${d.id}`];
      if (!dn) continue;
      decisions.push({
        id: dn.id, node: dn, awaiting: d.approver || null,
        affects: dn.affects, impactScore: dn.impactScore, dependents: dn.dependents,
        ownerId: null,
        why: d.title || "Pending approval",
        latestVerdict: null,
        kind: "decision-pending",
      });
    }
    decisions.sort((a, b) => (b.impactScore - a.impactScore) || a.id.localeCompare(b.id));

    // ── Crew roster (real counts; the live "now" line is composed in the lens) ──
    const decByAwaiting = {};
    for (const d of decisions) if (d.awaiting) (decByAwaiting[d.awaiting] = decByAwaiting[d.awaiting] || []).push(d);
    // CREW ROSTER STAYS ONE-ROW-PER-FLAT-ROLE (AG.ROLES, 6 rows) — the ownership
    // join (owned = nodes whose ownerId === r.id) is the REAL per-agent load. The
    // AG-P13.2 persona fields (personaId/persona/tier/reportsTo/leaderId/resolved)
    // are ADDITIVE per-row decoration so atlas-crew.jsx can replace its hardcoded
    // CREW_REPORTS_TO ladder with the engine's real reports_to. Every existing
    // field is preserved verbatim; null when CrewsAssign is absent.
    metrics.crew = roles.map(r => {
      const owned = nodes.filter(n => n.ownerId === r.id && n.type !== "role");
      const risky = owned.filter(n => (n.risk && n.risk.length) || n.verdictState === "rejected" || n.verdictState === "needs-review");
      const awaiting = decByAwaiting[r.id] || [];
      const res = resolveOwnerIdFor(r.id);
      const persona = res ? res.persona : null;
      return {
        id: r.id, meta: r, status: r.status,
        owns: owned.length, riskyCount: risky.length, awaitingCount: awaiting.length,
        ownedItems: owned, riskyItems: risky, awaitingItems: awaiting,
        personaId: res ? res.personaId : null,
        persona: persona,
        tier: res ? res.tier : null,
        reportsTo: persona ? (persona.reports_to || null) : null,
        leaderId: res ? res.leaderId : null,
        resolved: res ? !!res.resolved : false,
      };
    });

    // ── Roadmap (phase progress and blocker counts from task data) ──
    metrics.roadmap = phases.map((p, i) => {
      const b = byPhase[p.id] || { total: 0, completed: 0, blocked: 0, in_progress: 0 };
      const pct = b.total ? Math.round((b.completed / b.total) * 100) : 0;
      return {
        id: p.id, key: p.key, name: p.name, status: p.status, owner: p.owner,
        total: b.total, completed: b.completed || 0, blocked: b.blocked || 0,
        in_progress: b.in_progress || 0, todo: b.todo || 0, pct,
        scheduleRisk: b.blocked > 0 ? "at-risk" : (p.status === "in_progress" && pct < 40 ? "watch" : "on-track"),
        order: i,
      };
    });

    // `now` is the ISO string baked from AG.NOW (no clock read). rescanDiff reads
    // it as the comparison reference; relTime/components can parse it directly.
    return { nodes, edges, metrics, attention, decisions, byId, blocksAdj, now: nowIso };
  }

  // ── rescan(): designer-shaped just-resolved cascade ────────────────────
  // SIGNATURE THE VIEWS CALL: atlas-views.jsx invokes window.AtlasIndex.rescan([id])
  // and reads delta.freedCount ("rescan freed N downstream tasks"). Given the ids
  // the operator just resolved, rebuild and return the downstream tasks their
  // resolution frees. Pure: rebuilds the index, reads dependents, diffs. Accepts
  // the same build options so it stays project-scoped.
  function rescan(resolvedIds, options = {}) {
    const idx = build(options);
    const freed = new Set();
    for (const id of (resolvedIds || [])) {
      const n = idx.byId[id];
      if (n && n.dependents) n.dependents.forEach(d => freed.add(d));
    }
    return { resolved: [...(resolvedIds || [])], freed: [...freed], freedCount: freed.size };
  }

  // ── rescanDiff(): pure prev/next just-resolved differ (P9 M1) ───────────
  // PURE diff of two already-built indices. Reads EXISTING node fields only
  // (status / stale / pmStatus / verdictState) and each index's baked `now` —
  // never calls Date.now(), new Date(), or Math.random(), and never recomputes a
  // timestamp. Surfaces the per-category id deltas plus the "just-resolved" set
  // that drives the live-status fade marker. Exposed separately from rescan so the
  // live-status fade can use it without changing the cascade signature the views call.
  function nodeStateOf(n) {
    return {
      blocked: n.status === "blocked",
      stale: !!n.stale,
      needsReview: n.verdictState === "needs-review" || n.pmStatus === "needs-review",
      rejected: n.verdictState === "rejected" || n.pmStatus === "rejected",
    };
  }
  function isRisky(s) {
    return s.blocked || s.stale || s.needsReview || s.rejected;
  }
  function sortedIds(set) {
    return [...set].sort((a, b) => a.localeCompare(b));
  }
  function rescanDiff(prevIndex, nextIndex) {
    const empty = {
      changed: { blocked: [], unblocked: [], stale: [], unstale: [], needsReview: [], reviewResolved: [] },
      justResolved: new Set(),
      resolvedAt: {},
    };
    if (!prevIndex || !nextIndex) return empty;

    const prevById = prevIndex.byId || {};
    const nextById = nextIndex.byId || {};
    const prevState = {};
    for (const id of Object.keys(prevById)) prevState[id] = nodeStateOf(prevById[id]);
    const nextState = {};
    for (const id of Object.keys(nextById)) nextState[id] = nodeStateOf(nextById[id]);

    const blocked = new Set(), unblocked = new Set();
    const stale = new Set(), unstale = new Set();
    const needsReview = new Set(), reviewResolved = new Set();
    const justResolved = new Set();
    const resolvedAt = {};
    // nextIndex.now is the EXISTING comparison reference (ISO string baked at
    // build time) — do not regenerate it. Normalize to ISO without a clock read.
    const rawNow = nextIndex.now;
    const stamp = (typeof rawNow === "string")
      ? rawNow
      : (rawNow && typeof rawNow.toISOString === "function" ? rawNow.toISOString() : String(rawNow));

    // Only ids present in nextIndex can transition (a removed node is not a delta).
    for (const id of Object.keys(nextById)) {
      const ns = nextState[id];
      const ps = prevState[id];
      if (!ps) continue; // newly-appeared node — no prior state to diff against
      if (ns.blocked && !ps.blocked) blocked.add(id);
      if (!ns.blocked && ps.blocked) unblocked.add(id);
      if (ns.stale && !ps.stale) stale.add(id);
      if (!ns.stale && ps.stale) unstale.add(id);
      if (ns.needsReview && !ps.needsReview) needsReview.add(id);
      if (!ns.needsReview && ps.needsReview) reviewResolved.add(id);
      if (isRisky(ps) && !isRisky(ns)) {
        justResolved.add(id);
        resolvedAt[id] = stamp;
      }
    }

    return {
      changed: {
        blocked: sortedIds(blocked),
        unblocked: sortedIds(unblocked),
        stale: sortedIds(stale),
        unstale: sortedIds(unstale),
        needsReview: sortedIds(needsReview),
        reviewResolved: sortedIds(reviewResolved),
      },
      justResolved,
      resolvedAt,
    };
  }

  // ── extend(): simulate the approved data-model backfill ────────────────
  // Adds the additive plan_ids / owner relationships so the rich state can be
  // shown (Connected · N real, orphans collapse). Backfilled edges are tagged
  // confidence:"backfilled" so trust signals never present them as source-explicit.
  function extend(options = {}) {
    const idx = build(options);
    const AG = options.agentarium || window.AGENTARIUM || {};
    const plans = AG.PLANS || [];
    const planByPhase = {};
    for (const p of plans) if (p.status !== "superseded" && !planByPhase[p.phase]) planByPhase[p.phase] = (idx.byId[p.id] || idx.byId[`plan:${p.id}`] || {}).id || p.id;
    const owners = ["fe", "be", "tl"];
    let oi = 0, seq = idx.edges.length;
    function add(from, to, type, reason) {
      if (idx.byId[from] && idx.byId[to] && from !== to)
        idx.edges.push({ id: "x" + (seq++), from, to, type, confidence: "backfilled", reason });
    }
    // AG-P13.3: re-decorate a BACKFILLED owner through the same resolver build()
    // used (options.crewsAssign || window.CrewsAssign), so a task that GAINS an
    // owner in extended mode also gains its ownerPersonaId/Tier/etc. Null-safe and
    // pure (static personas only); no-op when CrewsAssign is absent.
    const extCA = options.crewsAssign || (typeof window !== "undefined" && window.CrewsAssign) || null;
    const extCrews = options.crews || AG.CREWS || null;
    const extAgents = options.agents
      || (typeof window !== "undefined" && window.CrewsAgents && window.CrewsAgents.listAgents
        ? (window.CrewsAgents.listAgents() || []) : null)
      || AG.AGENTS || [];
    function redecorate(n, ownerId) {
      let res = null;
      if (extCA && typeof extCA.resolveOwnerId === "function" && ownerId) {
        try { res = extCA.resolveOwnerId(ownerId, extCrews, extAgents); } catch (e) { res = null; }
      }
      n.ownerPersonaId = res ? res.personaId : null;
      n.ownerTier = res ? res.tier : null;
      n.ownerKind = res ? res.kind : null;
      n.ownerResolved = res ? !!res.resolved : false;
      n.ownerLeaderId = res ? res.leaderId : null;
    }
    for (const n of idx.nodes) {
      if (n.type !== "task") continue;
      if (!n.ownerId) {
        n.ownerId = owners[oi++ % owners.length];
        n.ownerBackfilled = true;
        add(n.id, n.ownerId, "assigned_to", `backfilled owner ${n.ownerId}`);
        redecorate(n, n.ownerId);
      }
      const plan = planByPhase[n.phase];
      if (plan) add(n.id, plan, "linked_to_plan", `backfilled link to ${plan}`);
    }
    // recompute connectivity + orphans + crew off the enriched edge set.
    // `blocks` stays excluded from degree (invariant #1) even after backfill.
    const deg = {};
    for (const e of idx.edges) { if (e.type === "blocks" || e.type === "implements") continue; deg[e.from] = (deg[e.from] || 0) + 1; deg[e.to] = (deg[e.to] || 0) + 1; }
    for (const n of idx.nodes) n.degree = deg[n.id] || 0;
    const taskLinked = new Set();
    for (const e of idx.edges) if (e.type === "linked_to_plan" && idx.byId[e.from]?.type === "task") taskLinked.add(e.from);
    const tasks2 = idx.nodes.filter(n => n.type === "task");
    idx.metrics.orphanTasks = tasks2.filter(n => !taskLinked.has(n.id)).length;
    idx.metrics.unassigned = tasks2.filter(n => !n.ownerId).length;
    idx.metrics.extended = true;
    // Recompute the graph-quality metric (AG-P14.2 #29) off the BACKFILLED edge
    // set so the macro lens reflects what the backfill closed (orphans drop,
    // owner-coverage rises, a backfilled-edge slice appears). Pure counting.
    {
      const MIRROR2 = new Set(["blocks", "implements"]);
      const qE = idx.edges.filter(e => !MIRROR2.has(e.type));
      const qT = qE.length || 0;
      const p = (n) => qT ? Math.round((n / qT) * 100) : 0;
      const ex = qE.filter(e => e.confidence === "explicit").length;
      const inf = qE.filter(e => e.confidence === "inferred").length;
      const bf = qE.filter(e => e.confidence === "backfilled").length;
      const planLinked2 = new Set();
      for (const e of idx.edges) if (e.type === "linked_to_plan" && idx.byId[e.to]?.type === "plan") planLinked2.add(e.to);
      const exDeg = {};
      for (const e of qE) { if (e.confidence !== "explicit") continue; exDeg[e.from] = (exDeg[e.from] || 0) + 1; exDeg[e.to] = (exDeg[e.to] || 0) + 1; }
      const low = [];
      for (const n of idx.nodes) {
        if (n.type === "phase" || n.type === "role") continue;
        const flags = [];
        if (n.type === "task" && !n.ownerId) flags.push("no-owner");
        if (n.type === "task" && !taskLinked.has(n.id)) flags.push("orphan");
        if (n.type === "plan" && !planLinked2.has(n.id) && !(n.linkedTaskCount || 0)) flags.push("orphan");
        if (n.degree > 0 && !exDeg[n.id]) flags.push("all-inferred");
        n.coverageFlags = flags;
        if (flags.length) low.push(n.id);
      }
      const withOwner = tasks2.filter(n => !!n.ownerId).length;
      idx.metrics.quality = {
        edges: qT, explicit: ex, inferred: inf, backfilled: bf,
        explicitPct: p(ex), inferredPct: p(inf), backfilledPct: p(bf),
        tasks: tasks2.length, tasksWithOwner: withOwner,
        ownerCoverage: tasks2.length ? Math.round((withOwner / tasks2.length) * 100) : 0,
        orphanTasks: idx.metrics.orphanTasks, orphanPlans: idx.metrics.orphanPlans,
        noOwnerTasks: idx.metrics.unassigned,
        lowCoverageIds: low.sort((a, b) => a.localeCompare(b)),
        lowCoverageCount: low.length,
      };
    }
    idx.metrics.crew = idx.metrics.crew.map(c => {
      const owned = idx.nodes.filter(n => n.ownerId === c.id && n.type !== "role");
      const risky = owned.filter(n => (n.risk && n.risk.length) || n.verdictState === "rejected" || n.verdictState === "needs-review");
      return { ...c, owns: owned.length, riskyCount: risky.length, ownedItems: owned, riskyItems: risky };
    });
    return idx;
  }

  window.AtlasIndex = { build, rescan, rescanDiff, extend, STALE_MS, SEVERE_STALE_MS };
})();
