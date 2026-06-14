'use strict';

// #73 FULL bite-suite for the agency-token primitive, end-to-end against a booted server:
// the happy path (upload -> date-bounded item on a DESIGNATED playlist) plus the four
// confinement assertions at their three seams (gate / off-ladder / JWT-only / issuance).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const PORT = 3992;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), 'st-agency-' + crypto.randomBytes(4).toString('hex'));
let proc;

before(async () => {
  const logFd = fs.openSync(path.join(os.tmpdir(), 'st-agency.log'), 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) break; } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } });

async function jfetch(p, opts = {}) {
  const res = await fetch(BASE + p, opts);
  let body = null; try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}
const jpost = (tok, o) => ({ method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}) });
const reg = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });

test('#73 agency token: full bite-suite (happy path + 4 confinement assertions)', async () => {
  const email = 'ag' + crypto.randomBytes(4).toString('hex') + '@x.local';
  const jwt = (await jfetch('/api/auth/register', reg({ email, password: 'Passw0rd123' }))).body.token;
  const pl1 = (await jfetch('/api/playlists', jpost(jwt, { name: 'Designated' }))).body;
  const pl2 = (await jfetch('/api/playlists', jpost(jwt, { name: 'Off-limits' }))).body;

  // issue an agency token bound to pl1 ONLY
  const tokRes = await jfetch('/api/tokens', jpost(jwt, { name: 'Agency', scope: 'agency', target_playlist_ids: [pl1.id] }));
  assert.equal(tokRes.status, 201, 'agency token created');
  assert.deepEqual(tokRes.body.target_playlist_ids, [pl1.id]);
  const atok = tokRes.body.token;

  // HAPPY PATH: upload via the agency token (shared ingest -> first-class content)
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('x')], { type: 'image/png' }), 't.png');
  const up = await fetch(BASE + '/api/agency/content', { method: 'POST', headers: { Authorization: 'Bearer ' + atok }, body: fd });
  assert.equal(up.status, 201, 'agency upload -> 201 (first-class content)');
  const content = await up.json();

  // date-bounded item on the DESIGNATED playlist
  const item = await jfetch(`/api/agency/playlists/${pl1.id}/items`, jpost(atok, { content_id: content.id, start_date: '2026-07-01', end_date: '2026-07-31' }));
  assert.equal(item.status, 201, 'item on designated playlist -> 201');

  // BITE 1 (gate): NON-designated playlist -> 403
  const blocked = await jfetch(`/api/agency/playlists/${pl2.id}/items`, jpost(atok, { content_id: content.id }));
  assert.equal(blocked.status, 403, 'non-designated playlist -> 403');

  // BITE 2 (off-ladder): agency token on a normal public router -> 403
  const dev = await jfetch('/api/devices', { headers: { Authorization: 'Bearer ' + atok } });
  assert.equal(dev.status, 403, 'agency token on /api/devices -> 403 (off-ladder, tokenScopeGate)');

  // BITE 3 (JWT-only): can't reach /api/tokens to widen its OWN targets -> 401
  const widen = await jfetch(`/api/tokens/${tokRes.body.id}/targets`, jpost(atok, { target_playlist_ids: [pl1.id, pl2.id] }));
  assert.equal(widen.status, 401, 'agency token cannot reach /api/tokens (JWT-only) -> 401');

  // BITE 4 (issuance): an agency token can't be BOUND to an out-of-workspace/unknown playlist -> 400
  const badTok = await jfetch('/api/tokens', jpost(jwt, { name: 'Bad', scope: 'agency', target_playlist_ids: ['nonexistent'] }));
  assert.equal(badTok.status, 400, 'cannot bind an out-of-workspace target at issuance');
});
