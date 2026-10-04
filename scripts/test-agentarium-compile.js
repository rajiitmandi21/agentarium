#!/usr/bin/env node
/**
 * Browser-compile smoke: catch duplicate declarations and missing window exports
 * before PM opens Dia (Babel standalone parses the same JSX files as index.html).
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const agentariumDir = path.join(root, 'agentarium');

function fail(msg) {
  console.error('FAIL:', msg);
  process.exit(1);
}

function checkVerdictTargetOnce(src) {
  const count = (src.match(/function\s+verdictTarget\s*\(/g) || []).length;
  if (count !== 1) {
    fail(`components.jsx: verdictTarget must be declared exactly once (found ${count})`);
  }
}

function checkObjectAssignExports(filePath, src) {
  const m = src.match(/Object\.assign\s*\(\s*window\s*,\s*\{([^}]+)\}/s);
  if (!m) return;
  const keys = [];
  for (const part of m[1].split(',')) {
    const key = part.trim().split(/\s+/).pop();
    if (key && /^[A-Za-z_$]/.test(key)) keys.push(key);
  }
  const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (dup.length) fail(`${filePath}: duplicate Object.assign export keys: ${[...new Set(dup)].join(', ')}`);
}

const componentsSrc = fs.readFileSync(path.join(agentariumDir, 'components.jsx'), 'utf8');
checkVerdictTargetOnce(componentsSrc);
checkObjectAssignExports('components.jsx', componentsSrc);
if (!/MODULES\s*=\s*\[/.test(componentsSrc)) {
  fail('components.jsx: MODULES array missing');
}
if (!/Object\.assign\s*\(\s*window/.test(componentsSrc)) {
  fail('components.jsx: window exports missing');
}

let babel;
try {
  babel = require('@babel/standalone');
} catch (e) {
  if (e.code === 'MODULE_NOT_FOUND') {
    fail('@babel/standalone is required for agentarium compile smoke (install devDependency or use index.html CDN in browser only)');
  }
  fail(e.message);
}

function collectJsx(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...collectJsx(abs));
    else if (ent.name.endsWith('.jsx')) out.push(path.relative(root, abs));
  }
  return out;
}

// Root-level JSX loaded by index.html (project-switcher.jsx, app.jsx, etc.) —
// these are babel-in-browser too, so a syntax error there breaks the app just
// like an agentarium/ file. Compile them in the same smoke.
const rootJsx = fs.readdirSync(root)
  .filter((n) => n.endsWith('.jsx'))
  .map((n) => path.relative(root, path.join(root, n)));

const jsxFiles = [...collectJsx(agentariumDir), ...rootJsx].sort();

for (const rel of jsxFiles) {
  const abs = path.join(root, rel);
  try {
    babel.transform(fs.readFileSync(abs, 'utf8'), { presets: ['react'], filename: rel });
  } catch (e) {
    fail(`${rel}: ${e.message}`);
  }
}

// AG-P14.3: the Project source viewer must be exported on window beside the
// existing switcher components, or the source affordance never mounts.
const switcherSrc = fs.readFileSync(path.join(root, 'project-switcher.jsx'), 'utf8');
checkObjectAssignExports('project-switcher.jsx', switcherSrc);
if (!/function\s+ProjectSourceModal\s*\(/.test(switcherSrc)) {
  fail('project-switcher.jsx: ProjectSourceModal component missing (AG-P14.3)');
}
if (!/Object\.assign\s*\(\s*window\s*,\s*\{[^}]*\bProjectSourceModal\b/s.test(switcherSrc)) {
  fail('project-switcher.jsx: ProjectSourceModal not exported on window (AG-P14.3)');
}

console.log(`OK: agentarium JSX compile smoke passed (${jsxFiles.length} files)`);
