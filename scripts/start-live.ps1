param([string]$Config = 'config.local.json', [switch]$Manual)
$ErrorActionPreference = 'Stop'
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
  $runtime = Join-Path (Get-Location) 'bin/node/node.exe'
  if (-not (Test-Path -LiteralPath $runtime)) { $runtime = (Get-Command node -ErrorAction Stop).Source }
  $launchArgs = @('src/main.mjs', $Config)
  if ($Manual) { $launchArgs += '--manual' }
  & $runtime @launchArgs
  if ($LASTEXITCODE -ne 0) { throw "Live service exited with code $LASTEXITCODE" }
} finally { Pop-Location }
