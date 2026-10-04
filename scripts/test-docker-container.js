#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PM_ROOT = path.join(ROOT, 'project-management');
const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:4747').replace(/\/+$/, '');
const index = JSON.parse(fs.readFileSync(path.join(PM_ROOT, 'pm-index.json'), 'utf8'));

async function getJson(route) {
  const response = await fetch(`${BASE_URL}${route}`);
  assert.strictEqual(response.status, 200, `${route} returned HTTP ${response.status}`);
  return response.json();
}

async function getText(route) {
  const response = await fetch(`${BASE_URL}${route}`);
  assert.strictEqual(response.status, 200, `${route} returned HTTP ${response.status}`);
  return response.text();
}

function expectedTaskCount() {
  return index.statusFiles.reduce((total, file) => {
    const data = JSON.parse(fs.readFileSync(path.join(PM_ROOT, 'status', file), 'utf8'));
    return total + (Array.isArray(data.tasks) ? data.tasks.length : 0);
  }, 0);
}

async function main() {
  const [health, project, status, plans, messages, decisions, roles, crews, verdicts, runs, engagements] =
    await Promise.all([
      getJson('/api/health'),
      getJson('/api/project'),
      getJson('/api/status'),
      getJson('/api/plans'),
      getJson('/api/messages'),
      getJson('/api/decisions'),
      getJson('/api/roles'),
      getJson('/api/crews'),
      getJson('/api/verdicts'),
      getJson('/api/runs'),
      getJson('/api/engagements'),
    ]);

  assert.strictEqual(health.ok, true, 'health.ok');
  assert.strictEqual(health.sourceMode, 'api-workspace', 'health source mode');
  assert.strictEqual(health.writeEnabled, true, 'container write API enabled');
  assert.strictEqual(project.projectManagementRoot, 'project-management/', 'canonical PM root');
  assert.deepStrictEqual(project.index.statusFiles, index.statusFiles, 'status index is real project data');
  assert.deepStrictEqual(project.index.planFiles, index.planFiles, 'plan index is real project data');
  assert.strictEqual(status.count, index.statusFiles.length, 'phase count');
  assert(status.phases.every((phase) => phase.data && !phase.error), 'every indexed phase loaded');

  const actualTasks = status.phases.reduce(
    (total, phase) => total + (Array.isArray(phase.data.tasks) ? phase.data.tasks.length : 0),
    0,
  );
  assert.strictEqual(actualTasks, expectedTaskCount(), 'real task count');
  assert.strictEqual(plans.count, index.planFiles.length, 'real plan count');
  assert.strictEqual(messages.count, index.messageFiles.length, 'real message count');
  assert.strictEqual(decisions.count, index.decisionFiles.length, 'real decision count');
  assert(roles.ok && roles.roles, 'roles loaded');
  assert(crews.ok && Array.isArray(crews.personas) && crews.personas.length > 0, 'Crews personas loaded');
  assert(verdicts.ok && Array.isArray(verdicts.taskVerdicts), 'task verdicts loaded');
  assert(runs.ok && Array.isArray(runs.records), 'run trail loaded');
  assert(engagements.ok && Array.isArray(engagements.records), 'engagement trail loaded');

  const [html, appSource, resolverSource] = await Promise.all([
    getText('/'),
    getText('/agentarium/app.jsx'),
    getText('/scripts/crews-dispatch-resolver.js'),
  ]);
  assert(/id="root"/.test(html), 'SPA root is present');
  assert(/function Agentarium(?:Root)?\s*\(/.test(appSource), 'Agentarium shell source served');
  assert(/window\.CrewsResolver\s*=\s*api/.test(resolverSource), 'Maestro dispatch resolver served');

  console.log(
    `OK: Docker Agentarium real data — ${status.count} phases, ${actualTasks} tasks, ` +
    `${plans.count} plans, ${messages.count} messages, ${decisions.count} decisions, ` +
    `${verdicts.taskVerdicts.length} verdicts, ${runs.records.length} run records, ` +
    `${engagements.records.length} engagement records.`,
  );
}

main().catch((error) => {
  console.error(`FAIL: ${error.stack || error.message}`);
  process.exit(1);
});
