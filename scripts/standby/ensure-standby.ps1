# Keeps the laptop standby processes running: the live gateway, the standby controller and a Cloudflare quick tunnel.
# The 'JC-LIVE Laptop Standby' scheduled task runs this every minute through StandbyLauncher.exe, which opens no
# console window (docs/LAPTOP-STANDBY.md). CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set for the user.
param([string]$Config = 'config.local.json', [string]$Cloudflared = 'C:\Program Files (x86)\cloudflared\cloudflared.exe')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$state = Join-Path $root 'data\standby'
New-Item -ItemType Directory -Force -Path $state | Out-Null
Set-Location -LiteralPath $root
$runtime = Join-Path $root 'bin\node\node.exe'
if (-not (Test-Path -LiteralPath $runtime)) { $runtime = 'C:\Program Files\nodejs\node.exe' }
$processes = @(Get-CimInstance Win32_Process)
foreach ($name in @('live-gateway.mjs', 'laptop-standby.mjs')) {
    if (-not ($processes | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like "*$name*" })) {
        $log = Join-Path $state ($name -replace '\.mjs$', '')
        Start-Process -FilePath $runtime -ArgumentList @('"' + (Join-Path $PSScriptRoot $name) + '"', $Config) -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput ($log + '.out.log') -RedirectStandardError ($log + '.err.log') | Out-Null
    }
}
$pending = Join-Path $state 'pending-tunnel-log.txt'
if (-not ($processes | Where-Object { $_.Name -eq 'cloudflared.exe' -and $_.CommandLine -like '*127.0.0.1:4321*' })) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $errFile = Join-Path $state ('tunnel-' + $stamp + '.err.log')
    Set-Content -LiteralPath $pending -Value $errFile -Encoding utf8
    Start-Process -FilePath $Cloudflared -ArgumentList @('tunnel', '--url', 'http://127.0.0.1:4321', '--no-autoupdate', '--protocol', 'http2') -WorkingDirectory $state -WindowStyle Hidden -RedirectStandardOutput (Join-Path $state ('tunnel-' + $stamp + '.out.log')) -RedirectStandardError $errFile | Out-Null
}
# A new quick tunnel gets a new address, so the Worker's JC_LAPTOP_URL binding is updated to follow it.
if (Test-Path -LiteralPath $pending) {
    $errFile = (Get-Content -LiteralPath $pending -Raw).Trim()
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Seconds 1
        $content = Get-Content -LiteralPath $errFile -Raw -ErrorAction SilentlyContinue
        if ($content -match 'https://[a-z0-9-]+\.trycloudflare\.com') {
            $env:JC_LAPTOP_TUNNEL_URL = $Matches[0]
            & $runtime (Join-Path $PSScriptRoot 'update-tunnel-binding.mjs')
            if ($LASTEXITCODE -ne 0) { throw 'Tunnel binding update failed' }
            Remove-Item -LiteralPath $pending
            break
        }
    }
}
