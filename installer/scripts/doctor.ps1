# doctor.ps1 — SNACK diagnostic checklist.
# Mirrors the in-app Doctor (System tab). Exits 0 only if all pass.
$ErrorActionPreference = 'Continue'

$results = @()
function Add($name, $pass, $fix) {
  $script:results += [PSCustomObject]@{ Name = $name; Pass = [bool]$pass; Fix = $fix }
}

# 1. NPU present
$hex = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
  Where-Object { $_.FriendlyName -match 'Hexagon|Qualcomm' } | Select-Object -First 1
Add 'NPU present' $hex "NPU not detected — check Device Manager / Windows updates"

# 2. GenieX runtime intact
$geniexOk = Test-Path 'C:\GenieX\geniex.exe'
Add 'GenieX runtime intact' $geniexOk "Run SnackSetup.exe again"

# 3. Model files present (one dir per model, <Id>.gguf)
$modelsOk = $true
foreach ($m in @('Qwen3.8-4B', 'Qwen3.8-9B')) {
  if (-not (Test-Path "C:\Snack\models\$m\$m.gguf")) { $modelsOk = $false }
}
Add 'Model files present' $modelsOk "Re-fetch models (System tab)"

# 4. Model manager IDs registered
$cacheOk = $false
foreach ($c in @((Join-Path $env:USERPROFILE '.cache\geniex\models'), (Join-Path $env:LOCALAPPDATA 'geniex\models'))) {
  if (Test-Path $c) { $cacheOk = $true }
}
Add 'Model manager IDs registered' $cacheOk "Run register-models.ps1 (System tab: Re-register)"

# 5. Server on port
$port = 18181
$alive = $false
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/v1/models" -UseBasicParsing -TimeoutSec 6
  $alive = $r.StatusCode -eq 200
} catch { $alive = $false }
Add "Server on port $port" $alive "Toggle the server on (Home tab)"

# 6. Inference smoke test (only when server is up)
$smoke = $false
if ($alive) {
  $body = '{"model":"qualcomm/Qwen3.8-4B","messages":[{"role":"user","content":"Say hi in one word."}],"max_tokens":8,"temperature":0.3}'
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/v1/chat/completions" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 120
    $smoke = $r.StatusCode -eq 200
  } catch { $smoke = $false }
}
Add 'Inference smoke test' $smoke "Server down or model failed to load — see server log"

# 7. Hermes installed
$hermesOk = Test-Path (Join-Path $env:USERPROFILE 'AppData\Local\hermes')
Add 'Hermes installed' $hermesOk "Install Hermes (SnackSetup or the Hermes installer)"

# render
$fail = 0
foreach ($r in $results) {
  $icon = if ($r.Pass) { 'PASS' } else { 'FAIL' }
  $line = "  [$icon] {0}" -f $r.Name
  if (-not $r.Pass) { $line += "   -> $($r.Fix)"; $fail++ }
  Write-Host $line
}
Write-Host ""
if ($fail -eq 0) {
  Write-Host "DOCTOR: all checks passed"
  exit 0
} else {
  Write-Host "DOCTOR: $fail check(s) failed"
  exit 1
}
