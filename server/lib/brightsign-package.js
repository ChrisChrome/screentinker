'use strict';

/*
 * Builds and serves the BrightSign player package (autorun.zip) for self-update.
 *
 * THE INVARIANT THIS FILE EXISTS TO HOLD: the checksum in the manifest and the bytes on the
 * download route come from the SAME in-memory buffer, built once. Advertising a version whose
 * checksum does not match the bytes actually served is the classic OTA-loop condition — the player
 * downloads, fails verification, retries, forever — and it is the easiest mistake to make when the
 * manifest is computed from one source and the file from another (a file on disk that a deploy
 * replaced, say). Here it is impossible by construction: there is one buffer and both routes read
 * it.
 *
 * The zip is built deterministically from brightsign/, not read from a prebuilt artifact, because a
 * prebuilt autorun.zip is a CI output that is not present in a git-checkout deployment. Building it
 * means the manifest is always available and always describes files that actually exist.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');

// The payload, mirroring scripts/build-autorun-zip.sh. autozip.brs must be present or nothing
// unpacks the archive on the player; autorun.brs must be INSIDE it and never beside it on the
// storage root, or the player refuses to process the zip at all.
const PACKAGE_FILES = ['autozip.brs', 'autorun.brs', 'offline.html', 'screentinker.json'];

// sha256 rather than sha1 because that is the algorithm BrightScript's roMessageDigest is
// documented against — the player has to be able to verify what we advertise, and an algorithm it
// cannot compute is an unverifiable package, which this whole design exists to refuse.
let cached = null;   // { version, sha256, size, buffer }

function brightsignDir() {
  return path.join(__dirname, '..', '..', 'brightsign');
}

function readVersion() {
  try {
    return fs.readFileSync(path.join(__dirname, '..', '..', 'VERSION'), 'utf8').trim();
  } catch (e) {
    return null;
  }
}

/*
 * Rewrite the stamped version line in autorun.brs.
 *
 * Anchored on the ST_PACKAGE_VERSION marker rather than on the literal, so a hand-edited default
 * cannot cause a silent miss. If the marker is ever removed the stamp is skipped and the package
 * ships reporting "0.0.0-dev", which reads as permanently out of date — noisy, but noisy in the
 * direction of "someone look at this" rather than a silent update loop.
 */
function stampVersion(source, version) {
  return source.replace(
    /return "[^"]*"(\s*'\s*ST_PACKAGE_VERSION)/,
    `return "${version}"$1`
  );
}

/*
 * Build the archive in memory. Entries are added in a fixed order with a fixed timestamp so the
 * bytes are reproducible: a checksum that changed on every server restart would make every player
 * re-download the same package after every deploy.
 */
function buildZip() {
  return new Promise((resolve, reject) => {
    const dir = brightsignDir();
    const chunks = [];
    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.on('data', (c) => chunks.push(c));
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));

    const version = readVersion();
    for (const name of PACKAGE_FILES) {
      const p = path.join(dir, name);
      if (!fs.existsSync(p)) return reject(new Error(`package file missing: ${name}`));
      let body = fs.readFileSync(p);
      // Stamp the version into the host so the script REPORTS the version it actually is. Ship it
      // unstamped and the player applies the update, still reports the old version, and is offered
      // the same package forever — the OTA loop, arriving by the back door.
      if (name === 'autorun.brs') body = Buffer.from(stampVersion(body.toString('utf8'), version), 'utf8');
      // date fixed for reproducibility; the player never reads it.
      archive.append(body, { name, date: new Date(0) });
    }
    archive.finalize();
  });
}

/*
 * Get the package, building once and caching. Returns null when the package cannot be built (a
 * deployment without the brightsign/ directory, for instance) — callers must treat that as "no
 * manifest", which the update decision reads as "keep running", never as "wipe yourself".
 */
async function getPackage() {
  if (cached) return cached;
  const version = readVersion();
  if (!version) return null;
  try {
    const buffer = await buildZip();
    cached = {
      version,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      size: buffer.length,
      buffer
    };
    return cached;
  } catch (e) {
    return null;
  }
}

/* Test seam: drop the cache so a changed file is picked up without a restart. */
function _reset() { cached = null; }

module.exports = { getPackage, _reset, PACKAGE_FILES };
