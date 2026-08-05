/*
 * Offline media cache for the Tizen player.
 *
 * Tizen was the one player that cached NOTHING but the playlist. A panel could come back from a
 * reboot knowing exactly what to show and then fetch every frame of it from a server that was not
 * there — the playlist survived the outage and the content did not, which from the floor looks the
 * same as having nothing at all. `offline.cache` is deliberately absent from the Tizen capability
 * baseline for exactly this reason; this is what makes it earnable.
 *
 * A service worker is not available here: the widget runs from an app:// origin, so the mechanism
 * the web player uses does not exist. The platform's own persistent store does: tizen.filesystem
 * under wgt-private, which survives reboots and app updates, and whose file:// URI both <video> and
 * AVPlay accept as a source.
 *
 * RESUMABLE, for the same reason as everywhere else in this product: a signage panel is often on
 * the worst link in the building, and a transfer that restarts from zero on every interruption
 * never finishes at all. Progress is appended to a `.part` file and continued with Range on the
 * next pass.
 *
 * REVISION-KEYED, so caching cannot make a screen permanently wrong. Replacing an asset in the
 * dashboard changes its content_rev; a cached copy at a different revision is treated as a miss and
 * re-fetched, and its bytes are deleted. Without that, "cached for offline" would mean "can never
 * be updated".
 *
 * The BACKEND is injected so every decision here is testable in Node without a TV (see
 * server/test/tizen-media-cache.test.js). The Tizen-specific parts — resolving wgt-private,
 * appending to a stream, turning a file into a URI — are the only things that need hardware, and
 * they are the parts with no logic in them.
 */
(function (root) {
  'use strict';

  var INDEX_KEY = 'st_media_index';
  // 1MB. Smaller than the web player's 4MB because each chunk crosses the JS/native boundary as a
  // byte array here, and a 4MB array is a memory spike on a TV that a slow link does not justify.
  var CHUNK_BYTES = 1024 * 1024;

  function MediaCache(backend) {
    this.backend = backend;
    this.index = backend.loadIndex() || {};
    this.busy = false;
  }

  MediaCache.CHUNK_BYTES = CHUNK_BYTES;
  MediaCache.INDEX_KEY = INDEX_KEY;

  MediaCache.prototype.save = function () {
    try { this.backend.saveIndex(this.index); } catch (e) { /* a full store must not break playback */ }
  };

  /*
   * The local URI for an item, or null when the bytes we hold are not the bytes it wants.
   *
   * The revision comparison is the whole point: `!==` rather than a truthiness check, so an item
   * that arrives WITHOUT a revision (an older server) still matches a cached copy recorded without
   * one, and a changed revision never matches a stale copy.
   */
  MediaCache.prototype.localUrl = function (contentId, rev) {
    if (!contentId) return null;
    var e = this.index[contentId];
    if (!e || !e.complete) return null;
    if (String(e.rev || '') !== String(rev || '')) return null;
    return e.uri || null;
  };

  /*
   * Bring [contentId] a little closer to being cached. One call = one attempt: it transfers what
   * the link allows and returns, leaving the rest for the next sweep. Never throws.
   *
   * Returns 'done' | 'progress' | 'stalled' | 'restart' — 'progress' being the one that matters,
   * because a caller that cannot tell progress from failure will back a slow link off into a dead
   * one.
   */
  MediaCache.prototype.fetchStep = function (contentId, rev, url) {
    var self = this;
    var e = this.index[contentId];

    // A different revision means the bytes on disk describe an asset that no longer exists.
    if (e && String(e.rev || '') !== String(rev || '')) {
      this.drop(contentId);
      e = null;
    }
    if (e && e.complete) return Promise.resolve('done');

    if (!e) {
      e = this.index[contentId] = { rev: rev, bytes: 0, total: 0, validator: null, complete: false, path: null, uri: null };
    }

    var pending;
    try {
      pending = e.bytes > 0 && e.validator
        ? this.backend.httpRange(url, e.bytes, e.bytes + CHUNK_BYTES - 1, e.validator)
        : this.backend.httpRange(url, 0, CHUNK_BYTES - 1, null);
    } catch (err) {
      return Promise.resolve('stalled');
    }
    // The backend hands back a promise (the real one is an ASYNC XHR — a synchronous request on
    // this thread would freeze the player for as long as the chunk takes, which on the links this
    // exists for is a stalled screen, not a slow download). Tests may hand back a plain value.
    return Promise.resolve(pending).then(function (res) {
      return self.applyChunk(contentId, rev, res);
    }, function () { return 'stalled'; });
  };

  /* The decision half, given whatever the server said. Pure enough to reason about on its own. */
  MediaCache.prototype.applyChunk = function (contentId, rev, res) {
    var e = this.index[contentId];
    if (!e) return 'stalled';
    if (!res) return 'stalled';

    if (res.status === 416) {
      // Our partial is at or past the end of the asset — it belongs to something else. Keeping it
      // would mean asking for a range past the end on every future sweep and never recovering.
      this.drop(contentId);
      return 'restart';
    }

    if (res.status === 200) {
      // No range support, or If-Range told the server the asset changed. Either way the body is the
      // WHOLE asset and anything we already hold is wrong.
      this.drop(contentId);
      e = this.index[contentId] = { rev: rev, bytes: 0, total: res.total || 0, validator: res.validator || null, complete: false, path: null, uri: null };
      return this.commit(contentId, e, res.body, 0, res.total || (res.body && res.body.length) || 0) ? 'done' : 'stalled';
    }

    if (res.status !== 206) return 'stalled';

    // Content-Length on a 206 is the length of the CHUNK. The full size only comes from
    // Content-Range, and without it there is nothing to decide completeness against.
    if (!(res.total > 0) || res.start !== e.bytes) return 'stalled';
    if (e.total && res.total !== e.total) { this.drop(contentId); return 'restart'; }
    if (e.validator && res.validator && e.validator !== res.validator) { this.drop(contentId); return 'restart'; }

    e.total = res.total;
    // No validator means no safe resume: a later attempt could append the tail of a different
    // asset. We keep the bytes only when we can prove on the next pass that they still belong.
    e.validator = res.validator || null;

    var wrote = this.commit(contentId, e, res.body, e.bytes, res.total);
    if (!wrote) return 'stalled';
    if (!e.validator && !e.complete) { this.drop(contentId); return 'stalled'; }
    return e.complete ? 'done' : 'progress';
  };

  /* Append [body] at [offset] and mark the entry complete when it reaches [total]. */
  MediaCache.prototype.commit = function (contentId, e, body, offset, total) {
    if (!body || !body.length) return false;
    var written;
    try {
      written = this.backend.appendPart(contentId, body, offset);
    } catch (err) {
      return false;
    }
    if (!(written > 0)) return false;
    e.bytes = offset + written;
    e.total = total || e.total;

    if (e.total > 0 && e.bytes >= e.total) {
      // Promote only when whole. A player handed a partial file has no way to report it as
      // incomplete — only as broken.
      var promoted;
      try { promoted = this.backend.promotePart(contentId); } catch (err) { promoted = null; }
      if (!promoted) return false;
      e.complete = true;
      e.path = promoted.path;
      e.uri = promoted.uri;
    }
    this.save();
    return true;
  };

  /* Forget an entry and delete its bytes, partial or complete. */
  MediaCache.prototype.drop = function (contentId) {
    try { this.backend.remove(contentId); } catch (e) { /* best effort */ }
    delete this.index[contentId];
    this.save();
  };

  /*
   * Delete anything the current playlist does not reference, and anything at a superseded revision.
   *
   * Without this the cache only ever grows: a panel that has cycled through a year of campaigns
   * fills its storage with assets nobody will play again, and the failure lands as a write error on
   * whatever happens to be downloading at the time.
   */
  MediaCache.prototype.prune = function (items) {
    var keep = {};
    (items || []).forEach(function (it) {
      if (it && it.content_id) keep[it.content_id] = String(it.content_rev || '');
    });
    var self = this;
    Object.keys(this.index).forEach(function (id) {
      var wanted = keep[id];
      if (wanted === undefined || wanted !== String(self.index[id].rev || '')) self.drop(id);
    });
  };

  /*
   * One pass over the playlist: prune, then advance each uncached item in turn.
   *
   * Serialised on purpose. Three concurrent transfers on a link that cannot finish one produce
   * three unfinished transfers instead of one finished one — and on a TV they also produce three
   * simultaneous native writes competing with video decode.
   */
  MediaCache.prototype.sync = function (items, urlFor) {
    if (this.busy) return Promise.resolve();
    this.busy = true;
    var self = this;

    try { this.prune(items); } catch (e) { /* pruning must never block fetching */ }
    var list = (items || []).filter(function (it) { return it && it.content_id && !it.remote_url; });

    /*
     * One item at a time, and within an item, keep going while bytes are landing — exactly the
     * shape the other players use. Serialised on purpose: three concurrent transfers on a link that
     * cannot finish one produce three unfinished transfers instead of one finished one, and on a TV
     * they also compete with video decode for the same memory.
     */
    function item(i) {
      if (i >= list.length) return Promise.resolve();
      var it = list[i];
      var guard = 0;
      function step() {
        // Bounded, so one enormous asset cannot monopolise the pass and starve the rest of the
        // playlist; whatever is left resumes on the next sweep.
        if (guard++ >= 32) return Promise.resolve();
        return self.fetchStep(it.content_id, it.content_rev, urlFor(it)).then(function (verdict) {
          return verdict === 'progress' ? step() : null;
        });
      }
      return step().catch(function () { /* this item stalled; the rest of the playlist continues */ })
        .then(function () { return item(i + 1); });
    }

    return item(0).catch(function () {}).then(function () { self.busy = false; });
  };

  /* ------------------------------------------------------------------ *
   * The Tizen adapter. No decisions live here — only platform calls.
   * ------------------------------------------------------------------ */
  function tizenBackend() {
    var dir = null;
    try {
      // Synchronous resolve is deprecated in newer Web APIs but is what the widget runtime on the
      // shipped panels supports; the async form would force this whole module to be callback-based
      // for no behavioural gain.
      dir = tizen.filesystem.resolve('wgt-private', function (d) { dir = d; }, function () { dir = null; }, 'rw');
    } catch (e) { dir = null; }

    function fileFor(name, create) {
      if (!dir) return null;
      try { return dir.resolve(name); } catch (e) { /* not there yet */ }
      if (!create) return null;
      try { return dir.createFile(name); } catch (e) { return null; }
    }

    return {
      available: function () { return !!dir; },
      loadIndex: function () {
        try { return JSON.parse(localStorage.getItem(INDEX_KEY) || '{}'); } catch (e) { return {}; }
      },
      saveIndex: function (idx) {
        try { localStorage.setItem(INDEX_KEY, JSON.stringify(idx)); } catch (e) { /* full */ }
      },
      httpRange: function (url, start, end, validator) {
        return new Promise(function (resolve) {
          var xhr = new XMLHttpRequest();
          xhr.open('GET', url, true);
          // Binary over responseText: the widget runtime on the shipped panels predates a reliable
          // arraybuffer path through this API, and x-user-defined keeps every byte addressable.
          xhr.overrideMimeType('text/plain; charset=x-user-defined');
          xhr.setRequestHeader('Range', 'bytes=' + start + '-' + end);
          if (validator) xhr.setRequestHeader('If-Range', validator);
          // A stalled chunk must give up rather than hold the slot forever — on a bad link a hung
          // request is indistinguishable from a dead one, and the next sweep resumes anyway.
          xhr.timeout = 60000;
          function done(res) { resolve(res); }
          xhr.onerror = function () { done(null); };
          xhr.ontimeout = function () { done(null); };
          xhr.onload = function () {
            var cr = xhr.getResponseHeader('Content-Range') || '';
            var m = /bytes\s+(\d+)-(\d+)\/(\d+)/.exec(cr);
            var body = null;
            if (xhr.status === 200 || xhr.status === 206) {
              var text = xhr.responseText || '';
              body = [];
              for (var i = 0; i < text.length; i++) body.push(text.charCodeAt(i) & 0xff);
            }
            done({
              status: xhr.status,
              start: m ? Number(m[1]) : 0,
              total: m ? Number(m[3]) : Number(xhr.getResponseHeader('Content-Length') || 0),
              validator: xhr.getResponseHeader('ETag') || xhr.getResponseHeader('Last-Modified') || null,
              body: body
            });
          };
          try { xhr.send(null); } catch (e) { done(null); }
        });
      },
      appendPart: function (contentId, body, offset) {
        var f = fileFor(contentId + '.part', true);
        if (!f) return 0;
        var written = 0;
        // 'a' append mode, so a resumed transfer adds to what is already there instead of
        // truncating it — which would make every attempt start from zero again.
        f.openStream(offset > 0 ? 'a' : 'w', function (stream) {
          try { stream.writeBytes(body); written = body.length; } finally { stream.close(); }
        }, function () { written = 0; });
        return written;
      },
      promotePart: function (contentId) {
        var part = fileFor(contentId + '.part', false);
        if (!part) return null;
        try {
          // Rename rather than copy: an atomic-enough swap, and a copy would need twice the space
          // for a large video on a panel that may not have it.
          part.moveTo(part.parent.fullPath + '/' + contentId, contentId, true, function () {}, function () {});
        } catch (e) { /* fall through and try to resolve it anyway */ }
        var whole = fileFor(contentId, false);
        if (!whole) return null;
        return { path: whole.fullPath, uri: whole.toURI() };
      },
      remove: function (contentId) {
        if (!dir) return;
        [contentId, contentId + '.part'].forEach(function (name) {
          try {
            var f = dir.resolve(name);
            if (f) dir.deleteFile(f.fullPath, function () {}, function () {});
          } catch (e) { /* not present */ }
        });
      }
    };
  }

  MediaCache.tizenBackend = tizenBackend;

  /*
   * The live instance, or null when the platform cannot give us persistent storage. Null is a
   * supported state everywhere it is used: the player falls back to streaming from the server,
   * which is what it did before this existed.
   */
  MediaCache.create = function () {
    try {
      var backend = tizenBackend();
      if (!backend.available()) return null;
      return new MediaCache(backend);
    } catch (e) {
      return null;
    }
  };

  root.MediaCache = MediaCache;
  if (typeof module === 'object' && module.exports) module.exports = MediaCache;
})(typeof window !== 'undefined' ? window : this);
