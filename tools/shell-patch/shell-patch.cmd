@echo off
rem shell-patch - turn "logins survive a restart" on or off.
rem
rem Double-click this file. It finds a Node binary (DSH ships one, so nothing
rem needs to be installed), runs the menu, and keeps the window open so the
rem result can be read.
rem
rem Usage:  shell-patch.cmd [status|apply|revert] [--resources <dir>]
rem
rem Nothing here edits files by itself: shell-patch.mjs does the work and
rem verifies it. This launcher only locates Node and passes the arguments on.
rem Everything outside the Node resolution is ASCII on purpose: this file is
rem read through the console codepage, and a multi-byte character in a comment
rem is enough to break the batch parser.
setlocal

set "HERE=%~dp0"
set "SCRIPT=%HERE%shell-patch.mjs"
if not exist "%SCRIPT%" (
  echo.
  echo   [x] shell-patch.mjs not found next to this file.
  echo       Expected: %SCRIPT%
  echo.
  pause
  exit /b 1
)

rem --- 1. Node bundled with DSH -------------------------------------------------
set "NODE="
if defined DSH_HOME (
  for /d %%R in ("%DSH_HOME%\dsh-runtimes\*") do (
    if exist "%%~fR\dependencies\node\bin\node.exe" set "NODE=%%~fR\dependencies\node\bin\node.exe"
  )
)
if not defined NODE (
  for /d %%R in ("%USERPROFILE%\.dsh\dsh-runtimes\*") do (
    if exist "%%~fR\dependencies\node\bin\node.exe" set "NODE=%%~fR\dependencies\node\bin\node.exe"
  )
)

rem --- 2. Node on PATH ----------------------------------------------------------
if not defined NODE (
  for /f "delims=" %%N in ('where node 2^>nul') do (
    if not defined NODE set "NODE=%%N"
  )
)

rem --- 3. The usual install location --------------------------------------------
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"

if not defined NODE (
  echo.
  echo   [x] No Node binary found.
  echo       DSH normally ships one under %%USERPROFILE%%\.dsh\dsh-runtimes
  echo       Either start DSH once, or install Node and try again.
  echo.
  pause
  exit /b 1
)

"%NODE%" "%SCRIPT%" %*
set "CODE=%ERRORLEVEL%"
echo.
if not "%CODE%"=="0" echo   [exit %CODE%]
pause
exit /b %CODE%
