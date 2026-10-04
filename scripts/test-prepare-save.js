#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const sandbox = { window: { khiraSanitize: null }, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'edits.js'), 'utf8'), sandbox);

const { preparePhaseForSave, clearSavedPhaseEdits, apiSaveablePhaseEdits, hasReviewerEdits } = sandbox.window.edits;
const savedAt = '2026-05-25T08:30:00Z';
const base = {
  title: 'Test',
  subtitle: 'Sub',
  last_updated: '2026-01-01T00:00:00Z',
  human_reviews: [],
  tasks: [{
    id: 'T1',
    title: 'Engineering title',
    status: 'todo',
    priority: 'p1',
    description: 'Do not drop',
    blockers: ['b1'],
    reviews: [{ type: 'NOTE', text: 'base', at: '2026-01-01T00:00:00Z' }],
    subtasks: [{ status: 'todo', text: 'st', review: null }],
    code_updated_at: '2026-01-01T00:00:00Z',
  }],
};
const edits = {
  tasks: {
    T1: {
      status: 'in_progress',
      pm_remark: 'PM note',
      extra_reviews: [{ type: 'NOTE', text: 'user', at: savedAt, _user: true }],
    },
  },
  extra_human_reviews: [{ text: 'human', at: savedAt, _user: true }],
};

const out = preparePhaseForSave(base, edits, savedAt);
let failed = 0;
function assert(cond, msg) {
  if (!cond) { failed++; console.error('FAIL:', msg); }
}

assert(out.last_updated === savedAt, 'last_updated bumped');
assert(out.tasks[0].status === 'in_progress', 'status merged');
assert(out.tasks[0].title === 'Engineering title', 'title preserved');
assert(out.tasks[0].blockers[0] === 'b1', 'blockers preserved');
assert(out.tasks[0].code_updated_at === '2026-01-01T00:00:00Z', 'code_updated_at preserved');
assert(out.tasks[0].reviews.length === 2, 'reviews appended');
assert(out.tasks[0].reviews[1].text === 'user' && !('_user' in out.tasks[0].reviews[1]), '_user stripped');
assert(out.human_reviews.length === 1 && !('_user' in out.human_reviews[0]), 'human review stripped');
assert(out.tasks[0].pm_updated_at === savedAt, 'pm_updated_at set when PM fields edited');

const submitted = { tasks: { T1: { status: 'in_progress', priority: 'p1',
  extra_reviews: [{ text: 'sent' }] } } };
const changedWhileSaving = { project: { P1: { tasks: { T1: {
  status: 'completed', priority: 'p1', extra_reviews: [{ text: 'sent' }, { text: 'later' }],
} } } } };
const remaining = clearSavedPhaseEdits(changedWhileSaving, 'project', 'P1', submitted);
assert(remaining.project.P1.tasks.T1.status === 'completed', 'later status edit survives save');
assert(!('priority' in remaining.project.P1.tasks.T1), 'submitted unchanged field clears');
assert(remaining.project.P1.tasks.T1.extra_reviews.length === 1 &&
  remaining.project.P1.tasks.T1.extra_reviews[0].text === 'later', 'later review survives save');
assert(!clearSavedPhaseEdits({ project: { P1: submitted } }, 'project', 'P1', submitted).project,
  'fully saved draft clears');
const mixed = { tasks: { T1: { status: 'in_progress', pm_remark: 'keep',
  extra_reviews: [{ text: 'keep review' }] } } };
const afterApi = clearSavedPhaseEdits({ project: { P1: mixed } }, 'project', 'P1', apiSaveablePhaseEdits(mixed));
assert(!('status' in afterApi.project.P1.tasks.T1) && afterApi.project.P1.tasks.T1.pm_remark === 'keep',
  'API save clears task fields and retains reviewer draft');
assert(hasReviewerEdits(mixed) && !hasReviewerEdits({ tasks: { T1: { status: 'todo' } } }),
  'reviewer draft detection distinguishes task-only edits');

if (failed) process.exit(1);
console.log('preparePhaseForSave checks passed.');
