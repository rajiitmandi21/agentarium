# Atlas — Design System Reference (AG-P6.3, v-final)

The maintainable spec for Atlas. Atlas owns **no visual primitives of its own** — it composes the Agentarium house kit (`styles.css` + `agentarium/styles.css`). The `.atlas-` namespace is **layout only**. This doc is the contract: tokens, the node/edge system, every component, every state.

> Rule of thumb when extending Atlas: if the house kit has a component, use it. Only add an `.atlas-` class for *arrangement*, never to re-skin a button/card/chip the kit already provides.

---

## 1. Tokens (all inherited — never hardcode)

| Group | Variables | Notes |
|---|---|---|
| Surfaces | `--bg --bg-elev --surface --surface-2 --surface-3` | warm-paper, theme-aware |
| Text | `--text --text-2 --text-3 --text-4` | 4 ramps |
| Borders | `--border --border-strong` | base components un-shadowed until hover |
| Accent | `--accent --accent-soft --accent-text` | app highlight / selection |
| Status (stoplight) | `--st-completed --st-progress --st-todo --st-blocked` (+ `-bg`) | **the only risk/severity palette** |
| Priority | `--pr-p0 --pr-p1 --pr-p2 --pr-pl` | P0 red → PL violet |
| Module hues | `--mod-khira 260 · --mod-plan 195 · --mod-courier 60 · --mod-ledger 20 · --mod-crew 150 · --mod-verdict 300` | the soul of the look |
| Module tint (active) | `--m-hue --m-tint --m-line --m-ink --m-accent` | Atlas sets `--m-hue: 250` (structural slate) |
| Role tint | `--r-hue --r-tint --r-line --r-ink --r-accent` | persona frame + chrome wash |
| Geometry | `--radius-sm 6 / --radius 10 / --radius-lg 14`; `--shadow-1/2/drawer` | |
| Density | `--row-h --row-pad-{x,y}` | must survive `[data-density="compact"]` |

**Type scale (snap to these):** 10.5 / 12 / 12.5 / 13 / 16 / 26 px. Eyebrows & metadata = **Geist Mono, 10.5px, uppercase, 0.14em, weight 700**. Titles sentence-case 13px/600. Geist / Geist Mono only.

**Theme & density:** every screen must hold in `[data-theme="dark"]` and `[data-density="compact"]`. Verified — see `screens/dark/*` and `screens/states/01-02`.

---

## 2. Node & edge visual system (the Map)

The only Atlas-specific rendering. Recolored to the **owning module's hue** — never a separate graph palette.

| Type | Shape | Hue (module) | Code |
|---|---|---|---|
| task | rounded square | 260 Khira | TSK |
| plan | document | 195 Planroom | PLN |
| message | circle | 60 Courier | MSG |
| decision | diamond | 20 Ledgers | DEC |
| role | persona circle (initials) | role hue | ROL |
| verdict | hexagon | 300 Verdicts | VRD |
| phase | lane (not a bubble) | 250 slate | — |

- **Type** = shape + module hue + code. Strokes desaturate to `oklch(82% 0.045 H)` (light) / `oklch(40% 0.05 H)` (dark); icons `--m-ink`-equivalent.
- **Status** = a thin ring using stoplight tokens: `.gn-ring.blocked/.in_progress/.completed/.todo`. Never a filled block.
- **Risk** = a small badge dot top-right (`.gn-badge.rejected/.stale/.bug/.needs-review`).
- **Impact** = **node radius scales with `affects`** — load-bearing nodes read at a glance.
- **Edges**: solid = explicit, dashed = inferred, red = `blocks`/`blocked_by`. On select, the one-hop neighborhood goes accent-hot; the rest dims to ~7%. Role edges hidden until selection.

Glyphs: `AtlasGlyph` (line icons, 1.7 stroke, matches house). Lens glyphs: pulse, map, decisions, crew, roadmap. See `atlas-parts.jsx`.

---

## 3. Components (house kit → Atlas usage)

| Component | House class | Used for |
|---|---|---|
| Lens selector | `.view-tabs` / `.view-tab` (or `.mode-toggle` segmented) | Pulse·Map·Decisions·Crew·Roadmap. `AtlasLensTabs(style)` |
| KPI tile | `.kpi` (+ `.alert/.warn/.ok`) | Pulse orientation strip, Roadmap summary |
| Attention card | `.card` + severity left-border (`.atlas-card.crit/.high/.med`) | Pulse lanes. Hover = bg change, never transform |
| Artifact ref | `.afc` (`ArtifactChip`, `data-kind` tints) | every task/plan/msg/decision/role reference |
| Status dot | `.tr-status` + stoplight | inspector facts, critical cards |
| Role avatar | `.role-av` (`RoleAvatar`) | owners, crew, decisions, command strip |
| Chip / filter | `.chip` / `.chip.active` | filter popover, risk signals |
| Toggle | `.mode-toggle` | inferred links, map sub-mode, lens (segmented) |
| Verdict / activity trail | `.activity-item` | inspector + decision trail |
| Stamp | `.stamp` (`Stamp`) | decided verdicts, inspector badges |
| Module header | `.modhead` + `.modhead-eyebrow` + room-number | cockpit header |
| Inspector | drawer = `.card` sections + `.afc` + `.icon-btn` close | `AtlasInspector` |
| Button | `.btn` / `.btn.primary` | actions, steer, approve/reject |
| Empty / locked | `.atlas-state-card` (`.locked`) | locked lenses, empty/error |

**Atlas-only layout classes** (arrangement, not skin): `.atlas` (shell), `.atlas-body`, `.atlas-work`, `.atlas-kpis`, `.atlas-lanes`, `.atlas-cards`, `.cp-*` (critical path), `.crew-* / .agent-*`, `.rm-*` (roadmap), `.atlas-cmdstrip`, `.atlas-insp`, `.atlas-submodes`, `.atlas-search-results`, `.atlas-focuschip`.

**Cross-cutting primitives** (in `atlas-parts.jsx`):
- `VisionTag({kind})` — `vision` / `buildable` / `live`. Tag every speculative affordance.
- `TrustChip({confidence})` — `explicit` (green) / `inferred` (amber) / `backfilled` (blue). Provenance, consistent across lenses.
- `ImpactBars({n})` — the `affects N` micro-bars.

---

## 4. Lenses & states

| Lens | Default | Key states |
|---|---|---|
| **Pulse** | KPI strip → severity lanes (Blocked→Rejected→Stale→Awaiting→Hi-pri→Handoffs→Missing-links→Overloaded), ranked by `impactScore` | empty ("nothing needs you") |
| **Map** | **Critical path** ("N nodes gate X% of remaining work", ranked on `impactScore`) | Topology graph drill (risky subgraph / all nodes); no-blockers empty |
| **Decisions** | queue ranked by `impactScore`; inline Approve / Reject (reason note) | optimistic + undo toast (uses `rescan()` cascade); decided; empty |
| **Crew** | persona roster (live "now" + load + risky-owned + steer) + authority chain | **locked-until-data** (`agentFeed: locked`) |
| **Roadmap** | phase timeline + progress + milestones + cross-phase gates + schedule risk | **locked-until-data** (`roadmapData: locked`) |

**Global states** (Tweaks → Data scenario): `full` · `khira-only` (banner) · `empty`/no-links · `loading` (skeleton) · `source-error`. **Data model** (Tweaks): `legacy` (orphan-as-finding) ↔ `extended` (backfilled `plan_ids`/`owner` → `Connected · N`, trust = backfilled). **Agent feed** live↔locked. **Roadmap data** planned↔locked.

All states captured in `screens/` — light, dark, compact, every lens, every scenario.

---

## 5. Interaction contract (P9 UX, preserved)

- **Search**: dropdown of id/title matches, `↑/↓` to move, `Enter` to select, **Cmd/Ctrl+K** to focus, Esc to close.
- **Focus**: selecting a node opens the inspector + (on Map) the one-hop highlight; a **focus breadcrumb** chip (`.atlas-focuschip`) shows "Focused {id} ✕"; **selection is preserved across lens switches**.
- **Relationship labels are directional** (in/out): "Blocks" vs "Blocked by", "Reviews" vs "Reviewed by", etc.
- **Just-resolved**: approving in Decisions runs `rescan([id])` and reports the freed downstream cascade; the card fades to a decided state with **Undo**.
- **Act-in-place**: inline approve/reject, deep-link "Open in {Module}", Crew steer/reassign — designed; wiring noted in the architecture doc.
- **Accessibility**: lens tabs use `role="tab"`/`aria-selected`; search is keyboard-driven; close buttons are `.icon-btn` with aria-labels.

---

## 6. Voice

Sentence case for titles/body. UPPERCASE mono for eyebrows/labels. Relative timestamps. Disabled = dim text, never a background change. **No money / cost / currency anywhere** — load is item-count framing only. Every speculative element wears a `VisionTag`.
