#!/usr/bin/env node
'use strict';

const assert = require('assert');

const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:4788').replace(/\/+$/, '');
const PERSONA = 'human-raj';

async function request(route, options) {
  const response = await fetch(`${BASE_URL}${route}`, options);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch (error) { /* assertion below reports body */ }
  return { response, json, text };
}

async function main() {
  const initial = await request('/api/status/p12');
  assert.strictEqual(initial.response.status, 200, 'GET p12');
  assert(initial.json && initial.json.data && initial.json.etag, 'phase data and ETag');

  const marker = ` [docker-write-${Date.now()}]`;
  const body = Object.assign({}, initial.json.data, {
    subtitle: `${initial.json.data.subtitle || ''}${marker}`,
  });
  const written = await request('/api/status/p12', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'If-Match': initial.json.etag,
      'X-Agentarium-Persona': PERSONA,
    },
    body: JSON.stringify(body),
  });
  assert.strictEqual(written.response.status, 200, `authorized bind-mount write: ${written.text}`);
  assert(written.json && written.json.etag !== initial.json.etag, 'write returns a new ETag');

  const persisted = await request('/api/status/p12');
  assert.strictEqual(persisted.response.status, 200, 'GET persisted p12');
  assert(persisted.json.data.subtitle.endsWith(marker), 'container write persisted through bind mount');

  const stale = await request('/api/status/p12', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'If-Match': initial.json.etag,
      'X-Agentarium-Persona': PERSONA,
    },
    body: JSON.stringify(initial.json.data),
  });
  assert.strictEqual(stale.response.status, 409, 'stale ETag is rejected');

  const unauthorized = await request('/api/status/p12', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(persisted.json.data),
  });
  assert.strictEqual(unauthorized.response.status, 401, 'missing persona is rejected');

  console.log('OK: Docker bind-mount write, ETag concurrency, and persona gate.');
}

main().catch((error) => {
  console.error(`FAIL: ${error.stack || error.message}`);
  process.exit(1);
});
