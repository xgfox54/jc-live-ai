param(
  [Parameter(Mandatory=$true)][string]$VisualStudioEnvironment,
  [string]$VulkanSdk,
  [string]$CudaPath,
  [Parameter(Mandatory=$true)][string]$ClangDirectory,
  [Parameter(Mandatory=$true)][string]$TargetDirectory,
  [ValidateSet('vulkan','cuda')][string]$Backend = 'vulkan',
  [string]$CudaArchitectures = '89',
  [switch]$Check
)
$ErrorActionPreference = 'Stop'
$worker = Join-Path (Split-Path $PSScriptRoot -Parent) 'worker'
$vsPath = [IO.Path]::GetFullPath($VisualStudioEnvironment)
$clangPath = [IO.Path]::GetFullPath($ClangDirectory)
$targetPath = [IO.Path]::GetFullPath($TargetDirectory)
if ($Backend -eq 'vulkan') {
  if (!$VulkanSdk) { throw 'VulkanSdk is required for the Vulkan backend' }
  $sdkPath = [IO.Path]::GetFullPath($VulkanSdk)
  $backendEnv = 'set "VULKAN_SDK=' + $sdkPath + '" && set "PATH=' + $sdkPath + '\Bin;!PATH!"'
} else {
  if (!$CudaPath) { throw 'CudaPath is required for the CUDA backend' }
  if ($CudaArchitectures -notmatch '^[0-9;]+$') { throw 'CudaArchitectures must list numeric architectures' }
  $sdkPath = [IO.Path]::GetFullPath($CudaPath)
  $backendEnv = 'set "CUDA_PATH=' + $sdkPath + '" && set "CUDAToolkit_ROOT=' + $sdkPath + '" && set "CUDAARCHS=' + $CudaArchitectures +
    '" && set "CUDAFLAGS=-std=c++17 -Xcompiler=/Zc:preprocessor" && set "PATH=' + $sdkPath + '\bin;!PATH!"'
}
foreach ($path in @($vsPath,$sdkPath,$clangPath,$targetPath,$worker)) {
  if ($path -match '[&|<>^%!\r\n"]') { throw 'Build path contains unsupported command characters' }
}
if (!(Test-Path -LiteralPath $vsPath -PathType Leaf)) { throw 'Visual Studio environment script missing' }
$cargo = if ($Check) { 'cargo clippy --locked --release --features ' + $Backend + ' -- -D warnings' } else { 'cargo build --locked --release --features ' + $Backend }
$command = 'call "' + $vsPath + '" && ' + $backendEnv + ' && set "LIBCLANG_PATH=' + $clangPath +
  '" && set "CC=' + $clangPath + '\clang-cl.exe" && set "CXX=' + $clangPath +
  '\clang-cl.exe" && set "CFLAGS=/utf-8" && set "CXXFLAGS=/EHsc /utf-8" && set "CMAKE_GENERATOR=Ninja" && set "CARGO_TARGET_DIR=' +
  $targetPath + '" && set "PATH=' + $clangPath + ';!PATH!" && cd /d "' + $worker + '" && ' + $cargo
& $env:ComSpec /d /v:on /s /c $command
if ($LASTEXITCODE -ne 0) { throw "Worker build failed: $LASTEXITCODE" }



