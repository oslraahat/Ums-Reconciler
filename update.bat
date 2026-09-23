@echo off
rem ===========================================================================
rem  UMS Reconciler - one-click updater (no git needed).
rem  Downloads the latest code from GitHub and refreshes the ums-reconciler
rem  folder next to this file. After it finishes, reload the extension in Chrome.
rem  Keep this file right next to the "ums-reconciler" folder you load as unpacked.
rem ===========================================================================
setlocal enableextensions
title UMS Reconciler - Update
cd /d "%~dp0"

set "REPO=oslraahat/Ums-Reconciler"
set "BRANCH=development"
set "TMP=%TEMP%\umsrec_update"
set "ZIP=%TMP%\src.zip"
set "DEST=%~dp0ums-reconciler"

echo(
echo  ============================================================
echo    UMS Reconciler - latest code download kora hocche...
echo  ============================================================
echo(

if not exist "%DEST%\manifest.json" (
  echo  [X] "ums-reconciler" folder ei file er pashe pawa gelo na.
  echo      update.bat ke tomar ums-reconciler folder er pashe rakho.
  goto :fail
)

if exist "%TMP%" rmdir /s /q "%TMP%"
mkdir "%TMP%" 2>nul

echo  [1/4] Downloading...
curl -L --fail -o "%ZIP%" "https://github.com/%REPO%/archive/refs/heads/%BRANCH%.zip"
if errorlevel 1 goto :fail

echo  [2/4] Extracting...
tar -xf "%ZIP%" -C "%TMP%"
if errorlevel 1 goto :fail

set "SRC=%TMP%\Ums-Reconciler-%BRANCH%\ums-reconciler"
if not exist "%SRC%\manifest.json" (
  echo  [X] Download thik moto hoyni.
  goto :fail
)

echo  [3/4] Updating files...
rem /E copies+overwrites but never deletes, so a partial source can't wipe the folder
robocopy "%SRC%" "%DEST%" /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NC /NS /NP >nul
rem robocopy: exit code 8+ = real error (0-7 are normal)
if errorlevel 8 goto :fail
rem also refresh the native host (crm-loadtest source), keeping its installed node_modules
set "HOSTSRC=%TMP%\Ums-Reconciler-%BRANCH%\crm-loadtest"
if exist "%HOSTSRC%\host\host.js" if exist "%~dp0crm-loadtest\" robocopy "%HOSTSRC%" "%~dp0crm-loadtest" /E /R:1 /W:1 /XD "%~dp0crm-loadtest\node_modules" /NFL /NDL /NJH /NJS /NC /NS /NP >nul

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
