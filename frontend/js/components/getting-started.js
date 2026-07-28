// "What do I do next?" — answered from what the account ACTUALLY contains.
//
// There was already an onboarding wizard, but it is a one-time modal gated on a localStorage
// flag: skip it once and it never returns, and it never knew whether you succeeded at anything.
// Someone who closed it and then wondered how to get content on a screen had nothing left to go
// on, which is exactly the confusion that got reported.
//
// A second tour would repeat that mistake. Tours are dismissed and forgotten, and they describe
// the product rather than the account. This reads real state instead, so it cannot claim you have
// done something you have not, it is still there tomorrow, and it disappears by itself once the
// first screen is actually live — no nagging anyone who already knows the product.
//
// The steps are the shortest true path to a screen showing something: get a screen connected,
// get media in, arrange it, put it on the screen.

import { t } from '../i18n.js';

// Pure: given what the account holds, which steps are done and which is next. Separated from the
// DOM so the logic that decides "you are finished" is testable — a checklist that congratulates
// you too early is worse than none.
export function computeSteps({ devices = [], content = [], playlists = [] } = {}) {
  const hasDevice = devices.length > 0;
  const hasContent = content.length > 0;
  const hasPlaylist = playlists.length > 0;
  // "On screen" is the only step that cannot be faked by creating an object and walking away:
  // some screen has to actually be pointed at something.
  const isAssigned = devices.some((d) => d.playlist_id || d.default_content_id || d.layout_id);

  const steps = [
    {
      key: 'device',
      done: hasDevice,
      title: t('gs.device.title'),
      desc: t('gs.device.desc'),
      cta: t('gs.device.cta'),
      href: '#/',
      action: 'add-device',
    },
    {
      key: 'content',
      done: hasContent,
      title: t('gs.content.title'),
      desc: t('gs.content.desc'),
      cta: t('gs.content.cta'),
      href: '#/content',
    },
    {
      key: 'playlist',
      done: hasPlaylist,
      title: t('gs.playlist.title'),
      desc: t('gs.playlist.desc'),
      cta: t('gs.playlist.cta'),
      href: '#/playlists',
    },
    {
      key: 'assign',
      done: isAssigned,
      title: t('gs.assign.title'),
      desc: t('gs.assign.desc'),
      cta: t('gs.assign.cta'),
      href: '#/',
    },
  ];

  // The NEXT step is the first unfinished one — in order, because each genuinely depends on the
  // one before it. Highlighting anything else would send someone to a screen they cannot use yet.
  const nextIndex = steps.findIndex((s) => !s.done);
  return {
    steps,
    nextIndex,
    complete: nextIndex === -1,
    doneCount: steps.filter((s) => s.done).length,
  };
}

const DISMISS_KEY = 'rd_gs_dismissed';
export const isDismissed = () => localStorage.getItem(DISMISS_KEY) === '1';
export const dismiss = () => localStorage.setItem(DISMISS_KEY, '1');
export const undismiss = () => localStorage.removeItem(DISMISS_KEY);

// Show it while there is still something to do and the user has not put it away. Deliberately
// NOT gated on "is this a new account" — someone who has had the product a month and still has no
// content is exactly who needs it.
export function shouldShow(state) {
  return !state.complete && !isDismissed();
}

export function render(host, state, { onAction } = {}) {
  if (!host) return;
  if (!shouldShow(state)) { host.innerHTML = ''; host.style.display = 'none'; return; }
  host.style.display = '';

  const { steps, nextIndex, doneCount } = state;
  host.innerHTML = `
    <div style="border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--bg-secondary);padding:16px;margin-bottom:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px">
        <div>
          <div style="font-weight:600;font-size:15px">${t('gs.title')}</div>
          <div style="color:var(--text-muted);font-size:12px;margin-top:2px">${t('gs.progress').replace('{done}', doneCount).replace('{total}', steps.length)}</div>
        </div>
        <button class="btn btn-sm" id="gsDismiss" style="color:var(--text-muted)">${t('gs.dismiss')}</button>
      </div>
      <div style="height:4px;background:var(--bg-primary);border-radius:2px;overflow:hidden;margin-bottom:14px">
        <div style="height:100%;width:${(doneCount / steps.length) * 100}%;background:var(--accent,#3B82F6);transition:width .3s"></div>
      </div>
      <div style="display:grid;gap:8px">
        ${steps.map((s, i) => {
          const isNext = i === nextIndex;
          return `
          <div style="display:flex;align-items:flex-start;gap:10px;padding:10px;border-radius:8px;
            ${isNext ? 'background:var(--bg-primary);border:1px solid var(--accent,#3B82F6)' : 'border:1px solid transparent'}">
            <div style="flex:0 0 20px;height:20px;border-radius:50%;margin-top:1px;display:flex;align-items:center;justify-content:center;
              font-size:11px;font-weight:700;
              ${s.done ? 'background:#22c55e;color:#fff' : isNext ? 'background:var(--accent,#3B82F6);color:#fff' : 'background:var(--bg-primary);color:var(--text-muted);border:1px solid var(--border)'}">
              ${s.done ? '&#10003;' : i + 1}
            </div>
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:${isNext ? '600' : '500'};${s.done ? 'color:var(--text-muted);text-decoration:line-through' : ''}">${s.title}</div>
              ${!s.done ? `<div style="color:var(--text-muted);font-size:12px;margin-top:2px">${s.desc}</div>` : ''}
            </div>
            ${!s.done && isNext ? `<button class="btn btn-primary btn-sm" data-gs-step="${s.key}" style="flex:0 0 auto">${s.cta}</button>` : ''}
          </div>`;
        }).join('')}
      </div>
    </div>`;

  host.querySelector('#gsDismiss')?.addEventListener('click', () => {
    dismiss();
    host.innerHTML = '';
    host.style.display = 'none';
  });
  host.querySelectorAll('[data-gs-step]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const step = steps.find((s) => s.key === btn.dataset.gsStep);
      if (!step) return;
      // An in-page action (open the pairing dialog) beats navigating somewhere and leaving the
      // user to find the button again.
      if (step.action && onAction && onAction(step.action)) return;
      window.location.hash = step.href;
    });
  });
}
