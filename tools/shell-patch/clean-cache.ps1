# clean-cache.ps1 - free the persistent sidebar-browser caches, keep the logins.
#
# The shell patch made `dsh-sidebar-browser-*` partitions persistent, so each
# workspace keeps its Chromium profile on disk. Most of that is disposable
# cache; the login itself lives in IndexedDB / Local Storage / Cookies, which
# this script never touches.
#
# The app must be closed: Chromium holds exclusive locks on the cache files.

param(
  [string]$Partitions = $env:DSH_PARTITIONS
)

$ErrorActionPreference = 'Continue'

$app     = 'DeepSeek Harness'
if (-not $Partitions) {
  $candidates = @()
  if ($env:APPDATA) { $candidates += (Join-Path $env:APPDATA '@deepseek-ai\dsh-desktop\Partitions') }
  if ($env:APPDATA) { $candidates += (Join-Path $env:APPDATA 'DeepSeek Harness\Partitions') }
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { $Partitions = $candidate; break }
  }
}
$base    = $Partitions
$cacheDirs = @(
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GrShaderCache',
  'ShaderCache',
  'Shared Dictionary'
)

if (-not $base) {
  Write-Host '  找不到 Partitions 目录：请用 -Partitions <dir> 指定，或设置 DSH_PARTITIONS。'
  exit 1
}

$running = Get-Process -Name $app -ErrorAction SilentlyContinue
if ($running) {
  Write-Host ''
  Write-Host '  DSH 正在运行，缓存文件被占用，无法清理。' -ForegroundColor Yellow
  Write-Host '  请先完全退出 DSH（托盘/菜单「退出」），再运行本脚本。' -ForegroundColor Yellow
  Write-Host ''
  exit 1
}

if (-not (Test-Path $base)) {
  Write-Host '  没有找到 Partitions 目录，无需清理。'
  exit 0
}

$before = (Get-ChildItem $base -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum

foreach ($partition in (Get-ChildItem $base -Directory -ErrorAction SilentlyContinue)) {
  $freed = 0
  foreach ($name in $cacheDirs) {
    $target = Join-Path $partition.FullName $name
    if (-not (Test-Path $target)) { continue }
    $size = (Get-ChildItem $target -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    Remove-Item -Recurse -Force $target -ErrorAction SilentlyContinue
    if (-not (Test-Path $target)) { $freed += $size }
  }
  if ($freed -gt 0) {
    Write-Host ("  {0}: 释放 {1:N1} MB（登录数据保留）" -f $partition.Name, ($freed / 1MB))
  }
}

$after = (Get-ChildItem $base -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
Write-Host ''
Write-Host ("  总计释放 {0:N1} MB，剩余 {1:N1} MB" -f (($before - $after) / 1MB), ($after / 1MB))
Write-Host '  登录状态、Cookie、LocalStorage 均未改动。'
Write-Host ''
