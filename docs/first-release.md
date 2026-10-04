# Agentarium 0.3.0 — first public release

Open the hosted app and choose **Connect your data**. You do not need to run a server.

In Chrome or Edge, select your repository root or its `project-management/` folder.
Allow folder access, browse your project, enable **Edit** in Khira, and **Save** task
changes to the linked folder. Refresh after an agent changes files on disk.

Other browsers can import phase JSON files, edit tasks, and export updated JSON.
Keep exported files as your backup; browser drafts are stored on this device and
do not sync across browsers. Folder permissions may need to be granted again.

## Available and upcoming

| Capability | First release |
| --- | --- |
| Task views, filtering, editing, local drafts | Available |
| Save to a connected folder | Available in supporting browsers |
| JSON import and export | Available |
| Plan, message, decision and review views | Available |
| Crews and Atlas project views | Available |
| Maestro simulation preview | Available; dispatch requires the optional local API |
| Plan authoring, message compose/reply/conversions | Upcoming |
| Decision authoring and independent review submission | Upcoming |
| Real agent execution and durable execution recovery | Upcoming |
| Cloud storage, accounts and cross-device sync | Upcoming |

Project data is processed in your browser, not uploaded to the hosting service.
The host serves application files and a synthetic demo. Google Fonts requests
are made for typography; React and the application scripts are served locally.
No analytics or project-upload endpoint is included in the static release.
The optional local API is a trusted single-operator workspace, not an authenticated
multi-user cloud service.

## Free Cloudflare hosting

Use Cloudflare's **Workers Free** plan with static assets and the free `workers.dev`
address. This release deploys no Worker script, database, paid model or storage service.
Cloudflare documents static asset requests as free and unlimited; account and
platform limits still apply. See [static asset billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/).

```sh
npm ci
npm run build
npm run test:release
npx wrangler login
npm run deploy
```

The CLI prints the deployed HTTPS URL. `wrangler.jsonc` serves **only `dist/`**.
Never upload the repository root as the site: it contains development project
records and local files. The build generates synthetic demo data and copies an
allowlist of application assets. No original project-management history ships.

For GitHub-connected Workers Builds: build command `npm run build`; deploy command
`npx wrangler deploy`. Keep the account on the free plan. No custom domain is needed.

Vercel can also host the same `dist/` static artifact (Other framework, build
`npm run build`, output `dist`), but this first release uses Cloudflare configuration.
The disk-writing local API cannot be copied into a serverless Function and used as
durable cloud storage. Managed cloud workspaces are a separate future feature.

## Optional local hosting

```sh
npm ci
npm run build
npm run preview:release
```

Open `http://localhost:4748`. For the development app and optional file-write API,
use `./start.sh --api`, or `docker compose up --build -d` and open localhost:4747.
These local modes retain their existing development corpus; the public site uses
the synthetic demo instead.

## Open-source publication

The prepared code is MIT licensed with Raj Kumar's copyright. Third-party licenses
remain applicable. Before publication, review the source release archive: it
contains app code and the synthetic example rather than private development
records. Create the public `agentarium` repository under your GitHub account,
upload the reviewed source, and publish tag `v0.3.0` with the static archive.
Record the actual GitHub and Cloudflare URLs after publishing; a local archive is
not a published release.
