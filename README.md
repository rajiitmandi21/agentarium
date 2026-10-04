# Agentarium

**First public release: 0.3.0.** A browser workspace for human-led AI agent teams.
Connect your project folder, browse its views and edit tasks without running a
server. In browsers without folder access, import and export JSON snapshots.

Plan/message/decision authoring, independent review submission, cloud sync and
real agent execution are **Upcoming**. Maestro provides a simulation preview;
dispatch currently requires the optional local API.

[Release capabilities and free Cloudflare deployment](docs/first-release.md) ·
[MIT license](LICENSE) · [Contributing](CONTRIBUTING.md)

```sh
npm ci
npm run build
npm run preview:release
```

The public build includes production scripts and synthetic example data only.
Deploy `dist/` with `npm run deploy` after Cloudflare login. Publication URLs will
be added once the GitHub repository and hosted site exist.

GitHub Pages also provides free hosting for the public repository. The included
Pages workflow builds and publishes only `dist/`; enable Pages with GitHub Actions
as its source in repository settings. Cloudflare login is optional for that path.

**Agentarium** is a local-first project command center for human-led AI-agent teams. **Khira** is the task tracker module inside Agentarium — a static, no-build status viewer for agent-focused workflows.

Project-management data lives under **`project-management/`** (tasks, plans, messages, decisions, roles). App code stays at the repo root.

> **Compatibility:** Root `status/`, `plans/`, and `messages/` symlink into `project-management/`. Older docs may say "Khira" for the whole app; Khira is now the task tracker only.

## Run locally

```bash
./start.sh
```

Opens [http://localhost:4747/](http://localhost:4747/) (override with `PORT=5555 ./start.sh`).

## Docker — one-command local hosting

Docker Desktop (or Docker Engine with Compose v2) is the only prerequisite.
From the repository root:

```bash
docker compose up --build -d
```

Open [http://localhost:4747/](http://localhost:4747/). The compose service mounts
this checkout's `project-management/` directory into the container, so Agentarium
renders and updates the real project data instead of an image snapshot. The host
port is loopback-only; override it without exposing the service publicly:

```bash
AGENTARIUM_PORT=5555 docker compose up --build -d
```

Check health and stop the service:

```bash
docker compose ps
npm run test:docker
docker compose down
```

The application filesystem is read-only, Linux capabilities are dropped, and
only the mounted `project-management/` tree remains writable for persona-gated
Agentarium API operations.

- **`index.html`** — Agentarium shell (module rail, Khira, Planroom, Signal Courier, …)
- **`khira.html`** — legacy Khira-only task tracker (previous `index.html` behavior)

**Browser:** Chromium-based (Chrome, Edge, Brave, Arc) for folder linking via the File System Access API.

## Import this repo

1. Start Agentarium and click **Add project**.
2. **Pick folder** — choose the **repo root** (recommended; discovers `project-management/status/`), **`project-management/`**, or **`project-management/status/`** for Khira-only.
3. Use **Refresh from disk** after agents edit `project-management/status/data_p1.json`.

Built-in sample data ships in `data.js`; use folder import to track real projects.

## Agent workflow

1. Create or update `project-management/status/data_p<N>.json` using the `status-update` skill (Developer role).
2. Validate: `node scripts/validate-status.js`
3. In Agentarium (Khira module), refresh the linked folder or re-import.
4. Rich text in remarks/reviews allows a small HTML subset; see `docs/rich-text-safety.md`.
5. Signal Courier handoffs: `project-management/messages/`; Crews roles: `project-management/roles/roles.json`.

## Hard Save (Phase 2)

For **folder-linked** projects (Pick folder), edit PM-safe fields in the Khira UI, then click **Save** to write the active phase back to its status JSON file under the linked tree (e.g. `project-management/status/data_p*.json` when the repo root is linked). Draft edits autosave to `localStorage` only until you explicitly Save.

- Snapshot and built-in projects: **Export** only (no Save).
- Re-pick the folder if Save reports permission or reconnect errors.
- Existing linked projects may need **Refresh from disk** once to pick up `relativePath` metadata after migration.

## Validation scripts

| Command | Purpose |
| -------- | -------- |
| `node scripts/validate-status.js` | Required keys in `project-management/status/data_p*.json` |
| `node scripts/test-sanitize.js` | Rich-text sanitizer fixtures |
| `node scripts/test-prepare-save.js` | Hard-save serialization (PM-safe merge) |

Fixture project for manual import tests: `fixtures/status-mini/`.

## Navigation skeleton (Phase 4)

First-pass module labels and source modes: `docs/agentarium-navigation-skeleton.md`.
