#!/usr/bin/env node
/**
 * Run: node scripts/test-sanitize.js
 * Loads sanitize.js in a minimal browser-like global and checks fixtures.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const cases = JSON.parse(
  fs.readFileSync(path.join(root, 'fixtures/sanitize-cases.json'), 'utf8')
);

const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(root, 'sanitize.js'), 'utf8'),
  sandbox
);

const { sanitizeRichHtml } = sandbox.window.khiraSanitize;
let failed = 0;

for (const c of cases) {
  const out = sanitizeRichHtml(c.input);
  const misses = (c.expectContains || []).filter((s) => !out.includes(s));
  const leaks = (c.expectNotContains || []).filter((s) => out.includes(s));
  if (misses.length || leaks.length) {
    failed++;
    console.error(`FAIL: ${c.name}`);
    if (misses.length) console.error('  missing:', misses);
    if (leaks.length) console.error('  should not contain:', leaks);
    console.error('  output:', out);
  } else {
    console.log(`ok: ${c.name}`);
  }
}

if (failed) process.exit(1);
console.log(`All ${cases.length} sanitize cases passed.`);
