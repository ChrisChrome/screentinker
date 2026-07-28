'use strict';

// The week calendar now supports direct manipulation — drag empty space to create, drag a block to
// move it, drag its grip to resize. The gestures are only as good as the arithmetic underneath,
// and that arithmetic fails quietly: an off-by-one hour, a block that ends before it starts, or a
// UTC conversion that moves a schedule to the previous day all LOOK fine on screen and only show
// up as a screen playing at the wrong time.
//
// So the maths lives in frontend/js/lib/schedule-grid.js as pure functions and is pinned here.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MOD = pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'js', 'lib', 'schedule-grid.js')).href;
let G;
test('load the module', async () => { G = await import(MOD); assert.ok(G.HOUR_PX > 0); });

test('pixels and minutes round-trip', async () => {
  G = G || await import(MOD);
  for (const min of [0, 15, 90, 447, 1439]) {
    assert.ok(Math.abs(G.pxToMinutes(G.minutesToPx(min)) - min) < 0.001, `${min} survives`);
  }
});

test('snapping goes to the NEAREST quarter, not the one below', async () => {
  // Dragging to 10:58 means 11:00. Flooring would silently give 10:45 and read as a broken drag.
  assert.equal(G.snapMinutes(658), 660);
  assert.equal(G.snapMinutes(652), 645);
  assert.equal(G.snapMinutes(0), 0);
});

test('a drag upward is still a valid range', async () => {
  // Anchor at 14:00, drag up to 12:00 — Outlook treats the anchor as the end. Without this the
  // range inverts and the schedule is nonsense.
  const r = G.rangeFromDrag(840, 720);
  assert.equal(r.startMin, 720);
  assert.equal(r.endMin, 840);
});

test('a click without movement still yields a usable block, not a zero-height one', async () => {
  const r = G.rangeFromDrag(600, 600);
  assert.equal(r.endMin - r.startMin, G.MIN_DURATION_MIN, 'a minimum length is enforced');
});

test('a range cannot escape the day', async () => {
  const late = G.rangeFromDrag(1430, 1600);
  assert.ok(late.endMin <= G.DAY_MIN, 'clamped to midnight');
  assert.ok(late.startMin < late.endMin, 'and still valid');
  const early = G.rangeFromDrag(-120, 30);
  assert.ok(early.startMin >= 0);
});

test('MOVING a block keeps its length — that is what makes it a move', async () => {
  const r = G.moveRange(9 * 60, 90);
  assert.equal(r.startMin, 540);
  assert.equal(r.endMin, 630);
  assert.equal(r.endMin - r.startMin, 90);
});

test('a move near midnight slides back instead of being truncated', async () => {
  // Truncating would quietly shorten a 2h schedule to 10 minutes.
  const r = G.moveRange(23 * 60 + 50, 120);
  assert.equal(r.endMin, G.DAY_MIN);
  assert.equal(r.endMin - r.startMin, 120, 'length preserved');
});

test('RESIZING moves only the end', async () => {
  const r = G.resizeRange(540, 700);
  assert.equal(r.startMin, 540);
  assert.equal(r.endMin, 705, 'snapped');
});

test('resizing above the start does not invert the block', async () => {
  const r = G.resizeRange(600, 300);
  assert.equal(r.startMin, 600);
  assert.equal(r.endMin, 600 + G.MIN_DURATION_MIN);
});

test('THE TIMEZONE TRAP: the stamp is LOCAL, not UTC', async () => {
  // toISOString() would render 00:30 local as the PREVIOUS day for anyone west of Greenwich —
  // the same class of bug as storing a schedule in the wrong zone.
  const d = new Date(2026, 6, 28, 12, 0, 0);          // 28 Jul 2026, local
  assert.equal(G.toLocalStamp(d, 30), '2026-07-28T00:30:00', 'early morning stays on the 28th');
  assert.equal(G.toLocalStamp(d, 23 * 60 + 45), '2026-07-28T23:45:00', 'late evening too');
});

test('the stamp is minute-accurate across the day', async () => {
  const d = new Date(2026, 0, 5, 8, 0, 0);
  assert.equal(G.toLocalStamp(d, 0), '2026-01-05T00:00:00');
  assert.equal(G.toLocalStamp(d, 13 * 60 + 15), '2026-01-05T13:15:00');
});

test('a one-off may be dragged to another DAY; a repeating one may not', async () => {
  // A one-off's day IS its date. A repeating schedule's day comes from its rule, so dragging an
  // instance sideways would rewrite the recurrence for every other occurrence too — that belongs
  // in the dialog, not in a mouse gesture.
  assert.equal(G.canMoveAcrossDays({ id: 1 }), true);
  assert.equal(G.canMoveAcrossDays({ id: 2, recurrence: 'FREQ=WEEKLY' }), false);
});

test('editing a repeating schedule is flagged as editing the series', async () => {
  assert.equal(G.editsWholeSeries({ recurrence: 'FREQ=DAILY' }), true);
  assert.equal(G.editsWholeSeries({}), false);
});

test('the drag readout is human, not 24h minutes', async () => {
  assert.equal(G.formatRange(540, 630), '9:00 AM – 10:30 AM');
  assert.equal(G.formatRange(0, 45), '12:00 AM – 12:45 AM');
  assert.equal(G.formatRange(720, 780), '12:00 PM – 1:00 PM');
});
