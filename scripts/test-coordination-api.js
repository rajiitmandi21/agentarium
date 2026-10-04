#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function main() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentarium-coordination-api-'));
  let child;
  try {
    const pm = path.join(temp, 'project-management');
    await fsp.mkdir(path.join(pm, 'roles'), { recursive: true });
    for (const name of ['server.js', 'coordination-transactions.js', 'sanitize.js', 'package.json']) {
      await fsp.copyFile(path.join(root, name), path.join(temp, name));
    }
    await fsp.copyFile(path.join(root, 'project-management/roles/roles.json'), path.join(pm, 'roles/roles.json'));
    await fsp.writeFile(path.join(pm, 'pm-index.json'), JSON.stringify({ statusFiles: [], messageFiles: [], decisionFiles: [] }));
    await fsp.writeFile(path.join(pm, 'pm-disk-manifest.json'), JSON.stringify({ statusFiles: [], messageFiles: [], decisionFiles: [] }));
    const port = await freePort();
    child = spawn(process.execPath, ['server.js'], { cwd: temp,
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) }, stdio: ['ignore', 'ignore', 'inherit'] });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(base + '/api/health')).ok) break; } catch (_) { /* starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    async function post(kind, persona, body) {
      const res = await fetch(`${base}/api/${kind}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Agentarium-Persona': persona }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    }
    const msg = { requestId: 'message-request-1', filename: '2026-09-27_1900Z_spm-to-human-raj_test.md',
      body: '**To:** human-raj\n**From:** spm\n**Date:** 2026-09-27T19:00:00Z\n**Type:** handoff\n' };
    assert.strictEqual((await post('messages', 'spm', msg)).status, 201);
    const retry = await post('messages', 'spm', msg);
    assert.strictEqual(retry.status, 200);
    assert.strictEqual(retry.body.duplicate, true);
    assert.strictEqual((await post('messages', 'spm', { ...msg, body: msg.body + 'changed' })).status, 409);
    const proposal = { requestId: 'decision-proposal-1', filename: '2026-09-27-test-proposal.md',
      title: 'Test proposal', status: 'proposed', approver: 'human-raj',
      question: 'Which approach should ship?', options: ['A: versioned records', 'B: defer'] };
    assert.strictEqual((await post('decisions', 'spm', proposal)).status, 201);
    assert.strictEqual((await post('decisions', 'be', { ...proposal, requestId: 'decision-denied-1' })).status, 403);
    const resolution = { requestId: 'decision-resolution-1', filename: '2026-09-27-test-resolution.md',
      resolves: '2026-09-27-test-proposal.md',
      title: 'Test resolution', status: 'active', selectedOption: 'A', note: 'Approve versioned records.' };
    assert.strictEqual((await post('decisions', 'human-raj', resolution)).status, 201);
    assert.strictEqual((await post('decisions', 'spm', { ...resolution, requestId: 'decision-denied-resolution' })).status, 403);
    assert.strictEqual((await post('decisions', 'spm', { ...proposal, requestId: 'decision-raw-body', body: 'Status: active' })).status, 422);
    const index = JSON.parse(await fsp.readFile(path.join(pm, 'pm-index.json')));
    const manifest = JSON.parse(await fsp.readFile(path.join(pm, 'pm-disk-manifest.json')));
    assert.deepStrictEqual(index.messageFiles, [msg.filename]);
    assert.deepStrictEqual(index.decisionFiles, [proposal.filename, resolution.filename]);
    assert.deepStrictEqual(manifest.decisionFiles, index.decisionFiles);
    console.log('OK: message and decision API writes, equal retry, conflicting retry, denied persona, named independent approver, index and manifest.');
  } finally {
    if (child) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    await fsp.rm(temp, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
