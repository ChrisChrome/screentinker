'use strict';

// #73 THE SEAM: agencyGate is the single place capability+target restriction is enforced.
// Prove it confines before any endpoint is built behind it. Removing the api_token_targets
// condition in agencyGate makes "non-designated -> 403" go red (the bite).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const mem = new Database(':memory:');
mem.exec(`
  CREATE TABLE api_token_targets (token_id TEXT, playlist_id TEXT, PRIMARY KEY(token_id, playlist_id));
  CREATE TABLE playlists (id TEXT PRIMARY KEY, workspace_id TEXT);
  INSERT INTO playlists (id, workspace_id) VALUES ('plA','wsA'), ('plB','wsA'), ('plC','wsB');
  INSERT INTO api_token_targets (token_id, playlist_id) VALUES ('tok1','plA'), ('tok1','plC');
`); // tok1 is allowlisted for plA (wsA, its bound ws) and plC (wsB, a DIFFERENT ws)
require.cache[require.resolve('../db/database')] = {
  id: require.resolve('../db/database'), loaded: true, exports: { db: mem },
};
const { agencyGate } = require('../middleware/apiToken');

function gate(over = {}) {
  const req = { viaToken: true, tokenScope: 'agency', apiToken: { id: 'tok1' }, jwtWorkspaceId: 'wsA', params: {}, body: {}, ...over };
  let status = 200, nexted = false;
  const res = { status(s) { status = s; return this; }, json() { return this; } };
  agencyGate(req, res, () => { nexted = true; });
  return { status, nexted };
}

test('#73 agencyGate: only agency tokens, only allowlisted playlists, only the bound workspace', () => {
  assert.equal(gate({ params: { playlistId: 'plA' } }).nexted, true, 'designated playlist in bound ws -> passes');
  assert.equal(gate({ params: { playlistId: 'plB' } }).status, 403, 'NON-designated playlist -> 403 (target restriction)');
  assert.equal(gate({ params: { playlistId: 'plC' } }).status, 403, 'designated but CROSS-workspace -> 403');
  assert.equal(gate({ tokenScope: 'write', params: { playlistId: 'plA' } }).status, 403, 'non-agency token -> 403');
  assert.equal(gate({ viaToken: false, params: { playlistId: 'plA' } }).status, 403, 'JWT -> 403');
  // body.playlist_id is honored too (create-item path), so the seam covers both routes
  assert.equal(gate({ body: { playlist_id: 'plB' } }).status, 403, 'non-designated via body -> 403');
});
