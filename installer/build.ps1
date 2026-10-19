# build.ps1 — verify pins + build SnackSetup.exe
# Run on the ARM64 build machine (the Surface).
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

Write-Host "=== 1. verify runtime/ artifacts + SHA256 pins ==="
$versions = Get-Content "$root\installer\runtime\versions.json" | ConvertFrom-Json

# Required entries (must exist and be pinned)
$required = @(
  @{ prop = 'geniex_cli_setup' }
)

# Optional entries (models — only pin if the file exists, skip if absent)
$optional = @(
  @{ prop = 'model_4b' },
  @{ prop = 'model_9b' }
)

function Verify-Entry($e, $required) {
  $v = $versions.$($e.prop)
  # install_script / npm_global harnesses have no bundled file — nothing to pin.
  if (-not $v.file) {
    Write-Host "  OK: $($e.prop) (method: $($v.method), no bundled artifact)"
    return
  }
  $p = Join-Path $root $v.file

  if ($required) {
    if (-not (Test-Path $p)) {
      Write-Host "  MISSING (required): $($v.file)"
      exit 1
    }
    if ($v.sha256 -match '^FILL') {
      Write-Host "  UNPINNED (required): $($v.file) (sha256 still FILL_BEFORE_BUILD)"
      Write-Host "    actual: $((Get-FileHash $p -Algorithm SHA256).Hash)"
      exit 1
    }
    $actual = (Get-FileHash $p -Algorithm SHA256).Hash
    if ($actual -ne $v.sha256) {
      Write-Host "  SHA MISMATCH: $($v.file)"
      Write-Host "    expected: $($v.sha256)"
      Write-Host "    actual:   $actual"
      exit 1
    }
    Write-Host "  OK: $($v.file) ($([math]::Round((Get-Item $p).Length/1MB,1)) MB)"
  } else {
    if (Test-Path $p) {
      if ($v.sha256 -match '^FILL') {
        Write-Host "  UNPINNED (optional): $($v.file)"
        Write-Host "    actual: $((Get-FileHash $p -Algorithm SHA256).Hash)"
        exit 1
      }
      $actual = (Get-FileHash $p -Algorithm SHA256).Hash
      if ($actual -ne $v.sha256) {
        Write-Host "  SHA MISMATCH: $($v.file)"
        exit 1
      }
      Write-Host "  OK: $($v.file) ($([math]::Round((Get-Item $p).Length/1MB,1)) MB) [optional]"
    } else {
      Write-Host "  SKIP: $($v.file) [optional — not present, installer will skip]"
    }
  }
}

foreach ($e in $required) { Verify-Entry $e $true }
foreach ($e in $optional) { Verify-Entry $e $false }

Write-Host "=== 2. snack.exe built? ==="
$exe = "$root\src-tauri\target\release\snack.exe"
if (-not (Test-Path $exe)) {
  Write-Host "  MISSING: target\release\snack.exe — run: cargo tauri build"
  exit 1
}
Write-Host "  OK: snack.exe"

Write-Host "=== 3. compile Inno setup ==="
$iscc = Get-Command ISCC.exe -ErrorAction SilentlyContinue
if (-not $iscc) {
  $cand = 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe'
  if (Test-Path $cand) { $iscc = $cand } else {
    Write-Host "  ISCC.exe not found — install Inno Setup 6 (winget install JRSoftware.InnoSetup)"
    exit 1
  }
}
& (if (Test-Path $iscc) { $iscc } else { $iscc.Source }) "$root\installer\setup.iss"
if ($LASTEXITCODE -ne 0) { Write-Host "  ISCC failed"; exit 1 }
Write-Host ""
Write-Host "=== DONE: $root\dist\SnackSetup.exe ==="
