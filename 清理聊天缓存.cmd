@echo off
rem Free the disposable Chromium caches of the embedded browser, keep the logins.
rem
rem Usage:  清理聊天缓存.cmd [partitions-dir]
rem The directory may also come from DSH_PARTITIONS; the usual locations are
rem tried otherwise. Close DSH before running this.
if "%~1"=="" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\shell-patch\clean-cache.ps1"
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\shell-patch\clean-cache.ps1" -Partitions "%~1"
)
pause
