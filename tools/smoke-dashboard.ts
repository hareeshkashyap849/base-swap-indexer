/**
 * Headless smoke-test for the dashboard.
 *
 * Why this exists: the dashboard had a bug where the chart code read `.price`
 * and `.volume` from raw API candles, which only have `.close` and
 * `.volumeUsdc`. Every Y coordinate became NaN and both charts silently drew
 * nothing — no exception, no console error, just empty panels. Nothing in the
 * test suite or the typechecker could see it, because it is a runtime data-shape
 * mismatch in a plain-JS file inside an HTML page.
 *
 * This script runs the dashboard's real inline script against a minimal DOM
 * shim and the real API, records every canvas call, and FAILS if the geometry
 * is degenerate. Exits non-zero on failure so it can gate CI.
 *
 * Usage (API must be running):
 *   node --experimental-strip-types tools/smoke-dashboard.ts [baseUrl]
 */

const BASE = process.argv[2] ?? 'http://127.0.0.1:3001';

interface CanvasOp {
  canvas: string;
  op: string;
  args: unknown[];
}

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(label);
};

const realFetch = globalThis.fetch;
// Node's fetch rejects relative URLs; browsers resolve them. The dashboard uses
// '/api/...', so the shim must resolve against the base or every request fails
// and the "test" reports a broken dashboard that is actually fine.
globalThis.fetch = ((u: string | URL | Request, o?: RequestInit) =>
  realFetch(new URL(String(u), BASE).href, o)) as typeof fetch;

const html = await (await realFetch(`${BASE}/`)).text();
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) {
  console.error('no inline <script> found in the dashboard HTML');
  process.exit(1);
}
const script = scriptMatch[1];

const declaredIds = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const ops: CanvasOp[] = [];

function makeCtx(canvas: string) {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        const p = String(prop);
        if (p === 'createLinearGradient') {
          return () => ({ addColorStop: () => {} });
        }
        if (p === 'measureText') return () => ({ width: 10 });
        return (...args: unknown[]) => {
          ops.push({ canvas, op: p, args });
        };
      },
      set(_t, prop, value) {
        ops.push({ canvas, op: `set:${String(prop)}`, args: [value] });
        return true;
      },
    },
  );
}

interface ShimEl {
  id: string;
  _html: string;
  hidden: boolean;
  textContent: string;
  clientWidth: number;
  style: Record<string, unknown>;
  getAttribute(k: string): string | null;
  setAttribute(): void;
  appendChild(): void;
  getContext(): unknown;
}

function makeEl(id: string): ShimEl {
  const el: ShimEl = {
    id,
    _html: '',
    hidden: false,
    textContent: '',
    // A real browser lays the canvas out; 1000px is representative.
    clientWidth: 1000,
    style: {},
    getAttribute: (k: string) => (k === 'height' ? (id === 'volCanvas' ? '150' : '280') : null),
    setAttribute: () => {},
    appendChild: () => {},
    getContext: () => makeCtx(id),
  };
  Object.defineProperty(el, 'innerHTML', {
    get: () => el._html,
    set: (v: string) => {
      el._html = v;
    },
  });
  return el;
}

const store = new Map(declaredIds.map((i) => [i, makeEl(i)]));
(globalThis as Record<string, unknown>)['document'] = {
  getElementById: (id: string) => store.get(id) ?? null,
  createElement: () => makeEl('created'),
};
(globalThis as Record<string, unknown>)['window'] = {
  devicePixelRatio: 1,
  addEventListener: () => {},
};
(globalThis as Record<string, unknown>)['setInterval'] = () => 0;

let syncError: Error | null = null;
try {
  new Function(script)();
} catch (e) {
  syncError = e as Error;
}

console.log(`dashboard smoke test against ${BASE}\n`);

if (syncError) {
  check('script executes without throwing', false, syncError.message);
  console.log(`\n${failures.length} failure(s)`);
  process.exit(1);
}
check('script executes without throwing', true);

// Let the fetch chain settle.
await new Promise((r) => setTimeout(r, 4000));

const el = (id: string): ShimEl => store.get(id) as ShimEl;

// --- the error banner must stay hidden on success -------------------------
const errHtml = el('error')._html;
check('no error banner rendered', errHtml === '', errHtml.slice(0, 160));

// --- the panels must actually contain content ----------------------------
check('KPI cards rendered', el('kpis')._html.includes('class="kpi"'), `${el('kpis')._html.length} chars`);
check('trades table rendered', el('tradesBody')._html.includes('<tr>'), `${el('tradesBody')._html.length} chars`);
check('freshness strip rendered', el('strip')._html.includes('last indexed block'));
check('trades subtitle set', el('tradesSub').textContent.length > 0);
check('price panel subtitle set', el('priceSub').textContent.length > 0);

// --- the charts must have drawn real geometry ----------------------------
for (const canvas of ['priceCanvas', 'volCanvas']) {
  const canvasOps = ops.filter((o) => o.canvas === canvas);
  const coords: number[] = [];
  for (const o of canvasOps) {
    if (o.op === 'moveTo' || o.op === 'lineTo') coords.push(o.args[0] as number, o.args[1] as number);
    if (o.op === 'fillRect')
      coords.push(
        o.args[0] as number,
        o.args[1] as number,
        (o.args[0] as number) + (o.args[2] as number),
        (o.args[1] as number) + (o.args[3] as number),
      );
    if (o.op === 'fillText') coords.push(o.args[1] as number, o.args[2] as number);
  }
  const nonFinite = coords.filter((c) => !Number.isFinite(c)).length;
  check(`${canvas} drew geometry`, canvasOps.length > 20, `${canvasOps.length} ops`);
  // This is the assertion that would have caught the original bug.
  check(`${canvas} has no non-finite coordinates`, nonFinite === 0, nonFinite ? `${nonFinite} NaN/Infinity` : '');
}

// --- volume bars must have visible height --------------------------------
const bars = ops
  .filter((o) => o.canvas === 'volCanvas' && o.op === 'fillRect')
  .map((o) => o.args[3] as number);
if (bars.length > 0) {
  const maxBar = Math.max(...bars);
  check('volume bars have non-zero height', maxBar > 1, `max height ${maxBar.toFixed(2)}px`);
}

// --- price line must span a range, not collapse to one row ---------------
const lineYs = ops
  .filter((o) => o.canvas === 'priceCanvas' && o.op === 'lineTo')
  .map((o) => o.args[1] as number)
  .filter((v) => Number.isFinite(v));
if (lineYs.length > 1) {
  const spread = Math.max(...lineYs) - Math.min(...lineYs);
  check('price line spans a vertical range', spread > 1, `${spread.toFixed(1)}px`);
}

console.log('');
if (failures.length > 0) {
  console.log(`${failures.length} check(s) FAILED:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('dashboard smoke test passed');
