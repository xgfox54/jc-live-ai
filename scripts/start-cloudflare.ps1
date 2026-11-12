param([ValidateSet('Viewer','Engine')][string]$Mode = 'Viewer', [switch]$Detached)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskLog = Join-Path $taskRoot 'data/cloudflare-start.log'
if (-not $Detached) {
  # A process started from a terminal or an agent session (Codex) can belong to that session's Windows job object and
  # is terminated when the session closes. WMI creates the launcher outside that job, so the services keep running.
  $taskShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $taskCommand = '"{0}" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{1}" -Mode {2} -Detached' -f $taskShell, $PSCommandPath, $Mode
  Set-Content -LiteralPath $taskLog -Value 'JC-LIVE launcher did not report a result.'
  $taskStartup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
  $taskLauncher = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $taskCommand; CurrentDirectory = $taskRoot; ProcessStartupInformation = $taskStartup }
  if ($taskLauncher.ReturnValue -ne 0) { throw 'JC-LIVE launcher could not start' }
  Wait-Process -Id $taskLauncher.ProcessId -Timeout 120 -ErrorAction SilentlyContinue
  $taskResult = (Get-Content -LiteralPath $taskLog -Raw).Trim()
  if ($taskResult -notlike 'JC-LIVE Cloudflare processes are configured*') { throw $taskResult }
  Write-Output $taskResult
  return
}
try {
$taskRuntime = Join-Path $taskRoot 'bin/node/node.exe'
$taskToken = Join-Path $taskRoot 'data/jc-live-tunnel.secret'
if (-not (Test-Path -LiteralPath $taskToken)) { throw 'JC-LIVE tunnel credential is missing' }
if ($Mode -eq 'Engine' -and (Get-NetTCPConnection -State Listen -LocalPort 4321 -ErrorAction SilentlyContinue)) {
  throw 'Stop the JC-LIVE viewer before starting the transcription engine'
}
if (-not (Get-NetTCPConnection -State Listen -LocalPort 4321 -ErrorAction SilentlyContinue)) {
  $taskScript = if ($Mode -eq 'Engine') { 'src/main.mjs' } else { 'scripts/serve-desktop-live.mjs' }
  $taskProcess = Start-Process -FilePath $taskRuntime -ArgumentList @($taskScript,'config.local.json') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskRoot 'data/cloudflare-viewer.out.log') -RedirectStandardError (Join-Path $taskRoot 'data/cloudflare-viewer.err.log') -PassThru
  $taskProcess.Id | Set-Content (Join-Path $taskRoot 'data/cloudflare-viewer.pid')
}
$taskExisting = if (Test-Path (Join-Path $taskRoot 'data/cloudflare-tunnel.pid')) { [int](Get-Content (Join-Path $taskRoot 'data/cloudflare-tunnel.pid')) } else { 0 }
$taskTunnel = if ($taskExisting) { Get-CimInstance Win32_Process -Filter "ProcessId=$taskExisting" } else { $null }
if (-not $taskTunnel -or $taskTunnel.CommandLine -notlike '*data\jc-live-tunnel.secret*') {
  $taskTunnel = Start-Process -FilePath 'C:\Program Files (x86)\cloudflared\cloudflared.exe' -ArgumentList @('tunnel','--no-autoupdate','--loglevel','warn','--metrics','127.0.0.1:20242','--protocol','quic','run','--token-file',$taskToken) -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskRoot 'data/cloudflare-tunnel.out.log') -RedirectStandardError (Join-Path $taskRoot 'data/cloudflare-tunnel.err.log') -PassThru
  $taskTunnel.Id | Set-Content (Join-Path $taskRoot 'data/cloudflare-tunnel.pid')
}
Set-Content -LiteralPath $taskLog -Value 'JC-LIVE Cloudflare processes are configured. Check the site and local logs.'
} catch {
  Set-Content -LiteralPath $taskLog -Value ('JC-LIVE start failed: ' + $_.Exception.Message)
  exit 1
}
