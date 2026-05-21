# Windows / PowerShell parity to scripts/check_health.sh.
#
# Cron- and Task-Scheduler-friendly: deterministic exit codes, single
# stdout line, no notifications, no SaaS, no external modules. Uses
# only built-in Invoke-WebRequest + ConvertFrom-Json.
#
# Exit codes
# ──────────
#   0  ok           — endpoint replied, status="ok"
#   1  degraded     — endpoint replied, status="degraded"
#   2  down         — endpoint replied, status="down"
#   3  unreachable  — endpoint did not reply / unparseable / unknown status
#
# Override the URL via env (same name as the Bash sibling for parity):
#   $env:HEALTH_URL = 'http://localhost:9999/api/health/infra'
#   pwsh scripts/check_health.ps1
#
# Override the timeout (seconds) via env:
#   $env:HEALTH_TIMEOUT_S = '10'
#
# Stdout is one of: "ok", "degraded", "down", "unreachable".

# Use environment variables with sensible fallbacks. ${env:NAME} returns
# $null when unset; `??` is unavailable in Windows PowerShell 5.1 — use
# a defensive `if`.
$url = $env:HEALTH_URL
if (-not $url) { $url = 'http://localhost:3002/api/health/infra' }

$timeoutS = $env:HEALTH_TIMEOUT_S
if (-not $timeoutS) { $timeoutS = '5' }
$timeoutSec = [int]$timeoutS

try {
    # -UseBasicParsing for compatibility with non-interactive Windows
    # PowerShell. -ErrorAction Stop turns 5xx responses into exceptions
    # we catch below — but we still want the body, so we re-read it
    # from the error record's Response stream when we can.
    $resp = Invoke-WebRequest `
        -Uri $url `
        -Method GET `
        -UseBasicParsing `
        -TimeoutSec $timeoutSec `
        -ErrorAction Stop

    $body = $resp.Content
} catch {
    # 503 from the endpoint is a *meaningful* response (status="degraded"
    # or "down"). Try to recover the body from the WebException's
    # Response stream. Anything else (network error, DNS, timeout,
    # 5xx without parseable body) → unreachable.
    $body = $null
    if ($_.Exception.Response) {
        try {
            $stream = $_.Exception.Response.GetResponseStream()
            $reader = New-Object IO.StreamReader $stream
            $body = $reader.ReadToEnd()
        } catch { $body = $null }
    }
    if (-not $body) {
        Write-Output 'unreachable'
        exit 3
    }
}

if (-not $body) {
    Write-Output 'unreachable'
    exit 3
}

# Try ConvertFrom-Json. Any parse failure → unreachable (HTML 404,
# truncated body, etc.). Substring fallback isn't needed here because
# JSON parsing is built in and reliable on PS 5+.
$status = $null
try {
    $parsed = $body | ConvertFrom-Json -ErrorAction Stop
    $status = $parsed.status
} catch {
    $status = $null
}

switch ($status) {
    'ok'       { Write-Output 'ok';          exit 0 }
    'degraded' { Write-Output 'degraded';    exit 1 }
    'down'     { Write-Output 'down';        exit 2 }
    default    { Write-Output 'unreachable'; exit 3 }
}
