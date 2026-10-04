#!/usr/bin/env node
/**
 * AG-P12.8 server concurrency contract test.
 * Copies the server and an isolated PM corpus into os.tmpdir(); no real project
 * data is ever written or restored by this test.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PERSONA = 'human-raj';
let failed = 0;
function assert(cond, msg) {
  if (!cond) { failed++; console.error('FAIL:', msg); }
  else console.log('OK  ', msg);
}
function req(port, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({
      host: '127.0.0.1', port, path: urlPath, method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, data ? { 'Content-Length': Buffer.byteLength(data) } : {}, headers),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch (_) { /* non-JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => err ? reject(err) : resolve(port));
    });
  });
}
async function waitForHealth(port, server, retries = 50) {
  for (let i = 0; i < retries; i++) {
    if (server.exitCode != null) throw new Error(`copied server exited early (${server.exitCode})`);
    try { const r = await req(port, 'GET', '/api/health'); if (r.status === 200) return; } catch (_) { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('copied server did not start');
}
function copyCorpus(tempRoot) {
  fs.mkdirSync(path.join(tempRoot, 'project-management', 'status'), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, 'project-management', 'roles'), { recursive: true });
  for (const file of ['server.js', 'coordination-transactions.js', 'sanitize.js', 'package.json']) {
    fs.copyFileSync(path.join(ROOT, file), path.join(tempRoot, file));
  }
  fs.copyFileSync(path.join(ROOT, 'project-management', 'status', 'schema.json'), path.join(tempRoot, 'project-management', 'status', 'schema.json'));
  fs.copyFileSync(path.join(ROOT, 'project-management', 'status', 'data_p12.json'), path.join(tempRoot, 'project-management', 'status', 'data_p12.json'));
  fs.copyFileSync(path.join(ROOT, 'project-management', 'roles', 'roles.json'), path.join(tempRoot, 'project-management', 'roles', 'roles.json'));
  fs.writeFileSync(path.join(tempRoot, 'project-management', 'pm-index.json'), JSON.stringify({ statusFiles: ['data_p12.json'] }, null, 2));
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khira-ifmatch-'));
  const diskFile = path.join(tempRoot, 'project-management', 'status', 'data_p12.json');
  copyCorpus(tempRoot);
  const original = JSON.parse(fs.readFileSync(diskFile, 'utf8'));
  const port = await freePort();
  const server = spawn(process.execPath, [path.join(tempRoot, 'server.js')], {
    cwd: tempRoot,
    env: Object.assign({}, process.env, { PORT: String(port), HOST: '127.0.0.1' }),
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    await waitForHealth(port, server);
    const firstRead = await req(port, 'GET', '/api/status/p12');
    assert(firstRead.status === 200, 'phase GET succeeds');
    assert(typeof firstRead.headers.etag === 'string' && firstRead.headers.etag === firstRead.json.etag, 'GET returns matching ETag header and body token');

    const initialTag = firstRead.json.etag;
    const payload = Object.assign({}, firstRead.json.data, {
      subtitle: `${firstRead.json.data.subtitle || ''} [conditional save]`,
      version: 'fixture-version-7',
    });
    const firstWrite = await req(port, 'PUT', '/api/status/p12', {
      headers: { 'If-Match': initialTag, 'X-Agentarium-Persona': PERSONA }, body: payload,
    });
    assert(firstWrite.status === 200, `fresh If-Match succeeds (got ${firstWrite.status})`);
    assert(typeof firstWrite.json?.etag === 'string' && firstWrite.json.etag !== initialTag, 'successful conditional save returns next ETag');

    const afterFirstWrite = fs.readFileSync(diskFile, 'utf8');
    const afterFirst = JSON.parse(afterFirstWrite);
    const stalePayload = Object.assign({}, payload, { subtitle: 'stale draft must not persist' });
    const stale = await req(port, 'PUT', '/api/status/p12', {
      headers: { 'If-Match': initialTag, 'X-Agentarium-Persona': PERSONA }, body: stalePayload,
    });
    assert(stale.status === 409, `stale If-Match returns 409 (got ${stale.status})`);
    assert(stale.json?.currentEtag === firstWrite.json?.etag, '409 reports current on-disk ETag');
    assert(fs.readFileSync(diskFile, 'utf8') === afterFirstWrite, '409 leaves the persisted file byte-identical');
    assert(JSON.parse(fs.readFileSync(diskFile, 'utf8')).subtitle === payload.subtitle, 'first writer content remains on disk after stale 409');

    const freshPayload = Object.assign({}, afterFirst, {
      title: `${afterFirst.title} [second fresh write]`,
      version: 'fixture-version-8',
    });
    const secondWrite = await req(port, 'PUT', '/api/status/p12', {
      headers: { 'If-Match': firstWrite.json.etag, 'X-Agentarium-Persona': PERSONA }, body: freshPayload,
    });
    assert(secondWrite.status === 200, `fresh returned ETag chains to next save (got ${secondWrite.status})`);

    const sidecarRead = await req(port, 'GET', '/api/status/p12');
    const sidecarPayload = Object.assign({}, sidecarRead.json.data, { _ifMatch: sidecarRead.json.etag, version: 'fixture-version-9' });
    delete sidecarPayload._provenance;
    const sidecarWrite = await req(port, 'PUT', '/api/status/p12', {
      headers: { 'X-Agentarium-Persona': PERSONA }, body: sidecarPayload,
    });
    assert(sidecarWrite.status === 200, `body _ifMatch fresh precondition succeeds (got ${sidecarWrite.status})`);
    const persisted = JSON.parse(fs.readFileSync(diskFile, 'utf8'));
    assert(!Object.prototype.hasOwnProperty.call(persisted, '_ifMatch'), '_ifMatch concurrency sidecar is stripped from disk');
    assert(persisted.version === 'fixture-version-9', 'legitimate version field survives persistence');

    const legacyPayload = Object.assign({}, persisted, { subtitle: 'unconditioned legacy write', version: 'legacy-version' });
    const legacy = await req(port, 'PUT', '/api/status/p12', {
      headers: { 'X-Agentarium-Persona': PERSONA }, body: legacyPayload,
    });
    assert(legacy.status === 428, `write without precondition is rejected (got ${legacy.status})`);
    const reviewerPayload = JSON.parse(JSON.stringify(persisted));
    reviewerPayload.tasks[0].pm_status = 'rejected';
    const reviewerWrite = await req(port, 'PUT', '/api/status/p12', {
      headers: { 'If-Match': sidecarWrite.json.etag, 'X-Agentarium-Persona': PERSONA }, body: reviewerPayload,
    });
    assert(reviewerWrite.status === 403, `generic phase save cannot change reviewer fields (got ${reviewerWrite.status})`);
    const reviewTamper = JSON.parse(JSON.stringify(persisted));
    reviewTamper.tasks[0].reviews = [];
    const reviewSave = await req(port, 'PUT', '/api/status/p12', {
      headers: { 'If-Match': sidecarWrite.json.etag, 'X-Agentarium-Persona': PERSONA }, body: reviewTamper,
    });
    assert(reviewSave.status === 200 && reviewSave.json?.ignoredProtectedChanges?.some((x) => x.endsWith('.reviews')),
      `generic save reports ignored review-history changes (got ${reviewSave.status})`);
    assert(JSON.stringify(JSON.parse(fs.readFileSync(diskFile, 'utf8')).tasks[0].reviews) === JSON.stringify(persisted.tasks[0].reviews),
      'generic save cannot erase prior reviews');
    const patchNoTag = await req(port, 'PATCH', `/api/status/p12/tasks/${encodeURIComponent(persisted.tasks[0].id)}`, {
      headers: { 'X-Agentarium-Persona': PERSONA }, body: { priority: 'p0' },
    });
    assert(patchNoTag.status === 428, `task PATCH requires If-Match (got ${patchNoTag.status})`);
    const reviewerPatch = await req(port, 'PATCH', `/api/status/p12/tasks/${encodeURIComponent(persisted.tasks[0].id)}`, {
      headers: { 'If-Match': sidecarWrite.json.etag, 'X-Agentarium-Persona': PERSONA }, body: { pm_status: 'rejected' },
    });
    assert(reviewerPatch.status === 422, `generic task PATCH cannot set verdicts (got ${reviewerPatch.status})`);
    const finalData = JSON.parse(fs.readFileSync(diskFile, 'utf8'));
    assert(finalData.subtitle !== 'unconditioned legacy write' && finalData.version === 'fixture-version-9', 'rejected writes leave prior content intact');
    assert(!Object.prototype.hasOwnProperty.call(finalData, '_ifMatch'), 'no body concurrency sidecar persisted');
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  assert(JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT, 'project-management', 'status', 'data_p12.json'), 'utf8'))) === JSON.stringify(original), 'real project status file was never changed');
  if (failed) { console.error(`\n${failed} check(s) failed.`); process.exit(1); }
  console.log('\nAll isolated server If-Match checks passed.');
}
main().catch((e) => { console.error(e); process.exit(1); });
