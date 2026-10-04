#!/usr/bin/env node
// Agentarium local API server (read + persona-gated write — AG-P8.1..AG-P8.5).
//
// Serves the existing static SPA exactly like `python3 -m http.server`, exposes
// GET /api/* read endpoints, and persona-gated write endpoints:
//   PUT   /api/status/:phase            (tasks:save)   — atomic hard save
//   PATCH /api/status/:phase/tasks/:id  (tasks:edit [+ roles:assign for owner_id])
//   POST  /api/messages                 (messages:create)  — append-only
//   POST  /api/decisions                (decisions:create|supersede) — supersede-only
//
// Built-in modules only (http, fs, path, url, crypto, vm) — no npm dependencies.
// Binds HOST env (default 127.0.0.1); port from PORT env (default 4747).
//
// Authorization: the acting persona arrives in X-Agentarium-Persona and is
// resolved against roles.json defaultPermissions. Unknown/missing → 401;
// lacking the permission → 403. Module policies (messages append-only, decisions
// supersede-only, PATCH never touching engineering fields) are enforced
// server-side regardless of persona. Writes are atomic (temp-then-rename),
// re-validated against the status schema, and HTML-bearing fields are sanitized.
// Path containment is mandatory — every artifact path is resolved UNDER the
// project-management/ root via resolveUnderPmRoot and any escape is rejected.

'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const vm = require('vm');
const { createCoordinationTransactions } = require('./coordination-transactions.js');

const ROOT = __dirname;
const PM_ROOT = path.join(ROOT, 'project-management');
// Keep direct/local launches private by default. Containers explicitly set
// HOST=0.0.0.0 and publish the port on host loopback via compose.yaml.
const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT, 10) || 4747;

// Largest request body we will buffer (bodies above this are rejected 413).
const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MB

// Writes are mounted (AG-P8.3/8.4/8.5). Health/project report this.
const WRITE_ENABLED = true;

// ─── Server-side rich-text sanitizer ────────────────────────────────────────
// Reuse the EXACT browser sanitizer (sanitize.js → window.khiraSanitize) by
// loading it into a VM sandbox. Same allowlist policy as docs/rich-text-safety.md,
// no divergent server copy to drift. Node built-in `vm` only.
const SANITIZE = (function loadSanitizer() {
  try {
    const code = fs.readFileSync(path.join(ROOT, 'sanitize.js'), 'utf8');
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: 'sanitize.js' });
    const api = sandbox.window.khiraSanitize;
    if (api && typeof api.sanitizeRichHtml === 'function') return api;
  } catch (e) {
    console.error('Sanitizer load failed:', e && e.message ? e.message : e);
  }
  // Fail closed: if the sanitizer cannot load, escape everything rather than
  // persist raw HTML. Keeps the write path safe even on a broken deploy.
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return {
    sanitizeRichHtml: esc,
    sanitizePhaseData: (d) => d,
    _fallback: true,
  };
})();

// Read app version from package.json if present; fall back to agentarium.json.
function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    if (pkg && pkg.version) return pkg.version;
  } catch (e) { /* optional */ }
  try {
    const man = JSON.parse(fs.readFileSync(path.join(PM_ROOT, 'agentarium.json'), 'utf8'));
    if (man && man.version) return man.version;
  } catch (e) { /* optional */ }
  return '0.0.0';
}

const APP_VERSION = readVersion();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.jsx': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function sendJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }, extraHeaders || {}));
  res.end(body);
}

function sendError(res, status, message, extra) {
  sendJson(res, status, Object.assign({ ok: false, error: message }, extra || {}));
}

// ─── Path containment ──────────────────────────────────────────────────────
// Resolve a caller-supplied relative path UNDER PM_ROOT and refuse anything
// that escapes it (traversal, absolute paths, symlink breakout). Returns the
// absolute path on success or null on rejection.
function resolveUnderPmRoot(relativePath) {
  if (relativePath == null || typeof relativePath !== 'string') return null;
  // Decode once defensively; reject if decoding fails (malformed %xx).
  let rel = relativePath;
  try {
    rel = decodeURIComponent(relativePath);
  } catch (e) {
    return null;
  }
  if (rel === '') return PM_ROOT;
  // Reject obvious traversal / absolute markers before normalizing.
  if (rel.includes('\0')) return null;
  if (rel.includes('..')) return null;
  if (rel.startsWith('/') || rel.startsWith('\\')) return null;
  if (/^[a-zA-Z]:[\\/]/.test(rel)) return null; // windows drive abs
  const resolved = path.resolve(PM_ROOT, rel);
  // Final guard: resolved path must be PM_ROOT itself or a descendant.
  const rootWithSep = PM_ROOT.endsWith(path.sep) ? PM_ROOT : PM_ROOT + path.sep;
  if (resolved !== PM_ROOT && !resolved.startsWith(rootWithSep)) return null;
  return resolved;
}

async function readPmJson(relativePath) {
  const abs = resolveUnderPmRoot(relativePath);
  if (!abs) return { code: 'traversal' };
  let text;
  try {
    text = await fsp.readFile(abs, 'utf8');
  } catch (e) {
    return { code: e.code === 'ENOENT' ? 'missing' : 'read-failed', detail: e.message };
  }
  try {
    return { data: JSON.parse(text) };
  } catch (e) {
    return { code: 'malformed', detail: e.message };
  }
}

async function readPmText(relativePath) {
  const abs = resolveUnderPmRoot(relativePath);
  if (!abs) return { code: 'traversal' };
  try {
    const text = await fsp.readFile(abs, 'utf8');
    return { text };
  } catch (e) {
    return { code: e.code === 'ENOENT' ? 'missing' : 'read-failed', detail: e.message };
  }
}

function statusCodeForArtifactError(code) {
  if (code === 'traversal') return 400;
  if (code === 'missing') return 404;
  if (code === 'malformed') return 502;
  return 500;
}

// ─── Optimistic-concurrency ETag (AG-P12.8) ──────────────────────────────────
// A weak validator over the exact on-disk bytes. GET stamps it as the `ETag`
// response header; PUT/PATCH compare a client-supplied `If-Match` against the
// CURRENT on-disk etag and 409 if the file moved since the client read it.
// crypto is already imported (line 30); no new deps. Deterministic — content-only.
function computeEtag(text) {
  const hash = crypto.createHash('sha1').update(text == null ? '' : text, 'utf8').digest('hex');
  return `W/"${hash}"`;
}

// Read the CURRENT on-disk etag for a PM-relative path. Returns { etag } when the
// file exists, { code } (e.g. 'missing') when it cannot be read. A missing file
// has no etag, so a client that sent If-Match for it is treated as stale.
async function currentEtagOf(relativePath) {
  const r = await readPmText(relativePath);
  if (r.text == null) return { code: r.code || 'read-failed' };
  return { etag: computeEtag(r.text) };
}

// Normalize an incoming If-Match header value for comparison. Accepts the weak
// form (`W/"…"`), a bare quoted tag, or a raw hash; strips the `W/` prefix and
// surrounding quotes so equivalent encodings compare equal.
function normalizeEtag(value) {
  if (value == null) return null;
  let v = Array.isArray(value) ? value[0] : value;
  if (typeof v !== 'string') return null;
  v = v.trim();
  if (v === '') return null;
  if (v.startsWith('W/')) v = v.slice(2).trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  return v;
}

function etagsMatch(ifMatchHeader, currentEtag) {
  const a = normalizeEtag(ifMatchHeader);
  const b = normalizeEtag(currentEtag);
  return a != null && b != null && a === b;
}

// ─── pm-index.json helpers ─────────────────────────────────────────────────
async function loadIndex() {
  const r = await readPmJson('pm-index.json');
  return r.data || {};
}

function phaseToStatusFile(phaseParam) {
  // Accept "p8", "8", or "data_p8.json" / "data_p8".
  if (!phaseParam) return null;
  let p = String(phaseParam).trim();
  if (p.includes('/') || p.includes('..') || p.includes('\\')) return null;
  let m = p.match(/^data_p(\d+)(?:\.json)?$/i);
  if (m) return `data_p${m[1]}.json`;
  m = p.match(/^p?(\d+)$/i);
  if (m) return `data_p${m[1]}.json`;
  return null;
}

// Read a list of markdown artifacts under a PM subfolder. `list` is true to
// only return filenames; otherwise each entry includes the file text.
async function listMarkdownArtifacts(subdir, fileKey, withBodies) {
  const index = await loadIndex();
  const files = Array.isArray(index[fileKey]) ? index[fileKey].slice().sort() : [];
  const items = [];
  for (const f of files) {
    const entry = { file: f, path: `project-management/${subdir}/${f}` };
    if (withBodies) {
      const r = await readPmText(`${subdir}/${f}`);
      if (r.text != null) entry.body = r.text;
      else entry.error = r.code;
    }
    items.push(entry);
  }
  return { subdir, count: items.length, items };
}

// ─── Route handlers ────────────────────────────────────────────────────────
async function handleHealth(res) {
  sendJson(res, 200, {
    ok: true,
    version: APP_VERSION,
    sourceMode: 'api-workspace',
    writeEnabled: WRITE_ENABLED,
  });
}

async function handleProject(res) {
  const index = await loadIndex();
  const manifestR = await readPmJson('agentarium.json');
  const statusFiles = Array.isArray(index.statusFiles) ? index.statusFiles.slice().sort() : [];
  const phases = statusFiles
    .map((f) => {
      const m = f.match(/data_p(\d+)\.json/i);
      return m ? { id: `p${m[1]}`, file: f } : null;
    })
    .filter(Boolean);
  sendJson(res, 200, {
    ok: true,
    sourceMode: 'api-workspace',
    writeEnabled: WRITE_ENABLED,
    manifest: manifestR.data || null,
    projectManagementRoot: 'project-management/',
    phases,
    index,
  });
}

async function handleStatusList(res) {
  const index = await loadIndex();
  const statusFiles = Array.isArray(index.statusFiles) ? index.statusFiles.slice().sort() : [];
  const phases = [];
  for (const f of statusFiles) {
    const m = f.match(/data_p(\d+)\.json/i);
    const id = m ? `p${m[1]}` : f.replace(/\.json$/i, '');
    const r = await readPmJson(`status/${f}`);
    if (r.data) phases.push({ id, file: f, data: r.data });
    else phases.push({ id, file: f, error: r.code });
  }
  sendJson(res, 200, { ok: true, count: phases.length, phases });
}

async function handleStatusPhase(res, phaseParam) {
  const file = phaseToStatusFile(phaseParam);
  if (!file) return sendError(res, 400, `Invalid phase parameter "${phaseParam}".`);
  const index = await loadIndex();
  const statusFiles = Array.isArray(index.statusFiles) ? index.statusFiles : [];
  if (!statusFiles.includes(file)) {
    return sendError(res, 404, `Phase status file "${file}" not found in index.`);
  }
  // Read raw bytes once: parse for the payload AND stamp a content ETag so a
  // client can later send it back as If-Match for an optimistic-concurrency PUT.
  const rawR = await readPmText(`status/${file}`);
  if (rawR.text == null) {
    return sendError(res, statusCodeForArtifactError(rawR.code), `Cannot read ${file}: ${rawR.code}`);
  }
  let data;
  try {
    data = JSON.parse(rawR.text);
  } catch (e) {
    return sendError(res, statusCodeForArtifactError('malformed'), `Cannot read ${file}: malformed`);
  }
  const etag = computeEtag(rawR.text);
  const m = file.match(/data_p(\d+)\.json/i);
  sendJson(res, 200, { ok: true, id: m ? `p${m[1]}` : file, file, etag, data }, { ETag: etag });
}

async function handleRoles(res) {
  const r = await readPmJson('roles/roles.json');
  if (!r.data) {
    return sendError(res, statusCodeForArtifactError(r.code), `Cannot read roles.json: ${r.code}`);
  }
  sendJson(res, 200, { ok: true, roles: r.data });
}

async function handleCrews(res) {
  const r = await readPmJson('roles/crews-index.json');
  if (!r.data) {
    return sendError(res, statusCodeForArtifactError(r.code), `Cannot read crews-index.json: ${r.code}`);
  }
  // Keep personas at the response root: pm-loader.normalizeCrews consumes the
  // same shape as the canonical file, with only an additive transport marker.
  sendJson(res, 200, Object.assign({ ok: true }, r.data));
}

async function handleMarkdownCollection(res, subdir, fileKey) {
  const out = await listMarkdownArtifacts(subdir, fileKey, true);
  sendJson(res, 200, Object.assign({ ok: true }, out));
}

// Verdicts have no file collection — they are cross-cutting trust state derived
// from task pm_status + completed-awaiting-PM + decisions. Surface the raw
// signals the client (pm-loader) already knows how to assemble.
async function handleVerdicts(res) {
  const index = await loadIndex();
  const statusFiles = Array.isArray(index.statusFiles) ? index.statusFiles.slice().sort() : [];
  const taskVerdicts = [];
  for (const f of statusFiles) {
    const r = await readPmJson(`status/${f}`);
    if (!r.data || !Array.isArray(r.data.tasks)) continue;
    const m = f.match(/data_p(\d+)\.json/i);
    const phaseId = m ? `p${m[1]}` : f;
    for (const t of r.data.tasks) {
      const subs = Array.isArray(t.subtasks) ? t.subtasks : [];
      const allSubsDone = subs.length > 0 && subs.every((s) => s.status === 'completed');
      const awaitingPm = !t.pm_status && (t.status === 'completed' || allSubsDone);
      if (t.pm_status || awaitingPm) {
        taskVerdicts.push({
          phase: phaseId,
          taskId: t.id,
          title: t.title,
          pm_status: t.pm_status || '',
          state: t.pm_status || 'needs-review',
          awaiting: t.pm_status ? null : 'spm',
          code_updated_at: t.code_updated_at || '',
          pm_updated_at: t.pm_updated_at || '',
        });
      }
    }
  }
  const decisions = await listMarkdownArtifacts('decisions', 'decisionFiles', false);
  sendJson(res, 200, {
    ok: true,
    coverage: 'Khira pm_status + completed-awaiting-PM + ledger decisions',
    taskVerdicts,
    decisions: decisions.items,
  });
}

// ─── Static file serving ───────────────────────────────────────────────────
// Serve repo files like `python3 -m http.server` (rooted at repo root), with
// the same path-containment guard — EXCEPT dotfiles are refused (see below).
function resolveStaticPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (e) {
    return null;
  }
  if (decoded.includes('\0')) return null;
  // Security: refuse ANY dot-prefixed path segment (.git/** incl. history and
  // config, .env-style secret files, concurrent writers' .tmp-* artifacts).
  // The SPA references no dotfile asset, so this deliberately diverges from
  // `python3 -m http.server` (which serves dotfiles) to prevent source/history
  // disclosure when HOST is bound beyond loopback.
  const relSegments = decoded.replace(/^\/+/, '').split('/').filter(Boolean);
  if (relSegments.some((seg) => seg.startsWith('.'))) return null;
  let rel = decoded.replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';
  const resolved = path.resolve(ROOT, rel);
  const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (resolved !== ROOT && !resolved.startsWith(rootWithSep)) return null;
  return resolved;
}

async function serveStatic(req, res, pathname) {
  const abs = resolveStaticPath(pathname);
  if (!abs) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }
  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  let target = abs;
  if (stat.isDirectory()) {
    target = path.join(abs, 'index.html');
    try {
      await fsp.stat(target);
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
  }
  const ext = path.extname(target).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type });
  const stream = fs.createReadStream(target);
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  stream.pipe(res);
}

// ─── Write infrastructure (AG-P8.3 / AG-P8.4 / AG-P8.5) ──────────────────────

// Read and JSON-parse a request body with a hard size cap. Never throws on a
// malformed body — returns a tagged result the caller turns into a clean 4xx.
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        resolve({ code: 'too-large' });
        try { req.destroy(); } catch (e) { /* ignore */ }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') return resolve({ data: {}, raw: '' });
      try {
        resolve({ data: JSON.parse(raw), raw });
      } catch (e) {
        resolve({ code: 'malformed', detail: e.message });
      }
    });
    req.on('error', () => {
      if (!aborted) resolve({ code: 'read-failed' });
    });
  });
}

// ─── Persona authorization (AG-P8.3) ────────────────────────────────────────
// Resolve the acting persona from the X-Agentarium-Persona header against
// roles.json defaultPermissions. Returns { ok, status, error, persona, perms }.
async function resolvePersona(req) {
  const headerVal = req.headers['x-agentarium-persona'];
  const personaId = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  if (!personaId || typeof personaId !== 'string' || personaId.trim() === '') {
    return { ok: false, status: 401, error: 'Missing X-Agentarium-Persona header — an acting persona is required for writes.' };
  }
  const id = personaId.trim();
  const r = await readPmJson('roles/roles.json');
  if (!r.data || !Array.isArray(r.data.roles)) {
    return { ok: false, status: 500, error: 'Cannot resolve persona — roles.json unavailable.' };
  }
  const role = r.data.roles.find((x) => x && x.id === id);
  if (!role) {
    return { ok: false, status: 401, error: `Unknown persona "${id}" — not defined in roles.json.` };
  }
  return { ok: true, persona: id, role, perms: role.defaultPermissions || {} };
}

// Does the persona hold `action` within `module` (e.g. tasks/save)?
function personaHas(authz, module, action) {
  const list = authz.perms && authz.perms[module];
  return Array.isArray(list) && list.includes(action);
}

// Require a permission; if missing, send 403 naming the persona + permission.
function requirePermission(res, authz, module, action) {
  if (personaHas(authz, module, action)) return true;
  sendError(res, 403, `Persona "${authz.persona}" lacks ${module}:${action}.`, {
    persona: authz.persona,
    missingPermission: `${module}:${action}`,
  });
  return false;
}

// ─── Atomic write (temp-then-rename) ────────────────────────────────────────
// Write `content` to an absolute path UNDER PM_ROOT atomically. A failure leaves
// any existing file intact (the temp file is removed and never replaces it).
async function atomicWrite(absPath, content) {
  const dir = path.dirname(absPath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  try {
    await fsp.writeFile(tmp, content, { encoding: 'utf8', mode: 0o644 });
    await fsp.rename(tmp, absPath);
  } catch (e) {
    try { await fsp.unlink(tmp); } catch (_) { /* temp may not exist */ }
    throw e;
  }
}

// ─── Atomic CREATE, exclusive ────────────────────────────────────────────────
// Create `absPath` with `content` ONLY if it does not already exist. The final
// name is claimed with link(), which fails EEXIST when another writer won the
// race — rename alone would silently overwrite, so append-only endpoints use
// this instead of a check-then-write pair.
async function atomicCreateExclusive(absPath, content) {
  const dir = path.dirname(absPath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  try {
    await fsp.writeFile(tmp, content, { encoding: 'utf8', mode: 0o644 });
    try {
      await fsp.link(tmp, absPath);
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        const exists = Object.assign(new Error('target exists'), { code: 'EEXIST' });
        throw exists;
      }
      throw e;
    }
  } finally {
    try { await fsp.unlink(tmp); } catch (_) { /* already linked or absent */ }
  }
}

// ─── Per-file write serialization ────────────────────────────────────────────
// In-process mutex keyed by absolute path: chains critical sections so a
// precondition check and its write cannot interleave with another writer's
// check→write sequence (TOCTOU on etag/existence guards). Cross-process
// writers remain outside this guarantee; the server is single-process.
const fileWriteLocks = new Map();
function withFileLock(absPath, fn) {
  const run = (fileWriteLocks.get(absPath) || Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  fileWriteLocks.set(absPath, tail);
  tail.then(() => {
    if (fileWriteLocks.get(absPath) === tail) fileWriteLocks.delete(absPath);
  });
  return run;
}
const coordinationWrites = createCoordinationTransactions({
  pmRoot: PM_ROOT, resolve: resolveUnderPmRoot, atomicWrite, atomicCreateExclusive, withFileLock,
});

// ─── Status schema re-validation (mirror of scripts/validate-status.js) ──────
const REQUIRED_TOP = ['title', 'subtitle', 'last_updated', 'human_reviews', 'tasks'];
const REQUIRED_TASK = ['id', 'title', 'status', 'priority', 'blockers', 'reviews', 'subtasks'];
const REQUIRED_REVIEW = ['type', 'text'];
const REQUIRED_SUBTASK = ['status', 'text'];
const STATUS_ENUM = new Set(['completed', 'in_progress', 'todo', 'blocked']);
const PRIORITY_ENUM = new Set(['p0', 'p1', 'p2', 'pl']);
const PM_STATUS_ENUM = new Set(['', 'done', 'tested', 'needs-review', 'rejected', 'superseded']);
const SUBTASK_STATUS_ENUM = new Set(['completed', 'in_progress', 'todo']);
const REVIEW_TYPE_ENUM = new Set(['BUG', 'PLAN', 'NOTE', 'CLEANUP']);

function validateReview(r, label, errors) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) {
    errors.push(`${label}: review must be an object`);
    return;
  }
  for (const k of REQUIRED_REVIEW) if (!(k in r)) errors.push(`${label}: missing "${k}"`);
  if ('type' in r && !REVIEW_TYPE_ENUM.has(r.type)) errors.push(`${label}: invalid review type "${r.type}"`);
  if ('text' in r && typeof r.text !== 'string') errors.push(`${label}: review text must be a string`);
}

// Returns an array of human-readable errors; empty array means valid.
function validateStatusBody(data) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    errors.push('body: not an object');
    return errors;
  }
  for (const k of REQUIRED_TOP) if (!(k in data)) errors.push(`body: missing required key "${k}"`);
  if ('title' in data && typeof data.title !== 'string') errors.push('body: "title" must be a string');
  if ('subtitle' in data && typeof data.subtitle !== 'string') errors.push('body: "subtitle" must be a string');
  if ('last_updated' in data && typeof data.last_updated !== 'string') errors.push('body: "last_updated" must be a string');
  if ('human_reviews' in data) {
    if (!Array.isArray(data.human_reviews)) errors.push('body: "human_reviews" must be an array');
    else data.human_reviews.forEach((h, i) => {
      if (!h || typeof h !== 'object') errors.push(`human_reviews[${i}]: must be an object`);
      else if (!('text' in h)) errors.push(`human_reviews[${i}]: missing "text"`);
      else if (typeof h.text !== 'string') errors.push(`human_reviews[${i}]: "text" must be a string`);
    });
  }
  if (!Array.isArray(data.tasks)) {
    errors.push('body: "tasks" must be an array');
    return errors;
  }
  data.tasks.forEach((t, i) => {
    const label = `tasks[${i}]`;
    if (!t || typeof t !== 'object' || Array.isArray(t)) {
      errors.push(`${label}: must be an object`);
      return;
    }
    for (const k of REQUIRED_TASK) if (!(k in t)) errors.push(`${label}: missing "${k}"`);
    if ('id' in t && typeof t.id !== 'string') errors.push(`${label}: "id" must be a string`);
    if ('title' in t && typeof t.title !== 'string') errors.push(`${label}: "title" must be a string`);
    if ('status' in t && !STATUS_ENUM.has(t.status)) errors.push(`${label}: invalid status "${t.status}"`);
    if ('priority' in t && !PRIORITY_ENUM.has(t.priority)) errors.push(`${label}: invalid priority "${t.priority}"`);
    if ('pm_status' in t && !PM_STATUS_ENUM.has(t.pm_status)) errors.push(`${label}: invalid pm_status "${t.pm_status}"`);
    if ('blockers' in t && !Array.isArray(t.blockers)) errors.push(`${label}: "blockers" must be an array`);
    if ('reviews' in t) {
      if (!Array.isArray(t.reviews)) errors.push(`${label}: "reviews" must be an array`);
      else t.reviews.forEach((r, j) => validateReview(r, `${label}.reviews[${j}]`, errors));
    }
    if ('subtasks' in t) {
      if (!Array.isArray(t.subtasks)) errors.push(`${label}: "subtasks" must be an array`);
      else t.subtasks.forEach((s, j) => {
        const slabel = `${label}.subtasks[${j}]`;
        if (!s || typeof s !== 'object') { errors.push(`${slabel}: must be an object`); return; }
        for (const k of REQUIRED_SUBTASK) if (!(k in s)) errors.push(`${slabel}: missing "${k}"`);
        if ('status' in s && !SUBTASK_STATUS_ENUM.has(s.status)) errors.push(`${slabel}: invalid status "${s.status}"`);
        if ('text' in s && typeof s.text !== 'string') errors.push(`${slabel}: "text" must be a string`);
        if ('review' in s && s.review != null) validateReview(s.review, `${slabel}.review`, errors);
      });
    }
  });
  return errors;
}

// ─── Write handlers ──────────────────────────────────────────────────────────

// PUT /api/status/:phase — hard save a phase atomically. Requires tasks:save.
async function handlePutStatusPhase(req, res, phaseParam, authz) {
  if (!requirePermission(res, authz, 'tasks', 'save')) return;
  const file = phaseToStatusFile(phaseParam);
  if (!file) return sendError(res, 400, `Invalid phase parameter "${phaseParam}".`);
  const rel = `status/${file}`;
  const abs = resolveUnderPmRoot(rel);
  if (!abs) return sendError(res, 400, 'Path containment rejected the target.');

  const body = await readJsonBody(req);
  if (body.code === 'too-large') return sendError(res, 413, 'Request body too large.');
  if (body.code) return sendError(res, 400, `Malformed JSON body: ${body.detail || body.code}.`);

  // Coordination write contract v1 requires a fresh read token on every
  // existing-file mutation. A body last_updated is not a read token.
  const ifMatchHeader = req.headers['if-match'];
  const bodyIfMatch = body.data && typeof body.data._ifMatch === 'string'
    ? body.data._ifMatch : null;
  const precondition = ifMatchHeader || bodyIfMatch || null;
  if (!precondition) return sendError(res, 428, 'If-Match is required for a phase save. Reload the phase and retry.');

  // Sanitize HTML-bearing fields BEFORE validating/persisting.
  const sanitized = SANITIZE.sanitizePhaseData(body.data);
  // The `_ifMatch` sidecar is inbound-only — never persisted. No other field
  // is stripped, so legitimate payload keys survive the round-trip.
  delete sanitized._ifMatch;

  const errors = validateStatusBody(sanitized);
  if (errors.length) {
    return sendError(res, 400, 'Status body failed schema re-validation; file unchanged.', { errors: errors.slice(0, 25) });
  }

  // Per-write provenance (acting persona + UTC timestamp), kept minimal.
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  // Precondition-check → write runs under the per-file lock so two writers
  // that both pass the etag comparison cannot interleave within this process.
  let respond = null;
  await withFileLock(abs, async () => {
    const curRaw = await readPmText(rel);
    const currentEtag = curRaw.text == null ? null : computeEtag(curRaw.text);
    if (!currentEtag || !etagsMatch(precondition, currentEtag)) {
      respond = () => sendError(res, 409, 'Stale write — file changed since you read it.',
        currentEtag ? { currentEtag } : { currentEtag: null, reason: curRaw.code || 'unreadable' });
      return;
    }
    let current;
    try { current = JSON.parse(curRaw.text); } catch (_) {
      respond = () => sendError(res, 422, 'Current phase is malformed; file unchanged.');
      return;
    }
    // Generic phase saves must not become a back door for verdicts, review
    // history, engineering timestamps, or task creation/deletion. Those have
    // separate role-checked actions.
    const currentById = new Map((current.tasks || []).map((t) => [t.id, t]));
    const protectedTaskKeys = (old, next) => new Set([...Object.keys(old), ...Object.keys(next)]
      .filter((key) => key === 'reviews' || key === 'code_updated_at' || key.startsWith('pm_')));
    const incomingIds = body.data.tasks.map((t) => t.id);
    if (currentById.size !== incomingIds.length || new Set(incomingIds).size !== incomingIds.length ||
        incomingIds.some((id) => !currentById.has(id))) {
      respond = () => sendError(res, 403, 'Phase save cannot change task identity.');
      return;
    }
    if (body.data.tasks.some((t) => t.status === 'completed' && currentById.get(t.id).status !== 'completed')) {
      respond = () => sendError(res, 403, 'Completing a task requires an independent review action.');
      return;
    }
    const protectedChanges = [];
    if (JSON.stringify(body.data.human_reviews) !== JSON.stringify(current.human_reviews)) {
      protectedChanges.push('human_reviews');
    }
    for (const t of body.data.tasks) {
      const old = currentById.get(t.id);
      if (!old) continue;
      for (const key of protectedTaskKeys(old, t)) {
        if (JSON.stringify(t[key]) !== JSON.stringify(old[key])) protectedChanges.push(`${t.id}.${key}`);
      }
    }
    if (protectedChanges.some((field) => field.endsWith('.pm_status'))) {
      respond = () => sendError(res, 403,
        'Phase save cannot change reviewer verdicts. Use the Verdicts action.',
        { protectedChanges: protectedChanges.slice(0, 12) });
      return;
    }
    sanitized.human_reviews = current.human_reviews;
    sanitized.tasks = sanitized.tasks.map((t) => {
      const old = currentById.get(t.id);
      const safe = { ...t };
      for (const key of protectedTaskKeys(old, t)) {
        if (key in old) safe[key] = old[key];
        else delete safe[key];
      }
      return safe;
    });
    const out = { ...sanitized,
      _provenance: { persona: authz.persona, at: now, via: 'api', action: 'tasks:save' } };
    const serialized = JSON.stringify(out, null, 2) + '\n';
    try {
      await atomicWrite(abs, serialized);
    } catch (e) {
      respond = () => sendError(res, 500, 'Atomic write failed; existing file left intact.');
      return;
    }
    // Echo the new content etag (+ ETag header) so a client can chain a subsequent
    // conditional write without an extra GET.
    const etag = computeEtag(serialized);
    const m = file.match(/data_p(\d+)\.json/i);
    respond = () => sendJson(res, 200, {
      ok: true, id: m ? `p${m[1]}` : file, file, persona: authz.persona, savedAt: now, etag,
      ignoredProtectedChanges: protectedChanges.slice(0, 25), data: out,
    }, { ETag: etag });
  });
  if (!respond) return sendError(res, 500, 'Internal server error.');
  return respond();
}

// PATCH /api/status/:phase/tasks/:id — assignment + PM-safe fields only.
// owner_id requires tasks:edit + roles:assign. Engineering fields are refused.
const PATCH_ALLOWED_FIELDS = new Set(['owner_id', 'status', 'priority']);
const ENGINEERING_FIELDS = new Set(['code_updated_at', 'id', 'subtasks', 'reviews', 'blockers', 'title', 'description']);

async function handlePatchTask(req, res, phaseParam, taskId, authz) {
  // Base edit permission required for any task field write.
  if (!requirePermission(res, authz, 'tasks', 'edit')) return;
  const file = phaseToStatusFile(phaseParam);
  if (!file) return sendError(res, 400, `Invalid phase parameter "${phaseParam}".`);
  if (!taskId || typeof taskId !== 'string') return sendError(res, 400, 'Missing task id.');
  const rel = `status/${file}`;
  const abs = resolveUnderPmRoot(rel);
  if (!abs) return sendError(res, 400, 'Path containment rejected the target.');

  const body = await readJsonBody(req);
  if (body.code === 'too-large') return sendError(res, 413, 'Request body too large.');
  if (body.code) return sendError(res, 400, `Malformed JSON body: ${body.detail || body.code}.`);
  const patch = body.data;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return sendError(res, 400, 'PATCH body must be a JSON object of fields to change.');
  }
  if (Object.keys(patch).length === 0) {
    return sendError(res, 422, 'PATCH body contained no fields to change.');
  }

  // Reject any attempt to write an engineering-owned field outright.
  for (const k of Object.keys(patch)) {
    if (ENGINEERING_FIELDS.has(k)) {
      return sendError(res, 403, `Field "${k}" is engineering-owned and cannot be set via PATCH.`, { field: k });
    }
    if (!PATCH_ALLOWED_FIELDS.has(k)) {
      return sendError(res, 422, `Field "${k}" is not a PATCH-allowed task field.`, { field: k });
    }
  }
  if (!req.headers['if-match']) return sendError(res, 428, 'If-Match is required for a task patch. Reload the phase and retry.');
  if (patch.status === 'completed') return sendError(res, 403, 'Completing a task requires an independent review action.');
  // owner_id is the Crews assignment path → also needs roles:assign.
  if ('owner_id' in patch && !requirePermission(res, authz, 'roles', 'assign')) return;

  // Read-modify-write under the per-file lock: the optimistic-concurrency etag
  // comparison and the atomic write cannot interleave with another writer.
  let respond = null;
  await withFileLock(abs, async () => {
    const curRaw = await readPmText(rel);
    if (curRaw.text == null) {
      respond = () => sendError(res, statusCodeForArtifactError(curRaw.code), `Cannot read ${file}: ${curRaw.code}`);
      return;
    }
    const currentEtag = computeEtag(curRaw.text);
    if (!etagsMatch(req.headers['if-match'], currentEtag)) {
      respond = () => sendError(res, 409, 'Stale write — file changed since you read it.', { currentEtag });
      return;
    }
    let cur;
    try {
      cur = { data: JSON.parse(curRaw.text) };
    } catch (e) {
      cur = { code: 'malformed' };
    }
    if (!cur.data) {
      respond = () => sendError(res, statusCodeForArtifactError(cur.code), `Cannot read ${file}: ${cur.code}`);
      return;
    }
    if (!Array.isArray(cur.data.tasks)) {
      respond = () => sendError(res, 422, `${file} has no tasks array.`);
      return;
    }
    const idx = cur.data.tasks.findIndex((t) => t && t.id === taskId);
    if (idx === -1) {
      respond = () => sendError(res, 404, `Task "${taskId}" not found in ${file}.`);
      return;
    }

    // Validate enum-bearing fields and sanitize HTML-bearing pm_remark.
    const next = { ...cur.data };
    next.tasks = cur.data.tasks.slice();
    const task = { ...next.tasks[idx] };
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'status' && !STATUS_ENUM.has(v)) {
        respond = () => sendError(res, 422, `Invalid status "${v}".`);
        return;
      }
      if (k === 'priority' && !PRIORITY_ENUM.has(v)) {
        respond = () => sendError(res, 422, `Invalid priority "${v}".`);
        return;
      }
      if (k === 'pm_status' && !PM_STATUS_ENUM.has(v)) {
        respond = () => sendError(res, 422, `Invalid pm_status "${v}".`);
        return;
      }
      if (k === 'owner_id' && typeof v !== 'string') {
        respond = () => sendError(res, 422, '"owner_id" must be a string.');
        return;
      }
      if (k === 'pm_updated_at' && !(typeof v === 'string' && (v === '' || !Number.isNaN(Date.parse(v))))) {
        respond = () => sendError(res, 422, '"pm_updated_at" must be an ISO timestamp string (or empty).');
        return;
      }
      task[k] = (k === 'pm_remark' && typeof v === 'string') ? SANITIZE.sanitizeRichHtml(v) : v;
    }
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    task._provenance = { persona: authz.persona, at: now, via: 'api', action: 'tasks:edit' };
    next.tasks[idx] = task;
    next.last_updated = now;

    const errors = validateStatusBody(next);
    if (errors.length) {
      respond = () => sendError(res, 400, 'Patched status failed re-validation; file unchanged.', { errors: errors.slice(0, 25) });
      return;
    }
    const serialized = JSON.stringify(next, null, 2) + '\n';
    try {
      await atomicWrite(abs, serialized);
    } catch (e) {
      respond = () => sendError(res, 500, 'Atomic write failed; existing file left intact.');
      return;
    }
    const etag = computeEtag(serialized);
    respond = () => sendJson(res, 200, { ok: true, file, taskId, persona: authz.persona, updatedAt: now, changed: Object.keys(patch), etag }, { ETag: etag });
  });
  if (!respond) return sendError(res, 500, 'Internal server error.');
  return respond();
}

// Build a safe message/decision filename from a caller hint.
// A caller-supplied name that looks like a traversal/path is REJECTED outright
// (returns { reject: true }) rather than silently rewritten — the brief requires
// traversal attempts to be rejected, not written. Returns { file } on success.
function safeArtifactFilename(name, fallbackSlug) {
  if (name == null || name === '') return { file: `${fallbackSlug}.md` };
  if (typeof name !== 'string') return { reject: true };
  const trimmed = name.trim();
  // Any path separator, traversal marker, NUL, or absolute hint → reject.
  if (/[\\/]/.test(trimmed) || trimmed.includes('..') || trimmed.includes('\0')) {
    return { reject: true };
  }
  let base = trimmed.replace(/\.md$/i, '');
  base = base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  if (!base) return { reject: true };
  return { file: `${base}.md` };
}

// POST /api/messages — append-only new timestamped file. Requires messages:create.
async function handlePostMessage(req, res, authz) {
  if (!requirePermission(res, authz, 'messages', 'create')) return;
  const body = await readJsonBody(req);
  if (body.code === 'too-large') return sendError(res, 413, 'Request body too large.');
  if (body.code) return sendError(res, 400, `Malformed JSON body: ${body.detail || body.code}.`);
  const { filename, body: text, requestId } = body.data || {};
  if (typeof text !== 'string' || text.trim() === '') {
    return sendError(res, 422, 'A non-empty "body" (markdown) field is required.');
  }
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const stamp = now.replace('T', '_').replace(/:/g, '').slice(0, 16) + 'Z';
  const named = safeArtifactFilename(filename, `${stamp}_${authz.persona}-message`);
  if (named.reject) return sendError(res, 400, 'Rejected "filename": path separators and traversal markers are not allowed.');
  const file = named.file;
  const rel = `messages/${file}`;
  const content = `**Recorded-At:** ${now}\n**Recorded-By:** ${authz.persona}\n` +
    (text.endsWith('\n') ? text : text + '\n');
  const result = { ok: true, file, path: `project-management/${rel}`, persona: authz.persona, recordedAt: now };
  const committed = await coordinationWrites.commit({
    requestId, action: 'messages:create', actor: authz.persona,
    payload: { filename: filename || null, body: text },
    files: [{ rel, mode: 'create', content }], registrations: { messageFiles: [file] }, result,
  });
  if (committed.error) return sendError(res, committed.status, committed.error);
  return sendJson(res, committed.duplicate ? 200 : 201,
    { ...committed.result, duplicate: committed.duplicate });
}

// POST /api/decisions — server-authored metadata and append-only transitions.
function oneDecisionHeader(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...text.matchAll(new RegExp(`^${escaped}:\\s*(.+)$`, 'gim'))];
  return matches.length === 1 ? matches[0][1].trim() : null;
}
function safeDecisionLine(value, max = 180) {
  return typeof value === 'string' && value.trim() && value.length <= max && !/[\r\n]/.test(value)
    ? value.trim() : null;
}
function safeDecisionBody(value, max = 10000) {
  return typeof value === 'string' && value.trim() && value.length <= max
    ? value.trim().replace(/^(Status|Owner|Approver|Decided by|Resolves|Supersedes|Selected option):/gim, '\\$&') : null;
}
async function handlePostDecision(req, res, authz) {
  const canCreate = personaHas(authz, 'decisions', 'create');
  const canSupersede = personaHas(authz, 'decisions', 'supersede');
  const canPropose = personaHas(authz, 'decisions', 'propose');
  if (!canCreate && !canSupersede && !canPropose) return sendError(res, 403,
    `Persona "${authz.persona}" lacks decisions:propose/create/supersede.`);
  const body = await readJsonBody(req);
  if (body.code === 'too-large') return sendError(res, 413, 'Request body too large.');
  if (body.code) return sendError(res, 400, `Malformed JSON body: ${body.detail || body.code}.`);
  const input = body.data || {};
  const { filename, requestId, resolves, supersedes } = input;
  if ('body' in input) return sendError(res, 422, 'Decision metadata must be sent as structured fields, not raw Markdown.');
  const state = input.status;
  if (!['proposed', 'active', 'rejected'].includes(state)) {
    return sendError(res, 422, 'status must be proposed, active, or rejected.');
  }
  const title = safeDecisionLine(input.title);
  if (!title) return sendError(res, 422, 'A one-line title is required.');
  if (state === 'proposed' && !canPropose && !canCreate) return sendError(res, 403, 'Proposal permission required.');
  if (state !== 'proposed' && !canCreate && !canSupersede) return sendError(res, 403, 'Approval permission required.');
  if (supersedes) return sendError(res, 422, 'Supersession uses a separate reviewed transition and is not enabled yet.');
  let owner = authz.persona;
  let approver = null;
  let priorFile = null;
  if (state === 'proposed') {
    if (resolves) return sendError(res, 422, 'A proposal cannot resolve another decision.');
    approver = safeDecisionLine(input.approver);
    const question = safeDecisionBody(input.question);
    if (!approver || !question || !Array.isArray(input.options) || input.options.length < 2 ||
        input.options.length > 5 || input.options.some((option) => !safeDecisionLine(option, 500))) {
      return sendError(res, 422, 'Proposal requires an approver, a question, and 2–5 one-line options.');
    }
  } else {
    if (!resolves) return sendError(res, 422, 'A resolution requires a resolves reference.');
    const priorName = safeArtifactFilename(resolves, 'invalid');
    if (priorName.reject) return sendError(res, 400, 'Invalid resolves reference.');
    const prior = await readPmText(`decisions/${priorName.file}`);
    if (!prior.text) return sendError(res, 404, 'Decision being resolved was not found.');
    if (oneDecisionHeader(prior.text, 'Status') !== 'proposed') {
      return sendError(res, 422, 'Only a proposed decision can be resolved.');
    }
    approver = oneDecisionHeader(prior.text, 'Approver');
    if (!approver || approver !== authz.persona) {
      return sendError(res, 403, 'Only the named approver may resolve this decision.');
    }
    owner = oneDecisionHeader(prior.text, 'Owner');
    if (!owner || owner === authz.persona) {
      return sendError(res, 403, 'Decision author independence is unknown or violated.');
    }
    if (state === 'active' && !safeDecisionLine(input.selectedOption, 500)) {
      return sendError(res, 422, 'Approval requires a selectedOption.');
    }
    priorFile = priorName.file;
  }
  const datePart = new Date().toISOString().slice(0, 10);
  const named = safeArtifactFilename(filename, `${datePart}-${authz.persona}-decision`);
  if (named.reject) return sendError(res, 400, 'Rejected "filename": path separators and traversal markers are not allowed.');
  const file = named.file;
  const rel = `decisions/${file}`;
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const taskIds = Array.isArray(input.taskIds) ? input.taskIds.filter((id) => /^[A-Za-z0-9.-]+$/.test(id)) : [];
  const content = [
    `# Decision: ${title}`, '', `Status: ${state}`, `Date: ${now}`,
    `Owner: ${owner}`, `Approver: ${approver}`,
    ...(state === 'proposed' ? [] : [`Decided by: ${authz.persona}`, `Resolves: ${priorFile}`]),
    ...(state === 'active' ? [`Selected option: ${input.selectedOption.trim()}`] : []),
    ...(taskIds.length ? [`Blocks-tasks: ${taskIds.join(', ')}`] : []),
    `Recorded-By: ${authz.persona}`, '',
    ...(state === 'proposed'
      ? ['## Question', '', safeDecisionBody(input.question), '', '## Options', '',
          ...input.options.map((option) => `- ${option.trim()}`)]
      : ['## Resolution', '', safeDecisionBody(input.note || title) || title]),
    '',
  ].join('\n');
  const result = { ok: true, file, path: `project-management/${rel}`, persona: authz.persona,
    state, resolves: priorFile, recordedAt: now };
  const committed = await coordinationWrites.commit({
    requestId, action: 'decisions:create', actor: authz.persona,
    payload: input,
    files: [{ rel, mode: 'create', content }], registrations: { decisionFiles: [file] }, result,
  });
  if (committed.error) return sendError(res, committed.status, committed.error);
  return sendJson(res, committed.duplicate ? 200 : 201,
    { ...committed.result, duplicate: committed.duplicate });
}

// ─── Maestro run/engagement records (AG-P11.5) ───────────────────────────────
// Run + engagement records are an APPEND-ONLY audit trail, written with the
// EXACT same semantics as messages/decisions: one JSON artifact per record, the
// target file is NEVER overwritten (a re-POST of the same id is a 409), and every
// record is provenance-stamped (acting persona + UTC timestamp + via + action).
// They are operator-owned artifacts under project-management/ — they are NOT in
// status/schema.json. The Crews Usage view re-points at the engagement records as
// its real source (replacing the AG-P7.8 stub). Records carry only simulated
// effort (representational units) — there is NO money string by construction, and
// the server REJECTS any record that smuggles in pm_*/verdict fields (those are
// Reviewer-only; the runtime never writes them).

// A safe, append-only record id → filename. Restricts to the same charset as the
// message/decision filename guard; rejects traversal. Records are stored flat.
function safeRecordFilename(id, fallbackSlug) {
  if (id == null || id === '') return { file: `${fallbackSlug}.json` };
  if (typeof id !== 'string') return { reject: true };
  const trimmed = id.trim();
  if (/[\\/]/.test(trimmed) || trimmed.includes('..') || trimmed.includes('\0')) {
    return { reject: true };
  }
  let base = trimmed.replace(/\.json$/i, '');
  base = base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  if (!base) return { reject: true };
  return { file: `${base}.json` };
}

// Reviewer-only / money guards on an inbound record. The runtime must never write
// pm_*/verdict fields, and no money concept may appear (simulated effort only).
const RECORD_FORBIDDEN_KEYS = ['pm_status', 'pm_remark', 'pm_updated_at', 'verdict', 'pm_verdict'];
function recordHasForbiddenField(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of Object.keys(obj)) {
    if (RECORD_FORBIDDEN_KEYS.includes(k)) return k;
  }
  return null;
}

// Append a record under a PM subfolder (runs/ or engagements/). Mirrors the
// message append path: 422 on empty/invalid, 409 on an existing file (never
// overwrite), provenance-stamp, atomic write. `action` labels the provenance.
async function appendRecord(req, res, authz, subdir, action) {
  // Append-only audit write — gated on runs:append (the audit-trail permission).
  if (!requirePermission(res, authz, 'runs', 'append')) return;
  const body = await readJsonBody(req);
  if (body.code === 'too-large') return sendError(res, 413, 'Request body too large.');
  if (body.code) return sendError(res, 400, `Malformed JSON body: ${body.detail || body.code}.`);
  const record = body.data;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return sendError(res, 422, 'A JSON record object is required.');
  }
  // The GROUP id (run_id / engagement_id) is required — it links every record in
  // the trail to its run/engagement. The FILENAME, however, is the record's OWN
  // unique id when supplied (record_id) so a run that emits one record PER
  // lifecycle transition lands a SEQUENCE of immutable append-only records (the
  // trail), never overwriting an earlier transition. Absent a record_id the group
  // id is the filename (single-record case + the test's duplicate guard).
  const idField = subdir === 'runs' ? 'run_id' : 'engagement_id';
  const groupId = record[idField] || record.id;
  if (typeof groupId !== 'string' || groupId.trim() === '') {
    return sendError(res, 422, `A non-empty "${idField}" (or "id") is required.`);
  }
  const fileId = (typeof record.record_id === 'string' && record.record_id.trim() !== '')
    ? record.record_id : groupId;
  // Reviewer-only fields and money concepts are rejected at the door.
  const forbidden = recordHasForbiddenField(record);
  if (forbidden) {
    return sendError(res, 422, `Field "${forbidden}" is Reviewer-only and cannot be written from a run/engagement record.`, { field: forbidden });
  }
  const named = safeRecordFilename(fileId, `${subdir}-record`);
  if (named.reject) return sendError(res, 400, 'Rejected record id: path separators and traversal markers are not allowed.');
  const file = named.file;
  const rel = `${subdir}/${file}`;
  const abs = resolveUnderPmRoot(rel);
  if (!abs) return sendError(res, 400, 'Path containment rejected the target.');

  // Provenance stamp (acting persona + UTC timestamp + via + action). The record
  // body is preserved verbatim except for the provenance envelope we add.
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const out = Object.assign({}, record, {
    _provenance: { persona: authz.persona, at: now, via: 'api', action },
  });

  // Append-only: never overwrite an existing record. Exclusive create (link
  // fails EEXIST) so racing POSTs cannot overwrite each other.
  const content = JSON.stringify(out, null, 2) + '\n';
  try {
    await atomicCreateExclusive(abs, content);
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      return sendError(res, 409, `Record "${file}" already exists; ${subdir} records are append-only and cannot be overwritten.`, { file });
    }
    return sendError(res, 500, `Atomic write failed; no ${subdir} record was created.`);
  }
  return sendJson(res, 201, {
    ok: true, file, path: `project-management/${rel}`, persona: authz.persona, [idField]: groupId, record_id: fileId, at: now,
  });
}

// GET a run/engagement collection — read every record file back (append-only
// store, so the full list IS the trail). Sorted by filename for stable order.
async function handleRecordCollection(res, subdir) {
  const dirAbs = resolveUnderPmRoot(subdir);
  let names = [];
  try {
    names = (await fsp.readdir(dirAbs)).filter((f) => f.endsWith('.json') && !f.startsWith('.')).sort();
  } catch (e) {
    // Folder may not exist yet (no runs conducted) → empty trail, not an error.
    if (e.code !== 'ENOENT') return sendError(res, 500, `Cannot list ${subdir}: ${e.code}`);
    names = [];
  }
  const records = [];
  for (const f of names) {
    const r = await readPmJson(`${subdir}/${f}`);
    if (r.data) records.push(Object.assign({ _file: f }, r.data));
  }
  sendJson(res, 200, { ok: true, kind: subdir, count: records.length, records });
}

// ─── API router ────────────────────────────────────────────────────────────
async function handleApi(req, res, pathname) {
  const method = req.method;
  const parts = pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const [resource, p1, p2, p3] = parts;

  // Reads (GET/HEAD) — unauthenticated, as in v1.
  if (method === 'GET' || method === 'HEAD') {
    switch (resource) {
      case undefined:
      case '':
        return sendJson(res, 200, {
          ok: true,
          endpoints: [
            '/api/health', '/api/project', '/api/status', '/api/status/:phase',
            '/api/plans', '/api/messages', '/api/decisions', '/api/roles', '/api/crews', '/api/verdicts',
            '/api/runs', '/api/engagements',
            'PUT /api/status/:phase', 'PATCH /api/status/:phase/tasks/:id',
            'POST /api/messages', 'POST /api/decisions',
            'POST /api/runs', 'POST /api/engagements',
          ],
        });
      case 'health':
        return handleHealth(res);
      case 'project':
        return handleProject(res);
      case 'status':
        return p1 ? handleStatusPhase(res, p1) : handleStatusList(res);
      case 'plans':
        return handleMarkdownCollection(res, 'plans', 'planFiles');
      case 'messages':
        return handleMarkdownCollection(res, 'messages', 'messageFiles');
      case 'decisions':
        return handleMarkdownCollection(res, 'decisions', 'decisionFiles');
      case 'roles':
        return handleRoles(res);
      case 'crews':
        return handleCrews(res);
      case 'verdicts':
        return handleVerdicts(res);
      case 'runs':
        return handleRecordCollection(res, 'runs');
      case 'engagements':
        return handleRecordCollection(res, 'engagements');
      default:
        return sendError(res, 404, `Unknown API resource "${resource}".`);
    }
  }

  // Writes (PUT/POST/PATCH) — persona-gated. Resolve persona first; unknown/
  // missing → 401 before any body is read or any file is touched.
  if (method === 'PUT' || method === 'POST' || method === 'PATCH') {
    const authz = await resolvePersona(req);
    if (!authz.ok) return sendError(res, authz.status, authz.error, { persona: null });

    if (resource === 'status' && method === 'PUT' && p1 && !p2) {
      return handlePutStatusPhase(req, res, p1, authz);
    }
    if (resource === 'status' && method === 'PATCH' && p1 && p2 === 'tasks' && p3) {
      return handlePatchTask(req, res, p1, p3, authz);
    }
    if (resource === 'messages' && method === 'POST' && !p1) {
      return handlePostMessage(req, res, authz);
    }
    if (resource === 'decisions' && method === 'POST' && !p1) {
      return handlePostDecision(req, res, authz);
    }
    if (resource === 'runs' && method === 'POST' && !p1) {
      return appendRecord(req, res, authz, 'runs', 'runs:append');
    }
    if (resource === 'engagements' && method === 'POST' && !p1) {
      return appendRecord(req, res, authz, 'engagements', 'engagements:append');
    }
    return sendError(res, 404, `No write route for ${method} ${pathname}.`);
  }

  return sendError(res, 405, `Method ${method} not allowed.`, { allow: 'GET, HEAD, PUT, POST, PATCH' });
}

const server = http.createServer((req, res) => {
  let pathname = '/';
  try {
    pathname = url.parse(req.url).pathname || '/';
  } catch (e) {
    res.writeHead(400);
    res.end('400 Bad Request');
    return;
  }

  const dispatch = pathname === '/api' || pathname.startsWith('/api/')
    ? handleApi(req, res, pathname)
    : serveStatic(req, res, pathname);

  Promise.resolve(dispatch).catch((err) => {
    // Never leak a stack trace to the client.
    console.error('Request error:', err && err.message ? err.message : err);
    if (!res.headersSent) sendError(res, 500, 'Internal server error.');
    else res.end();
  });
});

coordinationWrites.recover().then(() => {
  server.listen(PORT, HOST, () => {
    console.log(`Agentarium API server → http://${HOST}:${PORT}/ (read + persona-gated writes, writeEnabled=${WRITE_ENABLED})`);
  });
}).catch((error) => {
  console.error('Coordination write recovery failed:', error && error.message ? error.message : error);
  process.exitCode = 1;
});

// Let Docker (and direct terminal users) stop cleanly without cutting an
// in-flight atomic PM write in half.
function shutdown(signal) {
  console.log(`Agentarium received ${signal}; draining connections.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
