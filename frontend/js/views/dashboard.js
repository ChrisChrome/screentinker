import { api } from '../api.js';
import { on, off, requestScreenshot } from '../socket.js';
import { showToast } from '../components/toast.js';
import { esc } from '../utils.js';
import { t, tn } from '../i18n.js';

const DESTRUCTIVE_COMMANDS = ['reboot', 'shutdown'];
// Command types only — labels resolved through t('dashboard.cmd.<type>')
const GROUP_COMMANDS = [
  { type: 'screen_on' },
  { type: 'screen_off' },
  { type: 'launch' },
  { type: 'update' },
  { type: 'reboot', destructive: true },
  { type: 'shutdown', destructive: true },
];
const CMD_LABEL_KEY = {
  screen_on: 'dashboard.cmd.screen_on',
  screen_off: 'dashboard.cmd.screen_off',
  launch: 'dashboard.cmd.restart_app',
  update: 'dashboard.cmd.check_update',
  reboot: 'dashboard.cmd.reboot',
  shutdown: 'dashboard.cmd.shutdown',
};

let statusHandler = null;
let screenshotHandler = null;
let refreshInterval = null;

function formatTimeAgo(timestamp) {
  if (!timestamp) return t('common.never');
  const seconds = Math.floor(Date.now() / 1000 - timestamp);
  if (seconds < 60) return t('common.just_now');
  if (seconds < 3600) return t('common.minutes_ago', { n: Math.floor(seconds / 60) });
  if (seconds < 86400) return t('common.hours_ago', { n: Math.floor(seconds / 3600) });
  return t('common.days_ago', { n: Math.floor(seconds / 86400) });
}

function formatBytes(mb) {
  if (mb === null || mb === undefined) return '--';
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

function renderDeviceCard(device) {
  const token = localStorage.getItem('token');
  const screenshotUrl = device.screenshot_path
    ? `/api/devices/${device.id}/screenshot?t=${device.screenshot_at || ''}&token=${token}`
    : null;

  return `
    <div class="device-card" draggable="true" data-device-id="${device.id}" data-device-name="${esc(device.name)}" onclick="window.location.hash='/device/${device.id}'">
      <div class="device-card-preview" id="preview-${device.id}">
        ${screenshotUrl
          ? `<img src="${screenshotUrl}" alt="Screenshot" loading="lazy">`
          : `<div class="no-preview">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                <line x1="8" y1="21" x2="16" y2="21"/>
                <line x1="12" y1="17" x2="12" y2="21"/>
              </svg>
              <span>${t('dashboard.no_preview')}</span>
            </div>`
        }
        <div class="device-card-status">
          <span class="status-dot ${device.status}"></span>
          <span>${device.status === 'provisioning' ? t('dashboard.awaiting_pairing') : device.status}</span>
        </div>
        ${device.status === 'provisioning' && device.pairing_code ? `
        <div style="position:absolute;bottom:8px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.85);color:#f59e0b;padding:4px 12px;border-radius:6px;font-size:13px;font-weight:600;letter-spacing:2px;font-family:monospace">
          ${device.pairing_code}
        </div>` : ''}
      </div>
      <div class="device-card-body">
        <div class="device-card-name">${esc(device.name)}</div>
        ${device.owner_name || device.owner_email ? `<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
          </svg>
          ${esc(device.owner_name || device.owner_email)}
        </div>` : ''}
        <div class="device-card-meta">
          <div class="meta-item">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
            ${formatTimeAgo(device.last_heartbeat)}
          </div>
          ${device.battery_level !== null && device.battery_level !== undefined ? `
          <div class="meta-item">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="1" y="6" width="18" height="12" rx="2" ry="2"/><line x1="23" y1="13" x2="23" y2="11"/>
            </svg>
            ${device.battery_level}%
          </div>` : ''}
          ${device.wifi_rssi ? `
          <div class="meta-item">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/>
              <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>
            </svg>
            ${device.wifi_rssi} dBm
          </div>` : ''}
          ${device.storage_free_mb ? `
          <div class="meta-item">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
            </svg>
            ${formatBytes(device.storage_free_mb)} free
          </div>` : ''}
        </div>
      </div>
    </div>
  `;
}

function getGroupPlaylistLabel(devices, playlists) {
  const playlistMap = new Map((playlists || []).map(p => [p.id, p]));
  const assigned = devices.filter(d => d.playlist_id).map(d => d.playlist_id);
  if (assigned.length === 0) return '';
  const unique = [...new Set(assigned)];
  if (unique.length === 1) {
    const pl = playlistMap.get(unique[0]);
    return pl ? esc(pl.name) : t('dashboard.unknown_playlist');
  }
  return t('dashboard.mixed_playlists');
}

function renderGroupSection(group, devices, playlists) {
  const onlineCount = devices.filter(d => d.status === 'online').length;
  const playlistLabel = getGroupPlaylistLabel(devices, playlists);
  return `
    <div class="group-section" data-group-id="${group.id}" style="margin-bottom:24px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;padding:8px 12px;background:var(--bg-secondary);border-radius:8px;border-left:4px solid ${esc(group.color || '#3B82F6')}">
        <div style="display:flex;align-items:center;gap:10px">
          <strong style="font-size:15px">${esc(group.name)}</strong>
          <span style="color:var(--text-muted);font-size:12px">${tn('dashboard.devices_count', devices.length)} &middot; ${t('dashboard.online_count', { n: onlineCount })}</span>
          ${playlistLabel ? `<span style="font-size:11px;color:var(--text-secondary);background:var(--bg-primary);padding:2px 8px;border-radius:10px">${t('dashboard.playlist_label', { name: playlistLabel })}</span>` : ''}
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          ${devices.length > 0 ? `
          <select class="input group-playlist-select" data-group-id="${group.id}" data-group-name="${esc(group.name)}" style="width:160px;padding:4px 8px;font-size:12px;background:var(--bg-input)">
            <option value="">${t('dashboard.set_playlist_placeholder')}</option>
            ${(playlists || []).map(p => `<option value="${esc(p.id)}">${esc(p.name)}${p.status === 'draft' ? ' ' + t('dashboard.draft_suffix') : ''}</option>`).join('')}
          </select>
          <select class="input group-cmd-select" data-group-id="${group.id}" data-group-name="${esc(group.name)}" data-device-count="${devices.length}" style="width:150px;padding:4px 8px;font-size:12px;background:var(--bg-input)">
            <option value="">${t('dashboard.send_command_placeholder')}</option>
            ${GROUP_COMMANDS.map(c => `<option value="${c.type}" ${c.destructive ? 'style="color:var(--danger)"' : ''}>${t(CMD_LABEL_KEY[c.type])}</option>`).join('')}
          </select>
          ` : ''}
          <button class="btn" data-group-manage="${group.id}" style="padding:4px 10px;font-size:12px" title="${t('dashboard.manage_tooltip')}">${t('dashboard.manage')}</button>
          <button class="btn" data-group-delete="${group.id}" style="padding:4px 8px;font-size:12px;color:var(--danger)" title="${t('dashboard.delete_group_tooltip')}">&#x2715;</button>
        </div>
      </div>
      <div class="device-grid">
        ${devices.length > 0 ? devices.map(renderDeviceCard).join('') : `<div style="color:var(--text-muted);font-size:13px;padding:8px 12px">${t('dashboard.no_devices_in_group')}</div>`}
      </div>
    </div>
  `;
}

export function render(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>${t('dashboard.title')} <span class="help-tip" data-tip="${t('dashboard.help_tip')}">?</span></h1>
        <div class="subtitle">${t('dashboard.subtitle')}</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn" id="createGroupBtn">${t('dashboard.create_group')}</button>
        <button class="btn btn-primary" id="addDeviceBtn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          ${t('dashboard.add')}
        </button>
      </div>
    </div>
    <div id="dashStats" class="dash-stats-row" style="display:flex;gap:12px;margin-bottom:16px"></div>
    <div style="display:flex;gap:12px;margin-bottom:16px;align-items:center">
      <input type="text" id="deviceSearch" class="input" placeholder="${t('dashboard.search')}" style="max-width:300px">
      <select id="deviceFilter" class="input" style="width:140px;background:var(--bg-input)">
        <option value="">${t('dashboard.all_status')}</option>
        <option value="online">${t('dashboard.online')}</option>
        <option value="offline">${t('dashboard.offline')}</option>
      </select>
    </div>
    <div id="groupedDevices"></div>
  `;

  const addBtn = container.querySelector('#addDeviceBtn');
  addBtn.addEventListener('click', () => {
    document.getElementById('addDeviceModal').style.display = 'flex';
    document.getElementById('pairingCodeInput').value = '';
    document.getElementById('deviceNameInput').value = '';
    document.getElementById('pairingCodeInput').focus();
  });

  // Search and filter
  document.getElementById('deviceSearch').oninput = () => filterDevices();
  document.getElementById('deviceFilter').onchange = () => filterDevices();

  function filterDevices() {
    const search = document.getElementById('deviceSearch').value.toLowerCase();
    const status = document.getElementById('deviceFilter').value;
    document.querySelectorAll('.device-card').forEach(card => {
      const name = card.querySelector('.device-card-name')?.textContent.toLowerCase() || '';
      const deviceStatus = card.querySelector('.device-card-status span:last-child')?.textContent || '';
      const matchSearch = !search || name.includes(search);
      const matchStatus = !status || deviceStatus === status;
      card.style.display = (matchSearch && matchStatus) ? '' : 'none';
    });
  }

  // Setup pairing
  const pairBtn = document.getElementById('pairDeviceBtn');
  pairBtn.onclick = async () => {
    const code = document.getElementById('pairingCodeInput').value.trim();
    const name = document.getElementById('deviceNameInput').value.trim();
    if (!code || code.length !== 6) {
      showToast(t('dashboard.error_pairing_code'), 'error');
      return;
    }
    try {
      await api.pairDevice(code, name || undefined);
      document.getElementById('addDeviceModal').style.display = 'none';
      showToast(t('dashboard.toast.display_paired'), 'success');
      loadDashboard();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // Create group
  container.querySelector('#createGroupBtn').addEventListener('click', async () => {
    const name = prompt(t('dashboard.prompt_group_name'));
    if (!name) return;
    try {
      await api.createGroup(name);
      showToast(t('dashboard.toast.group_created'), 'success');
      loadDashboard();
    } catch (e) { showToast(e.message, 'error'); }
  });

  // Load everything
  loadDashboard();

  // Real-time updates
  statusHandler = (data) => {
    const cards = document.querySelectorAll(`[data-device-id="${data.device_id}"]`);
    cards.forEach(card => {
      const statusEl = card.querySelector('.device-card-status');
      if (statusEl) statusEl.innerHTML = `<span class="status-dot ${data.status}"></span><span>${data.status}</span>`;
    });
  };

  screenshotHandler = (data) => {
    document.querySelectorAll(`#preview-${data.device_id}`).forEach(preview => {
      const imgSrc = data.image_data || (data.url + '&token=' + localStorage.getItem('token'));
      const img = preview.querySelector('img');
      if (img) {
        img.src = imgSrc;
      } else {
        const statusHtml = preview.querySelector('.device-card-status')?.outerHTML || '';
        preview.innerHTML = `<img src="${imgSrc}" alt="Screenshot" loading="lazy">${statusHtml}`;
      }
    });
  };

  const deviceAddedHandler = () => loadDashboard();
  const deviceRemovedHandler = () => loadDashboard();

  on('device-status', statusHandler);
  on('screenshot-ready', screenshotHandler);
  on('device-added', deviceAddedHandler);
  on('device-removed', deviceRemovedHandler);

  // Request fresh screenshots on load
  setTimeout(() => {
    document.querySelectorAll('.device-card').forEach(card => {
      requestScreenshot(card.dataset.deviceId);
    });
  }, 2000);

  refreshInterval = setInterval(() => {
    document.querySelectorAll('.device-card').forEach(card => {
      requestScreenshot(card.dataset.deviceId);
    });
  }, 30000);
}

async function loadDashboard() {
  const main = document.getElementById('groupedDevices');
  if (!main) return;

  try {
    const [rawDevices, groups, playlists] = await Promise.all([api.getDevices(), api.getGroups(), api.getPlaylists()]);

    // Deduplicate devices by id — a stale reconnect race can briefly cause the same
    // device to appear twice in the list. Last-write-wins keeps the freshest state.
    const seen = new Map();
    for (const d of rawDevices) seen.set(d.id, d);
    const devices = Array.from(seen.values());

    // Stats
    const online = devices.filter(d => d.status === 'online').length;
    const offline = devices.filter(d => d.status === 'offline').length;
    const provisioning = devices.filter(d => d.status === 'provisioning').length;
    const statsEl = document.getElementById('dashStats');
    if (statsEl) {
      statsEl.innerHTML = `
        <div class="info-card" style="flex:1;min-width:120px">
          <div class="info-card-label">${t('dashboard.total_displays')}</div>
          <div class="info-card-value">${devices.length}</div>
        </div>
        <div class="info-card" style="flex:1;min-width:120px">
          <div class="info-card-label">${t('dashboard.online')}</div>
          <div class="info-card-value" style="color:var(--success)">${online}</div>
        </div>
        <div class="info-card" style="flex:1;min-width:120px">
          <div class="info-card-label">${t('dashboard.offline')}</div>
          <div class="info-card-value" style="color:${offline > 0 ? 'var(--danger)' : 'var(--text-muted)'}">${offline}</div>
        </div>
        ${provisioning > 0 ? `
        <div class="info-card" style="flex:1;min-width:120px">
          <div class="info-card-label">${t('dashboard.awaiting_pairing')}</div>
          <div class="info-card-value" style="color:var(--warning,#f59e0b)">${provisioning}</div>
        </div>` : ''}
      `;
    }

    if (devices.length === 0 && groups.length === 0) {
      main.innerHTML = `
        <div class="empty-state">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
            <line x1="8" y1="21" x2="16" y2="21"/>
            <line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
          <h3>${t('dashboard.no_displays')}</h3>
          <p>${t('dashboard.no_displays_desc')}</p>
        </div>
      `;
      return;
    }

    // Fetch group memberships
    const groupsWithDevices = await Promise.all(groups.map(async g => {
      const members = await api.getGroupDevices(g.id);
      const memberIds = new Set(members.map(m => m.id));
      // Use full device data from the main devices list (has telemetry/screenshots)
      const fullDevices = devices.filter(d => memberIds.has(d.id));
      return { ...g, devices: fullDevices, memberIds };
    }));

    // Render each device exactly once: the first group it belongs to wins.
    // memberIds is preserved for the Manage modal so multi-group membership info stays accurate.
    const renderedIds = new Set();
    for (const g of groupsWithDevices) {
      g.devices = g.devices.filter(d => {
        if (renderedIds.has(d.id)) return false;
        renderedIds.add(d.id);
        return true;
      });
    }
    const ungrouped = devices.filter(d => !renderedIds.has(d.id));

    let html = '';

    // Render each group with its devices
    for (const g of groupsWithDevices) {
      html += renderGroupSection(g, g.devices, playlists);
    }

    // Render ungrouped devices. The wrapper is tagged data-ungrouped="1" so
    // attachGroupHandlers can wire it as a drop target — dropping a device here
    // removes it from every group it currently belongs to.
    if (ungrouped.length > 0) {
      html += `
        <div class="ungrouped-section" data-ungrouped="1" style="margin-bottom:24px">
          ${groups.length > 0 ? `
          <div style="display:flex;align-items:center;margin-bottom:10px;padding:8px 12px;background:var(--bg-secondary);border-radius:8px;border-left:4px solid var(--text-muted)">
            <strong style="font-size:15px;color:var(--text-muted)">${t('dashboard.ungrouped')}</strong>
            <span style="color:var(--text-muted);font-size:12px;margin-left:10px">${tn('dashboard.devices_count', ungrouped.length)}</span>
          </div>` : ''}
          <div class="device-grid">
            ${ungrouped.map(renderDeviceCard).join('')}
          </div>
        </div>
      `;
    }

    main.innerHTML = html;
    attachGroupHandlers(groupsWithDevices, devices);

  } catch (err) {
    main.innerHTML = `<div class="empty-state"><h3>${t('dashboard.failed_to_load')}</h3><p>${esc(err.message)}</p></div>`;
  }
}

function attachGroupHandlers(groupsWithDevices, allDevices) {
  // Drag-and-drop: device cards are draggable; group sections + the Ungrouped
  // wrapper are drop targets. Drop on a group adds membership (mirrors the
  // Manage modal). Drop on Ungrouped removes the device from every group it's
  // currently a member of.
  const groupsByDeviceId = new Map();
  for (const g of groupsWithDevices) {
    g.memberIds.forEach(id => {
      if (!groupsByDeviceId.has(id)) groupsByDeviceId.set(id, []);
      groupsByDeviceId.get(id).push({ id: g.id, name: g.name });
    });
  }

  document.querySelectorAll('.device-card').forEach(card => {
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/device-id', card.dataset.deviceId);
      e.dataTransfer.setData('text/device-name', card.dataset.deviceName || '');
      e.dataTransfer.effectAllowed = 'move';
    });
  });

  function highlightOn(el) { el.style.outline = '2px solid var(--primary)'; el.style.outlineOffset = '2px'; }
  function highlightOff(el) { el.style.outline = ''; el.style.outlineOffset = ''; }

  document.querySelectorAll('.group-section').forEach(section => {
    section.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('text/device-id')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      highlightOn(section);
    });
    section.addEventListener('dragleave', (e) => {
      // Avoid flicker when moving across child elements
      if (e.target === section) highlightOff(section);
    });
    section.addEventListener('drop', async (e) => {
      e.preventDefault();
      highlightOff(section);
      const deviceId = e.dataTransfer.getData('text/device-id');
      const deviceName = e.dataTransfer.getData('text/device-name') || 'this device';
      if (!deviceId) return;
      const groupId = section.dataset.groupId;
      const targetGroup = groupsWithDevices.find(g => g.id === groupId);
      if (!targetGroup) return;
      // Already in this group — no-op.
      if (targetGroup.memberIds.has(deviceId)) {
        showToast(t('dashboard.toast.already_in_group', { name: deviceName, group: targetGroup.name }), 'info');
        return;
      }
      // If the device is in another group, mirror the Manage modal's confirm.
      const others = (groupsByDeviceId.get(deviceId) || []).map(g => g.name);
      if (others.length > 0) {
        if (!confirm(t('dashboard.confirm_add_to_group', { name: deviceName, groups: others.join(', '), target: targetGroup.name }))) return;
      }
      try {
        await api.addDeviceToGroup(groupId, deviceId);
        showToast(t('dashboard.toast.moved_device', { name: deviceName, group: targetGroup.name }), 'success');
        loadDashboard();
      } catch (err) { showToast(err.message, 'error'); }
    });
  });

  // Ungrouped wrapper: remove device from every group it's in.
  document.querySelectorAll('[data-ungrouped="1"]').forEach(section => {
    section.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('text/device-id')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      highlightOn(section);
    });
    section.addEventListener('dragleave', (e) => {
      if (e.target === section) highlightOff(section);
    });
    section.addEventListener('drop', async (e) => {
      e.preventDefault();
      highlightOff(section);
      const deviceId = e.dataTransfer.getData('text/device-id');
      const deviceName = e.dataTransfer.getData('text/device-name') || 'this device';
      if (!deviceId) return;
      const memberships = groupsByDeviceId.get(deviceId) || [];
      if (memberships.length === 0) return; // already ungrouped
      try {
        await Promise.all(memberships.map(m => api.removeDeviceFromGroup(m.id, deviceId)));
        showToast(tn('dashboard.toast.removed_device', memberships.length, { name: deviceName }), 'success');
        loadDashboard();
      } catch (err) { showToast(err.message, 'error'); }
    });
  });

  // Playlist assignment handlers
  document.querySelectorAll('.group-playlist-select').forEach(select => {
    select.addEventListener('change', async (e) => {
      const playlistId = e.target.value;
      if (!playlistId) return;
      const groupId = e.target.dataset.groupId;
      const groupName = e.target.dataset.groupName;
      const playlistName = e.target.options[e.target.selectedIndex].textContent;

      if (!confirm(t('dashboard.confirm_assign_playlist', { playlist: playlistName, group: groupName }))) {
        e.target.value = '';
        return;
      }

      try {
        const result = await api.groupAssignPlaylist(groupId, playlistId);
        showToast(tn('dashboard.toast.playlist_assigned', result.devices_updated), 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
      e.target.value = '';
    });
  });

  // Command select handlers
  document.querySelectorAll('.group-cmd-select').forEach(select => {
    select.addEventListener('change', async (e) => {
      const type = e.target.value;
      if (!type) return;
      const groupId = e.target.dataset.groupId;
      const groupName = e.target.dataset.groupName;
      const count = e.target.dataset.deviceCount;
      const cmdLabel = t(CMD_LABEL_KEY[type] || type);

      if (DESTRUCTIVE_COMMANDS.includes(type)) {
        if (!confirm(t('dashboard.confirm_destructive_command', { cmd: cmdLabel.toUpperCase(), n: count, group: groupName }))) {
          e.target.value = '';
          return;
        }
      }

      try {
        const result = await api.sendGroupCommand(groupId, type);
        const msg = result.offline > 0
          ? t('dashboard.toast.command_sent_with_offline', { cmd: cmdLabel, sent: result.sent, total: result.total, offline: result.offline })
          : t('dashboard.toast.command_sent', { cmd: cmdLabel, sent: result.sent, total: result.total });
        showToast(msg, result.offline > 0 ? 'warning' : 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
      e.target.value = '';
    });
  });

  // Delete group
  document.querySelectorAll('[data-group-delete]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.groupDelete;
      if (!confirm(t('dashboard.confirm_delete_group'))) return;
      try {
        await api.deleteGroup(id);
        showToast(t('dashboard.toast.group_deleted'), 'success');
        loadDashboard();
      } catch (e) { showToast(e.message, 'error'); }
    });
  });

  // Manage group (add/remove devices)
  document.querySelectorAll('[data-group-manage]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const groupId = btn.dataset.groupManage;
      const group = groupsWithDevices.find(g => g.id === groupId);
      const memberIds = new Set(group.devices.map(d => d.id));

      // Get all groups for multi-group warning
      const otherGroups = groupsWithDevices.filter(g => g.id !== groupId);

      const modal = document.createElement('div');
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:1000';
      modal.innerHTML = `
        <div style="background:var(--bg-card);border-radius:12px;padding:24px;max-width:400px;width:90%;max-height:70vh;overflow-y:auto">
          <h3 style="margin:0 0 4px">${esc(group.name)}</h3>
          <p style="margin:0 0 16px;font-size:12px;color:var(--text-muted)">${t('dashboard.manage_group_subtitle')}</p>
          <div style="display:flex;flex-direction:column;gap:6px">
            ${allDevices.filter(d => d.status !== 'provisioning').map(d => {
              const inOther = otherGroups.filter(g => g.memberIds.has(d.id)).map(g => g.name);
              return `
                <label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;background:var(--bg-secondary)">
                  <input type="checkbox" data-device-id="${d.id}" data-in-groups="${inOther.join(',')}" ${memberIds.has(d.id) ? 'checked' : ''}>
                  <span class="status-dot ${d.status}" style="width:8px;height:8px"></span>
                  <span style="font-size:13px;flex:1">${esc(d.name)}</span>
                  ${inOther.length > 0 ? `<span style="font-size:10px;color:var(--text-muted);background:var(--bg-primary);padding:1px 6px;border-radius:8px">${esc(inOther.join(', '))}</span>` : ''}
                </label>
              `;
            }).join('')}
          </div>
          <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
            <button class="btn" id="manageGroupClose">${t('common.done')}</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      modal.querySelector('#manageGroupClose').onclick = () => { modal.remove(); loadDashboard(); };
      modal.addEventListener('click', (ev) => { if (ev.target === modal) { modal.remove(); loadDashboard(); } });

      modal.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', async () => {
          const deviceId = cb.dataset.deviceId;
          const existingGroups = cb.dataset.inGroups;
          const cbName = cb.closest('label')?.querySelector('span:not(.status-dot)')?.textContent || '';
          try {
            if (cb.checked && existingGroups) {
              if (!confirm(t('dashboard.confirm_add_to_group', { name: cbName, groups: existingGroups, target: group.name }))) {
                cb.checked = false;
                return;
              }
            }
            if (cb.checked) {
              await api.addDeviceToGroup(groupId, deviceId);
            } else {
              await api.removeDeviceFromGroup(groupId, deviceId);
            }
          } catch (err) {
            showToast(err.message, 'error');
            cb.checked = !cb.checked;
          }
        });
      });
    });
  });
}

export function cleanup() {
  if (statusHandler) off('device-status', statusHandler);
  if (screenshotHandler) off('screenshot-ready', screenshotHandler);
  off('device-added', () => {});
  off('device-removed', () => {});
  if (refreshInterval) clearInterval(refreshInterval);
  statusHandler = null;
  screenshotHandler = null;
  refreshInterval = null;
}
