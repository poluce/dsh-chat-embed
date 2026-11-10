@echo off
rem Restore the original DeepSeek Harness app.asar after the persistence patch.
rem
rem Usage:  restore-shell-patch.cmd [resources-dir]
rem The directory may also come from DSH_RESOURCES, otherwise the usual install
rem locations are tried.
setlocal
if not "%~1"=="" set "RES=%~1"
if "%RES%"=="" set "RES=%DSH_RESOURCES%"
if "%RES%"=="" if exist "%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app.asar" set "RES=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources"
if "%RES%"=="" if exist "C:\Program Files\DeepSeek Harness\resources\app.asar" set "RES=C:\Program Files\DeepSeek Harness\resources"
if "%RES%"=="" goto nores
if not exist "%RES%\app.asar.orig" goto nobackup

if exist "%RES%\app.asar" (
  move /Y "%RES%\app.asar" "%RES%\app.asar.patched.bak" >nul
)
move /Y "%RES%\app.asar.orig" "%RES%\app.asar" >nul
echo.
echo  [OK] 已恢复原版 app.asar
echo       补丁版备份在 app.asar.patched.bak
echo.
goto end

:nores
echo.
echo  [!!] 找不到 DSH 安装目录：请传入参数，或设置 DSH_RESOURCES。
echo       例：restore-shell-patch.cmd "D:\DeepSeek Harness\resources"
echo.

goto end

:nobackup
echo.
echo  [!!] 找不到 app.asar.orig，可能从未打过补丁，或已被还原过。
echo.

:end
pause
