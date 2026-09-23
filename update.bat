@echo off
rem ===========================================================================
rem  UMS Reconciler - one-click updater (no git needed).
rem  Downloads the latest code from GitHub and refreshes THIS folder (the one you
rem  load as an unpacked extension). After it finishes, reload the extension in
rem  Chrome. Keep update.bat in the extension folder (next to manifest.json).
rem ===========================================================================
setlocal enableextensions
title UMS Reconciler - Update
cd /d "%~dp0"

set "REPO=oslraahat/Ums-Reconciler"
set "BRANCH=development"
set "TMP=%TEMP%\umsrec_update"
set "ZIP=%TMP%\src.zip"
set "DEST=%~dp0"
if "%DEST:~-1%"=="\" set "DEST=%DEST:~0,-1%"

echo(
echo  ============================================================
echo    UMS Reconciler - latest code download kora hocche...
echo  ============================================================
echo(

if not exist "%DEST%\manifest.json" (
  echo  [X] manifest.json ei folder e pawa gelo na.
  echo      update.bat ke extension folder e (manifest.json er pashe) rakho.
  goto :fail
)

if exist "%TMP%" rmdir /s /q "%TMP%"
mkdir "%TMP%" 2>nul

echo  [1/4] Downloading...
curl -L --fail -o "%ZIP%" "https://codeload.github.com/%REPO%/zip/refs/heads/%BRANCH%"
if errorlevel 1 goto :fail

echo  [2/4] Extracting...
tar -xf "%ZIP%" -C "%TMP%"
if errorlevel 1 goto :fail

set "SRC=%TMP%\Ums-Reconciler-%BRANCH%"
if not exist "%SRC%\manifest.json" (
  echo  [X] Download thik moto hoyni.
  goto :fail
)

echo  [3/4] Updating files...
rem /E copies+overwrites but never deletes, so a partial source can't wipe the folder;
rem /XD keeps the installed node_modules and the .git history untouched.
robocopy "%SRC%" "%DEST%" /E /R:1 /W:1 /XD "%DEST%\crm-loadtest\node_modules" "%DEST%\.git" /NFL /NDL /NJH /NJS /NC /NS /NP >nul
rem robocopy: exit code 8+ = real error (0-7 are normal)
if errorlevel 8 goto :fail

echo  [4/4] Cleaning up...
rmdir /s /q "%TMP%" 2>nul

for /f "tokens=2 delims=:, " %%v in ('findstr /i "\"version\"" "%DEST%\manifest.json"') do set "NEWVER=%%~v"

echo(
echo  ============================================================
echo    HOYE GECHE!  (version %NEWVER%)
echo    Ekhon:
echo      1) Chrome e  chrome://extensions  kholo
echo      2) UMS Reconciler er niche Reload (refresh) icon e click koro
echo  ============================================================
echo(
pause
exit /b 0

:fail
echo(
echo  *** UPDATE BYARTHO ***
echo  - Internet connection ache ki na dekho
echo  - GitHub repo public ache ki na dekho
echo(
pause
exit /b 1
