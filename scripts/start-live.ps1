param([string]$Config = 'config.local.json')
$ErrorActionPreference = 'Stop'
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
  & node src/main.mjs $Config
  if ($LASTEXITCODE -ne 0) { throw "Live service exited with code $LASTEXITCODE" }
} finally { Pop-Location }
