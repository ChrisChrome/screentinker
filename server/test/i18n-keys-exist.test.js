'use strict';

// t() returns the KEY ITSELF when a string is missing — `registry[lang]?.[key] ?? fallback[key] ?? key`.
// It never returns undefined. Two consequences, both of which have already bitten:
//
//   1. A missing key ships to the user as raw text. A browser run found a context menu whose only
//      item read "schedule.ctx_new".
//   2. `t('x') || 'Some default'` looks like a safety net but is dead code, because the key string
//      is truthy. The default can never render, so it hides the missing key instead of covering it.
//
// Neither shows up in a unit test of the logic, or in a syntax check, or in review — only in front
// of a user. So this walks the views for the keys they actually ask for and checks English has them.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend', 'js');
const EN = fs.readFileSync(path.join(FRONTEND, 'i18n', 'en.js'), 'utf8');

// Keys defined in en.js, as written: 'some.key': '...'
const defined = new Set([...EN.matchAll(/^\s*'([^']+)'\s*:/gm)].map(m => m[1]));

function sourceFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'i18n') out.push(...sourceFiles(p)); }
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// Only literal t('...') calls — a computed key cannot be checked statically, and pretending
// otherwise would produce false failures.
function referencedKeys(src) {
  return [...src.matchAll(/\bt\(\s*'([a-z0-9_]+(?:\.[a-z0-9_]+)+)'/gi)].map(m => m[1]);
}

test('every literal t() key used by the app exists in English', () => {
  const missing = [];
  for (const file of sourceFiles(FRONTEND)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const key of referencedKeys(src)) {
      if (!defined.has(key)) missing.push(`${path.relative(FRONTEND, file)}: ${key}`);
    }
  }
  assert.deepEqual(missing, [],
    `these render as raw key text to the user:\n  ${missing.join('\n  ')}`);
});

test('no t() call carries a || default, which can never fire', () => {
  // The pattern reads as a safety net and is the opposite: it guarantees the missing key is
  // silently shipped instead of the readable default.
  const offenders = [];
  for (const file of sourceFiles(FRONTEND)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bt\(\s*'[^']+'\s*(?:,[^)]*)?\)\s*\|\|\s*'/g)) {
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`${path.relative(FRONTEND, file)}:${line}`);
    }
  }
  assert.deepEqual(offenders, [],
    `t() never returns falsy, so these defaults are dead:\n  ${offenders.join('\n  ')}`);
});

test('the getting-started checklist has all of its strings', () => {
  // Called out separately because it is brand-new copy and entirely user-facing.
  for (const k of ['gs.title', 'gs.progress', 'gs.dismiss',
    'gs.device.title', 'gs.device.desc', 'gs.device.cta',
    'gs.content.title', 'gs.content.desc', 'gs.content.cta',
    'gs.playlist.title', 'gs.playlist.desc', 'gs.playlist.cta',
    'gs.assign.title', 'gs.assign.desc', 'gs.assign.cta']) {
    assert.ok(defined.has(k), `${k} is missing and would render literally`);
  }
});
