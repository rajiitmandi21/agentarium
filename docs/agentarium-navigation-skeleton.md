# Agentarium navigation and source-mode skeleton

First-pass labels and guardrails for future UI work. **Do not implement the full redesign here** — designer direction is pending (`messages/2026-05-26_1913Z_human-raj-to-product-designer_agentarium-ui-brief.md`).

## Product shell vs modules

- **Agentarium** — product shell, project switcher, source mode, global search (future).
- **Khira** — task tracker (live today; current views: Overview, List, Board, Focus).
- **Planroom**, **Signal Courier**, **Ledgers**, **Crews**, **Verdicts** — first-class modules; read-only or skeleton until later phases.

## First-pass navigation labels

| Nav label | Module | Primary artifact path |
| --------- | ------ | --------------------- |
| Khira | Task tracker | `project-management/status/data_p*.json` |
| Planroom | Plans | `project-management/plans/*.md` |

### Planroom progress (two bars)

Each plan card/detail can show **two** progress indicators:

| Bar | Source | Meaning |
| --- | ------ | ------- |
| **Checklist** | Markdown `- [ ]` / `- [x]` lines in the plan file | Plan acceptance items written in Planroom |
| **Tasks** | Linked Khira tasks (`plan.task_ids` / `**Task ids:**`) | How many linked tasks have `status: completed` |

They are independent: a plan can have 29 checklist items and 10 linked tasks. Maintain links via `scripts/sync-artifact-links.js` (`MANUAL_PLAN_TASKS`).
| Signal Courier | Messages | `project-management/messages/*.md` |
| Ledgers | Decisions | `project-management/decisions/*.md` |
| Crews | Roles | `project-management/roles/roles.json` |
| Verdicts | Trust layer | Cross-cutting + future dashboard |

Global controls (future): project switcher, **Acting as** role, source mode indicator, refresh from source, create menu.

## Source modes

| Mode | Status | Behavior |
| ---- | ------ | -------- |
| **Local Folder Mode** | Active now | User picks a project root; app reads/writes linked folders via File System Access API. |
| **API Workspace Mode** | Planned | Remote workspace, permissions, indexing, multi-user. |
| **Hybrid Mode** | Planned | Local files stay canonical; API indexes and validates. |

Manifest: `project-management/agentarium.json` → `sourceMode: "local-folder"`.

Recommended import: **repo root** (discovers `project-management/`). Partial imports: `project-management/`, `project-management/status/`, etc. Legacy root symlinks `status/`, `plans/`, `messages/` still resolve.

## Editing policies

| Artifact | Policy |
| -------- | ------ |
| **Tasks** (`project-management/status/`) | Structured JSON; draft in localStorage; hard Save to disk for folder-linked projects (Phase 2). |
| **Plans** (`project-management/plans/`) | Living documents; editable in future Planroom (not in Phase 4). |
| **Messages** (`project-management/messages/`) | **Append-only by default** — new handoffs get new timestamped files; do not overwrite. |
| **Decisions** (`project-management/decisions/`) | Explicit records; supersede rather than silently edit. |
| **Verdicts** | Always show actor, timestamp, role, and target; may appear inline in tasks/plans/messages/decisions. |

## Verdicts as module and cross-cutting state

**Verdicts** is both:

1. A **module** — future dashboard for pending reviews, rejections, tested work, items awaiting Raj/TL/SPM.
2. **Cross-cutting trust state** — `pm_status`, review chips, and human_reviews on tasks; future equivalents on plans, messages, and decisions.

Valid task-level `pm_status` values (Khira today): `""`, `done`, `tested`, `needs-review`, `rejected`, `superseded`.

## What stays unchanged in Phase 4

- Current Khira task views and Phase 2 hard-save behavior.
- Historical task IDs (`KH-P1.*`, `KH-P2.*`, `KH-P3.*`) and old message/plan filenames.
- No speculative UI beyond naming, manifest, and this skeleton doc.
