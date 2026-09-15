/**
 * Start the API server.
 *
 * Why not `npm run api`: npm.cmd is a batch wrapper, and on Windows Ctrl+C is
 * delivered to that batch file rather than to the node process it started. npm
 * exits, node survives, the port stays held, and the next start dies with
 * EADDRINUSE.
 *
 * `node tools/serve.mjs` runs the server in THIS process, so Ctrl+C reaches the
 * server itself, which closes the socket and the SQLite handle and exits.
 *
 * Extra convenience over running the server file directly: it writes
 * data/api.pid, so `node tools/kill-api.mjs` can find and stop this exact
 * process even if the port has already been released or was never bound.
 *
 * Usage:
 *   node tools/serve.mjs              port 3001
 *   $env:PORT=3002; node tools/serve.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(HERE, '..');
const SERVER = join(PROJECT, 'src', 'api', 'server.ts');
const PID_FILE = join(PROJECT, 'data', 'api.pid');

if (!existsSync(SERVER)) {
  console.error(`cannot find ${SERVER}`);
  process.exit(2);
}

const port = process.env.PORT ?? '3001';

// Spawn as a child rather than importing, so the server keeps its own signal
// handling and this wrapper stays a thin, replaceable shell.
const child = spawn(
  process.execPath,
  ['--no-warnings', '--experimental-strip-types', SERVER],
  {
    cwd: PROJECT,
    env: { ...process.env, PORT: port },
    stdio: 'inherit', // let the server own the terminal, including Ctrl+C
  },
);

try {
  mkdirSync(dirname(PID_FILE), { recursive: true });
  writeFileSync(PID_FILE, String(child.pid), 'utf8');
} catch {
  // A missing pid file only costs us the convenience path in kill-api.mjs.
}

const cleanup = () => {
  try {
    rmSync(PID_FILE, { force: true });
  } catch {
    /* nothing we can do, and nothing that matters */
  }
};

child.on('exit', (code, signal) => {
  cleanup();
  if (signal) {
    console.log(`\nserver stopped by ${signal}`);
    process.exit(0);
  }
  process.exit(code ?? 0);
});

// Forward signals so a Ctrl+C delivered to this wrapper also reaches the server.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    child.kill(sig);
  });
}

console.log(`base-swap-indexer api (via tools/serve.mjs)`);
console.log(`  pid file  : data/api.pid (pid ${child.pid})`);
console.log(`  stop with : Ctrl+C here, or  node tools/kill-api.mjs ${port}`);
console.log('');
