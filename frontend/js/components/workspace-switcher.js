import { api } from '../api.js';
import { showToast } from './toast.js';

// Render the workspace switcher inside #workspaceSwitcher based on the
// /api/auth/me response. Three modes:
//   - 0 accessible workspaces: muted "No workspace" placeholder
//   - 1 accessible workspace: workspace name as static text
//   - >1 accessible workspaces: dropdown button + menu with click-to-switch
export function renderWorkspaceSwitcher(me) {
  const container = document.getElementById('workspaceSwitcher');
  if (!container) return;

  const list = Array.isArray(me?.accessible_workspaces) ? me.accessible_workspaces : [];
  const currentId = me?.current_workspace_id || null;

  if (list.length === 0) {
    container.classList.remove('open');
    container.innerHTML = `<span class="workspace-switcher-empty">No workspace</span>`;
    return;
  }

  if (list.length === 1) {
    container.classList.remove('open');
    container.innerHTML = `<span class="workspace-switcher-static">${esc(list[0].name)}</span>`;
    return;
  }

  // >1: dropdown. Alpha sort by workspace name for MVP (no recently-used yet).
  const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name));
  const current = sorted.find(w => w.id === currentId) || sorted[0];

  container.innerHTML = `
    <button class="workspace-switcher-button" type="button" aria-haspopup="listbox" aria-expanded="false">
      <span class="ws-name" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(current.name)}</span>
      <svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    </button>
    <div class="workspace-switcher-menu" role="listbox">
      ${sorted.map(w => `
        <div class="workspace-switcher-item ${w.id === currentId ? 'current' : ''}" data-workspace-id="${esc(w.id)}" role="option">
          <svg class="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="${w.id === currentId ? '' : 'visibility:hidden'}">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <div class="ws-meta">
            <div class="ws-name">${esc(w.name)}</div>
            <div class="ws-org">${esc(w.organization_name || '')}</div>
          </div>
          ${w.can_admin ? `
            <button class="workspace-switcher-pencil" type="button" data-rename-id="${esc(w.id)}" aria-label="Rename workspace" title="Rename">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
              </svg>
            </button>
          ` : ''}
        </div>
      `).join('')}
    </div>
  `;

  const button = container.querySelector('.workspace-switcher-button');
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = !container.classList.contains('open');
    container.classList.toggle('open');
    button.setAttribute('aria-expanded', String(opening));
  });

  // Pencil click opens the rename modal. Must stopPropagation so the click
  // doesn't bubble up to the switcher-item's switch handler.
  container.querySelectorAll('.workspace-switcher-pencil').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const wsId = btn.dataset.renameId;
      const ws = sorted.find(w => w.id === wsId);
      if (!ws) return;
      container.classList.remove('open');
      const { openWorkspaceRenameModal } = await import('./workspace-rename-modal.js');
      openWorkspaceRenameModal(ws);
    });
  });

  container.querySelectorAll('.workspace-switcher-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      // Ignore clicks that originated on the pencil (it has its own handler).
      if (e.target.closest('.workspace-switcher-pencil')) return;
      const wsId = item.dataset.workspaceId;
      if (wsId === currentId) { container.classList.remove('open'); return; }
      try {
        const resp = await api.switchWorkspace(wsId);
        if (resp?.token) {
          localStorage.setItem('token', resp.token);
          window.location.reload();
        } else {
          showToast('Switch returned no token', 'error');
        }
      } catch (err) {
        showToast(err.message || 'Failed to switch workspace', 'error');
      }
    });
  });

  // Click-outside closes the menu.
  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) {
      container.classList.remove('open');
      button.setAttribute('aria-expanded', 'false');
    }
  });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
