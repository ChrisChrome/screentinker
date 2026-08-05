'use strict';

// Tizen was the one player that cached nothing but the playlist: a panel came back from a reboot
// knowing exactly what to show and fetched every frame of it from a server that was not there.
// tizen/js/media-cache.js fixes that, and none of it can be exercised on hardware without a TV — so
// the decisions are all in injected-backend form and driven here against a fake one.
//
// The backend (resolve wgt-private, append to a stream, turn a file into a URI) is the only part
// that needs a device, and it is the part with no logic in it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MediaCache = require(path.join(__dirname, '..', '..', 'tizen', 'js', 'media-cache.js'));
const CHUNK = MediaCache.CHUNK_BYTES;

/**
 * A fake TV. `failEvery` drops every Nth request — a marginal link, which is the condition the
 * whole resumable design exists for.
 */
function fakeBackend(asset, opts = {}) {
  const b = {
    asset,                      // { bytes: number[], etag, total }
    files: new Map(),           // name -> number[]
    index: {},
    requests: 0,
    failEvery: opts.failEvery || 0,
    rangeSupport: opts.rangeSupport !== false,
    available: () => true,
    loadIndex: () => b.index,
    saveIndex: (i) => { b.index = JSON.parse(JSON.stringify(i)); },
    httpRange(url, start, end, validator) {
      b.requests++;
      if (b.failEvery && b.requests % b.failEvery === 0) throw new Error('link dropped');
      const body = b.asset.bytes;
      if (!b.rangeSupport) {
        return { status: 200, start: 0, total: body.length, validator: b.asset.etag, body: body.slice() };
      }
      // If-Range with a stale validator: the server sends the WHOLE asset, which is the signal to
      // start over rather than append a tail from a different file.
      if (validator && validator !== b.asset.etag) {
        return { status: 200, start: 0, total: body.length, validator: b.asset.etag, body: body.slice() };
      }
      if (start >= body.length) return { status: 416, start, total: body.length, validator: b.asset.etag, body: null };
      const stop = Math.min(end, body.length - 1);
      return {
        status: 206, start, total: body.length, validator: b.asset.etag,
        body: body.slice(start, stop + 1)
      };
    },
    appendPart(contentId, body, offset) {
      const name = contentId + '.part';
      const cur = b.files.get(name) || [];
      if (offset === 0) b.files.set(name, body.slice());
      else {
        if (cur.length !== offset) return 0;   // a real append cannot write into a hole
        b.files.set(name, cur.concat(body));
      }
      return body.length;
    },
    promotePart(contentId) {
      const part = b.files.get(contentId + '.part');
      if (!part) return null;
      b.files.set(contentId, part);
      b.files.delete(contentId + '.part');
      return { path: '/wgt-private/' + contentId, uri: 'file:///wgt-private/' + contentId };
    },
    remove(contentId) { b.files.delete(contentId); b.files.delete(contentId + '.part'); }
  };
  return b;
}

const asset = (n, fill, etag = '"v1"') => ({ bytes: new Array(n).fill(fill), etag });
const urlFor = (it) => 'http://s/api/content/' + it.content_id + '/file?rev=' + it.content_rev;

test('THE GAP: media is cached at all, and resolves to a local file the player can open', async () => {
  const b = fakeBackend(asset(CHUNK, 7));
  const mc = new MediaCache(b);

  assert.equal(mc.localUrl('c1', 5), null, 'nothing cached yet');
  await mc.sync([{ content_id: 'c1', content_rev: 5 }], urlFor);
  assert.equal(mc.localUrl('c1', 5), 'file:///wgt-private/c1');
  assert.deepEqual(b.files.get('c1'), new Array(CHUNK).fill(7));
});

test('a link that drops every other request still completes the asset', async () => {
  // Without accumulation this never finishes: each attempt restarts from zero, so an asset larger
  // than one uninterrupted transfer is never cached and the panel has nothing to fall back on.
  const b = fakeBackend(asset(CHUNK * 4, 3), { failEvery: 2 });
  const mc = new MediaCache(b);
  const items = [{ content_id: 'c1', content_rev: 5 }];

  for (let pass = 0; pass < 30 && !mc.localUrl('c1', 5); pass++) await mc.sync(items, urlFor);

  assert.ok(mc.localUrl('c1', 5), 'the asset must eventually be cached');
  assert.equal(b.files.get('c1').length, CHUNK * 4);
});

test('a partial is never promoted — an incomplete file is not offered to the player', async () => {
  const b = fakeBackend(asset(CHUNK * 3, 9), { failEvery: 1 });   // every request fails
  const mc = new MediaCache(b);
  await mc.sync([{ content_id: 'c1', content_rev: 5 }], urlFor);
  assert.equal(mc.localUrl('c1', 5), null);
  assert.equal(b.files.get('c1'), undefined, 'no whole file exists');
});

test('progress accumulates across passes rather than restarting', async () => {
  const b = fakeBackend(asset(CHUNK * 3, 4));
  const mc = new MediaCache(b);
  // One step at a time, so the resume offset is observable.
  assert.equal(await mc.fetchStep('c1', 5, 'http://s/x'), 'progress');
  assert.equal(mc.index.c1.bytes, CHUNK);
  assert.equal(await mc.fetchStep('c1', 5, 'http://s/x'), 'progress');
  assert.equal(mc.index.c1.bytes, CHUNK * 2, 'the second attempt appended, it did not restart');
  assert.equal(await mc.fetchStep('c1', 5, 'http://s/x'), 'done');
});

test('THE UPDATE HALF: a replaced asset is a miss, and the old bytes are deleted', async () => {
  // The trap that offline caching creates. Same content id, same URL path, different bytes — a
  // cache that cannot tell would keep playing last month's video forever.
  const b = fakeBackend(asset(CHUNK, 1));
  const mc = new MediaCache(b);
  await mc.sync([{ content_id: 'c1', content_rev: 5 }], urlFor);
  assert.ok(mc.localUrl('c1', 5));

  b.asset = asset(CHUNK, 2, '"v2"');
  assert.equal(mc.localUrl('c1', 6), null, 'a new revision must not match the cached copy');

  await mc.sync([{ content_id: 'c1', content_rev: 6 }], urlFor);
  assert.ok(mc.localUrl('c1', 6), 'the new revision is cached');
  assert.deepEqual(b.files.get('c1'), new Array(CHUNK).fill(2), 'and it is the NEW bytes');
});

test('an asset replaced MID-transfer is discarded, not spliced', async () => {
  // Appending the tail of the new asset to the head of the old one produces a file of exactly the
  // right length that is wrong throughout — it would pass every completeness check there is.
  const b = fakeBackend(asset(CHUNK * 4, 0x61));
  const mc = new MediaCache(b);
  assert.equal(await mc.fetchStep('c1', 5, 'http://s/x'), 'progress');
  assert.equal(mc.index.c1.bytes, CHUNK);

  b.asset = asset(CHUNK * 4, 0x62, '"v2"');           // replaced underneath us, same revision claim
  assert.equal(await mc.fetchStep('c1', 5, 'http://s/x'), 'done', 'a 200 carries the whole new asset');

  const cached = b.files.get('c1');
  assert.equal(cached.length, CHUNK * 4);
  assert.ok(cached.every((v) => v === 0x62), 'not one byte of the superseded asset may survive');
});

test('items dropped from the playlist have their bytes deleted', async () => {
  // Otherwise the cache only grows, and the failure eventually lands as a write error on whatever
  // happens to be downloading at the time.
  const b = fakeBackend(asset(CHUNK, 1));
  const mc = new MediaCache(b);
  await mc.sync([{ content_id: 'c1', content_rev: 5 }], urlFor);
  assert.ok(b.files.get('c1'));

  await mc.sync([{ content_id: 'c2', content_rev: 1 }], urlFor);
  assert.equal(b.files.get('c1'), undefined, 'an unreferenced asset must not linger');
  assert.equal(mc.index.c1, undefined);
});

test('a cached asset costs no requests on later sweeps', async () => {
  const b = fakeBackend(asset(CHUNK, 1));
  const mc = new MediaCache(b);
  const items = [{ content_id: 'c1', content_rev: 5 }];
  await mc.sync(items, urlFor);
  const after = b.requests;
  await mc.sync(items, urlFor);
  await mc.sync(items, urlFor);
  assert.equal(b.requests, after, 'a cached asset must not be re-fetched every 60s');
});

test('remote-url items are never downloaded', async () => {
  const b = fakeBackend(asset(CHUNK, 1));
  const mc = new MediaCache(b);
  await mc.sync([{ content_id: 'c1', content_rev: 5, remote_url: 'https://example.com/live' }], urlFor);
  assert.equal(b.requests, 0);
});

test('a server with no range support still caches the asset whole', async () => {
  const b = fakeBackend(asset(CHUNK * 2, 6), { rangeSupport: false });
  const mc = new MediaCache(b);
  await mc.sync([{ content_id: 'c1', content_rev: 5 }], urlFor);
  assert.ok(mc.localUrl('c1', 5));
  assert.equal(b.files.get('c1').length, CHUNK * 2);
});

test('a 416 discards a partial that is longer than the asset', async () => {
  const b = fakeBackend(asset(CHUNK, 1));
  const mc = new MediaCache(b);
  // Pretend a previous life left a longer partial behind.
  mc.index.c1 = { rev: 5, bytes: CHUNK * 9, total: CHUNK * 9, validator: '"v1"', complete: false };
  b.files.set('c1.part', new Array(CHUNK * 9).fill(0));
  assert.equal(await mc.fetchStep('c1', 5, 'http://s/x'), 'restart');
  assert.equal(b.files.get('c1.part'), undefined, 'the stale partial must be gone');
});

test('the index survives a restart — progress is not lost with the process', async () => {
  // A signage panel reboots. If the index lived only in memory, every reboot during a slow
  // download would throw the transfer away, which on a bad link means it never finishes.
  const b = fakeBackend(asset(CHUNK * 3, 8));
  const first = new MediaCache(b);
  assert.equal(await first.fetchStep('c1', 5, 'http://s/x'), 'progress');

  const reborn = new MediaCache(b);              // same backend = same persisted index + files
  assert.equal(reborn.index.c1.bytes, CHUNK, 'the resume offset survived');
  assert.equal(await reborn.fetchStep('c1', 5, 'http://s/x'), 'progress');
  assert.equal(reborn.index.c1.bytes, CHUNK * 2);
});

test('an item with no revision still caches, and matches a copy stored without one', async () => {
  // Older servers do not send content_rev. Treating absent-vs-absent as a mismatch would re-download
  // the entire playlist on every sweep.
  const b = fakeBackend(asset(CHUNK, 1));
  const mc = new MediaCache(b);
  await mc.sync([{ content_id: 'c1' }], () => 'http://s/x');
  assert.ok(mc.localUrl('c1', undefined));
  const after = b.requests;
  await mc.sync([{ content_id: 'c1' }], () => 'http://s/x');
  assert.equal(b.requests, after);
});
