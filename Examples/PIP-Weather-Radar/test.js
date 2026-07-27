'use strict';
const r = require('./radar');

let pass = true;
const checks = [];
function ok(name, cond) { checks.push([name, !!cond]); if (!cond) pass = false; }

// fixture: NWS-style FeatureCollection
const now = Date.parse('2026-06-18T22:00:00Z');
const fc = {
  type: 'FeatureCollection',
  features: [
    { id: 'A', properties: { id: 'A', event: 'Tornado Warning', severity: 'Extreme', expires: '2026-06-18T22:30:00Z', headline: 'TOR until 5:30' }, geometry: { type: 'Polygon', coordinates: [[[0, 0]]] } },
    { id: 'B', properties: { id: 'B', event: 'Flood Warning', severity: 'Severe', expires: '2026-06-18T21:00:00Z', headline: 'expired' }, geometry: { type: 'Polygon', coordinates: [[[0, 0]]] } },
    { id: 'C', properties: { id: 'C', event: 'Heat Advisory', severity: 'Moderate', expires: '2026-06-19T00:00:00Z', headline: 'not a warning' }, geometry: { type: 'Polygon', coordinates: [[[0, 0]]] } },
    { id: 'D', properties: { id: 'D', event: 'Severe Thunderstorm Warning', severity: 'Severe', expires: '2026-06-18T22:45:00Z', headline: 'SVR' }, geometry: null },
  ],
};
const alerts = r.normaliseFeatureCollection(fc);
const byId = Object.fromEntries(alerts.map((a) => [a.identifier, a]));

ok('normalise parses 4', alerts.length === 4);
ok('normalise reads geometry flag', byId.A.hasGeometry === true && byId.D.hasGeometry === false);

const EV = ['Tornado Warning', 'Severe Thunderstorm Warning', 'Flash Flood Warning', 'Flood Warning'];
ok('qualifies: active tornado w/ polygon', r.qualifies(byId.A, { events: EV, now }) === true);
ok('qualifies: expired excluded', r.qualifies(byId.B, { events: EV, now }) === false);
ok('qualifies: non-listed event excluded', r.qualifies(byId.C, { events: EV, now }) === false);
ok('qualifies: missing geometry excluded', r.qualifies(byId.D, { events: EV, now }) === false);

ok('color: tornado red', r.colorForEvent('Tornado Warning') === '#FF2D2D');
ok('color: svr yellow', r.colorForEvent('Severe Thunderstorm Warning') === '#FFD12E');
ok('color: unknown -> default', r.colorForEvent('Dust Storm Warning') === r.DEFAULT_COLOR);

const url = r.frameTileUrl('https://tilecache.rainviewer.com', '/v2/radar/abc', 5, 8, 12);
ok('rainviewer tile url', url === 'https://tilecache.rainviewer.com/v2/radar/abc/256/5/8/12/4/1_1.png');

const uri = r.buildOverlayUri('https://s/radar-overlay.html', {
  lat: 43.0389, lon: -87.9065, zoom: 8, max_counties: 2, area: 'Milwaukee County, WI', states: ['WI'], events: EV,
});
const back = new URLSearchParams(uri.split('?')[1]);
ok('overlay uri: lat/lon round-trip', back.get('lat') === '43.0389' && back.get('lon') === '-87.9065');
ok('overlay uri: area round-trip', back.get('area') === 'Milwaukee County, WI');
ok('overlay uri: states/events joined', back.get('states') === 'WI' && back.get('events') === EV.join(','));
ok('overlay uri: framing clamp carried through', back.get('maxcounties') === '2');
// Omitted means "let the overlay pick its own default" — not "unlimited zoom-out".
const noClamp = new URLSearchParams(r.buildOverlayUri('https://s/x.html', { lat: 1, lon: 2 }).split('?')[1]);
ok('overlay uri: clamp omitted when unset', noClamp.get('maxcounties') === null);


// --- framing: the map may zoom, but it must never pan -------------------------------
// frameFor lives in browser code, so lift the real source out and run it against a
// stand-in for L.latLngBounds (pure math in Leaflet — no DOM involved). Testing the
// shipped function beats testing a copy of it that can drift.
{
  const src = require('fs').readFileSync(__dirname + '/radar-overlay.js', 'utf8');
  const B = (s2, w, n, e) => ({
    getSouth: () => s2, getWest: () => w, getNorth: () => n, getEast: () => e,
    isValid: () => true,
    intersects(o) { return !(o.getSouth() > n || o.getNorth() < s2 || o.getWest() > e || o.getEast() < w); },
  });
  const L = { latLngBounds: (a, b) => B(a[0], a[1], b[0], b[1]) };
  const lat = 42.6052, lon = -87.8299;
  const COUNTY_DEG = 0.35, MIN_HALF_LAT = 0.18, maxCounties = 2;
  const padLat = COUNTY_DEG * maxCounties;
  const padLon = padLat / Math.max(0.2, Math.cos(lat * Math.PI / 180));
  const homeFrame = L.latLngBounds([lat - padLat, lon - padLon], [lat + padLat, lon + padLon]);
  const frameFor = eval('(' + src.match(/function frameFor\(b\) \{[\s\S]*?\n  \}/)[0] + ')');

  const centred = (f) => Math.abs((f.getSouth() + f.getNorth()) / 2 - lat) < 1e-9 &&
                         Math.abs((f.getWest() + f.getEast()) / 2 - lon) < 1e-9;

  const near = frameFor(B(42.75, -87.70, 42.95, -87.45));   // storm 20 mi NE
  ok('framing: a nearby storm still leaves the view centred on home', centred(near));
  ok('framing: a nearby storm zooms in, not out', (near.getNorth() - near.getSouth()) < 2 * padLat);

  const wide = frameFor(B(42.0, -90.5, 46.0, -87.0));       // statewide squall line
  ok('framing: a statewide line is capped at the county budget', (wide.getNorth() - wide.getSouth()) <= 2 * padLat + 1e-9);
  ok('framing: and is still centred on home', centred(wide));

  const tiny = frameFor(B(42.60, -87.83, 42.61, -87.82));   // one small cell overhead
  ok('framing: a single small cell does not slam to street level', (tiny.getNorth() - tiny.getSouth()) >= 2 * MIN_HALF_LAT - 1e-9);

  ok('framing: a storm outside the frame is not chased (hold configured view)',
     frameFor(B(44.0, -88.7, 44.6, -88.0)) === null);
  ok('framing: no bounds at all holds the configured view', frameFor(null) === null);
}

console.log(`Weather-Radar checks (${checks.filter((c) => c[1]).length}/${checks.length}):`);
for (const [name, good] of checks) console.log(`  ${good ? '✓' : '✗'} ${name}`);
console.log('\nRESULT:', pass ? 'PASS ✅' : 'FAIL ❌');
process.exit(pass ? 0 : 1);
