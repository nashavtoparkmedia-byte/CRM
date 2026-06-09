# migrate-docker-wsl.ps1
#
# Move Docker Desktop WSL distro from C: to D:\Docker\wsl\
# Safe order: export -> only if successful -> unregister -> import.
# Does NOT touch other distros (Ubuntu etc.).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\migrate-docker-wsl.ps1
# After completion, start Docker Desktop -- it will pick up the distro from D:.

$ErrorActionPreference = 'Stop'

$DISTRO       = 'docker-desktop'
$BACKUP_DIR   = 'D:\Docker\backup'
$INSTALL_ROOT = 'D:\Docker\wsl'
$TARGET_DIR   = Join-Path $INSTALL_ROOT $DISTRO
$TAR_FILE     = Join-Path $BACKUP_DIR "$DISTRO.tar"

Write-Host "=== Docker WSL migration C: to D: ===" -ForegroundColor Cyan

# --- 1. Stop Docker Desktop + backend processes -------------------------------
Write-Host ""
Write-Host "[1/6] Stopping Docker Desktop processes..."
$dockerProcs = Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessName -match '^(Docker Desktop|com\.docker|dockerd|docker)$'
}
if ($dockerProcs) {
    $dockerProcs | ForEach-Object {
        Write-Host ("  killing {0} [PID {1}]" -f $_.ProcessName, $_.Id)
        try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch {}
    }
    Start-Sleep -Seconds 3
} else {
    Write-Host "  no Docker processes running"
}

# --- 2. Shutdown WSL ----------------------------------------------------------
Write-Host ""
Write-Host "[2/6] wsl --shutdown..."
wsl --shutdown
Start-Sleep -Seconds 3

# --- 3. Verify distro exists --------------------------------------------------
Write-Host ""
Write-Host "[3/6] Verifying distro $DISTRO exists..."
$distros = (wsl --list --quiet) | ForEach-Object { $_.Trim() } | Where-Object { $_ }
if ($distros -notcontains $DISTRO) {
    Write-Host "  Distro $DISTRO not found. Nothing to migrate." -ForegroundColor Yellow
    Write-Host ("  Found distros: {0}" -f ($distros -join ', '))
    exit 0
}
Write-Host "  OK"

# --- 4. Create target dirs ----------------------------------------------------
Write-Host ""
Write-Host "[4/6] Preparing D:\Docker\..."
New-Item -ItemType Directory -Force -Path $BACKUP_DIR   | Out-Null
New-Item -ItemType Directory -Force -Path $INSTALL_ROOT | Out-Null
if (Test-Path $TARGET_DIR) {
    Write-Host "  WARNING: $TARGET_DIR already exists." -ForegroundColor Yellow
    Write-Host "  Aborting to avoid overwrite. Remove it manually if you want to retry."
    exit 1
}
Write-Host "  OK"

# --- 5a. Export ---------------------------------------------------------------
Write-Host ""
Write-Host "[5/6] Exporting $DISTRO to $TAR_FILE ..."
Write-Host "  (this can take a few minutes for ~11GB)"
$exportStart = Get-Date
wsl --export $DISTRO $TAR_FILE
if ($LASTEXITCODE -ne 0) {
    throw "wsl --export failed with exit code $LASTEXITCODE. Aborting WITHOUT unregister."
}
$exportSec = [int]((Get-Date) - $exportStart).TotalSeconds
$tarSize   = (Get-Item $TAR_FILE).Length / 1GB
Write-Host ("  exported {0:N2} GB in {1}s" -f $tarSize, $exportSec)

# --- 5b. Unregister (data is safely in tar) -----------------------------------
Write-Host ""
Write-Host "[5b] Unregistering $DISTRO from C: ..."
wsl --unregister $DISTRO
if ($LASTEXITCODE -ne 0) {
    throw "wsl --unregister failed. Tar backup is intact at $TAR_FILE. You can re-import manually."
}

# --- 5c. Import to D: ---------------------------------------------------------
Write-Host ""
Write-Host "[5c] Importing $DISTRO to $TARGET_DIR ..."
New-Item -ItemType Directory -Force -Path $TARGET_DIR | Out-Null
$importStart = Get-Date
wsl --import $DISTRO $TARGET_DIR $TAR_FILE --version 2
if ($LASTEXITCODE -ne 0) {
    throw "wsl --import failed. Tar at $TAR_FILE. Retry: wsl --import $DISTRO $TARGET_DIR $TAR_FILE --version 2"
}
$importSec = [int]((Get-Date) - $importStart).TotalSeconds
Write-Host ("  imported in {0}s" -f $importSec)

# --- 5d. Cleanup tar ----------------------------------------------------------
Write-Host ""
Write-Host "[5d] Removing tar backup $TAR_FILE ..."
Remove-Item $TAR_FILE -Force

# --- 6. Verify ----------------------------------------------------------------
Write-Host ""
Write-Host "[6/6] Migration result:" -ForegroundColor Green
wsl --list --verbose

$vhdx = Join-Path $TARGET_DIR 'ext4.vhdx'
if (Test-Path $vhdx) {
    $vhdxSize = (Get-Item $vhdx).Length / 1GB
    Write-Host ("")
    Write-Host ("New vhdx: $vhdx ({0:N2} GB)" -f $vhdxSize) -ForegroundColor Green
}

Write-Host ""
Write-Host "Done. Start Docker Desktop. It will use the distro from D:." -ForegroundColor Cyan
