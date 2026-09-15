/**
 * Validate the two deployment config files plan (`.github/workflows/index.yml`
 * and `render.yaml`) before they are trusted.
 *
 * WHAT THIS CAN CHECK (locally, no accounts):
 *   - the YAML parses under a parser that has its own self-test (`--selftest`)
 *   - required keys exist, the cron fires at a sane frequency, `concurrency`
 *     is present (its absence is the most common cause of a cron job that
 *     commits to its own repo failing on push)
 *   - verify-before-commit ordering
 *   - the npm scripts / entry paths the configs reference actually exist
 *
 * WHAT IT CANNOT CHECK: whether Render accepts the manifest, whether GitHub
 * schedules the workflow as written, or how a real cold start behaves. Those
 * need real accounts. Saying otherwise would be inventing evidence.
 *
 * Run:
 *   node tools/check-deploy-configs.mjs              # validate cwd
 *   node tools/check-deploy-configs.mjs --dir <path>
 *   node tools/check-deploy-configs.mjs --selftest   # test the parser itself
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * True only when this file is the entry point.
 *
 * Without this guard, importing `parseYaml` from another script runs the whole
 * checker as a side effect and calls process.exit — which is exactly how a
 * probe script ended up printing checker output instead of parse results and
 * led to two wrong conclusions. `file://${argv[1]}` is NOT equivalent on
 * Windows (backslashes, drive letter), so use pathToFileURL.
 */
const isMain =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

/**
 * Minimal YAML subset parser.
 *
 * There is no YAML parser in Node core and this project has no YAML dependency
 * (adding one to lint two config files is not worth a dependency). So this
 * handles exactly the subset these files use and THROWS on anything it does not
 * understand rather than guessing — a linter that silently mis-parses is worse
 * than no linter.
 *
 * Supported: nested maps, sequences, sequences of maps (with continuation keys
 * indented past the dash, which is the case that broke the first version of
 * this file), quoted and plain scalars, booleans, nulls, comments (outside
 * quotes), and block scalars (`|`, `|-`, `|+`, `>`) whose body is captured
 * verbatim because it is not YAML.
 *
 * Known limitation, handled by the CALLER: `on:` in a GitHub workflow parses as
 * the boolean `true` under YAML 1.1 rules. `parseYaml` returns keys verbatim to
 * stay honest about that; `pickWorkflowTrigger` below does the key lookup.
 */
export function parseYaml(text, label = '<yaml>') {
  const rawLines = text.replace(/\r\n/g, '\n').split('\n');
  let pos = 0;

  const fail = (msg) => {
    throw new Error(`${label}:${pos + 1}: ${msg}`);
  };
  const indentOf = (l, strict = true) => {
    const lead = l.slice(0, l.length - l.trimStart().length);
    // YAML forbids tabs for indentation. Accepting them would let a
    // space-indented file and a tab-indented file parse the same way.
    if (strict && lead.includes('\t')) fail('tab character used for indentation');
    return lead.length;
  };
  /** Blank out a trailing `#` comment, ignoring `#` inside quotes. */
  function stripComment(l) {
    let inSingle = false;
    let inDouble = false;
    for (let k = 0; k < l.length; k++) {
      const c = l[k];
      if (c === "'" && !inDouble) inSingle = !inSingle;
      else if (c === '"' && !inSingle) inDouble = !inDouble;
      else if (c === '#' && !inSingle && !inDouble && (k === 0 || /\s/.test(l[k - 1]))) {
        return l.slice(0, k);
      }
    }
    return l;
  }

  /** Advance past blank / comment-only lines. Returns the next content line or null. */
  function peek() {
    while (pos < rawLines.length) {
      const c = stripComment(rawLines[pos]);
      if (c.trim() !== '') return { lineNo: pos, indent: indentOf(c), text: c.trim() };
      pos++;
    }
    return null;
  }

  /**
   * Consume a block scalar body verbatim.
   *
   * `keyIndent` is the indentation of the line holding `key: |`. The caller has
   * ALREADY advanced past that line, so this must not skip another one: an
   * extra `pos++` here silently ate the body's first line (the difference
   * between a commit step that runs and one whose first command vanishes).
   *
   * Only `parseValueOnLine` may call this, and only after the key line is
   * consumed.
   */
  function consumeBlockScalar(keyIndent, header) {
    const body = [];
    while (pos < rawLines.length) {
      const l = rawLines[pos];
      if (l.trim() === '') {
        body.push('');
        pos++;
        continue;
      }
      if (indentOf(l, false) <= keyIndent) break;
      body.push(l);
      pos++;
    }
    while (body.length && body[body.length - 1] === '') body.pop();
    // Dedent by the smallest indentation actually present, per YAML's rule for
    // determining block scalar indentation.
    const min = body.reduce(
      (acc, l) => (l.trim() === '' ? acc : Math.min(acc, indentOf(l, false))),
      Infinity,
    );
    const text = Number.isFinite(min) ? body.map((l) => l.slice(min)).join('\n') : '';
    return { kind: 'block-scalar', header, text };
  }

  function parseValueOnLine(rest, currentIndent) {
    if (rest === '') {
      const next = peek();
      if (next && next.indent > currentIndent) {
        return next.text.startsWith('- ') || next.text === '-'
          ? parseSequence(next.indent)
          : parseMap(next.indent);
      }
      return null;
    }
    if (/^[|>][+-]?\d*$/.test(rest)) return consumeBlockScalar(currentIndent, rest);
    return scalar(rest);
  }

  function parseMap(mapIndent) {
    const out = {};
    for (;;) {
      const here = peek();
      if (!here) break;
      if (here.indent < mapIndent) break;
      if (here.indent > mapIndent) fail(`unexpected indentation ${here.indent} (map entries sit at ${mapIndent})`);
      if (/^- /.test(here.text) || here.text === '-') break;

      const kv = here.text.match(/^([^:\s][^:]*?):(?:\s+(.*))?$/);
      if (!kv) fail(`cannot parse as a key/value pair: "${here.text.slice(0, 60)}"`);
      const key = kv[1];
      const rest = kv[2] === undefined ? '' : kv[2].trim();
      pos++;
      out[key] = parseValueOnLine(rest, here.indent);
    }
    return out;
  }

  function parseSequence(seqIndent) {
    const out = [];
    for (;;) {
      const here = peek();
      if (!here) break;
      if (here.indent !== seqIndent) {
        if (here.indent < seqIndent) break;
        fail(`unexpected indentation ${here.indent} inside sequence at ${seqIndent}`);
      }
      if (!/^-(\s|$)/.test(here.text)) break;

      const rest = here.text.replace(/^-\s*/, '');
      pos++;
      if (rest === '') {
        const next = peek();
        if (next && next.indent > seqIndent) {
          out.push(next.text.startsWith('- ') ? parseSequence(next.indent) : parseMap(next.indent));
        } else {
          out.push(null);
        }
        continue;
      }

      // `- key: value` starts an item map. The item's own keys continue at the
      // indentation of the first key, which is NOT necessarily seqIndent + 2.
      const kv = rest.match(/^([^:\s][^:]*?):(?:\s+(.*))?$/);
      if (!kv) {
        out.push(scalar(rest));
        continue;
      }

      const item = {};
      const dashCol = seqIndent;
      const firstKeyIndent = dashCol + 2;
      item[kv[1]] = parseValueOnLine(kv[2] === undefined ? '' : kv[2].trim(), firstKeyIndent);

      // Continuation keys of the same item.
      for (;;) {
        const next = peek();
        if (!next || next.indent <= dashCol) break;
        if (/^-(\s|$)/.test(next.text)) break;
        if (next.indent !== firstKeyIndent) {
          fail(`sequence item key at indent ${next.indent}, expected ${firstKeyIndent}`);
        }
        const kv2 = next.text.match(/^([^:\s][^:]*?):(?:\s+(.*))?$/);
        if (!kv2) fail(`cannot parse sequence item key: "${next.text.slice(0, 60)}"`);
        pos++;
        item[kv2[1]] = parseValueOnLine(kv2[2] === undefined ? '' : kv2[2].trim(), next.indent);
      }
      out.push(item);
    }
    return out;
  }

  function scalar(v) {
    const t = v.trim();
    if (t.length >= 2 && ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"')))) {
      const inner = t.slice(1, -1);
      return t.startsWith("'") ? inner.replace(/''/g, "'") : inner.replace(/\\"/g, '"');
    }
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null' || t === '~') return null;
    return t;
  }

  const first = peek();
  if (!first) return {};
  if (first.indent !== 0) fail(`document starts at indent ${first.indent}, expected 0`);
  const doc = first.text.startsWith('- ') || first.text === '-' ? parseSequence(0) : parseMap(0);
  const leftover = peek();
  if (leftover) fail(`trailing content at indent ${leftover.indent}: "${leftover.text.slice(0, 60)}"`);
  return doc;
}

/** YAML 1.1 turns a bare `on` key into boolean true; workflows mean the string. */
export function pickWorkflowTrigger(doc) {
  return doc.on ?? doc[true] ?? doc[String(true)] ?? null;
}

// --------------------------------------------------------------- self-test
/**
 * The first version of this checker had a broken sequence parser and reported
 * 14 failures against a plan document that was actually fine. A parser without
 * tests is not evidence, so this suite asserts both what must parse AND what
 * must be rejected.
 */
function selftest() {
  let pass = 0;
  let fail = 0;
  const t = (name, fn) => {
    try {
      fn();
      console.log(`  PASS  ${name}`);
      pass++;
    } catch (err) {
      console.log(`  FAIL  ${name}\n          ${err.message}`);
      fail++;
    }
  };
  const eq = (a, b, what = '') => {
    const sa = JSON.stringify(a);
    const sb = JSON.stringify(b);
    if (sa !== sb) throw new Error(`${what}expected ${sb}, got ${sa}`);
  };
  const throws = (fn, why) => {
    let threw = false;
    try {
      fn();
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`expected a parse error (${why}) but it parsed`);
  };

  console.log('=== parser self-test ===');

  t('simple map', () => eq(parseYaml('a: 1\nb: two\n'), { a: '1', b: 'two' }));
  t('nested map', () => eq(parseYaml('a:\n  b:\n    c: 1\n'), { a: { b: { c: '1' } } }));
  t('booleans', () => eq(parseYaml('x: true\ny: false\n'), { x: true, y: false }));
  t('quoted scalars keep inner punctuation', () =>
    eq(parseYaml("cron: '*/30 * * * *'\n"), { cron: '*/30 * * * *' }));
  t('comment stripped outside quotes', () => eq(parseYaml('a: 1  # note\n'), { a: '1' }));
  t('hash inside quotes is NOT a comment', () =>
    eq(parseYaml("a: 'x # y'\n"), { a: 'x # y' }));
  t('CJK comment is stripped', () => eq(parseYaml('a: 1 # 中文注释\n'), { a: '1' }));
  t('sequence of scalars', () => eq(parseYaml('s:\n  - a\n  - b\n'), { s: ['a', 'b'] }));
  t('sequence of maps, keys indented past the dash', () =>
    eq(parseYaml('s:\n  - type: web\n    name: x\n    plan: free\n'), {
      s: [{ type: 'web', name: 'x', plan: 'free' }],
    }));
  t('sequence of maps with a nested map under a key', () =>
    eq(parseYaml("st:\n  - uses: a@v4\n    with:\n      node-version: '24'\n  - run: go\n"), {
      st: [{ uses: 'a@v4', with: { 'node-version': '24' } }, { run: 'go' }],
    }));
  t('nested sequence inside a sequence item', () =>
    eq(parseYaml('a:\n  - b:\n      - 1\n      - 2\n'), { a: [{ b: ['1', '2'] }] }));
  t('blank lines between sequence items', () =>
    eq(parseYaml('s:\n  - a\n\n  - b\n'), { s: ['a', 'b'] }));
  t('comment line between sequence items', () =>
    eq(parseYaml('s:\n  - a\n  # note\n  - b\n'), { s: ['a', 'b'] }));
  t('block scalar captured verbatim, not parsed as YAML', () => {
    const doc = parseYaml('run: |\n  git commit -m "x"\n  git push\n');
    eq(doc.run.kind, 'block-scalar');
    eq(doc.run.text, 'git commit -m "x"\ngit push');
  });
  t('block scalar body may contain colons and dashes', () => {
    const doc = parseYaml('run: |\n  if a; then\n    echo "no new: blocks"\n  fi\n');
    eq(doc.run.text, 'if a; then\n  echo "no new: blocks"\nfi');
  });
  t('block scalar does not swallow the next top-level key', () =>
    eq(parseYaml('run: |\n  line1\nnext: 2\n').next, '2'));
  t('key with empty value at end is null', () => eq(parseYaml('a:\n'), { a: null }));
  t('empty document', () => eq(parseYaml(''), {}));
  t('CJK value survives', () => eq(parseYaml('a: 中文值\n'), { a: '中文值' }));

  // Rejections — a parser that accepts everything proves nothing.
  t('rejects a tab-indented key', () => throws(() => parseYaml('a:\n\tb: 1\n'), 'tabs'));
  t('rejects a line with no colon', () => throws(() => parseYaml('a: 1\njust a sentence\n'), 'no colon'));
  t('rejects a sequence item key at the wrong indent', () =>
    throws(() => parseYaml('s:\n  - a: 1\n   b: 2\n'), 'misaligned item key'));

  console.log('');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

if (isMain && process.argv.includes('--selftest')) selftest();

// Everything below is the checker body. It must not run on import: a probe
// script that imported `parseYaml` used to trigger the whole checker and its
// process.exit. A guard function keeps the body un-indented and honest.
function runChecker() {
// ------------------------------------------------------------------ checker
const dirFlag = process.argv.indexOf('--dir');
const PROJECT = dirFlag >= 0 ? resolve(process.argv[dirFlag + 1]) : process.cwd();

// `--plan`: the configs come from a plan document and the project they describe
// does not exist yet, so "does src/api/server.ts exist" is not a meaningful
// question. Structural checks still run; existence checks are reported as SKIP
// rather than silently passing, because a silent pass would be a lie.
const PLAN_MODE = process.argv.includes('--plan');

let skipped = 0;
const skip = (label, why) => {
  console.log(`  SKIP  ${label}  (${why})`);
  skipped++;
};

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

const tryParse = (path) => {
  try {
    return { doc: parseYaml(readFileSync(path, 'utf8'), path), error: null };
  } catch (err) {
    return { doc: null, error: err.message };
  }
};

/** Expand a single cron field into a matcher, enough for the 5-field form. */
function cronFieldMatches(field, value, min, max) {
  for (const part of field.split(',')) {
    const step = part.match(/^(\*|\d+(?:-\d+)?)\/(\d+)$/);
    if (step) {
      const [from, to] = step[1] === '*' ? [min, max] : step[1].split('-').map(Number);
      const by = Number(step[2]);
      for (let v = from; v <= to; v += by) if (v === value) return true;
      continue;
    }
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      if (value >= Number(range[1]) && value <= Number(range[2])) return true;
      continue;
    }
    if (part === '*') return true;
    if (Number(part) === value) return true;
  }
  return false;
}

// Read the project's package.json so the checker can prove the commands the
// configs reference actually resolve.
let pkg = null;
const pkgPath = join(PROJECT, 'package.json');
if (existsSync(pkgPath)) {
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch (err) {
    console.log(`  WARN  package.json is not valid JSON: ${err.message}`);
  }
} else if (PLAN_MODE) {
  // In plan mode the project does not exist yet, so fall back to the plan's own
  // declaration of what it intends to provide. This still catches the valuable
  // failure — a config referencing a script nobody planned to write.
  const planPath = join(PROJECT, 'plan-expectations.json');
  if (existsSync(planPath)) {
    try {
      const plan = JSON.parse(readFileSync(planPath, 'utf8'));
      pkg = { scripts: plan.scripts ?? {} };
      console.log(`(plan mode: using ${planPath} as the expected script set)`);
    } catch (err) {
      console.log(`  WARN  plan-expectations.json is not valid JSON: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------- workflow
console.log(`=== .github/workflows/index.yml ===  [${PROJECT}]`);
const wfPath = join(PROJECT, '.github', 'workflows', 'index.yml');
if (!existsSync(wfPath)) {
  check('workflow file exists', false, wfPath);
} else {
  const { doc, error } = tryParse(wfPath);
  check('YAML parses', error === null, error ?? '');
  if (doc) {
    const trigger = pickWorkflowTrigger(doc);
    check('has a name', typeof doc.name === 'string' && doc.name.length > 0, String(doc.name));
    check('triggers on a schedule', trigger != null && trigger.schedule != null, '(YAML 1.1 would read "on" as boolean true; both accepted)');
    const cron = trigger?.schedule?.[0]?.cron;
    check('cron expression present', typeof cron === 'string', String(cron));

    if (typeof cron === 'string') {
      const parts = cron.trim().split(/\s+/);
      check('cron has 5 fields', parts.length === 5, `${parts.length} fields`);
      if (parts.length === 5) {
        const [min, hour, dom, mon, dow] = parts;
        check(
          'cron fires on the half hour',
          cronFieldMatches(min, 30, 0, 59) && cronFieldMatches(min, 0, 0, 59),
          cron,
        );
        check('cron is not per-minute (would burn runner minutes)', min !== '*', min);
        check('day/month fields are unrestricted', dom === '*' && mon === '*', `${dom} / ${mon}`);
        check('dow unrestricted', dow === '*', dow);
      }
    }

    check(
      'manual trigger available (the dApp "refresh" button needs it)',
      trigger?.workflow_dispatch !== undefined,
      trigger?.workflow_dispatch === null ? '(no inputs)' : 'with inputs',
    );

    // The most common failure for a cron job that commits: two runs collide.
    check('has a concurrency group to serialise runs', doc.concurrency != null);
    check(
      'concurrency does not cancel in progress (a half-finished index must not be dropped)',
      doc.concurrency?.['cancel-in-progress'] === false,
      JSON.stringify(doc.concurrency?.['cancel-in-progress']),
    );

    check(
      'requests contents: write (needed to push the snapshot)',
      doc.permissions?.contents === 'write',
      String(doc.permissions?.contents),
    );

    const steps = doc.jobs?.index?.steps;
    check('has an index job with steps', Array.isArray(steps) && steps.length > 0, `${steps?.length ?? 0} steps`);
    if (Array.isArray(steps)) {
      const blob = (s) => JSON.stringify(s ?? null);
      const all = steps.map(blob).join('\n');
      check('installs dependencies', all.includes('npm ci'));
      check('runs the indexer', all.includes('npm run index'));
      check(
        'verifies data before committing',
        all.includes('npm run verify') || all.includes('verify-data'),
        'the audit must gate the commit',
      );
      check('commits the snapshot', all.includes('git commit'));
      check('pushes back to the repo', all.includes('git push'));

      // Order matters: verifying after committing would let bad data through.
      const verifyIdx = steps.findIndex(
        (s) => blob(s).includes('npm run verify') || blob(s).includes('verify-data'),
      );
      const commitIdx = steps.findIndex((s) => blob(s).includes('git commit'));
      check(
        'verify step comes BEFORE the commit step',
        verifyIdx >= 0 && commitIdx >= 0 && verifyIdx < commitIdx,
        `verify@${verifyIdx} commit@${commitIdx}`,
      );

      if (pkg?.scripts) {
        const used = [...all.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)].map((m) => m[1]);
        for (const name of new Set(used)) {
          check(`package.json defines script "${name}"`, pkg.scripts[name] !== undefined);
        }
        const ci = [...all.matchAll(/npm ci\b/gi)].length > 0;
        if (ci) {
          if (PLAN_MODE) skip('lockfile is present (npm ci requires it)', 'plan mode: project not built yet');
          else check('lockfile is present (npm ci requires it)', existsSync(join(PROJECT, 'package-lock.json')));
        }
      } else if (PLAN_MODE) {
        skip('npm scripts resolve', 'plan mode: no package.json yet');
      }
    }
  }
}

// ------------------------------------------------------------------ render
console.log('\n=== render.yaml ===');
const rPath = join(PROJECT, 'render.yaml');
if (!existsSync(rPath)) {
  check('render.yaml exists', false, rPath);
} else {
  const { doc, error } = tryParse(rPath);
  check('YAML parses', error === null, error ?? '');
  if (doc) {
    const svc = Array.isArray(doc.services) ? doc.services[0] : null;
    check('declares at least one service', Array.isArray(doc.services) && doc.services.length > 0);
    check('service is a web service', svc?.type === 'web', String(svc?.type));
    check('uses the node runtime', svc?.runtime === 'node', String(svc?.runtime));
    check('pins the free plan', svc?.plan === 'free', String(svc?.plan));
    check(
      'has a build command that installs from the lockfile',
      typeof svc?.buildCommand === 'string' && svc.buildCommand.includes('npm ci'),
      String(svc?.buildCommand),
    );
    check('has a start command', typeof svc?.startCommand === 'string' && svc.startCommand.length > 0, String(svc?.startCommand));
    check('declares a health check path', typeof svc?.healthCheckPath === 'string' && svc.healthCheckPath.startsWith('/'), String(svc?.healthCheckPath));
    check('does not pin a paid plan', String(svc?.plan) !== 'starter' && String(svc?.plan) !== 'standard');

    // The start command must point at a file that exists, or the deploy fails
    // on first boot — the most expensive possible time to find out.
    const startFile = String(svc?.startCommand ?? '').match(/([\w./-]+\.ts)\b/)?.[1];
    if (startFile) {
      if (PLAN_MODE) {
        skip(`start command target exists (${startFile})`, 'plan mode: entry file not written yet');
      } else {
        check(`start command target exists (${startFile})`, existsSync(join(PROJECT, startFile)));
      }
    }

    const envVars = Array.isArray(svc?.envVars) ? svc.envVars : [];
    const envKeys = envVars.map((e) => e?.key).filter(Boolean);
    check('sets NODE_VERSION', envKeys.includes('NODE_VERSION'), envKeys.join(', '));
    check('sets bounded catch-up limit', envKeys.includes('MAX_CATCHUP_BLOCKS'));
    check('sets catch-up timeout', envKeys.includes('MAX_CATCHUP_SECONDS'));
    check(
      'every env var has a key and a value',
      envVars.length > 0 && envVars.every((e) => e && typeof e.key === 'string' && e.value !== undefined),
      `${envVars.length} vars`,
    );
    check(
      'no duplicate env keys',
      new Set(envKeys).size === envKeys.length,
      envKeys.join(', '),
    );

    const num = (key) => Number(envVars.find((e) => e?.key === key)?.value);
    const blocks = num('MAX_CATCHUP_BLOCKS');
    check('catch-up bound is a small finite number', Number.isFinite(blocks) && blocks > 0 && blocks <= 2000, String(blocks));
    const secs = num('MAX_CATCHUP_SECONDS');
    check(
      'catch-up timeout is short enough not to stall the health check',
      Number.isFinite(secs) && secs > 0 && secs <= 30,
      String(secs),
    );

    const dbVar = envVars.find((e) => e?.key === 'DB')?.value;
    if (dbVar) {
      check(
        'DB path is repo-relative (the snapshot ships with the repo)',
        !String(dbVar).startsWith('/') && !/^[A-Za-z]:/.test(String(dbVar)),
        String(dbVar),
      );
    }
  }
}

console.log('');
if (failures > 0) {
  console.log(`${failures} check(s) FAILED${skipped ? `, ${skipped} skipped` : ''}`);
  process.exit(1);
}
console.log(
  `deployment configs are internally consistent${skipped ? ` (${skipped} check(s) skipped)` : ''}`,
);
if (PLAN_MODE) {
  console.log('');
  console.log('Plan mode: the project these configs describe does not exist yet, so');
  console.log('existence checks (npm scripts, entry file, lockfile) were SKIPPED, not passed.');
  console.log('They must be re-run without --plan once the project is built.');
}
console.log('');
console.log('NOT verified here (needs real accounts):');
console.log('  - whether Render accepts the manifest');
console.log('  - whether GitHub schedules the workflow as written');
console.log('  - real cold-start duration on the free tier');
}

if (isMain) runChecker();
