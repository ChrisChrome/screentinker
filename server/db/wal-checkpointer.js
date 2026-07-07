// Off-main-thread WAL checkpointer — main-thread controller.
//
// SQLite's default auto-checkpoint runs a synchronous, fsync-heavy checkpoint inline on the
// write that trips the 1000-page threshold; on slow storage that blocks the event loop for
// ~600-750ms on a ~60s beat (the periodic p99 spike). Here we disable inline auto-checkpoint
// on the MAIN connection and delegate checkpointing to a worker_threads worker that opens its
// OWN connection (see wal-checkpointer-worker.js) so the fsync blocks the worker, not the loop.
const path = require('path');
const { Worker } = require('worker_threads');
const config = require('../config');

let worker = null;

// Call ONCE at boot, after the DB is open + migrated. `db` is the main connection (used only
// to flip the pragma + do a one-time handoff checkpoint on the main thread at boot). `dbPath`
// is the STRING the worker uses to open its own handle — the main handle is never shared.
function startWalCheckpointer(db, dbPath) {
  if (worker) return worker;

  // From now on the main thread NEVER inline-checkpoints (removes the loop-blocking fsync).
  db.pragma('wal_autocheckpoint = 0');
  // Hand the worker a clean WAL (one-time, at boot, on a small WAL — cheap). Explicit
  // checkpoints are independent of wal_autocheckpoint, so this still works with it at 0.
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) { /* best-effort */ }

  worker = new Worker(path.join(__dirname, 'wal-checkpointer-worker.js'), {
    workerData: {
      dbPath,                                                    // string only (thread-safe handoff)
      intervalMs: config.walCheckpointIntervalMs,
      highWaterBytes: config.walCheckpointHighWaterMB * 1024 * 1024,
      starvationRuns: config.walCheckpointStarvationRuns,
    },
  });
  worker.on('message', (m) => { if (m && m.log) console.log('[wal-checkpoint] ' + m.log); });
  worker.on('error', (e) => console.error('[wal-checkpoint] worker error:', e && e.message));
  worker.on('exit', (code) => { if (code !== 0) console.warn(`[wal-checkpoint] worker exited (code ${code})`); worker = null; });
  // A worker thread cannot outlive its process, but unref() also ensures it never KEEPS the
  // process alive during shutdown — so there's no orphaned worker/connection either way.
  worker.unref();

  console.log(`[wal-checkpoint] off-thread checkpointer started (every ${config.walCheckpointIntervalMs}ms; escalate >${config.walCheckpointHighWaterMB}MB or ${config.walCheckpointStarvationRuns} growing runs)`);
  return worker;
}

// Graceful teardown: ask the worker to stop (clears its timer + closes its connection), then
// force-terminate as a backstop. Safe to call when not started.
async function stopWalCheckpointer() {
  if (!worker) return;
  const w = worker;
  worker = null;
  try { w.postMessage({ stop: true }); } catch (_) {}
  await new Promise((r) => setTimeout(r, 150)); // let it close its handle cleanly
  try { await w.terminate(); } catch (_) {}
}

module.exports = { startWalCheckpointer, stopWalCheckpointer };
