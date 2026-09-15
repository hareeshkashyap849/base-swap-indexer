@echo off
REM Start the API server WITHOUT going through npm.
REM
REM Why: `npm run api` runs npm.cmd, a batch wrapper. On Windows, Ctrl+C is
REM delivered to that batch file, not to the node process it spawned. npm exits,
REM node keeps running, and the port stays held — so the next start fails with
REM EADDRINUSE and the terminal appears impossible to stop.
REM
REM Running node directly means Ctrl+C reaches the server itself, which now
REM closes the socket and the database and exits deterministically.
REM
REM Usage:  tools\serve.cmd          (default port 3001)
REM         set PORT=3002 && tools\serve.cmd

setlocal
cd /d "%~dp0.."
node --no-warnings --experimental-strip-types src\api\server.ts
endlocal
