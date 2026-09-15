/**
 * Stop whatever is listening on the API port.
 *
 * Why this exists: Ctrl+C does not reliably stop the API on Windows. `npm run
 * api` runs npm.cmd, a batch wrapper, so the signal is delivered to the batch
 * file rather than to the node process it started. npm exits, node survives,
 * the port stays held, and every later start fails with EADDRINUSE while the
 * terminal looks impossible to stop.
 *
 * Two implementation notes that matter:
 *
 *   1. It uses `netstat -ano` rather than Get-NetTCPConnection. Measured here:
 *      a listener on port 3001 was visible to netstat as PID 63944 and invisible
 *      to Get-NetTCPConnection, which reported no listeners at all. Trusting the
 *      cmdlet is how a "port is free" report gets printed while the port is very
 *      much not free.
 *
 *   2. It uses `taskkill /PID <pid> /F` rather than Stop-Process, because
 *      taskkill reports a real exit status per target and also terminates the
 *      process tree, which matters when node was spawned by a wrapper.
 *
 * Usage:
 *   node tools/kill-api.mjs            stop whatever holds 3001
 *   node tools/kill-api.mjs 3002       stop whatever holds 3002
 *   node tools/kill-api.mjs --list     just show who holds the port
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const port = Number(args.find((a) => /^\d+$/.test(a)) ?? 3001);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`invalid port: ${args[0]}`);
  process.exit(2);
}

/**
 * Run a command and return its stdout, WITHOUT using a pipe.
 *
 * On this machine a sandbox forbids creating the named pipes that
 * child_process uses for piped stdio, so execFileSync('netstat', ...) fails with
 * `spawnSync netstat EPERM` even though netstat itself works perfectly from a
 * shell. The same restriction breaks `git submodule` and therefore
 * `forge install`.
 *
 * The workaround is to redirect the command's output into a temporary file with
 * `stdio: 'ignore'` and read the file, which needs no pipe. Node's `>` is not a
 * shell feature, so passing the file as stdout works on every platform.
 */
function run(command, args, encoding = 'utf8') {
  const tmp = join(tmpdir(), `kill-api-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  try {
    const fd = openSync(tmp, 'w');
    let status = 0;
    try {
      const res = spawnSync(command, args, { stdio: ['ignore', fd, 'ignore'] });
      status = res.status ?? 0;
    } finally {
      closeSync(fd);
    }
    const out = readFileSync(tmp, encoding);
    return { status, out };
  } finally {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* leftover temp file is harmless */
    }
  }
}
/**
 * Parse `netstat -ano` for listeners on `port`.
 *
 * Output lines look like:
 *   TCP    127.0.0.1:3001    0.0.0.0:0    LISTENING    63944
 *
 * Matching the LISTENING state specifically avoids confusing an outbound
 * connection TO the port with a listener ON it: a client socket has a different
 * PID, and killing that would be wrong. Measured on this machine, port 3001 had
 * one LISTENING socket (the server) and four ESTABLISHED ones from the browser.
 */
function findListeners(targetPort) {
  const { out, status } = run('netstat', ['-ano']);
  if (status !== 0) {
    console.error(`netstat exited with status ${status}`);
    process.exit(2);
  }
  const hits = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+(\S+)\s+(\d+)$/);
    if (!m) continue;
    const [, , linePort, state, pid] = m;
    if (Number(linePort) !== targetPort) continue;
    if (state.toUpperCase() !== 'LISTENING') continue;
    hits.push({ pid: Number(pid), state, address: m[1] });
  }
  return hits;
}

/** Ask Windows what a PID actually is, so the report is not a bare number. */
function describe(pid) {
  const { out } = run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
  const line = out.trim().split(/\r?\n/)[0] ?? '';
  if (!line || line.startsWith('INFO:') || line.startsWith('ERROR')) return null;
  // CSV: "node.exe","1234","Console","1","123,456 K"
  const m = line.match(/^"([^"]+)","(\d+)"/);
  return m ? m[1] : null;
}

console.log(`looking for a listener on port ${port} ...`);

let listeners = findListeners(port);

if (listeners.length === 0) {
  console.log(`  nothing is LISTENING on ${port}`);
  console.log('');
  console.log('  Note: netstat reports no listener, so the port really is free.');
  console.log('  If a request to it still succeeds, something is answering from');
  console.log(`  outside this session's view — try:  netstat -ano | findstr :${port}`);
  process.exit(0);
}

for (const l of listeners) {
  const name = describe(l.pid) ?? 'unknown process';
  console.log(`  PID ${l.pid} (${name}) on ${l.address}:${port}`);
}

if (listOnly) {
  process.exit(0);
}

console.log('');
let killed = 0;
for (const l of listeners) {
  // /T also terminates child processes, which is what leaves orphans behind when
  // npm.cmd is the parent and only the wrapper receives the signal.
  const { out, status } = run('taskkill', ['/PID', String(l.pid), '/T', '/F']);
  const first = out.trim().split(/\r?\n/)[0] ?? '';
  if (status === 0) {
    console.log(`  stopped PID ${l.pid}: ${first || 'ok'}`);
    killed++;
  } else {
    console.log(`  FAILED to stop PID ${l.pid} (status ${status}): ${first || 'no output'}`);
  }
}

// Give Windows a moment to tear the socket down before checking.
await new Promise((r) => setTimeout(r, 2000));
const remaining = findListeners(port);

console.log('');
if (remaining.length === 0) {
  console.log(`port ${port} is free (stopped ${killed} process${killed === 1 ? '' : 'es'})`);
  console.log('');
  console.log('  start it again with:  node tools/serve.mjs');
  process.exit(0);
}

console.log(`port ${port} is STILL held by: ${remaining.map((r) => r.pid).join(', ')}`);
console.log('');
console.log('  taskkill could not stop it. Likely causes:');
console.log('    - the process runs elevated (an Administrator terminal)');
console.log('      -> open Task Manager as Administrator and end that node.exe');
console.log('    - something is respawning it (a watcher, an editor task)');
console.log('      -> stop the watcher first');
console.log('');
console.log('  Fastest way forward regardless: use a different port.');
console.log(`      $env:PORT=${port + 1}; node tools/serve.mjs`);
process.exit(1);
