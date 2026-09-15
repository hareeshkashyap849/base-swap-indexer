/**
 * Dashboard smoke test.
 *
 * Runs the dashboard's real inline script against a minimal DOM shim and the
 * live API, records every canvas call, and fails on degenerate geometry.
 *
 * Two things this catches that nothing else does:
 *
 *   1. A field-name mismatch. The chart code once read `.price` and `.volume`
 *      from candle objects that only carry `.close` and `.volumeUsdc`, so every
 *      Y coordinate became NaN and both charts drew nothing — no exception, no
 *      console error. Canvas accepts NaN silently.
 *   2. Breakage on interaction. The charts are redrawn whenever the interval or
 *      the time window changes, so this script clicks through every combination
 *      and re-checks the geometry each time. A chart that renders correctly on
 *      first load and then breaks when you press a button is still broken.
 *
 * Usage (API must be running):
 *   npm run smoke:dashboard [baseUrl]
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
// and this test reports a broken dashboard that is actually fine.
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
let ops: CanvasOp[] = [];

function makeCtx(canvas: string) {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        const p = String(prop);
        if (p === 'createLinearGradient') return () => ({ addColorStop: () => {} });
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
  textContent: string;
  clientWidth: number;
  style: Record<string, unknown>;
  attributes: Record<string, string>;
  children: ShimEl[];
  onclick: (() => void) | null;
  listeners: Record<string, Array<() => void>>;
  getAttribute(k: string): string | null;
  setAttribute(k: string, v: string): void;
  appendChild(c: ShimEl): void;
  getContext(): unknown;
  click(): void;
}

function makeEl(id: string): ShimEl {
  const el: ShimEl = {
    id,
    _html: '',
    textContent: '',
    clientWidth: 1000, // a real browser lays the canvas out; 1000px is representative
    style: {},
    attributes: {},
    children: [],
    onclick: null,
    listeners: {},
    getAttribute(k: string) {
      if (k === 'height') return id === 'volCanvas' ? '150' : '280';
      return el.attributes[k] ?? null;
    },
    setAttribute(k: string, v: string) {
      el.attributes[k] = v;
    },
    appendChild(c: ShimEl) {
      el.children.push(c);
    },
    getContext: () => makeCtx(id),
    click() {
      // The dashboard wires buttons through both .onclick and addEventListener
      // depending on the element; support both so a click is a real click.
      if (el.onclick) el.onclick();
      for (const fn of el.listeners['click'] ?? []) fn();
    },
  };
  Object.defineProperty(el, 'innerHTML', {
    get: () => el._html,
    set: (v: string) => {
      el._html = v;
      // innerHTML='' clears children the way a browser would.
      if (v === '') el.children = [];
    },
  });
  return el;
}

const store = new Map(declaredIds.map((i) => [i, makeEl(i)]));
(globalThis as Record<string, unknown>)['document'] = {
  getElementById: (id: string) => store.get(id) ?? null,
  createElement: (tag: string) => {
    const e = makeEl(`<${tag}>`);
    e.setAttribute = (k: string, v: string) => {
      e.attributes[k] = v;
    };
    // Buttons created by the dashboard carry their handler on .onclick.
    return e;
  },
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

const el = (id: string): ShimEl => store.get(id) as ShimEl;
const settle = (ms = 3000): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- geometry
interface Geometry {
  opCount: number;
  nonFinite: number;
  priceSpread: number;
  maxBar: number;
  bars: number;
  drawn: boolean;
}

function geometryFor(canvas: string): Geometry {
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
  const ys = canvasOps
    .filter((o) => o.op === 'lineTo' || o.op === 'moveTo')
    .map((o) => o.args[1] as number)
    .filter((v) => Number.isFinite(v));
  const barHeights = canvasOps
    .filter((o) => o.op === 'fillRect')
    .map((o) => o.args[3] as number)
    .filter((v) => Number.isFinite(v));
  return {
    opCount: canvasOps.length,
    nonFinite: coords.filter((c) => !Number.isFinite(c)).length,
    priceSpread: ys.length > 1 ? Math.max(...ys) - Math.min(...ys) : 0,
    maxBar: barHeights.length ? Math.max(...barHeights) : 0,
    bars: barHeights.length,
    // emptyNote() means the chart decided there was no data
    drawn: !canvasOps.some((o) => o.op === 'fillText' && String(o.args[0]).startsWith('no ')),
  };
}

await settle();
check('no error banner after first load', el('error')._html === '', el('error')._html.slice(0, 160));
check('KPI cards rendered', el('kpis')._html.includes('class="kpi"'), `${el('kpis')._html.length} chars`);
check('trades table rendered', el('tradesBody')._html.includes('<tr>'), `${el('tradesBody')._html.length} chars`);
check('freshness strip rendered', el('strip')._html.includes('last indexed block'));

/**
 * Split the recorded ops into individual draw calls.
 *
 * The dashboard redraws on a 15s timer, so a log window can contain several
 * draws. Counting axis labels across two draws reports duplicates that are an
 * artefact of the log rather than of the chart. Each draw begins with a
 * setTransform, which is the boundary used here.
 */
function partitionDraws(canvas: string): CanvasOp[][] {
  const draws: CanvasOp[][] = [];
  let current: CanvasOp[] | null = null;
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

function assertCharts(label: string): void {
  for (const canvas of ['priceCanvas', 'volCanvas']) {
    const g = geometryFor(canvas);
    check(
      `${label}: ${canvas} drew geometry`,
      g.drawn && g.opCount > 20,
      g.drawn ? `${g.opCount} ops` : 'showed the empty-state message',
    );
    check(`${label}: ${canvas} has no non-finite coordinates`, g.nonFinite === 0, g.nonFinite ? `${g.nonFinite} NaN` : '');
  }
  const pg = geometryFor('priceCanvas');
  check(`${label}: price line spans a vertical range`, pg.priceSpread > 1, `${pg.priceSpread.toFixed(1)}px`);
  const vg = geometryFor('volCanvas');
  check(`${label}: volume bars have height`, vg.maxBar > 1, `${vg.maxBar.toFixed(2)}px over ${vg.bars} bars`);

  // Axis labels must not repeat within a single draw. Coarse intervals put
  // every bucket on a round boundary, so an hours-and-minutes formatter printed
  // "00:00 ... 00:00" for 4h and 1d — a correct chart that reads as a broken
  // time axis. Labels are now interval-aware (dates for 4h and above).
  const draws = partitionDraws('priceCanvas');
  const last = draws[draws.length - 1] ?? [];
  const labels = last.filter((o) => o.op === 'fillText').map((o) => String(o.args[0]));
  const dup = labels.length > 1 && new Set(labels).size < labels.length;
  check(`${label}: no duplicate axis labels`, !dup, labels.join(' '));
}

assertCharts('initial load');

// ------------------------------------------------- interaction: intervals
// The charts are redrawn on every control change. A chart that works on first
// paint and breaks on a button press is still broken, so every combination is
// exercised and re-checked.
const intervals = [...html.matchAll(/var INTERVALS = \[([^\]]+)\]/g)][0]?.[1]
  ?.split(',')
  .map((s) => s.trim().replace(/^'|'$/g, '')) ?? [];
const windows = [...html.matchAll(/var WINDOWS = \[([^\]]+)\]/g)][0]?.[1] ?? '';

console.log(`\ninteraction: ${intervals.length} intervals x windows = ${intervals.join(', ')}`);

for (const iv of intervals) {
  ops = [];
  const btn = el('segInterval').children.find((c) => c.textContent === iv);
  if (!btn) {
    check(`interval ${iv}: button exists`, false, 'not found in the segmented control');
    continue;
  }
  btn.click();
  await settle(2500);

  const errHtml = el('error')._html;
  check(`interval ${iv}: no error banner`, errHtml === '', errHtml.slice(0, 140));
  const g = geometryFor('priceCanvas');
  check(
    `interval ${iv}: price chart still draws`,
    g.drawn && g.opCount > 20 && g.nonFinite === 0 && g.priceSpread > 1,
    `ops=${g.opCount} nan=${g.nonFinite} spread=${g.priceSpread.toFixed(1)}px`,
  );
  const vg = geometryFor('volCanvas');
  check(
    `interval ${iv}: volume chart still draws`,
    vg.drawn && vg.nonFinite === 0 && vg.maxBar > 1,
    `ops=${vg.opCount} nan=${vg.nonFinite} maxBar=${vg.maxBar.toFixed(1)}px`,
  );

  // The regression that prompted this whole check: at 4h and 1d every bucket
  // falls on a round hour, so an HH:MM label repeated ("00:00 ... 00:00").
  const draws = partitionDraws('priceCanvas');
  const lastDraw = draws[draws.length - 1] ?? [];
  const labels = lastDraw.filter((o) => o.op === 'fillText').map((o) => String(o.args[0]));
  const dup = labels.length > 1 && new Set(labels).size < labels.length;
  check(`interval ${iv}: no duplicate axis labels`, !dup, labels.join(' '));
}

// ------------------------------------------------- interaction: windows
const windowLabels = [...windows.matchAll(/l:'([^']+)'/g)].map((m) => m[1]);
console.log(`\ninteraction: windows = ${windowLabels.join(', ')}`);
for (const w of windowLabels) {
  ops = [];
  const btn = el('segWindow').children.find((c) => c.textContent === w);
  if (!btn) {
    check(`window ${w}: button exists`, false, 'not found in the segmented control');
    continue;
  }
  btn.click();
  await settle(2500);
  const errHtml = el('error')._html;
  check(`window ${w}: no error banner`, errHtml === '', errHtml.slice(0, 140));
  const g = geometryFor('priceCanvas');
  check(
    `window ${w}: price chart still draws`,
    g.drawn && g.opCount > 20 && g.nonFinite === 0 && g.priceSpread > 1,
    `ops=${g.opCount} nan=${g.nonFinite} spread=${g.priceSpread.toFixed(1)}px`,
  );
}

console.log('');
if (failures.length > 0) {
  console.log(`${failures.length} check(s) FAILED:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('dashboard smoke test passed');
