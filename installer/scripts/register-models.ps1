# register-models.ps1 — register local GGUFs with the GenieX model manager.
# Layout contract (LOAD-BEARING): one directory per model, each containing
# exactly one file named <ModelId>.gguf. A shared directory poisons the
# localfs pull cache (wrong file linked to another model's ID).
$ErrorActionPreference = 'Continue'

$geniex = 'C:\GenieX\geniex.exe'
if (-not (Test-Path $geniex)) {
  Write-Host "[register] ERROR: GenieX not found at $geniex"
  exit 1
}
$env:GENIEX_PLUGIN_PATH = 'C:\GenieX'
Set-Location 'C:\GenieX'

$modelsRoot = 'C:\Snack\models'
Write-Host "[register] models root: $modelsRoot"

$failures = 0
foreach ($dir in Get-ChildItem $modelsRoot -Directory) {
  $id = $dir.Name
  $gguf = Join-Path $dir.FullName ($id + '.gguf')
  if (-not (Test-Path $gguf)) {
    Write-Host "[register] SKIP $id (no $id.gguf in dir)"
    $failures++
    continue
  }
  Write-Host "[register] pulling $id from $($dir.FullName)"
  & $geniex pull $id --model-hub localfs --local-path $dir.FullName 2>&1 |
    ForEach-Object { Write-Host "  $_" }
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[register] FAIL $id (exit $LASTEXITCODE)"
    $failures++
  }
}

if ($failures -gt 0) {
  Write-Host "[register] DONE with $failures failure(s)"
  exit 1
}
Write-Host "[register] DONE — all models registered"
exit 0
