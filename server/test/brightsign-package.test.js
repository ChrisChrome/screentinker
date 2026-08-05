'use strict';

// The manifest and the download must describe the SAME bytes.
//
// Advertising a version whose checksum does not match the file actually served is the classic
// OTA-loop condition: the player downloads, fails verification, retries, forever. It is also the
// easiest mistake to make, because the natural implementation computes the manifest from one source
// (a VERSION file, a build record) and serves the file from another (a path on disk that some
// deploy replaced). These tests pin the invariant that makes that impossible here: one buffer,
// hashed once, read by both routes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const pkgLib = require('../lib/brightsign-package');

test('THE OTA LOOP: the advertised checksum is the hash of the bytes that are served', async () => {
  const pkg = await pkgLib.getPackage();
  assert.ok(pkg, 'package should build from brightsign/');
  // sha256 because that is what BrightScript's roMessageDigest can compute — a checksum the player
  // cannot verify is an unverifiable package.
  const actual = crypto.createHash('sha256').update(pkg.buffer).digest('hex');
  assert.equal(pkg.sha256, actual, 'a mismatch here loops every player in the fleet');
  assert.equal(pkg.size, pkg.buffer.length);
});

test('the package is byte-identical on rebuild — otherwise every deploy re-flashes the fleet', async () => {
  // Zip entries carry timestamps. Left at "now" the archive changes on every server restart, the
  // checksum changes with it, and every player decides it has an update waiting.
  const first = await pkgLib.getPackage();
  pkgLib._reset();
  const second = await pkgLib.getPackage();
  assert.equal(second.sha1, first.sha1);
});

test('the archive contains exactly the payload, at its ROOT with no wrapper directory', async () => {
  // A player extracts to the storage root. A wrapper folder puts autorun.brs where the player never
  // looks and the card silently does nothing — the failure mode is "blank screen", not an error.
  const pkg = await pkgLib.getPackage();
  const names = [];
  // Minimal central-directory walk: entry names follow the 0x02014b50 signature at offset +46.
  const buf = pkg.buffer;
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf.readUInt32LE(i) === 0x02014b50) {
      const nameLen = buf.readUInt16LE(i + 28);
      names.push(buf.slice(i + 46, i + 46 + nameLen).toString('utf8'));
    }
  }
  assert.deepEqual(names.sort(), pkgLib.PACKAGE_FILES.slice().sort());
  for (const n of names) {
    assert.ok(!n.includes('/'), `${n} must be at the archive root, not nested`);
  }
});

test('autorun.brs and autozip.brs are both present — either missing is a dead panel', async () => {
  // autorun.brs missing: nothing to run after extraction.
  // autozip.brs missing: nothing extracts the archive in the first place.
  assert.ok(pkgLib.PACKAGE_FILES.includes('autorun.brs'));
  assert.ok(pkgLib.PACKAGE_FILES.includes('autozip.brs'));
});

test('THE BACK-DOOR LOOP: the shipped autorun.brs reports the version the manifest advertises', async () => {
  // Ship it unstamped and the player applies the update, still reports the old version, and is
  // offered the same package on every check — forever. The loop arrives even though the checksum
  // was correct and the download was clean.
  const unzipper = require('unzipper');
  const pkg = await pkgLib.getPackage();
  const dir = await unzipper.Open.buffer(pkg.buffer);
  const entry = dir.files.find((f) => f.path === 'autorun.brs');
  assert.ok(entry, 'autorun.brs must be in the package');
  const text = (await entry.buffer()).toString('utf8');
  const m = text.match(/return "([^"]*)"\s*' ST_PACKAGE_VERSION/);
  assert.ok(m, 'the ST_PACKAGE_VERSION marker must survive — it is what the stamp anchors on');
  assert.equal(m[1], pkg.version, 'stamped version must equal the advertised version');
});

test('the version comes from VERSION, so the manifest matches the release it shipped with', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const expected = fs.readFileSync(path.join(__dirname, '..', '..', 'VERSION'), 'utf8').trim();
  const pkg = await pkgLib.getPackage();
  assert.equal(pkg.version, expected);
});

// A BrightSign consultant's automated deployment copied our first autorun.zip onto a player and
// then reported it invalid. Two causes: the archive was DEFLATED, and we opened it with roUnzip
// rather than roBrightPackage. The player bootstrap extracts autozip.brs by itself before any
// script runs, and roBrightPackage supports a specific set of methods — "no compression" is the
// universally safe one.
//
// This is the failure mode that hurts: a compressed package uploads, downloads and deploys
// perfectly, then fails to open on the player. It reads as a broken deployment, not a broken zip,
// so it gets debugged everywhere except where the bug is.
test('THE DEPLOYMENT BUG: every member of the package is STORED, never deflated', async () => {
  const pkg = await pkgLib.getPackage();
  const buf = Buffer.isBuffer(pkg) ? pkg : (pkg && (pkg.buffer || pkg.bytes || pkg.zip));
  assert.ok(Buffer.isBuffer(buf), 'getPackage must yield the archive bytes');

  // Walk the local file headers: signature PK\x03\x04, compression method at offset +8.
  let found = 0;
  for (let i = 0; i + 30 <= buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x04034b50) continue;
    const method = buf.readUInt16LE(i + 8);
    const nameLen = buf.readUInt16LE(i + 26);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString();
    assert.equal(method, 0, `${name} is compressed (method ${method}); the player cannot open it`);
    found++;
  }
  assert.ok(found > 0, 'no entries found — the walk itself is wrong, not the archive');
});
