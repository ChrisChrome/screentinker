'use strict';

// #73: the single query behind GET /api/agency/playlists. Returns ONLY this token's
// designated playlists, in its bound workspace. The WHERE clause IS the confinement and is
// the thing to bite-test:
//   t.token_id = ?      -> this token's targets, never another token's
//   (JOIN api_token_targets) -> only allowlisted playlists, never one outside the allowlist
//   p.workspace_id = ?  -> only the bound workspace, never cross-workspace
// db is passed in (not module-required) so the confinement is unit-testable in isolation.
function listDesignatedPlaylists(db, tokenId, workspaceId) {
  return db.prepare(`
    SELECT p.id, p.name, p.status
    FROM api_token_targets t
    JOIN playlists p ON p.id = t.playlist_id
    WHERE t.token_id = ? AND p.workspace_id = ?
    ORDER BY p.name
  `).all(tokenId, workspaceId);
}

module.exports = { listDesignatedPlaylists };
