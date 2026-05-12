const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { canAdminWorkspace } = require('../lib/permissions');

// Workspace management routes. Operates on a target workspace specified by
// URL param, NOT the caller's currently active workspace - so this router
// does NOT use resolveTenancy. Permission is gated via canAdminWorkspace()
// which evaluates against the target workspace, not req.workspaceRole.

const NAME_MAX = 80;
const SLUG_MAX = 60;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Rename a workspace. MVP scope: name + slug only. Permission: platform_admin,
// org_owner/admin of the parent org, or workspace_admin of the target ws.
router.patch('/:id', (req, res) => {
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });
  if (!canAdminWorkspace(db, req.user, ws)) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  // Stamp the target workspace_id so activityLogger captures the right
  // tenant attribution. This route doesn't use resolveTenancy (operates on
  // a URL-param target, not the caller's active workspace), so req.workspaceId
  // would otherwise be undefined and the audit row would have NULL workspace.
  req.workspaceId = ws.id;

  const updates = [];
  const values = [];

  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: 'Name cannot be empty' });
    if (name.length > NAME_MAX) return res.status(400).json({ error: `Name must be ${NAME_MAX} characters or fewer` });
    updates.push('name = ?');
    values.push(name);
  }

  if (req.body.slug !== undefined) {
    // Empty string -> NULL (workspace has no slug). Otherwise normalize +
    // validate against the URL-safe segment pattern.
    const raw = String(req.body.slug || '').trim().toLowerCase();
    if (raw === '') {
      updates.push('slug = NULL');
    } else {
      if (raw.length > SLUG_MAX) return res.status(400).json({ error: `Slug must be ${SLUG_MAX} characters or fewer` });
      if (!SLUG_RE.test(raw)) {
        return res.status(400).json({ error: 'Slug must be lowercase letters, digits, and hyphens (no leading/trailing/double hyphens)' });
      }
      updates.push('slug = ?');
      values.push(raw);
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  updates.push("updated_at = strftime('%s','now')");
  values.push(req.params.id);

  try {
    db.prepare(`UPDATE workspaces SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE/i.test(e.message)) {
      return res.status(409).json({ error: 'Slug already used in this organization' });
    }
    throw e;
  }

  const updated = db.prepare('SELECT id, name, slug, organization_id FROM workspaces WHERE id = ?').get(req.params.id);
  res.json(updated);
});

module.exports = router;
