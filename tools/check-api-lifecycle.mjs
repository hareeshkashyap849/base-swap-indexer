// Verify the API starts and stops cleanly, repeatedly.
//
// The failure being tested against: run `npm run api`, press Ctrl+C, and the
// node process survives while holding the port, so the next start fails with
// EADDRINUSE. The signal never reached node because npm.cmd is a batch wrapper.
//
// What this CAN and CANNOT establish on Windows:
//
//   CAN: that the server binds, serves the current build, and that the port is
//   released afterwards, cycle after cycle. Releasing the port is the property
//   that actually matters, and it is asserted directly by polling the port.
//
//   CANNOT: that the server's own SIGINT handler ran. Windows has no POSIX
//   signals; child.kill('SIGINT') resolves to a TerminateProcess call, so the
//   reported cause is "signal:SIGINT" rather than a normal exit code 0. The
//   graceful path (close the socket, close SQLite, exit 0) is only exercised by
//   a real Ctrl+C in a real console and is therefore NOT covered here. Saying
//   otherwise would be claiming evidence this harness does not produce.
//
// Usage: node tools/check-api-lifecycle.mjs [startPort]
import { spawn } from 'node:child_process';

const PORT = Number(process.argv[2] ?? 3005);
const PROJECT = process.cwd();
const CYCLES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForListening(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  return false;
}

async function waitForReleased(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(800) });
      // still answering
    } catch {
      return true;
    }
    await sleep(250);
  }
  return false;
}

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

console.log(`api lifecycle test on port ${PORT}, ${CYCLES} start/stop cycles\n`);

for (let cycle = 1; cycle <= CYCLES; cycle++) {
  console.log(`cycle ${cycle}: starting`);
  const child = spawn(
    process.execPath,
    ['--no-warnings', '--experimental-strip-types', 'src/api/server.ts'],
    {
      cwd: PROJECT,
      // stdio: 'ignore' is required in this sandbox — piped stdio cannot be set
      // up. The server's own output is verified over HTTP instead.
      stdio: 'ignore',
      env: { ...process.env, PORT: String(PORT) },
    },
  );

  const up = await waitForListening();
  check(`cycle ${cycle}: server came up`, up, `port ${PORT}`);
  if (!up) {
    child.kill('SIGKILL');
    continue;
  }

  // Confirm it is serving the current build, so a stale process cannot pass.
  try {
    const html = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
    check(`cycle ${cycle}: serving current dashboard`, html.includes('function timeLabel'), `${html.length} chars`);
  } catch (e) {
    check(`cycle ${cycle}: serving current dashboard`, false, String(e));
  }

  const exitCode = await new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve(signal ? `signal:${signal}` : code));
    child.kill('SIGINT');
    setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGKILL');
        resolve('did-not-exit');
      }
    }, 8000);
  });

  check(`cycle ${cycle}: exited on SIGINT`, exitCode === 0 || exitCode === 'signal:SIGINT', `exit=${exitCode}`);

  const released = await waitForReleased();
  check(`cycle ${cycle}: port released`, released, released ? '' : `port ${PORT} still answering`);
}

console.log('');
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('start/stop works repeatedly — no orphaned process, no port held');
