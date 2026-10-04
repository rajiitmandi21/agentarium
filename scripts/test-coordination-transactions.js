#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { createCoordinationTransactions } = require('../coordination-transactions.js');

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentarium-coordination-tx-'));
  let failIndexOnce = true;
  const resolve = (rel) => rel.includes('..') ? null : path.join(root, rel);
  const atomicWrite = async (abs, content) => {
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    if (abs === path.join(root, 'pm-index.json') && failIndexOnce) {
      failIndexOnce = false;
      throw Object.assign(new Error('simulated index interruption'), { code: 'EIO' });
    }
    await fsp.writeFile(abs, content);
  };
  const atomicCreateExclusive = async (abs, content) => {
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, { flag: 'wx' });
  };
  try {
    await fsp.writeFile(path.join(root, 'pm-index.json'), JSON.stringify({ messageFiles: [] }));
    await fsp.writeFile(path.join(root, 'pm-disk-manifest.json'), JSON.stringify({ messageFiles: [] }));
    const tx = createCoordinationTransactions({ pmRoot: root, resolve, atomicWrite,
      atomicCreateExclusive, withFileLock: (_path, fn) => fn() });
    const args = { requestId: 'request-1234', action: 'messages:create', payload: { body: 'hello' },
      files: [{ rel: 'messages/hello.md', mode: 'create', content: 'hello\n' }],
      registrations: { messageFiles: ['hello.md'] }, result: { file: 'hello.md' } };
    const interrupted = await tx.commit(args);
    assert.strictEqual(interrupted.status, 503);
    assert.strictEqual((await fsp.readdir(path.join(root, 'transactions/pending'))).length, 1);
    await tx.recover();
    assert.deepStrictEqual(JSON.parse(await fsp.readFile(path.join(root, 'pm-index.json'))).messageFiles, ['hello.md']);
    assert.deepStrictEqual(JSON.parse(await fsp.readFile(path.join(root, 'pm-disk-manifest.json'))).messageFiles, ['hello.md']);
    assert.strictEqual((await fsp.readdir(path.join(root, 'transactions/pending'))).length, 0);
    assert.strictEqual((await tx.commit(args)).duplicate, true);
    assert.strictEqual((await tx.commit({ ...args, payload: { body: 'changed' } })).status, 409);
    assert.strictEqual(await fsp.readFile(path.join(root, 'messages/hello.md'), 'utf8'), 'hello\n');
    console.log('OK: interrupted bundle recovered artifact, index, manifest and idempotency result; equal retry reused result; changed retry returned 409.');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
