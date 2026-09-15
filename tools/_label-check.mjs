// Reproduce the interval-switching axis-label bug and prove the fix.
// Serves dashboard/index.html from disk (so it does not depend on whatever
// process is holding port 3001) and proxies /api to the live API.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const PROJECT = process.argv[2];
const API = 'http://127.0.0.1:3001';
const PORT = 3399;

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
      const body = await r.text();
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(body);
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

// ---- run the dashboard script exactly as a browser would -----------------
const BASE = `http://127.0.0.1:${PORT}`;
const realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => realFetch(new URL(String(u), BASE).href, o);

const page = await (await realFetch(BASE + '/')).text();
const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
const ids = [...page.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
let log = [];
function ctx(lb) {
  return new Proxy(
    {},
    {
      get(_t, p) {
        const q = String(p);
        if (q === 'createLinearGradient') return () => ({ addColorStop: () => {} });
        if (q === 'measureText') return () => ({ width: 10 });
        return (...a) => log.push([lb, q, a]);
      },
      set(_t, p, v) {
        log.push([lb, 'set:' + String(p), [v]]);
        return true;
      },
    },
  );
}
function el(id) {
  const e = {
    id, _html: '', textContent: '', clientWidth: 1000, style: {}, attrs: {}, children: [],
    getAttribute: (k) => (k === 'height' ? (id === 'volCanvas' ? '150' : '280') : null),
    setAttribute: (k, v) => { e.attrs[k] = v; },
    appendChild(c) { e.children.push(c); },
    onclick: null, listeners: {},
    getContext: () => ctx(id),
    click() { if (e.onclick) e.onclick(); },
  };
  Object.defineProperty(e, 'innerHTML', { get: () => e._html, set: (v) => { e._html = v; if (v === '') e.children = []; } });
  return e;
}
const store = new Map(ids.map((i) => [i, el(i)]));
globalThis.document = { getElementById: (i) => store.get(i) ?? null, createElement: () => el('x') };
globalThis.window = { devicePixelRatio: 1, addEventListener: () => {} };
globalThis.setInterval = () => 0;

new Function(script)();
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
await settle(2500);

console.log('\naxis labels per interval (window fixed at 6h)\n' + '-'.repeat(74));
const seg = store.get('segInterval');
let problems = 0;

/**
 * Split the op log into individual draw calls.
 *
 * The dashboard redraws on a 15s timer, so the log can contain more than one
 * draw. Counting labels across two draws reports duplicates that are only an
 * artefact of the log, not of the chart. Every draw starts with setTransform.
 */
function partitionDraws(entries, canvas) {
  const draws = [];
  let current = null;
  for (const e of entries) {
    if (e[0] !== canvas) continue;
    if (e[1] === 'setTransform') {
      current = [];
      draws.push(current);
      continue;
    }
    if (current) current.push(e);
  }
  return draws;
}

for (const iv of ['1m', '5m', '15m', '1h', '4h', '1d']) {
  const btn = seg.children.find((c) => c.textContent === iv);
  if (!btn) {
    console.log(`  ${iv}: BUTTON MISSING`);
    problems++;
    continue;
  }
  log = [];
  btn.click();
  await settle(2200);

  const draws = partitionDraws(log, 'priceCanvas');
  const lastDraw = draws[draws.length - 1] ?? [];
  const labels = lastDraw.filter((e) => e[1] === 'fillText').map((e) => e[2][0]);
  const uniq = new Set(labels);
  const dup = labels.length > 1 && uniq.size < labels.length;
  const bars = log.filter((e) => e[0] === 'volCanvas' && e[1] === 'fillRect').length;
  const marker = lastDraw.filter((e) => e[1] === 'arc').length;
  const nan = lastDraw
    .filter((e) => e[1] === 'lineTo' || e[1] === 'moveTo')
    .filter((e) => !Number.isFinite(e[2][0]) || !Number.isFinite(e[2][1])).length;

  console.log(
    `  ${iv.padEnd(4)} draws=${draws.length} bars=${String(bars).padEnd(3)} nan=${nan} labels=${JSON.stringify(labels).padEnd(40)}${marker ? ' +single-point marker' : ''}`,
  );
  if (dup) {
    console.log(`       DUPLICATE AXIS LABELS in one draw -> looks broken`);
    problems++;
  }
  if (nan) {
    console.log(`       NON-FINITE COORDINATES -> chart would be blank`);
    problems++;
  }
}

console.log('\nwidth stability across redraws (the growth-loop check)\n' + '-'.repeat(74));
// Trigger several redraws by bouncing between intervals, then confirm the
// canvas is not getting wider each time. Before the fix the width attribute was
// read back as the layout width and multiplied by dpr on every draw.
const before = log.filter((e) => e[0] === 'priceCanvas' && e[1] === 'set:width').map((e) => e[2][0]);
for (const iv of ['1m', '5m', '1m', '5m', '1m']) {
  const btn = seg.children.find((c) => c.textContent === iv);
  log = [];
  btn.click();
  await settle(1800);
  const w = log.filter((e) => e[0] === 'priceCanvas' && e[1] === 'set:width').map((e) => e[2][0]);
  const styleW = log.filter((e) => e[0] === 'priceCanvas' && e[1] === 'set:width' && e[2][0] === '100%');
  console.log(`  interval ${iv.padEnd(4)} set:width values = ${JSON.stringify(w)}`);
}
const widths = log.filter((e) => e[0] === 'priceCanvas' && e[1] === 'set:width').map((e) => e[2][0]);
const numeric = widths.filter((v) => typeof v === 'number');
if (numeric.length > 1) {
  const grew = numeric.some((v, i) => i > 0 && v > numeric[0]);
  console.log(`  numeric widths: ${numeric.join(', ')}`);
  if (grew) { console.log('  RUNAWAY: width increases across redraws'); problems++; }
}

server.close();
console.log('-'.repeat(74));
console.log(problems === 0 ? 'no duplicate axis labels at any interval' : `${problems} problem(s)`);
process.exit(problems === 0 ? 0 : 1);
