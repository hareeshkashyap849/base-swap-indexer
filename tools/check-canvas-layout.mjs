/**
 * Canvas layout-stability check.
 *
 * Why: the chart canvas grew on every redraw. setupCanvas() set
 * cv.width = cssW * dpr but never pinned a CSS width, and a canvas with no CSS
 * width takes its LAYOUT width from the width attribute. So each draw widened
 * the element by dpr, the next draw read that larger clientWidth and multiplied
 * again. Measured on a 1.5x display: 1500 -> 2250 -> 3375 -> 5063 -> 7595 px
 * over five redraws, and it redraws every 15 seconds. As the canvas widened,
 * more axis labels fitted into it too, which is why it also looked like the
 * time axis kept gaining rows.
 *
 * This script models the browser's layout rule faithfully — layout width comes
 * from style.width when set, otherwise from the width attribute — and drives
 * the dashboard through repeated redraws, asserting the width stays put.
 *
 * Serves dashboard/index.html from disk and proxies /api to the live server, so
 * it checks the on-disk page even while a stale process holds the port.
 *
 * Usage: node tools/check-canvas-layout.mjs <projectDir> [apiUrl]
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const PROJECT = process.argv[2];
const API = process.argv[3] ?? 'http://127.0.0.1:3001';
const PORT = 3398;

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

const DPR = 1.5; // a typical Windows display scaling factor
const CONTAINER_WIDTH = 1000; // the panel's content box

const canvasHistory = { priceCanvas: [], volCanvas: [] };

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
    // Backing-store size. Defaults mirror the height attribute in the HTML; the
    // width attribute defaults to 300 per the spec, which is exactly why a
    // missing CSS width is dangerous.
    width: 300,
    height: 150,
    drawn: false,
    get clientWidth() {
      /* THE LAYOUT MODEL. A canvas's layout width is its CSS width if one is
       * set, otherwise it is the width attribute. This single rule is what
       * produced the runaway loop, so the test must reproduce it. */
      const css = el.style['width'];
      if (css === '100%') return CONTAINER_WIDTH;
      if (css && css.endsWith('px')) return parseFloat(css);
      return el.width;
    },
    getContext() {
      if (!el.drawn) {
        if (canvasHistory[id]) canvasHistory[id].push(el.width);
        el.drawn = true;
      }
      return new Proxy(
        {},
        {
          get(_t, p) {
            const q = String(p);
            if (q === 'createLinearGradient') return () => ({ addColorStop: () => {} });
            if (q === 'measureText') return () => ({ width: 10 });
            return () => {};
          },
          set() {
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
  // Record every write to the width attribute, which is what fed the loop.
  let realWidth = el.width;
  Object.defineProperty(el, 'width', {
    get: () => realWidth,
    set: (v) => {
      realWidth = v;
      if (canvasHistory[id]) canvasHistory[id].push(v);
    },
  });
  return el;
}

const panel = makeEl('panel');
/* The canvas measures its PARENT's content box, so the parent has to report a
 * realistic width. A real .panel inside a 1180px page with 16px padding has
 * about a 1000px content box. */
Object.defineProperty(panel, 'clientWidth', { get: () => CONTAINER_WIDTH, configurable: true });

const store = new Map(ids.map((i) => [i, makeEl(i, panel)]));
globalThis.document = {
  getElementById: (i) => store.get(i) ?? null,
  createElement: () => makeEl('x', panel),
};
globalThis.window = { devicePixelRatio: DPR, addEventListener: () => {} };
globalThis.setInterval = () => 0;

new Function(script)();
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
await settle(2500);

console.log(`\ncontainer width ${CONTAINER_WIDTH}px, devicePixelRatio ${DPR}`);
console.log('expected backing-store width if the layout width is pinned: ' + CONTAINER_WIDTH * DPR + 'px');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

// Drive repeated redraws the way a user switching intervals would.
const seg = store.get('segInterval');
for (const iv of ['1m', '5m', '15m', '1h', '1m', '5m', '1m']) {
  const btn = seg.children.find((c) => c.textContent === iv);
  if (!btn) continue;
  btn.click();
  await settle(1600);
}

console.log('\nrecorded canvas.width values per draw:');
for (const [canvas, widths] of Object.entries(canvasHistory)) {
  console.log(`  ${canvas}: ${widths.join(', ')}`);
}

console.log('');
for (const [canvas, widths] of Object.entries(canvasHistory)) {
  if (widths.length === 0) {
    check(`${canvas}: was drawn at least once`, false);
    continue;
  }
  const first = widths[0];
  const max = Math.max(...widths);
  // The bug's signature: every draw multiplies by dpr.
  const grew = max > first * 1.01;
  check(`${canvas}: width does not grow across redraws`, !grew, `first=${first} max=${max} over ${widths.length} draws`);
  check(
    `${canvas}: width matches the container, not the container times dpr`,
    Math.abs(first - CONTAINER_WIDTH * DPR) < 2,
    `${first} vs expected ${CONTAINER_WIDTH * DPR}`,
  );
}

// The backing store must still be dpr-scaled for crisp text; pinning the layout
// width must not have thrown that away.
const pw = canvasHistory['priceCanvas'][0];
check('backing store is still devicePixelRatio-scaled (crispness kept)', pw >= CONTAINER_WIDTH, `${pw}px backing vs ${CONTAINER_WIDTH}px layout`);

// Layout width must be pinned in CSS for the loop to be impossible.
const canvasEl = store.get('priceCanvas');
check('CSS width is pinned on the canvas', canvasEl.style['width'] === '100%', `style.width=${JSON.stringify(canvasEl.style['width'])}`);

// Height must be a sane fixed number, never 0 (0 gives an undefined aspect
// ratio that can resolve to a huge intrinsic height).
check('CSS height is a fixed positive pixel value', /^\d+px$/.test(canvasEl.style['height'] ?? ''), `style.height=${JSON.stringify(canvasEl.style['height'])}`);

server.close();
console.log('');
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('canvas layout is stable');
