'use strict';

// Recoverable local write bundle for coordination artifacts. A pending journal
// is staged before its first visible file changes; the PM index is written
// after artifacts, and the idempotency result is written last. Startup replays
// interrupted process writes before the API begins serving requests. Power-loss
// durability requires filesystem fsync ordering and remains a separate gate.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}
function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function createCoordinationTransactions({ pmRoot, resolve, atomicWrite, atomicCreateExclusive, withFileLock }) {
  const indexRel = 'pm-index.json';
  const indexAbs = path.join(pmRoot, indexRel);
  const pendingDir = path.join(pmRoot, 'transactions', 'pending');
  const requestsDir = path.join(pmRoot, 'transactions', 'requests');

  async function readText(rel) {
    const abs = resolve(rel);
    if (!abs) throw new Error(`Invalid transaction path: ${rel}`);
    try { return await fsp.readFile(abs, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function apply(journal) {
    for (const file of journal.files) {
      const abs = resolve(file.rel);
      if (!abs) throw new Error(`Invalid transaction path: ${file.rel}`);
      if (file.mode === 'create') {
        try { await atomicCreateExclusive(abs, file.content); }
        catch (error) {
          if (error.code !== 'EEXIST' || await readText(file.rel) !== file.content) throw error;
        }
      } else if (file.mode === 'replace') {
        await atomicWrite(abs, file.content);
      } else throw new Error(`Invalid transaction mode: ${file.mode}`);
    }
  }
  async function recover() {
    await fsp.mkdir(pendingDir, { recursive: true });
    await fsp.mkdir(requestsDir, { recursive: true });
    const names = (await fsp.readdir(pendingDir)).filter((name) => name.endsWith('.json')).sort();
    for (const name of names) {
      const journal = JSON.parse(await fsp.readFile(path.join(pendingDir, name), 'utf8'));
      await apply(journal);
      await fsp.unlink(path.join(pendingDir, name));
    }
  }

  async function commit({ requestId, action, actor, payload, files, registrations, result }) {
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) {
      return { error: 'A stable requestId (8–128 letters, digits, _ or -) is required.', status: 422 };
    }
    const hash = digest({ action, payload, actor });
    const key = digest(requestId);
    const requestRel = `transactions/requests/${key}.json`;
    const pendingRel = `transactions/pending/${key}.json`;
    return withFileLock(indexAbs, async () => {
      try { await recover(); }
      catch (error) { return { error: `Pending write recovery failed: ${error.code || error.message}`, status: 503 }; }
      const priorText = await readText(requestRel);
      if (priorText) {
        const prior = JSON.parse(priorText);
        return prior.hash === hash && prior.action === action
          ? { result: prior.result, duplicate: true }
          : { error: 'requestId was already used for a different payload.', status: 409 };
      }
      const indexText = await readText(indexRel);
      if (!indexText) return { error: 'PM index is missing.', status: 500 };
      for (const file of files) {
        if (!resolve(file.rel)) return { error: 'Invalid artifact path.', status: 400 };
        if (file.mode === 'create' && await readText(file.rel) !== null) {
          return { error: `Artifact ${file.rel} already exists.`, status: 409 };
        }
      }
      const index = JSON.parse(indexText);
      const manifestRel = 'pm-disk-manifest.json';
      const manifestText = await readText(manifestRel);
      if (!manifestText) return { error: 'PM disk manifest is missing.', status: 500 };
      const manifest = JSON.parse(manifestText);
      for (const [keyName, names] of Object.entries(registrations || {})) {
        for (const target of [index, manifest]) {
          if (!Array.isArray(target[keyName])) target[keyName] = [];
          for (const name of names) if (!target[keyName].includes(name)) target[keyName].push(name);
          target[keyName].sort();
        }
      }
      manifest.generatedAt = new Date().toISOString();
      const requestContent = JSON.stringify({ requestId, action, hash, result }, null, 2) + '\n';
      const journal = { requestId, action, files: [
        ...files,
        { rel: indexRel, mode: 'replace', content: JSON.stringify(index, null, 2) + '\n' },
        { rel: manifestRel, mode: 'replace', content: JSON.stringify(manifest, null, 2) + '\n' },
        { rel: requestRel, mode: 'create', content: requestContent },
      ] };
      await atomicWrite(resolve(pendingRel), JSON.stringify(journal, null, 2) + '\n');
      try {
        await apply(journal);
        await fsp.unlink(resolve(pendingRel));
      } catch (error) {
        // The durable journal is left for startup recovery. No success response.
        return { error: `Write bundle is pending recovery: ${error.code || error.message}`, status: 503 };
      }
      return { result, duplicate: false };
    });
  }
  return { commit, recover };
}

module.exports = { createCoordinationTransactions, digest };
