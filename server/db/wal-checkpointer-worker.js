// WAL checkpointer WORKER (worker_threads). Runs OFF the main event-loop thread so the
// synchronous, fsync-heavy checkpoint never blocks the loop (the ~60s p99 spike).
//
// CRITICAL: this worker opens its OWN better-sqlite3 Database() handle against the same
// file. better-sqlite3 handles are NOT thread-safe, so the main thread's handle is never
// shared into the worker — only the dbPath STRING is passed via workerData. SQLite WAL is
// designed for multiple connections to the same file, so a second connection checkpointing
// while the main connection writes is safe.
const { workerData, parentPort } = require('worker_threads');
const fs = require('fs');
const Database = require('better-sqlite3');

const { dbPath, intervalMs, highWaterBytes, starvationRuns } = workerData;

// Fault injection for TESTS ONLY (env-gated; inert in prod). Exits immediately on start so
// the controller's respawn / autocheckpoint-fallback path can be exercised deterministically.
if (process.env.WAL_CKPT_FAIL_START) process.exit(1);

// Fresh, worker-owned connection (NOT the main handle).
const db = new Database(dbPath);
db.pragma('busy_timeout = 5000');      // wait (on THIS worker thread) through the main writer's brief locks
db.pragma('wal_autocheckpoint = 0');   // this connection must never auto-checkpoint either

const walFile = dbPath + '-wal';
function walBytes() { try { return fs.statSync(walFile).size; } catch { return 0; } }

let lastBytes = 0;
let growthRuns = 0;   // consecutive PASSIVE runs where the WAL failed to shrink
let timer = null;

function tick() {
  try {
    // PASSIVE never blocks writers, but skips frames pinned by active readers/writers —
    // so on its own it can perpetually under-checkpoint. That's what the guard below bounds.
    db.pragma('wal_checkpoint(PASSIVE)', { simple: false });
    const bytes = walBytes();

    // --- STARVATION BOUND (this is where "WAL cannot grow forever" is enforced) ---
    // Either signal forces a TRUNCATE, which BLOCKS until it has checkpointed everything
    // and truncated the file to 0. Blocking is fatal on the loop but FINE here on the worker.
    if (bytes > lastBytes) growthRuns++; else growthRuns = 0;
    const overHighWater = bytes > highWaterBytes;
    const starved = growthRuns >= starvationRuns;

    if (overHighWater || starved) {
      db.pragma('wal_checkpoint(TRUNCATE)', { simple: false });
      const after = walBytes();
      post(`escalated TRUNCATE (${overHighWater ? 'high-water' : 'starvation'}): WAL ${(bytes / 1e6).toFixed(1)}MB -> ${(after / 1e6).toFixed(1)}MB`);
      growthRuns = 0;
      lastBytes = after;
    } else {
      lastBytes = bytes;
    }
  } catch (e) {
    post('checkpoint error: ' + (e && e.message));
  }
}

function post(log) { try { parentPort && parentPort.postMessage({ log }); } catch (_) {} }

timer = setInterval(tick, intervalMs);

// Clean shutdown: stop the timer, close our connection, exit THIS worker thread.
parentPort && parentPort.on('message', (m) => {
  if (m && m.stop) {
    if (timer) { clearInterval(timer); timer = null; }
    try { db.close(); } catch (_) {}
    process.exit(0);
  }
});
