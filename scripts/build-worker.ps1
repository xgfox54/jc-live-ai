param(
  [Parameter(Mandatory=$true)][string]$VisualStudioEnvironment,
  [Parameter(Mandatory=$true)][string]$VulkanSdk,
  [Parameter(Mandatory=$true)][string]$ClangDirectory,
  [Parameter(Mandatory=$true)][string]$TargetDirectory,
  [switch]$Check
)
$ErrorActionPreference = 'Stop'
$worker = Join-Path (Split-Path $PSScriptRoot -Parent) 'worker'
$vsPath = [IO.Path]::GetFullPath($VisualStudioEnvironment)
$sdkPath = [IO.Path]::GetFullPath($VulkanSdk)
$clangPath = [IO.Path]::GetFullPath($ClangDirectory)
$targetPath = [IO.Path]::GetFullPath($TargetDirectory)
foreach ($path in @($vsPath,$sdkPath,$clangPath,$targetPath,$worker)) {
  if ($path -match '[&|<>^%!\r\n"]') { throw 'Build path contains unsupported command characters' }
}
if (!(Test-Path -LiteralPath $vsPath -PathType Leaf)) { throw 'Visual Studio environment script missing' }
$command = 'call "' + $vsPath + '" && set "VULKAN_SDK=' + $sdkPath + '" && set "LIBCLANG_PATH=' + $clangPath +
  '" && set "CC=' + $clangPath + '\clang-cl.exe" && set "CXX=' + $clangPath +
  '\clang-cl.exe" && set "CFLAGS=/utf-8" && set "CXXFLAGS=/EHsc /utf-8" && set "CMAKE_GENERATOR=Ninja" && set "CARGO_TARGET_DIR=' +
  $targetPath + '" && set "PATH=' + $sdkPath + '\Bin;' + $clangPath + ';!PATH!" && cd /d "' +
  $worker + '" && cargo build --locked --release --features vulkan'
if ($Check) { $command = $command.Replace('cargo build --locked --release --features vulkan', 'cargo clippy --locked --release --features vulkan -- -D warnings') }
& $env:ComSpec /d /v:on /s /c $command
if ($LASTEXITCODE -ne 0) { throw "Worker build failed: $LASTEXITCODE" }
