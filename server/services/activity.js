const { db } = require('../db/database');
const proxyaddr = require('proxy-addr');
const { cloudflareIps } = require('../config/cloudflareIps');

// Peer gate for CF-Connecting-IP: ONLY Cloudflare's published edge ranges, deliberately
// NOT the loopback/linklocal/uniquelocal entries that `trust proxy` also carries.
//
// Those entries are right for X-Forwarded-For, because a local reverse proxy APPENDS to
// XFF and Express then walks the chain right-to-left, so a client-supplied value cannot
// end up as the resolved address. CF-Connecting-IP has no chain: nginx passes through
// whatever single value the client sent. Treating a loopback peer as evidence that the
// request came through Cloudflare therefore means trusting the client.
//
// This is also the portable behaviour. Most self-hosted installs do NOT sit behind
// Cloudflare; for them this header is now simply ignored and attribution comes from
// req.ip via whatever `trust proxy` the operator configured. An install that DOES front
// with Cloudflare is unaffected: its peer really is a CF edge.
const isCloudflarePeer = proxyaddr.compile(cloudflareIps);

// Resolve the real client IP. This value keys every per-IP control (the auth/pairing rate
// limiters, lib/pair-lockout) and the ip_address column in activity_log, so a caller must
// never be able to choose it.
function getClientIp(req) {
  if (!req) return null;
  const cf = req.headers && req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim().length > 0) {
    const peer = req.socket && req.socket.remoteAddress;
    // Believe it only when the request demonstrably arrived through Cloudflare.
    if (peer && isCloudflarePeer(peer, 0)) return cf.trim();
  }
  return req.ip || null;
}

// Phase 2.2 writer-leak fix: activity_log rows now stamp workspace_id so
// tenant-scoped queries don't miss new events. Callers pass the workspace
// when known; the middleware below sources it from resolveTenancy. When
// workspaceId is null but a device_id is provided, fall back to the device's
// workspace - matches the backfill rule for consistency.
function logActivity(userId, action, details = null, deviceId = null, ipAddress = null, workspaceId = null) {
  try {
    let ws = workspaceId || null;
    if (!ws && deviceId) {
      const d = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(deviceId);
      ws = d?.workspace_id || null;
    }
    db.prepare(
      'INSERT INTO activity_log (user_id, device_id, action, details, ip_address, workspace_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(userId || null, deviceId || null, action, details || null, ipAddress || null, ws);
  } catch (e) {
    console.error('Activity log error:', e.message);
  }
}

function getActivity(options = {}) {
  const { userId, deviceId, limit = 50, offset = 0 } = options;
  let sql = `SELECT al.*, u.name as user_name, u.email as user_email
    FROM activity_log al LEFT JOIN users u ON al.user_id = u.id WHERE 1=1`;
  const params = [];

  if (userId) { sql += ' AND al.user_id = ?'; params.push(userId); }
  if (deviceId) { sql += ' AND al.device_id = ?'; params.push(deviceId); }

  sql += ' ORDER BY al.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
}

// Prune old activity logs (keep 90 days)
function pruneActivityLog() {
  db.prepare("DELETE FROM activity_log WHERE created_at < strftime('%s','now') - (90 * 86400)").run();
}

// Express middleware to auto-log API mutations
function activityLogger(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = function(data) {
    // Only log successful mutations
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && res.statusCode < 400) {
      const action = `${req.method} ${req.baseUrl || ''}${req.route?.path || req.path}`;
      const userId = req.user?.id;
      const deviceId = req.params?.id || req.params?.deviceId || req.body?.device_id;
      const details = summarizeAction(req);
      logActivity(userId, action, details, deviceId, getClientIp(req), req.workspaceId || null);
    }
    return originalJson(data);
  };
  next();
}

function summarizeAction(req) {
  const parts = [];
  if (req.body?.name) parts.push(`name: ${req.body.name}`);
  if (req.body?.filename) parts.push(`file: ${req.body.filename}`);
  if (req.body?.pairing_code) parts.push('device paired');
  if (req.body?.plan_id) parts.push(`plan: ${req.body.plan_id}`);
  if (req.file?.originalname) parts.push(`uploaded: ${req.file.originalname}`);
  return parts.join(', ') || null;
}

module.exports = { logActivity, getActivity, pruneActivityLog, activityLogger, getClientIp };
