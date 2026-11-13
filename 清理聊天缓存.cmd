@echo off
rem Free the disposable Chromium caches of the embedded browser, keep the logins.
rem
rem This is a shortcut for "shell-patch.cmd cache"; the same thing is item 4 in
rem that script's menu. Close DSH first for a thorough clean.
setlocal
set "HERE=%~dp0"
if not exist "%HERE%tools\shell-patch\shell-patch.cmd" (
  echo.
  echo   [x] tools\shell-patch\shell-patch.cmd not found.
  echo.
  pause
  exit /b 1
)
call "%HERE%tools\shell-patch\shell-patch.cmd" cache
