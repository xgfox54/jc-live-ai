param([switch]$ViewerOnly)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskNames = if ($ViewerOnly) { @('viewer') } else { @('viewer','tunnel') }
foreach ($taskName in $taskNames) {
  $taskPidFile = Join-Path $taskRoot ('data/cloudflare-' + $taskName + '.pid')
  if (-not (Test-Path -LiteralPath $taskPidFile)) { continue }
  $taskPid = [int](Get-Content -LiteralPath $taskPidFile)
  $taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$taskPid"
  if (-not $taskProcess) { continue }
  $taskExpected = if ($taskName -eq 'tunnel') { '*data\jc-live-tunnel.secret*' } else { '*scripts/serve-desktop-live.mjs*' }
  if ($taskProcess.CommandLine -notlike $taskExpected) { throw 'Process identity differs; use the documented engine shutdown endpoint' }
  Stop-Process -Id $taskPid
}
