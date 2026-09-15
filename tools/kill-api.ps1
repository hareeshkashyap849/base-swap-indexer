# Kill whatever is holding the API port, so `npm run api` can start cleanly.
#
# Why this exists: Ctrl+C does not always work. A process started detached from
# the console (Start-Process, a background job, an editor task runner) never
# receives the console's Ctrl+C event, so the terminal appears to ignore you
# while the process keeps running and keeps the port. Stopping it by PORT is
# reliable regardless of how it was launched.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\kill-api.ps1

param([int]$Port = 3001)

Write-Host "looking for listeners on port $Port ..."
$conns = @(Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue)
if ($conns.Count -eq 0) {
    Write-Host "  nothing is listening on $Port"
} else {
    $pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($procId in $pids) {
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Host ("  stopping PID " + $procId + " (" + $proc.ProcessName + ")")
        } else {
            Write-Host ("  stopping PID " + $procId)
        }
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }
}

# A process can hold the socket briefly after being killed.
Start-Sleep -Seconds 2
$still = @(Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue)
if ($still.Count -gt 0) {
    Write-Host ""
    Write-Host "port $Port is STILL held. The process is probably not visible to this session."
    Write-Host "Open Task Manager, find node.exe processes, and end them, or run:"
    Write-Host "    Get-Process node | Stop-Process -Force"
    exit 1
}

# Also clear any stray node processes whose command line names our server, in
# case one is alive but not bound (e.g. crashed mid-start).
$stray = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*api/server.ts*" })
foreach ($s in $stray) {
    Write-Host ("  stopping stray server process PID " + $s.ProcessId)
    Stop-Process -Id $s.ProcessId -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 1
Write-Host ""
Write-Host "port $Port is free. Now run:  npm run api"
