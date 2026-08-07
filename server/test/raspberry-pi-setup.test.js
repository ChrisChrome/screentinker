'use strict';

/*
 * The Pi installer generates another script (the kiosk launcher) and writes it to disk. Nothing
 * ever executed either one in CI, so every defect in them was found by a user on real hardware —
 * which is how #245 arrived: a menu that ignored the operator, a keyring prompt, X11 tools
 * no-oping on a Wayland Pi, and a banner spelling the product's own name wrong.
 *
 * These tests check the two things a repo can check without a Pi: that the generated script is
 * syntactically valid bash, and that the flags/guards the bug reports turned on are actually
 * present. `bash -n` on the OUTER script would not have caught any of it — the kiosk script lives
 * inside a heredoc, where a syntax error is just text until it reaches a screen.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'raspberry-pi-setup.sh');
const SRC = fs.readFileSync(SCRIPT, 'utf8');

// The kiosk launcher as the installer will write it, with the install-time expansions applied.
function generatedKioskScript() {
  const m = SRC.match(/cat > "\$PI_HOME\/screentinker-kiosk\.sh" << KIOSKEOF\n([\s\S]*?)\nKIOSKEOF/);
  assert.ok(m, 'kiosk heredoc not found — did the installer restructure?');
  return m[1]
    .replace(/\$\{KIOSK_URL\}/g, 'http://localhost:3001/player')
    .replace(/\$\{SCREENTINKER_PORT\}/g, '3001')
    .replace(/\$\{CHROMIUM_BIN\}/g, '/usr/bin/chromium-browser')
    .replace(/\\\$/g, '$')
    .replace(/\\\\/g, '\\');
}

function bashSyntaxOk(text) {
  const p = path.join(os.tmpdir(), `st-kiosk-${process.pid}-${Math.abs(text.length)}.sh`);
  fs.writeFileSync(p, text);
  try {
    execFileSync('bash', ['-n', p], { stdio: 'pipe' });
    return true;
  } catch (e) {
    throw new Error(`generated script is not valid bash:\n${e.stderr?.toString() || e.message}`);
  } finally {
    try { fs.unlinkSync(p); } catch { /* best-effort */ }
  }
}

test('#245: the installer itself is valid bash', () => {
  assert.ok(bashSyntaxOk(SRC));
});

test('#245: the kiosk launcher it generates is valid bash', () => {
  assert.ok(bashSyntaxOk(generatedKioskScript()));
});

test('#245: prompts read the terminal, not the pipe', () => {
  // `curl … | sudo bash` makes stdin the SCRIPT. bash has consumed it by the time any read
  // runs, so a plain `read` gets EOF instantly and the menu "chooses" the default without the
  // operator touching anything — reported as the menu being skipped, because it was.
  assert.match(SRC, /exec 3<\/dev\/tty/, 'prompts must come from the controlling terminal');
  // Any prompting `read` that is not the one inside ask() itself (which is the tty read).
  const reads = SRC.match(/^\s*read (?!.*-u 3).*-p /gm) || [];
  assert.equal(reads.length, 0, `every prompt must go through ask(); found a raw read: ${reads[0]}`);
  assert.match(SRC, /read .*-u 3/, 'ask() must read from the tty fd');
  // And when there is genuinely no terminal, it must SAY which way it went rather than let an
  // empty answer look like a decision.
  assert.match(SRC, /No terminal available for the menu/);
});

test('#245: Chromium is told not to ask for a keyring', () => {
  // "Choose password for keyring" on every boot: Chromium reaching for gnome-keyring on a
  // desktop session. A kiosk has nobody to answer it.
  assert.match(generatedKioskScript(), /--password-store=basic/);
});

test('#245: X11-only tools are guarded by the session type', () => {
  // Pi 5 on Bookworm defaults to Wayland, where xset/unclutter/xrandr are no-ops that log an
  // error and silently do nothing — so the Pi got no blanking suppression and no cursor
  // hiding while looking configured.
  const kiosk = generatedKioskScript();
  assert.match(kiosk, /SESSION_TYPE/, 'the launcher must detect the display server');
  const x11Block = kiosk.slice(kiosk.indexOf('if [ "$SESSION_TYPE" = "wayland" ]'), kiosk.indexOf('# Clean Chromium crash flags'));
  assert.ok(x11Block.length > 0, 'session-type branch not found');
  for (const tool of ['xset', 'unclutter']) {
    assert.ok(x11Block.includes(tool), `${tool} must live inside the session-type branch`);
  }
  assert.match(kiosk, /--ozone-platform=wayland/, 'Wayland needs the ozone backend named');
});

test('#245: the crash-restore surface is cleared, not just flagged', () => {
  // The white page on every boot after the first: a kiosk is killed by shutdown, never exits
  // cleanly, and Chromium returns with a restore surface over the player. ALT+F4 "fixed" it
  // because it closed that surface, not the player. Rewriting the flags is not enough on its
  // own — Chromium also replays the previous window set from Sessions/.
  const kiosk = generatedKioskScript();
  assert.match(kiosk, /exited_cleanly/, 'the clean-exit flag must be rewritten');
  assert.match(kiosk, /rm -rf .*Sessions/, 'the stored session must be removed too');
  assert.match(kiosk, /--disable-session-crashed-bubble/);
});

test('#245: the login banner spells the product name', () => {
  // It read "Scree Tinker" — the n was missing from the ASCII art, and it is the first thing
  // anyone sees over SSH.
  const motd = SRC.slice(SRC.indexOf("cat > /etc/motd << 'MOTDEOF'"), SRC.indexOf('MOTDEOF\n', SRC.indexOf("cat > /etc/motd") + 30));
  const lines = motd.split('\n').filter((l) => /[_\\\/|()]/.test(l) && l.trim().length > 20);
  assert.ok(lines.length >= 5, 'expected the 5-row banner');
  // Row 4 of figlet "standard" carries the distinguishing strokes: 'n' contributes "| | | |".
  const banner = lines.join('\n');
  assert.ok(banner.includes('| | | |'), 'the n glyph is missing from the banner — it reads "Scree Tinker"');
});
