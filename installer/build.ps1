# build.ps1 — verify pins + build SnackSetup.exe
# Run on the ARM64 build machine (the Surface).
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

Write-Host "=== 1. verify runtime/ artifacts + SHA256 pins ==="
$versions = Get-Content "$root\installer\runtime\versions.json" | ConvertFrom-Json
$entries = @(
  @{ prop = 'geniex_cli_setup' },
  @{ prop = 'hermes_setup' },
  @{ prop = 'model_4b' },
  @{ prop = 'model_9b' }
)
foreach ($e in $entries) {
  $v = $versions.($e.prop)
  $p = Join-Path $root $v.file
  if (-not (Test-Path $p)) {
    Write-Host "  MISSING: $($v.file)"
    exit 1
  }
  if ($v.sha256 -match '^FILL') {
    Write-Host "  UNPINNED: $($v.file) (sha256 still FILL_BEFORE_BUILD)"
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
}

Write-Host "=== 2. snack.exe built? ==="
$exe = "$root\target\release\snack.exe"
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
