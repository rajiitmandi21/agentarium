'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', 'dist');
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory()
    ? files(path.join(dir, e.name)) : [path.relative(root, path.join(dir, e.name))]);
}
const inventory = files(root);
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
assert(!html.includes('text/babel') && !html.includes('babel.min.js'));
assert(!html.includes('react.development') && html.includes('vendor/react.production.min.js'));
assert(html.includes('staticHosting'));
for (const m of html.matchAll(/(?:src|href)="([^"?#]+)(?:\?[^\"]*)?"/g)) {
  if (/^(https?:|data:)/.test(m[1])) continue;
  assert(fs.existsSync(path.join(root, m[1])), 'Missing ' + m[1]);
}
assert(!inventory.some(f => /(^|\/)(\.git|\.codex|node_modules|server\.js|coordination-transactions\.js|maestro-langgraph\.js|\.env)/.test(f)));
assert(!inventory.some(f => f.endsWith('.jsx') || f.endsWith('.zip')));
const index = JSON.parse(fs.readFileSync(path.join(root, 'project-management/pm-index.json')));
assert.deepStrictEqual(index.statusFiles, ['data_p1.json']);
assert.strictEqual(index.planFiles.length, 1);
assert.strictEqual(index.messageFiles.length, 1);
assert.strictEqual(index.decisionFiles.length, 1);
assert.strictEqual(index.artifactFiles.length, 0);
const phase = JSON.parse(fs.readFileSync(path.join(root, 'project-management/status/data_p1.json')));
assert(phase.tasks.every(t => t.id.startsWith('DEMO-')));
assert(!fs.readFileSync(path.join(root, 'data.js'), 'utf8').includes('Digital Twin'));
assert(fs.readFileSync(path.join(root, 'agentarium/components.compiled.js'), 'utf8').includes('Upcoming'));
assert(fs.readFileSync(path.join(root, 'agentarium/maestro.compiled.js'), 'utf8').includes('real agent execution upcoming'));
console.log(`PASS: ${inventory.length} allowlisted release files; every asset exists; production scripts; synthetic demo only; no backend/private corpus; Upcoming labels.`);
