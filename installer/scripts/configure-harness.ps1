# configure-harness.ps1 - point the selected harness at the SNACK endpoint and
# record the harness choice in C:\Snack\config.json.
# Called by SnackSetup: configure-harness.ps1 -Harness hermes|pi|dsh
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('hermes', 'pi', 'dsh')]
  [string]$Harness
)
$ErrorActionPreference = 'Continue'

# ---------------------------------------------------------------- config.json
# Record the harness choice so snack.exe launches the right one. Merge into an
# existing config.json if present (never clobber model/nctx the app wrote).
$configPath = 'C:\Snack\config.json'
$cfg = [ordered]@{ model = 'qualcomm/Qwen3.8-9B'; nctx = 65536; port = 18181; harness = $Harness }
if (Test-Path $configPath) {
  try {
    $existing = Get-Content $configPath -Raw | ConvertFrom-Json
    foreach ($p in $existing.PSObject.Properties) { $cfg[$p.Name] = $p.Value }
    $cfg['harness'] = $Harness
  } catch { Write-Host '[harness] config.json unreadable - writing fresh' }
}
$cfg | ConvertTo-Json | Set-Content -Path $configPath -Encoding UTF8
Write-Host "[harness] config.json harness = $Harness"

# ---------------------------------------------------------------- Pi
# %USERPROFILE%\.pi\agent\models.json - custom OpenAI-compatible provider so
# `pi` can select the SNACK models with no API key.
if ($Harness -eq 'pi') {
  $piDir = Join-Path $env:USERPROFILE '.pi\agent'
  New-Item -ItemType Directory -Force -Path $piDir | Out-Null
  $modelsJson = @'
{
  "providers": {
    "snack-npu": {
      "baseUrl": "http://127.0.0.1:18181/v1",
      "api": "openai-completions",
      "apiKey": "local",
      "models": [
        { "id": "qualcomm/Qwen3.8-9B", "name": "Qwen3.8-9B (SNACK NPU)", "contextWindow": 65536, "maxTokens": 4096, "input": ["text"] },
        { "id": "qualcomm/Qwen3.8-4B", "name": "Qwen3.8-4B (SNACK NPU)", "contextWindow": 65536, "maxTokens": 4096, "input": ["text"] }
      ]
    }
  }
}
'@
  $modelsPath = Join-Path $piDir 'models.json'
  if (Test-Path $modelsPath) {
    Write-Host "[harness] Pi models.json already exists - SNACK provider NOT merged automatically; add baseUrl http://127.0.0.1:18181/v1 manually if needed"
  } else {
    Set-Content -Path $modelsPath -Value $modelsJson -Encoding UTF8
    Write-Host "[harness] wrote $modelsPath (provider: snack-npu)"
  }
}

# ---------------------------------------------------------------- DeepSeek Harness
# ~/.dsh/settings.yaml - custom OpenAI-compatible provider (snack-npu).
# Existing settings are left untouched; the snippet is written alongside for
# copy-paste merge (dsh settings format is preview-stage and may change).
if ($Harness -eq 'dsh') {
  $dshDir = Join-Path $env:USERPROFILE '.dsh'
  New-Item -ItemType Directory -Force -Path $dshDir | Out-Null
  $snippet = @'
# SNACK NPU provider snippet for DeepSeek Harness.
# Merge into ~/.dsh/settings.yaml (Settings -> Models -> Add a custom provider
# in the Web UI works too).
agent-default-model:
  provider: snack-npu
  model: qualcomm/Qwen3.8-9B

llm-pi-ai:
  providers:
    snack-npu:
      api: openai-completions
      baseURL: http://127.0.0.1:18181/v1
      models:
        - id: qualcomm/Qwen3.8-9B
        - id: qualcomm/Qwen3.8-4B
'@
  $snippetPath = Join-Path $dshDir 'snack-provider.snippet.yaml'
  Set-Content -Path $snippetPath -Value $snippet -Encoding UTF8
  $settingsPath = Join-Path $dshDir 'settings.yaml'
  if (Test-Path $settingsPath) {
    Write-Host "[harness] existing settings.yaml left untouched - merge $snippetPath into it (or use Settings -> Models in the dsh Web UI)"
  } else {
    Copy-Item $snippetPath $settingsPath
    Write-Host "[harness] wrote $settingsPath from the SNACK snippet"
  }
}

Write-Host '[harness] done'
exit 0
