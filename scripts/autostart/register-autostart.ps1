# Registers or removes the sign-in task that starts JC-LIVE on this desktop (docs/CLOUDFLARE.md).
# Usage: powershell -ExecutionPolicy Bypass -File scripts/autostart/register-autostart.ps1 [-Unregister]
param([switch]$Unregister)
$ErrorActionPreference = 'Stop'
$taskName = 'JC-LIVE Desktop Autostart'
if ($Unregister) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output "$taskName removed"
  return
}
$source = Join-Path $PSScriptRoot 'AutostartLauncher.cs'
$launcher = Join-Path $PSScriptRoot 'AutostartLauncher.exe'
if (-not (Test-Path -LiteralPath $launcher) -or (Get-Item -LiteralPath $launcher).LastWriteTime -lt (Get-Item -LiteralPath $source).LastWriteTime) {
  $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  & $compiler /nologo /target:winexe "/out:$launcher" $source
  if ($LASTEXITCODE -ne 0) { throw 'Autostart launcher did not compile' }
}
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$trigger.Delay = 'PT1M'
$action = New-ScheduledTaskAction -Execute $launcher -WorkingDirectory $PSScriptRoot
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName $taskName -Trigger $trigger -Action $action -Principal $principal -Settings $settings -Description 'Starts the JC-LIVE engine, viewer listener and tunnel once after sign-in. It does not restart a manually stopped engine.' -Force | Out-Null
Write-Output "$taskName registered for $user (sign-in + 1 minute)"
