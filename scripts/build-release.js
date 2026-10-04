#!/usr/bin/env node
'use strict';

// Allowlisted public build. Never copy a user's project-management corpus.
const fs = require('fs');
const path = require('path');
const babel = require('@babel/standalone');
const root = path.join(__dirname, '..');
const out = path.join(root, 'dist');
const version = '0.3.0';
const date = '2026-10-04T00:00:00Z';
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
function write(rel, content) {
  fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true });
  fs.writeFileSync(path.join(out, rel), content);
}
function copy(rel, target = rel) { write(target, fs.readFileSync(path.join(root, rel))); }
function json(rel, value) { write(rel, JSON.stringify(value, null, 2) + '\n'); }

let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
// Production React ships locally; JSX is compiled once instead of in-browser.
html = html.replace(/<script src="https:\/\/unpkg\.com\/react@[^>]+><\/script>/,
  '<script src="vendor/react.production.min.js"></script>');
html = html.replace(/<script src="https:\/\/unpkg\.com\/react-dom@[^>]+><\/script>/,
  '<script src="vendor/react-dom.production.min.js"></script>');
html = html.replace(/\s*<script src="https:\/\/unpkg\.com\/@babel[^>]+><\/script>/, '');
html = html.replace(/<script>window.KHIRA_ASSET_V[^<]+<\/script>/,
  `<script>window.KHIRA_ASSET_V='${version}';window.AGENTARIUM_RELEASE=${JSON.stringify({ version, staticHosting: true, demoName: 'Agentarium demo' })};</script>`);
html = html.replace(/<script type="text\/babel" src="([^"?]+)(?:\?[^\"]*)?"><\/script>/g, (_, rel) => {
  const target = rel.replace(/\.jsx$/, '.compiled.js');
  const code = babel.transform(fs.readFileSync(path.join(root, rel), 'utf8'), {
    presets: ['env', 'react'], comments: false, filename: rel,
  }).code;
  write(target, code);
  return `<script src="${target}?v=${version}"></script>`;
});
for (const match of html.matchAll(/(?:src|href)="([^"?#]+)(?:\?[^\"]*)?"/g)) {
  const rel = match[1];
  if (/^(https?:|data:)/.test(rel) || fs.existsSync(path.join(out, rel)) || rel === 'data.js' || rel.startsWith('vendor/')) continue;
  if (!/\.(js|css)$/.test(rel) || rel.includes('..') || !fs.existsSync(path.join(root, rel))) throw new Error('Unexpected asset ' + rel);
  copy(rel);
}
copy('node_modules/react/umd/react.production.min.js', 'vendor/react.production.min.js');
copy('node_modules/react-dom/umd/react-dom.production.min.js', 'vendor/react-dom.production.min.js');
copy('node_modules/react/LICENSE', 'vendor/react-LICENSE.txt');
copy('node_modules/react-dom/LICENSE', 'vendor/react-dom-LICENSE.txt');

const planId = '2026-10-04-phase1-demo-workspace';
const tasks = [
  { id: 'DEMO-P1.1', title: 'Connect your project folder', status: 'completed', priority: 'p1', description: 'Synthetic example: use Connect your data to link your own project-management folder.', owner_id: 'human-raj', pm_status: 'done' },
  { id: 'DEMO-P1.2', title: 'Try task editing and export', status: 'in_progress', priority: 'p1', description: 'Turn on Edit, select this task, update its fields and export a JSON snapshot. Linked folders can Save locally.', owner_id: 'fe', pm_status: '' },
  { id: 'DEMO-P1.3', title: 'Explore project views', status: 'todo', priority: 'p2', description: 'Browse the sample plan, handoff, decision, crews, review queue and Atlas. All demo content is synthetic.', owner_id: 'spm', pm_status: '' },
].map(t => ({ ...t, blockers: [], reviews: [], subtasks: [], plan_ids: [planId], code_updated_at: date }));
const phase = { title: 'Agentarium demo — Phase 1', subtitle: 'Synthetic example workspace · connect your data to get started', phase_status: 'in_progress', last_updated: date, human_reviews: [], tasks };
write('data.js', `window.PHASE_DATA=${JSON.stringify({ P1: phase })};window.PHASES=${JSON.stringify([{ id: 'p1', label: 'Phase 1', name: 'Example workspace', key: 'P1' }])};\n`);
json('project-management/status/data_p1.json', phase);
copy('project-management/status/schema.json');
const roles = JSON.parse(fs.readFileSync(path.join(root, 'project-management/roles/roles.json'), 'utf8'));
json('project-management/roles/roles.json', roles);
// Canonical persona definitions are product data; no assignments/engagements.
copy('project-management/roles/crews-index.json');
json('project-management/roles/engagements.json', { records: [] });
write(`project-management/plans/${planId}.md`, `# Example workspace\n\n**Phase:** P1\n**Owner role:** spm\n**Status:** Active\n**Updated:** ${date}\n**Task ids:** ${tasks.map(t => t.id).join(', ')}\n\n## Scope\n\nExplore Agentarium with synthetic examples, then connect your own data.\n\n## Acceptance Criteria\n\n- [x] Open the example workspace.\n- [ ] Edit and export a task.\n- [ ] Connect your project.\n`);
const message = '2026-10-04_0000Z_spm-to-fe_demo-handoff.md';
write(`project-management/messages/${message}`, `**To:** fe\n**From:** spm\n**Date:** ${date}\n**Type:** note\n**Subject:** Explore your Phase 1 workspace\n**Re:** Phase 1 example workspace\n**Phase:** p1\n**Task-Ids:** DEMO-P1.2\n\nThis is a synthetic handoff. Browse a task, try editing, and export your changes. Compose and reply actions are upcoming.\n`);
const decision = '2026-10-04-demo-local-data.md';
write(`project-management/decisions/${decision}`, `# Decision: Keep this example local\n\nStatus: active\nDate: ${date}\nPhase: p1\nOwner: human-raj\nDecided by: human-raj\n\n## Decision\n\nThis synthetic workspace demonstrates browser-local project views. Connect your folder or import JSON; cloud sync and real agent execution are upcoming.\n`);
const index = { statusFiles: ['data_p1.json'], planFiles: [planId + '.md'], messageFiles: [message], decisionFiles: [decision], artifactFiles: [] };
json('project-management/pm-index.json', index);
json('project-management/pm-disk-manifest.json', index);
json('project-management/agentarium.json', { product: 'Agentarium', version, projectManagementRoot: 'project-management/', sourceMode: 'local-folder' });
let provenance = fs.readFileSync(path.join(out, 'provenance.js'), 'utf8');
provenance = provenance.replace("version: '0.2.0'", `version: '${version}'`).replace("licenseStatus: 'private'", "licenseStatus: 'MIT'");
write('provenance.js', provenance);
html = html.replace(/\?v=[^"']+/g, '?v=' + version);
write('index.html', html);
copy('LICENSE');
write('_headers', '/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Frame-Options: DENY\n');
json('release-manifest.json', { product: 'Agentarium', version, hosting: 'static', demo: 'synthetic', upcoming: ['plan-authoring', 'courier-compose-reply', 'decision-authoring', 'review-submission', 'cloud-sync', 'real-agent-execution'] });
console.log(`Built Agentarium ${version} in dist/ (production React, compiled JSX, synthetic demo; no backend or private PM corpus).`);
