'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..');
const release = path.join(root, 'release');
const source = path.join(release, 'agentarium-0.3.0-source');
if (!fs.existsSync(path.join(root, 'dist/release-manifest.json'))) throw new Error('Run npm run build first.');
fs.mkdirSync(release, { recursive: true });
if (fs.existsSync(path.join(source, '.git'))) throw new Error('Source staging is a Git repository; archive its commit instead of replacing it.');
fs.rmSync(source, { recursive: true, force: true });
fs.mkdirSync(source);
const names = ['index.html', 'Atlas.html', 'khira.html', 'styles.css', 'sanitize.js', 'helpers.js', 'edits.js',
  'projects.js', 'pm-loader.js', 'tweaks-panel.jsx', 'components.jsx', 'views.jsx', 'drawer.jsx',
  'project-switcher.jsx', 'app.jsx', 'server.js', 'coordination-transactions.js', 'package.json',
  'package-lock.json', 'Dockerfile', '.dockerignore', 'compose.yaml', '.gitignore', 'start.sh',
  'LICENSE', 'README.md', 'CONTRIBUTING.md', 'wrangler.jsonc', 'agentarium'];
for (const rel of names) fs.cpSync(path.join(root, rel), path.join(source, rel), { recursive: true });
fs.mkdirSync(path.join(source, 'scripts'));
for (const rel of ['build-release.js', 'package-release.js', 'test-release-package.js', 'test-agentarium-compile.js',
  'crews-dispatch-resolver.js', 'test-sanitize.js', 'test-prepare-save.js', 'test-server-ifmatch.js',
  'test-coordination-api.js', 'test-coordination-transactions.js', 'test-maestro-langgraph-adapter.js',
  'test-docker-container.js', 'test-docker-write.js']) {
  fs.copyFileSync(path.join(root, 'scripts', rel), path.join(source, 'scripts', rel));
}
fs.mkdirSync(path.join(source, 'docs'));
fs.copyFileSync(path.join(root, 'docs/first-release.md'), path.join(source, 'docs/first-release.md'));
for (const rel of ['rich-text-safety.md', 'agentarium-navigation-skeleton.md']) fs.copyFileSync(path.join(root, 'docs', rel), path.join(source, 'docs', rel));
fs.cpSync(path.join(root, '.github'), path.join(source, '.github'), { recursive: true });
// Use the synthetic public corpus and provenance, never the working board.
fs.cpSync(path.join(root, 'dist/project-management'), path.join(source, 'project-management'), { recursive: true });
for (const rel of ['data.js', 'provenance.js']) fs.copyFileSync(path.join(root, 'dist', rel), path.join(source, rel));
for (const [archive, cwd, rel] of [
  ['agentarium-0.3.0-static.zip', path.join(root, 'dist'), '.'],
  ['agentarium-0.3.0-source.zip', release, 'agentarium-0.3.0-source'],
]) {
  fs.rmSync(path.join(release, archive), { force: true });
  execFileSync('zip', ['-qr', path.join(release, archive), rel], { cwd });
}
console.log('Prepared sanitized source tree and source/static archives in release/.');
