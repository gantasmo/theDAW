@echo off
title theDAW

:: Run from the repo root (this script's folder) so the checks + bootstrap
:: below resolve .venv / frontend\node_modules relative to the project.
cd /d "%~dp0"

:: -- Preflight: required tools ------------------------------------------
:: uv  = Python env manager (creates .venv, installs torch/CUDA + flash-attn)
:: node/npm = frontend dev server + the VJ sidecar
:: ffmpeg = all audio I/O (effects, exports, library ingest, MIDI, YouTube)
:: The public tunnel (localtunnel "lt") is optional and auto-detected by the
:: dev stack at the end.
set "MISSING="
where uv     >nul 2>&1 || set "MISSING=%MISSING% uv"
where node   >nul 2>&1 || set "MISSING=%MISSING% node"
where npm    >nul 2>&1 || set "MISSING=%MISSING% npm"
where ffmpeg >nul 2>&1 || set "MISSING=%MISSING% ffmpeg"
where git    >nul 2>&1 || set "MISSING=%MISSING% git"
if defined MISSING (
    echo   Missing tools:%MISSING%
    echo   Running the one-time setup helper ^(detects hardware + installs prerequisites with your consent^)...
    echo.
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install\setup.ps1"
    if errorlevel 10 goto :rerun
    if errorlevel 2 goto :needtools
)
:: Re-verify the hard-required tools before bootstrapping.
where uv   >nul 2>&1 || goto :needtools
where node >nul 2>&1 || goto :needtools
where npm  >nul 2>&1 || goto :needtools
where ffmpeg >nul 2>&1 || echo   [!] ffmpeg not on PATH - audio effects/exports/ingest fail until installed.

:: -- Bootstrap Python deps if the venv is missing OR incomplete --------
:: A previous `uv sync` can be interrupted AFTER uv creates the venv but
:: BEFORE it installs packages, leaving .venv\Scripts\activate present while
:: uvicorn / fastapi and the other declared deps are absent. The old
:: "venv exists -> skip sync" check then launched the backend against a
:: half-built env and crashed on `import uvicorn`. So sync when a core import
:: fails too, not only when the venv is missing entirely.
set "NEED_SYNC=0"
if not exist ".venv\Scripts\activate" set "NEED_SYNC=1"
if not exist ".venv\Scripts\python.exe" set "NEED_SYNC=1"
if "%NEED_SYNC%"=="0" (
    .venv\Scripts\python.exe -c "import uvicorn, fastapi" >nul 2>&1
    if errorlevel 1 set "NEED_SYNC=1"
)
if "%NEED_SYNC%"=="1" (
    echo Bootstrapping Python env: uv sync --group dev
    echo   First run downloads torch + CUDA wheels and can take several minutes...
    call uv sync --group dev
    if errorlevel 1 (
        echo.
        echo   [X] uv sync failed - see the error above.
        pause
        exit /b 1
    )
)
if not exist "frontend\node_modules" (
    echo Installing frontend dependencies: npm install
    pushd frontend
    call npm install
    if errorlevel 1 (
        popd
        echo.
        echo   [X] npm install failed - see the error above.
        pause
        exit /b 1
    )
    popd
)
echo.

:: -- Kill any stale processes on our ports ------------------------------
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":5173 " ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":8600 " ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":5187 " ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>&1
timeout /t 1 /nobreak >nul

:: -- Read the saved launch mode (web | desktop) from data\settings.json -
:: Set in-app via Settings -> Startup. Defaults to web if unset/missing.
set "LAUNCH_MODE=web"
if not exist "data\settings.json" goto :modeready
if not exist ".venv\Scripts\python.exe" goto :modeready
:: NOTE: the python path must be UNQUOTED here — a quoted exe inside a `for /f`
:: backtick command breaks cmd's parser (and 2^>nul would then hide the error,
:: silently falling back to web). The path has no spaces, so unquoted is safe.
for /f "usebackq delims=" %%m in (`.venv\Scripts\python.exe -c "import json;print((json.load(open('data/settings.json')).get('app') or {}).get('launch_mode','web'))" 2^>nul`) do set "LAUNCH_MODE=%%m"
:modeready

if /i "%LAUNCH_MODE%"=="desktop" goto :desktop

:: -- WEB mode: backend + Vite + browser in THIS one console -----------
:: backend._devstack runs the backend (with the rc=88 restart contract so the
:: in-app Restart button works), the Vite frontend, and the optional
:: localtunnel, streaming all three as prefixed [backend] / [frontend] /
:: [tunnel] log lines here. It opens http://localhost:5173 once Vite is ready.
:: Ctrl-C in this window stops everything.
echo Launch mode: WEB ^(browser^)  -  change in Settings ^> Startup
call .venv\Scripts\activate
python -m backend._devstack
goto :stopped

:desktop
:: -- DESKTOP mode: the Electron shell (it spawns the backend itself) ---
:: electron-vite serves the same frontend and Electron starts the backend
:: (backend._supervisor) if one isn't already running. Close the window or
:: Ctrl-C to stop. Switch back to the browser in Settings ^> Startup.
echo Launch mode: DESKTOP ^(Electron^)  -  change in Settings ^> Startup
:: Auto-install/refresh desktop deps so startup never needs a terminal.
:: Reinstall when node_modules is missing OR electron-ui\package.json changed
:: since the last install (npm writes node_modules\.package-lock.json on install).
set "NEED_DESKTOP_NPM=0"
if not exist "electron-ui\node_modules" set "NEED_DESKTOP_NPM=1"
if not exist "electron-ui\node_modules\.package-lock.json" goto :desktop_npm_ready
if not exist ".venv\Scripts\python.exe" goto :desktop_npm_ready
for /f "usebackq delims=" %%s in (`.venv\Scripts\python.exe -c "import os;print(1 if os.path.getmtime('electron-ui/package.json')>os.path.getmtime('electron-ui/node_modules/.package-lock.json') else 0)" 2^>nul`) do set "NEED_DESKTOP_NPM=%%s"
:desktop_npm_ready
if "%NEED_DESKTOP_NPM%"=="1" (
    echo Installing/updating desktop app dependencies - first run or after an update can take a few minutes...
    pushd electron-ui
    call npm install
    popd
)

:: Ensure the Electron binary is actually present. An interrupted download
:: leaves the package installed but WITHOUT its binary, which makes electron-vite
:: throw "Electron uninstall". Self-heal by re-running electron's own installer
:: (idempotent + resumable) - this must never take down the launch.
if not exist "electron-ui\node_modules\electron\dist\electron.exe" (
    echo Repairing Electron download ^(a previous run may have been interrupted^)...
    pushd electron-ui
    if exist "node_modules\electron\install.js" node node_modules\electron\install.js
    popd
)

:: If the desktop app still can't run, fall back to the browser - NEVER fail.
if not exist "electron-ui\node_modules\electron\dist\electron.exe" (
    echo.
    echo   Desktop app isn't ready yet - starting theDAW in your browser instead.
    echo   Re-run theDAW.bat later to retry the desktop app.
    echo.
    call .venv\Scripts\activate
    python -m backend._devstack
    goto :stopped
)

pushd electron-ui
call npm run dev
popd
goto :stopped

:stopped
echo.
echo theDAW stopped. Press any key to close this window...
pause >nul
exit /b 0

:rerun
echo.
echo   Setup installed new tools. Close this window and double-click theDAW.bat again to launch.
echo.
pause
exit /b 0

:needtools
echo.
echo   theDAW needs uv + Node to run, and they are not installed yet.
echo   Double-click theDAW.bat again to retry the installer, or install uv + Node by hand.
echo.
pause
exit /b 1
