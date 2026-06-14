'use strict';

// #73 zone-grant security model. Proves the structural narrow guarantee BEFORE any UI rides
// on it: zone grants confine placement, are FK-anchored to the playlist grant (orphan-
// impossible), and cascade away with it. The whole thing depends on PRAGMA foreign_keys=ON,
// so this test asserts that too (a cascade that silently no-ops because FKs are off is the trap).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { resolveGrantedZone, grantableZoneIds } = require('../lib/agency-targets');

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON'); // mirrors db/database.js:13
  db.exec(`
    CREATE TABLE api_tokens (id TEXT PRIMARY KEY);
    CREATE TABLE playlists (id TEXT PRIMARY KEY, workspace_id TEXT);
    CREATE TABLE layouts (id TEXT PRIMARY KEY);
    CREATE TABLE layout_zones (id TEXT PRIMARY KEY, layout_id TEXT REFERENCES layouts(id) ON DELETE CASCADE);
    CREATE TABLE api_token_targets (
      token_id TEXT NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
      playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      PRIMARY KEY (token_id, playlist_id));
    CREATE TABLE api_token_target_zones (
      token_id TEXT NOT NULL, playlist_id TEXT NOT NULL,
      zone_id TEXT NOT NULL REFERENCES layout_zones(id) ON DELETE CASCADE,
      created_at INTEGER,
      PRIMARY KEY (token_id, playlist_id, zone_id),
      FOREIGN KEY (token_id, playlist_id) REFERENCES api_token_targets(token_id, playlist_id) ON DELETE CASCADE);
    INSERT INTO api_tokens VALUES ('tok1');
    INSERT INTO playlists VALUES ('plA','wsA'), ('plB','wsA');
    INSERT INTO layouts VALUES ('L1'), ('L2');
    INSERT INTO layout_zones VALUES ('zA1','L1'), ('zA2','L1'), ('zB1','L2');
    CREATE TABLE playlist_items (id INTEGER PRIMARY KEY, playlist_id TEXT, zone_id TEXT);
    INSERT INTO playlist_items VALUES (1,'plA','zA1'), (2,'plB','zB1'); -- plA feeds L1, plB feeds L2
    INSERT INTO api_token_targets VALUES ('tok1','plA'), ('tok1','plB');
    INSERT INTO api_token_target_zones VALUES ('tok1','plA','zA1', 0); -- plA narrowed to zA1; plB has none
  `);
  return db;
}

test('#73 foreign_keys is ON (the cascade/FK guarantees are real, not silent no-ops)', () => {
  assert.equal(freshDb().pragma('foreign_keys', { simple: true }), 1);
});

test('#73 zone confinement: granted YES, non-granted/cross-playlist/ambiguous all blocked', () => {
  const db = freshDb();
  // granted zone within a designated playlist -> YES
  assert.deepEqual(resolveGrantedZone(db, 'tok1', 'plA', 'zA1'), { ok: true, zoneId: 'zA1' });
  // NON-granted zone within the SAME designated playlist -> blocked (the refinement bites)
  assert.equal(resolveGrantedZone(db, 'tok1', 'plA', 'zA2').ok, false);
  // a zone from a DIFFERENT playlist's layout -> blocked (no cross-playlist)
  assert.equal(resolveGrantedZone(db, 'tok1', 'plA', 'zB1').ok, false);
  // no requested zone, exactly one grant -> auto-place into it
  assert.deepEqual(resolveGrantedZone(db, 'tok1', 'plA', null), { ok: true, zoneId: 'zA1' });
  // playlist with NO zone grants -> whole-playlist (full-screen); a body zone is IGNORED
  assert.deepEqual(resolveGrantedZone(db, 'tok1', 'plB', null), { ok: true, zoneId: null });
  assert.deepEqual(resolveGrantedZone(db, 'tok1', 'plB', 'zB1'), { ok: true, zoneId: null });
  // multiple grants, no pick -> must specify
  db.prepare("INSERT INTO api_token_target_zones VALUES ('tok1','plA','zA2',0)").run();
  assert.equal(resolveGrantedZone(db, 'tok1', 'plA', null).reason, 'ambiguous');
  assert.deepEqual(resolveGrantedZone(db, 'tok1', 'plA', 'zA2'), { ok: true, zoneId: 'zA2' }); // picks among grants
});

test('#73 orphan-grant is IMPOSSIBLE: a zone grant cannot exist without its playlist grant', () => {
  const db = freshDb();
  // (tok1, plC) is NOT in api_token_targets -> the composite FK must reject the zone grant
  assert.throws(
    () => db.prepare("INSERT INTO api_token_target_zones VALUES ('tok1','plC','zA1',0)").run(),
    /FOREIGN KEY/i,
    'inserting a zone grant without its playlist grant must be rejected by the FK');
});

test('#73 cascade: revoking the playlist grant removes its zone grants (structural, not manual)', () => {
  const db = freshDb();
  db.prepare("DELETE FROM api_token_targets WHERE token_id='tok1' AND playlist_id='plA'").run();
  assert.equal(db.prepare("SELECT COUNT(*) c FROM api_token_target_zones WHERE playlist_id='plA'").get().c, 0,
    'zone grants cascade out when the parent playlist grant is deleted');
});

test('#73 cascade chain: deleting a playlist removes BOTH the playlist grant and the zone grants', () => {
  const db = freshDb();
  db.prepare("DELETE FROM playlists WHERE id='plA'").run();
  assert.equal(db.prepare("SELECT COUNT(*) c FROM api_token_targets WHERE playlist_id='plA'").get().c, 0, 'playlist grant gone');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM api_token_target_zones WHERE playlist_id='plA'").get().c, 0, 'zone grants gone (no orphans)');
});

test('#73 cascade: deleting a zone (or its layout) drops the grant referencing it', () => {
  const db = freshDb();
  db.prepare("DELETE FROM layouts WHERE id='L1'").run(); // -> layout_zones zA1/zA2 cascade -> zone grants cascade
  assert.equal(db.prepare("SELECT COUNT(*) c FROM api_token_target_zones WHERE zone_id='zA1'").get().c, 0);
});

test('#73 ISSUANCE validation: can only grant a zone the playlist\'s layout feeds', () => {
  const db = freshDb();
  // plA feeds L1, so its layout's zones (zA1, zA2) are grantable - and nothing else
  assert.deepEqual([...grantableZoneIds(db, 'plA')].sort(), ['zA1', 'zA2']);
  // zB1 belongs to L2 (plB's layout) - NOT grantable for plA (no cross-playlist-layout grant)
  assert.equal(grantableZoneIds(db, 'plA').has('zB1'), false);
  assert.deepEqual([...grantableZoneIds(db, 'plB')], ['zB1']);
});
