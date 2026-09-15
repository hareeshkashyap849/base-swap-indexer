/**
 * Dashboard check: labels, geometry, and layout stability.
 *
 * Serves dashboard/index.html from disk and proxies /api to a running server, so
 * it verifies the ON-DISK page even while an older process still holds the port.
 * That matters because the API used to cache the dashboard at startup, which
 * made fixes look like they had not worked.
 *
 * Three classes of bug are covered here, each one that actually shipped:
 *
 *   1. Charts drawing nothing. The chart code read `.price` and `.volume` from
 *      candles that only carry `.close` and `.volumeUsdc`, so every Y coordinate
 *      became NaN. Canvas accepts NaN silently: blank panels, no exception.
 *      -> asserts no non-finite coordinates, non-zero bar heights, and a price
 *         line with real vertical spread.
 *
 *   2. Duplicate time-axis labels at coarse intervals. Buckets at 4h and 1d land
 *      on round hours, so an HH:MM formatter printed "00:00 ... 00:00", which
 *      reads as a broken axis even though the data is correct.
 *      -> asserts labels within a single draw are distinct.
 *
 *   3. The canvas growing on every redraw. setupCanvas() set cv.width = cssW*dpr
 *      without pinning a CSS width, and a canvas takes its LAYOUT width from the
 *      width attribute when no CSS width is set. Each draw multiplied again
 *      (1500 -> 2250 -> 3375 -> 5063 -> 7595 px measured at 1.5x), once per
 *      15-second refresh, and the widening canvas also fitted more axis labels.
 *      -> models the browser's layout rule and asserts the width is stable.
 *
 * Usage: node tools/check-dashboard.mjs <projectDir> [apiUrl]
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const PROJECT = process.argv[2];
const API = process.argv[3] ?? 'http://127.0.0.1:3001';
const PORT = 3398;

const DPR = 1.5; // a typical Windows display scaling factor
const CONTAINER_WIDTH = 1000; // .panel content box inside a 1180px page

const html = readFileSync(PROJECT + '/dashboard/index.html', 'utf8');
console.log(`serving dashboard/index.html from disk (${html.length} chars) on :${PORT}`);

const server = createServer(async (req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  if (req.url?.startsWith('/api/')) {
    try {
      const r = await fetch(API + req.url);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(await r.text());
    } catch (e) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }
  res.writeHead(404);
  res.end('not found');
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const BASE = `http://127.0.0.1:${PORT}`;
const realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => realFetch(new URL(String(u), BASE).href, o);

const page = await (await realFetch(BASE + '/')).text();
const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
const ids = [...page.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);

let ops = [];
const widthHistory = { priceCanvas: [], volCanvas: [] };

function makeEl(id, parent = null) {
  const el = {
    id,
    _html: '',
    textContent: '',
    style: {},
    attrs: {},
    children: [],
    onclick: null,
    parentElement: parent,
    width: 300, // the spec default; exactly why a missing CSS width is dangerous
    height: 150,
    drawn: false,
    get clientWidth() {
      /* THE LAYOUT MODEL — the rule that produced bug 3.
       * A canvas's layout width is its CSS width if one is set, otherwise the
       * width attribute. Reproducing this is the whole point of the harness. */
      const css = el.style['width'];
      if (css === '100%') return CONTAINER_WIDTH;
      if (css && css.endsWith('px')) return parseFloat(css);
      return el.width;
    },
    getContext() {
      if (!el.drawn) {
        if (widthHistory[id]) widthHistory[id].push(el.width);
        el.drawn = true;
      }
      return new Proxy(
        {},
        {
          get(_t, p) {
            const q = String(p);
            if (q === 'createLinearGradient') return () => ({ addColorStop: () => {} });
            if (q === 'measureText') return () => ({ width: 10 });
            return (...args) => {
              ops.push({ canvas: id, op: q, args });
            };
          },
          set(_t, p, v) {
            ops.push({ canvas: id, op: 'set:' + String(p), args: [v] });
            return true;
          },
        },
      );
    },
    getAttribute: (k) => (k === 'height' ? (el.attrs['height'] ?? '280') : (el.attrs[k] ?? null)),
    setAttribute(k, v) {
      el.attrs[k] = v;
    },
    appendChild(c) {
      el.children.push(c);
    },
    getBoundingClientRect: () => ({ width: el.clientWidth }),
    click() {
      if (el.onclick) el.onclick();
    },
  };
  Object.defineProperty(el, 'innerHTML', {
    get: () => el._html,
    set: (v) => {
      el._html = v;
      if (v === '') el.children = [];
    },
  });
  let realWidth = el.width;
  Object.defineProperty(el, 'width', {
    get: () => realWidth,
    set: (v) => {
      realWidth = v;
      if (widthHistory[id]) widthHistory[id].push(v);
    },
  });
  return el;
}

const panel = makeEl('panel');
/* The canvas measures its PARENT, so the parent must report a realistic box. */
Object.defineProperty(panel, 'clientWidth', { get: () => CONTAINER_WIDTH, configurable: true });

const store = new Map(ids.map((i) => [i, makeEl(i, panel)]));
globalThis.document = {
  getElementById: (i) => store.get(i) ?? null,
  createElement: () => makeEl('x', panel),
};
globalThis.window = { devicePixelRatio: DPR, addEventListener: () => {} };

/* Capture the dashboard's own refresh timer instead of discarding it.
 *
 * Earlier versions of this harness stubbed setInterval to a no-op, which meant
 * the auto-refresh path — the one that made the canvas grow every 15 seconds in
 * real use — was never exercised. A timer that fires on its own is exactly the
 * case where a layout feedback loop compounds, so the test has to be able to
 * trigger it. */
const timers = [];
globalThis.setInterval = (fn, ms) => {
  timers.push({ fn, ms });
  return timers.length;
};
globalThis.clearInterval = () => {};

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

console.log(`\ncontainer ${CONTAINER_WIDTH}px, devicePixelRatio ${DPR}`);
console.log('expected backing-store width: ' + CONTAINER_WIDTH * DPR + 'px\n');

let syncError = null;
try {
  new Function(script)();
} catch (e) {
  syncError = e;
}
check('dashboard script executes', !syncError, syncError ? syncError.message : '');
if (syncError) {
  server.close();
  process.exit(1);
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const el = (id) => store.get(id);

/** Split the op log into individual draws; each begins with setTransform. */
function partitionDraws(canvas) {
  const draws = [];
  let current = null;
  for (const o of ops) {
    if (o.canvas !== canvas) continue;
    if (o.op === 'setTransform') {
      current = [];
      draws.push(current);
      continue;
    }
    if (current) current.push(o);
  }
  return draws;
}

await settle(2500);

// --- structural -----------------------------------------------------------
check('no error banner', el('error')._html === '', el('error')._html.slice(0, 140));
check('KPI cards rendered', el('kpis')._html.includes('class="kpi"'), `${el('kpis')._html.length} chars`);
check('trades table rendered', el('tradesBody')._html.includes('<tr>'), `${el('tradesBody')._html.length} chars`);
check('freshness strip rendered', el('strip')._html.includes('last indexed block'));

// --- per interval: geometry and labels -----------------------------------
const seg = el('segInterval');
const intervals = [...html.matchAll(/var INTERVALS = \[([^\]]+)\]/g)][0]?.[1]
  .split(',')
  .map((s) => s.trim().replace(/^'|'$/g, '')) ?? [];

console.log('\nper interval (geometry and axis labels)');
for (const iv of intervals) {
  const btn = seg.children.find((c) => c.textContent === iv);
  if (!btn) {
    check(`interval ${iv}: control exists`, false);
    continue;
  }
  ops = [];
  btn.click();
  await settle(1800);

  const draws = partitionDraws('priceCanvas');
  const last = draws[draws.length - 1] ?? [];
  const coords = [];
  for (const o of last) {
    if (o.op === 'moveTo' || o.op === 'lineTo') coords.push(o.args[0], o.args[1]);
    if (o.op === 'fillText') coords.push(o.args[1], o.args[2]);
  }
  const nonFinite = coords.filter((c) => !Number.isFinite(c)).length;
  const ys = last.filter((o) => o.op === 'lineTo' || o.op === 'moveTo').map((o) => o.args[1]).filter(Number.isFinite);
  const spread = ys.length > 1 ? Math.max(...ys) - Math.min(...ys) : 0;
  const labels = last.filter((o) => o.op === 'fillText').map((o) => String(o.args[0]));
  const dup = labels.length > 1 && new Set(labels).size < labels.length;
  const bars = ops.filter((o) => o.canvas === 'volCanvas' && o.op === 'fillRect').map((o) => o.args[3]);
  const maxBar = bars.length ? Math.max(...bars.filter(Number.isFinite)) : 0;

  check(`interval ${iv}: no error banner`, el('error')._html === '');
  check(`interval ${iv}: no non-finite coordinates`, nonFinite === 0, nonFinite ? `${nonFinite} NaN` : '');
  check(`interval ${iv}: price line has vertical spread`, spread > 1, `${spread.toFixed(1)}px`);
  check(`interval ${iv}: volume bars have height`, maxBar > 1, `${maxBar.toFixed(1)}px`);
  check(`interval ${iv}: axis labels are distinct`, !dup, labels.join(' '));
}

// --- control hygiene: the segmented buttons must not accumulate -----------
//
// buildSegments() is called on every interval/window change, and the first
// version only appended to its container. So each click added another complete
// row of buttons: clicking three intervals produced four sets, and the page grew
// a new row every time. It was reported by a user as "the time buttons keep
// increasing", which is exactly what it was.
//
// This checks the count, and the count of the *other* control too, since one
// function builds both.
console.log('\ncontrol hygiene');
{
  const intervalCount = seg.children.length;
  const windowSeg = el('segWindow');
  const windowCount = windowSeg.children.length;

  check('interval control has exactly one button per interval', intervalCount === intervals.length, `${intervalCount} vs ${intervals.length}`);

  /* Count the windows by parsing the WINDOWS array itself.
   *
   * A file-wide /l:'([^']+)'/ match does NOT work: it also hits the interval
   * labels in timeLabel(), so it reported 6 windows where the array holds 5 and
   * failed a control that was correct. Scope the match to the array. */
  const windowsLiteral = html.match(/var WINDOWS = \[([^\]]+)\]/)?.[1] ?? '';
  const expectedWindows = [...windowsLiteral.matchAll(/\{l:/g)].length;
  check('window control has exactly one button per window', windowCount === expectedWindows, `${windowCount} vs ${expectedWindows}`);

  // Now click around and make sure nothing accumulates.
  for (const iv of ['1m', '5m', '1m', '1d', '5m']) {
    const btn = seg.children.find((c) => c.textContent === iv);
    if (btn) {
      btn.click();
      await settle(900);
    }
  }
  check(
    'buttons do not accumulate after 5 interval changes',
    seg.children.length === intervals.length,
    `${seg.children.length} buttons, expected ${intervals.length}`,
  );
  check(
    'window buttons do not accumulate either',
    windowSeg.children.length === expectedWindows,
    `${windowSeg.children.length} buttons, expected ${expectedWindows}`,
  );
}

// --- layout stability across redraws ------------------------------------
console.log('\nlayout stability across redraws');
for (const [canvas, widths] of Object.entries(widthHistory)) {
  if (widths.length === 0) {
    check(`${canvas}: was drawn`, false);
    continue;
  }
  const first = widths[0];
  const max = Math.max(...widths);
  check(`${canvas}: width stable across redraws`, max <= first * 1.01, `${widths.length} draws, first=${first} max=${max}`);
  check(`${canvas}: width is container x dpr`, Math.abs(first - CONTAINER_WIDTH * DPR) < 2, `${first} vs ${CONTAINER_WIDTH * DPR}`);
}
const cv = el('priceCanvas');
check('CSS width pinned on the canvas', cv.style['width'] === '100%', `style.width=${JSON.stringify(cv.style['width'])}`);
check('CSS height is a fixed positive px value', /^\d+px$/.test(cv.style['height'] ?? ''), `style.height=${JSON.stringify(cv.style['height'])}`);

// --- the auto-refresh path -------------------------------------------------
// The growth bug compounded once per refresh. Clicking controls also redraws,
// so a control-driven test can pass while the timer-driven path still blows up.
// Fire the captured timer several times and re-assert stability.
console.log('\nauto-refresh path');
check('the dashboard registered a refresh timer', timers.length > 0, timers.map((t) => `${t.ms}ms`).join(','));
if (timers.length > 0) {
  const beforeWidths = Object.fromEntries(
    Object.entries(widthHistory).map(([k, v]) => [k, v[v.length - 1]]),
  );
  for (let i = 0; i < 4; i++) {
    for (const t of timers) t.fn();
    await settle(1500);
  }
  for (const [canvas, last] of Object.entries(beforeWidths)) {
    const now = widthHistory[canvas][widthHistory[canvas].length - 1];
    check(
      `${canvas}: width stable across auto-refreshes`,
      now <= last * 1.01,
      `before=${last} after 4 refreshes=${now}`,
    );
    const max = Math.max(...widthHistory[canvas]);
    check(
      `${canvas}: never exceeded container x dpr`,
      max <= CONTAINER_WIDTH * DPR * 1.01,
      `max=${max} limit=${CONTAINER_WIDTH * DPR}`,
    );
  }
  // The charts must still be drawing after all that, not degraded to blank.
  const last = partitionDraws('priceCanvas').pop() ?? [];
  const nonFinite = last
    .filter((o) => o.op === 'moveTo' || o.op === 'lineTo')
    .filter((o) => !Number.isFinite(o.args[0]) || !Number.isFinite(o.args[1])).length;
  check('charts still draw correctly after auto-refreshes', last.length > 20 && nonFinite === 0, `${last.length} ops, ${nonFinite} NaN`);
}

server.close();
console.log('');
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('dashboard check passed');
