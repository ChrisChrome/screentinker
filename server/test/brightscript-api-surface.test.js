'use strict';

// BrightScript cannot be run, linted or type-checked here — the only interpreter is a player. So a
// call to an object that does not exist looks exactly like a call to one that does, right up until
// a display in the field stops working.
//
// That is not hypothetical. `brightsign/*.brs` shipped with a whole family of ROKU APIs in it —
// roFileSystem, roMessageDigest, PostFromStringWithRetry — because BrightScript is Roku's language
// and the two references read almost identically. Each one silently disabled a feature: the
// self-update path could never mark a package applied, verification returned false unconditionally
// and burned an attempt counter, and a snapshot request raised "Member function not found" from
// inside the event loop, taking the player down. None of it was visible from here.
//
// This is the cheapest thing that would have caught all of it: a deny-list of APIs that exist on
// Roku and not on BrightSign, plus the argument-shape mistakes that made calls compile and then do
// nothing. It cannot prove the scripts are right. It does stop these specific, expensive mistakes
// coming back — and every entry below was paid for once already.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', '..', 'brightsign');
const FILES = fs.readdirSync(DIR).filter((f) => f.endsWith('.brs'));

/** Source with comment lines stripped, so prose about a bug is not mistaken for the bug. */
function code(file) {
  return fs.readFileSync(path.join(DIR, file), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*'/.test(l))
    .join('\n');
}

test('there are BrightScript files to check', () => {
  assert.ok(FILES.length >= 2, `expected the host scripts, found ${FILES.join(', ')}`);
});

// Objects that exist on Roku and NOT on BrightSign. Verified against BrightSign's Object Reference,
// which lists every ro* object the platform has.
const ROKU_ONLY = [
  ['roFileSystem', 'use the global MoveFile / DeleteFile / CopyFile, or roByteArray to read'],
  ['roMessageDigest', 'use roHashGenerator("sha256"); Hash() answers with an roByteArray'],
  ['roUnzip', 'use roBrightPackage — roUnzip is not the reader for a player package'],
  ['roRegistryKey', 'use roRegistrySection'],
  ['roAssociativeArrayEx', 'plain roAssociativeArray'],
];

for (const [obj, advice] of ROKU_ONLY) {
  test(`no ${obj} — it does not exist on BrightSign (${advice})`, () => {
    for (const f of FILES) {
      assert.ok(!code(f).includes(obj), `${f} calls ${obj}, which is a Roku object. ${advice}`);
    }
  });
}

// Methods that do not exist on the object they are called on.
const BAD_METHODS = [
  ['PostFromStringWithRetry', 'roUrlTransfer has no retry variant; AsyncPostFromString + roUrlEvent is how a POST body is read'],
  ['.Final(', 'roMessageDigest-era API; roHashGenerator returns the digest from Hash()'],
  ['OpenInputFile', 'no roFileSystem here; read with roByteArray.ReadFile'],
];

for (const [needle, advice] of BAD_METHODS) {
  test(`no ${needle.replace(/[.(]/g, '')} — ${advice}`, () => {
    for (const f of FILES) {
      assert.ok(!code(f).includes(needle), `${f} calls ${needle}. ${advice}`);
    }
  });
}

test('MatchFiles is called with a DIRECTORY and a bare pattern', () => {
  // The bug that made a deployment report an empty card while `dir SD:` listed the file. MatchFiles
  // takes a directory plus a pattern and is documented to return nothing when the pattern contains
  // a separator — so passing a path as the second argument answers "no" for every file that exists.
  for (const f of FILES) {
    for (const m of code(f).matchAll(/MatchFiles\(([^)]*)\)/g)) {
      const args = m[1].split(',').map((a) => a.trim());
      assert.equal(args.length, 2, `${f}: MatchFiles needs exactly two arguments, got ${m[0]}`);
      assert.ok(!/["'].*\/.*["']/.test(args[1]) && !/\+/.test(args[1]),
        `${f}: the MatchFiles PATTERN must not contain a path separator — ${m[0]}`);
    }
  }
});

test('Unpack() is never used as if it returned a boolean', () => {
  // Unpack(path) is declared As Void. `if not package.Unpack(...)` is a type error, not an error
  // check — and reads exactly like one. Success is proven by looking for an expected file instead.
  for (const f of FILES) {
    const src = code(f);
    assert.ok(!/if\s+not\s+\w*\.?Unpack\s*\(/i.test(src),
      `${f}: Unpack() returns Void — test for an extracted file rather than its return value`);
    assert.ok(!/=\s*\w*\.?Unpack\s*\(/i.test(src), `${f}: Unpack() returns nothing to assign`);
  }
});

test('Unpack() never targets a volume root', () => {
  // "Providing a destination path of SD:/ will wipe all preexisting files from the card." Unpacking
  // an update straight to the root would erase the player's provisioning and its whole content pool
  // as a side effect of a routine upgrade.
  for (const f of FILES) {
    for (const m of code(f).matchAll(/\.Unpack\(([^)]*)\)/g)) {
      const arg = m[1].trim();
      assert.ok(!/^(root|root\$)\s*\+\s*"\/"$/.test(arg) && !/^"[A-Z0-9]+:\/"$/.test(arg),
        `${f}: ${m[0]} unpacks to a volume root, which DELETES everything already there. Stage it.`);
    }
  }
});

test('roVideoMode.SetMode() is called with exactly one argument', () => {
  // SetMode(mode As String). A second argument is a "wrong number of function parameters" abort.
  // Rotation belongs to SetScreenModes(), whose config carries the transform.
  for (const f of FILES) {
    for (const m of code(f).matchAll(/\.SetMode\(([^)]*)\)/g)) {
      assert.equal(m[1].split(',').length, 1, `${f}: ${m[0]} — SetMode takes one argument`);
    }
  }
});

test('GetStorageStatus is not called with a USBn: drive string', () => {
  // Documented: "The results of the GetStorageStatus() method are unreliable when called with a
  // USBn: parameter." The drive strings it understands are "USB:", "SD:", "SSD:", "SD2:/", "Flash:".
  for (const f of FILES) {
    assert.ok(!/GetStorageStatus\(\s*"USB\d/i.test(code(f)),
      `${f}: GetStorageStatus is unreliable with USBn: — use "USB:"`);
  }
});

test('a load-error is reported with its uri, not a url', () => {
  // `url` is a key of download-request; a load-error carries `uri`. Reading the wrong one made the
  // only diagnostic that names the failing resource print "invalid" every time.
  for (const f of FILES) {
    const src = code(f);
    if (!src.includes('load-error')) continue;
    assert.ok(!/\bdata\.url\b/.test(src), `${f}: a load-error names its resource in data.uri`);
  }
});

test('parameters do not carry BOTH a type suffix and an As clause', () => {
  // `filePath$ As String` is a shape the reference never sanctions, and a parse error would stop
  // the script loading at all — the worst possible failure, since nothing would run to report it.
  for (const f of FILES) {
    for (const m of code(f).matchAll(/(?:Function|Sub)\s+\w+\s*\(([^)]*)\)/g)) {
      for (const param of m[1].split(',')) {
        assert.ok(!/[$%!#&]\s+As\s+/i.test(param),
          `${f}: parameter "${param.trim()}" has a type suffix and an As clause`);
      }
    }
  }
});

test('the storage root is resolved by probing, not assumed', () => {
  // Knowing only FLASH and SD meant that fitting real storage to a flash-booting player and moving
  // the deployment onto it resolved every derived path to a volume that was not there.
  const src = code('autorun.brs');
  const fn = src.slice(src.indexOf('Function StorageRoot'));
  for (const vol of ['SSD:', 'USB1:', 'FLASH:']) {
    assert.ok(fn.slice(0, 900).includes(vol), `StorageRoot() must consider ${vol}`);
  }
});

test('the widget storage path is absolute, on a real volume', () => {
  // "/cache" carries no drive specifier, so the widget's local storage has nowhere to persist.
  const src = code('autorun.brs');
  assert.ok(!/storage_path:\s*"\/[^"]*"/.test(src),
    'storage_path must name a volume — a bare "/path" is outside the writable volumes');
  assert.match(src, /storage_path:\s*StorageRoot\(\)/);
});

test('no doubled quotes inside a string literal — BrightScript has no escape sequences', () => {
  // The one that cost a player its boot. `"{""width"":"` is not an escaped quote; it is three
  // adjacent string literals with no operator between them, and the compiler rejects the WHOLE
  // FILE: "ScriptLoadError: Syntax Error. (compile error &h02) in SSD:/autorun.brs(196)". The
  // display came up with nothing at all — not a broken feature, no player. A quote in a literal has
  // to come from Chr(34).
  for (const f of FILES) {
    const lines = fs.readFileSync(path.join(DIR, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*'/.test(line)) return;
      // `""` hugged by non-delimiters is a literal trying to contain a quote; `, ""` or `("")` is
      // simply an empty string argument and is fine.
      assert.ok(!/[^\s(,=]""[^\s),]/.test(line),
        `${f}:${i + 1}: a string literal cannot contain a quote — build it with Chr(34)\n    ${line.trim()}`);
    });
  }
});

test('every string literal on a line is closed', () => {
  // An odd number of quotes is the same class of failure: it takes the whole script down, and
  // nothing here can run it to find out.
  for (const f of FILES) {
    const lines = fs.readFileSync(path.join(DIR, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*'/.test(line)) return;
      const beforeComment = line.split(/\s'(?=(?:[^"]*"[^"]*")*[^"]*$)/)[0];
      const quotes = (beforeComment.match(/"/g) || []).length;
      assert.equal(quotes % 2, 0, `${f}:${i + 1}: unbalanced quotes\n    ${line.trim()}`);
    });
  }
});
