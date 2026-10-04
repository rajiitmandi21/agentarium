# Atlas — Architecture & Handoff (AG-P6.3, v-final)

**From:** Product Designer (consultant) → in-house team
**Status:** Final consultant delivery. Complete lens set, all states, v-final code, screenshots, design-system reference. **Read-only design surface — you integrate onto the live engine.**
**Open in:** `Atlas.html`. **Supersedes** all prior Atlas handoffs.

---

## 1. What this is — and the real-vs-vision line

A complete, house-aligned design of the Atlas lens-cockpit, driven by a deterministic index over the **real** project data so every screen is true, not mocked. After this round the team integrates it onto the P9 engine and owns Atlas design in-house.

**Real (computed from data, wires directly):**
- Pulse attention + severity ranking; Decisions queue; the dependency graph; impact ranking (`affects` / `impactScore` / `dependents`); phase progress + schedule-risk signal; Crew roster, load, ownership; orphan/trust detection.

**Vision (designed, labeled, wiring deferred):** every one wears a `VisionTag`.
- **Agent-command** — the Crew "now" line + steer/reassign/intervene, and the **Maestro command strip**. Wires with Maestro + the role→persona map.
- **Roadmap** target dates + milestones (progress/risk are real; dates are projected).
- **Act-in-place** — inline approve/reject is optimistic-local; "Open in {Module}" flashes intent. Wire to the live verdict + router plumbing.

The footer and tags always tell you which mode you're in (e.g. `extended model · agent feed dark`).

---

## 2. Engine bridge — design is built TO your field contract

`atlas-index.js` is the **demo** engine; replace it with the P9 engine. It already emits your field names, so the lenses bind with no rework:

| Field | Meaning | Where it drives UI |
|---|---|---|
| `affects` | transitive downstream count (via reverse `blocks`) | "affects N", node size, Pulse/Decisions/Critical ranking |
| `impactScore` | `affects*10 + priorityWeight` (p0 40 / p1 25 / p2 12 / pl 6) | Decisions + Critical-path sort, Pulse lane sort |
| `dependents` | the gated ids | critical-path chain preview, inspector |
| `blocks` (reverse of `blocked_by`) | blocker → dependents | impact, red edges, directional labels |
| `rescan(resolvedIds)` | pure just-resolved delta `{resolved, freed, freedCount}` | the post-approve "freed N downstream" cascade |

**Integration:** keep your engine; point the lenses at its outputs. Each lens reads `index.{nodes,edges,byId,attention,decisions,metrics}` and `metrics.{byPhase,crew,roadmap,ownerLoad,...}`. Swap the builder, keep the views. The edge set uses `blocked_by`; reconcile with your `blocks` direction (both are equivalent — `blocks` is the reverse) and your `rescan()`.

**Data-model extension (approved):** `extend()` simulates the additive `plan_ids`/`owner` backfill + role→persona map. In `legacy` mode orphans are reframed as findings; in `extended` mode they resolve to real `Connected · N` with `backfilled` trust provenance. Wire `extend()`'s outputs to the real backfill.

---

## 3. The lens set (all complete)

1. **Pulse** — KPI orientation strip → severity lanes, each card = artifact + why + owner + impact + one-click next action.
2. **Map** — **critical-path hero** ("N nodes gate X% of remaining work", ranked on `impactScore`) as the landing; **topology graph** (risky subgraph → all nodes) as the drill. Node-cloud is never the landing.
3. **Decisions** — queue ranked by `impactScore`; inline approve / reject-with-reason; optimistic + undo; `rescan()` cascade.
4. **Crew** *(moat)* — persona roster: station, live activity (vision), load, the risky items each owns, steer/reassign/intervene (vision), and the `reports_to` authority/escalation chain. Plus the locked-until-data state.
5. **Roadmap** — phase timeline, progress, milestones (vision), cross-phase gates, schedule risk. Plus the locked-until-data state.

**Agent-command** lives in **both** Crew (deep) and the persistent **Maestro strip** (glanceable + steer across lenses). This is the moat surface — designed now, labeled vision, ready when Maestro + the persona map land.

---

## 4. Files

| File | Role |
|---|---|
| `atlas-index.js` | Demo engine — nodes/edges + `affects`/`impactScore`/`dependents`/`blocks`/`rescan()`/`extend()` + `metrics.{crew,roadmap}`. **Replace with P9.** |
| `atlas-parts.jsx` | Node system, glyphs, lens tabs, filters popover, legend, `VisionTag`, `TrustChip`, `ImpactBars`, search w/ dropdown, Maestro command strip |
| `atlas-graph.jsx` | Map — critical-path hero + topology graph |
| `atlas-inspector.jsx` | Inspector drawer (directional labels, trust, freshness) |
| `atlas-views.jsx` | Pulse + Decisions |
| `atlas-crew.jsx` | Crew lens (roster, live, steer, authority chain, locked) |
| `atlas-roadmap.jsx` | Roadmap lens (timeline, gates, risk, locked) |
| `atlas-app.jsx` | Cockpit shell, lens routing, command strip, Cmd+K, focus, Tweaks |
| `atlas.css` | Atlas **layout** only |
| `ATLAS-DESIGN-SYSTEM.md` | The maintainable spec |
| `screens/` | Current screenshots — light/dark/compact × every lens × every state |

No-build React + Babel; globals on `window` (each `text/babel` file exports what others consume). Load order is set in `Atlas.html`.

---

## 5. v2 fixes — confirmed in

Connected·0 orphan reframe ✓ · impact-scaled Map nodes ✓ · node dedup (one task = one node) ✓ · no stale status strings ✓ · stale AG-P6.x screenshots deleted ✓.

## 6. Known gaps (own these next)

1. **Agent-command is the moat and it is vision here.** Roster/load/ownership are real; live activity + steer wire with **Maestro + the role→persona map**. Build that next — it's what makes Atlas *command*, not *status*.
2. **Data-model backfill must ship** for the rich state to be real (`plan_ids`/`owner`). Until then `legacy` mode is honest about orphans; `extended` shows the target.
3. **Act-in-place wiring** — approve/reject and deep-links are staged; connect to live verdict + router.
4. **Roadmap dates/milestones** are projected until phases carry real dates.
5. **Engine merge** — adopt the presentation onto the P9 engine; do not ship `atlas-index.js` as the engine.
