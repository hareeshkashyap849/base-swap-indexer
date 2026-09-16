/**
 * Extract the deployment configs that are embedded in the project's deployment plan
 * and write them into a scratch directory, so `check-deploy-configs.mjs` can
 * validate them before they exist as real project files.
 *
 * The plan is the single source of truth for the deployment configs while the
 * project is still in the planning stage. (It is kept outside this repository,
 * so its content is reproduced here rather than linked.) Without this step, the
 * YAML in that plan is prose that nobody ever parses — and prose YAML rots. With
 * it, the exact text that will be written into `.github/workflows/index.yml` and
 * `render.yaml` is checked on every run.
 *
 * Deliberately does NOT spawn the checker: in a sandbox that forbids named
 * pipes, a child process cannot be given piped stdio, so a nested invocation
 * fails with EPERM. Run the two commands separately (see below).
 *
 * Run:
 *   node tools/check-plan-configs.mjs <plan.md> <outDir>
 *   node tools/check-deploy-configs.mjs --dir <outDir>
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const [planPath, outDirArg] = process.argv.slice(2);
if (!planPath || !outDirArg) {
  console.error('usage: node tools/check-plan-configs.mjs <plan.md> <outDir>');
  process.exit(2);
}
if (!existsSync(planPath)) {
  console.error(`plan document not found: ${planPath}`);
  process.exit(2);
}
const outDir = resolve(outDirArg);

const text = readFileSync(planPath, 'utf8');

// Fenced blocks labelled yaml, in document order, with their starting line.
const blocks = [];
for (const m of text.matchAll(/^```ya?ml[^\n]*\n([\s\S]*?)^```/gm)) {
  const line = text.slice(0, m.index).split('\n').length;
  blocks.push({ line, body: m[1] });
}

console.log(`${planPath}: found ${blocks.length} YAML block(s)`);
if (blocks.length === 0) {
  console.error('no YAML blocks found — expected at least the workflow and render manifest');
  process.exit(1);
}

// Identify by content, not by order: order in a document is a presentation
// detail and will change.
const workflow = blocks.find((b) => /\bruns-on:/.test(b.body));
const render = blocks.find((b) => /^services:/m.test(b.body) && b !== workflow);

const problems = [];
if (!workflow) problems.push('no block containing "runs-on:" (GitHub workflow)');
if (!render) problems.push('no block containing a top-level "services:" (Render manifest)');
if (problems.length) {
  for (const p of problems) console.error(`  MISSING  ${p}`);
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, '.github', 'workflows'), { recursive: true });

const outputs = [
  { path: join(outDir, '.github', 'workflows', 'index.yml'), block: workflow },
  { path: join(outDir, 'render.yaml'), block: render },
];

// The extracted file must be byte-identical to the fenced body, otherwise the
// checker would be validating something other than what the document says.
const normalise = (s) => s.replace(/\r\n/g, '\n').replace(/\n+$/, '\n');
for (const { path, block } of outputs) {
  const body = normalise(block.body);
  writeFileSync(path, body, 'utf8');
  const written = readFileSync(path, 'utf8');
  const ok = written === body;
  console.log(
    `  ${ok ? 'WROTE' : 'MISMATCH'}  ${path}  ` +
      `(${body.split('\n').length - 1} lines, from plan line ${block.line})`,
  );
  if (!ok) process.exit(1);
}

console.log('');
// Carry the plan's declaration of what the project will provide, so the checker
// can validate script references even though the project is not built yet.
const expectations = join(dirname(resolve(planPath)), 'plan-expectations.json');
if (existsSync(expectations)) {
  copyFileSync(expectations, join(outDir, 'plan-expectations.json'));
  console.log(`  COPIED  plan-expectations.json (expected scripts and files)`);
} else {
  console.log(`  NOTE  no plan-expectations.json next to the plan; script references will be SKIPPED`);
}

console.log('');
console.log('next: node tools/check-deploy-configs.mjs --dir ' + outDir + ' --plan');
