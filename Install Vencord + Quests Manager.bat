@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
title Vencord + Quests Manager Installer

REM Do not elevate the whole script - Vencord rule
net session >nul 2>&1
if %errorlevel% EQU 0 goto :err_admin

cd /d "%~dp0"

set "SCRIPT_DIR=%~dp0"
set "VEN_DIR=%USERPROFILE%\Documents\Vencord"
set "DL_DIR=%SCRIPT_DIR%_dl"
set "LOCAL_PATCH=%SCRIPT_DIR%patch-discord.mjs"
set "RELEASE_API=https://api.github.com/repos/Afrsto/Discord-Quest-Auto-Completer/releases/latest"

call :banner
call :pathline "%VEN_DIR%"
echo.

where winget >nul 2>&1
if errorlevel 1 goto :err_winget

goto :step1

REM ============================================================
:step1
call :step 1 9 "Checking Node.js ..."
call :refresh_path
where node >nul 2>&1
if not errorlevel 1 (
    for /f "delims=" %%V in ('node --version 2^>nul') do call :ok "Node.js %%V"
    goto :step2
)

call :info "Installing Node.js LTS via winget - may prompt for UAC..."
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
call :refresh_path
where node >nul 2>&1
if errorlevel 1 (
    if exist "C:\Program Files\nodejs\node.exe" set "PATH=%PATH%;C:\Program Files\nodejs"
)
where node >nul 2>&1
if errorlevel 1 goto :err_node
for /f "delims=" %%V in ('node --version 2^>nul') do call :ok "Node.js %%V installed"
goto :step2

REM ============================================================
:step2
call :step 2 9 "Checking Git ..."
call :refresh_path
where git >nul 2>&1
if not errorlevel 1 (
    for /f "tokens=3 delims= " %%V in ('git --version 2^>nul') do call :ok "Git %%V"
    goto :step3
)

call :info "Installing Git via winget - may prompt for UAC..."
winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements
call :refresh_path
where git >nul 2>&1
if errorlevel 1 (
    if exist "C:\Program Files\Git\cmd\git.exe" set "PATH=%PATH%;C:\Program Files\Git\cmd"
)
where git >nul 2>&1
if errorlevel 1 goto :err_git
for /f "tokens=3 delims= " %%V in ('git --version 2^>nul') do call :ok "Git %%V installed"
goto :step3

REM ============================================================
:step3
call :step 3 9 "Checking pnpm ..."
call :refresh_path
where npm >nul 2>&1
if errorlevel 1 (
    if exist "C:\Program Files\nodejs\npm.cmd" set "PATH=%PATH%;C:\Program Files\nodejs"
)
where npm >nul 2>&1
if errorlevel 1 goto :err_npm

where pnpm >nul 2>&1
if not errorlevel 1 (
    for /f "delims=" %%V in ('pnpm --version 2^>nul') do call :ok "pnpm %%V"
    goto :step4
)

call :info "Installing pnpm ..."
call npm install -g pnpm
if errorlevel 1 goto :err_pnpm
call :refresh_path
where pnpm >nul 2>&1
if errorlevel 1 (
    set "PATH=%PATH%;%APPDATA%\npm"
)
where pnpm >nul 2>&1
if errorlevel 1 goto :err_pnpm
for /f "delims=" %%V in ('pnpm --version 2^>nul') do call :ok "pnpm %%V"
goto :step4

REM ============================================================
:step4
call :step 4 9 "Toolchain ready"
for /f "delims=" %%V in ('node --version 2^>nul') do call :ok "node %%V"
for /f "delims=" %%V in ('pnpm --version 2^>nul') do call :ok "pnpm %%V"
for /f "delims=" %%V in ('git --version 2^>nul') do call :ok "%%V"
echo.
goto :step5

REM ============================================================
:step5
call :step 5 9 "Preparing Vencord source ..."
if not exist "%USERPROFILE%\Documents" mkdir "%USERPROFILE%\Documents"

if exist "%VEN_DIR%" (
    call :info "Removing existing Vencord folder..."
    rmdir /s /q "%VEN_DIR%" >nul 2>&1
    if exist "%VEN_DIR%" (
        timeout /t 2 /nobreak >nul
        rmdir /s /q "%VEN_DIR%" >nul 2>&1
    )
    if exist "%VEN_DIR%" (
        set "VEN_DIR=%USERPROFILE%\Documents\Vencord_%RANDOM%"
        call :warn "Old folder locked - cloning to !VEN_DIR!"
    )
)

call :info "Cloning Vencord ..."
git clone --depth 1 https://github.com/Vencord/Vencord.git "%VEN_DIR%"
if errorlevel 1 goto :err_clone
cd /d "%VEN_DIR%"
if errorlevel 1 goto :err_clone
call :ok "Vencord cloned"
goto :step6

REM ============================================================
:step6
call :step 6 9 "Downloading Quests Manager assets ..."
if exist "%DL_DIR%" rmdir /s /q "%DL_DIR%" >nul 2>&1
mkdir "%DL_DIR%"
if not exist "%DL_DIR%" goto :err_dlmkdir

call :info "Fetching latest release from GitHub..."
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $h=@{ 'User-Agent'='Vencord-QM'; 'Accept'='application/vnd.github+json' }; $r=Invoke-RestMethod -Uri '%RELEASE_API%' -Headers $h; $s=($r.assets | Where-Object { $_.name -eq 'src.zip' } | Select-Object -First 1); $p=($r.assets | Where-Object { $_.name -eq 'patch-discord.mjs' } | Select-Object -First 1); if (-not $s) { throw 'src.zip missing from release' }; Invoke-WebRequest -Uri $s.browser_download_url -OutFile (Join-Path '%DL_DIR%' 'src.zip') -Headers $h; if ($p) { Invoke-WebRequest -Uri $p.browser_download_url -OutFile (Join-Path '%DL_DIR%' 'patch-discord.mjs') -Headers $h }; Write-Host ('    Release: ' + $r.tag_name) -ForegroundColor DarkGray"
if errorlevel 1 (
    call :warn "GitHub download reported an error - checking files..."
)

if not exist "%DL_DIR%\src.zip" goto :err_srczip

if not exist "%DL_DIR%\patch-discord.mjs" (
    if exist "%LOCAL_PATCH%" (
        call :warn "patch-discord.mjs missing from release - using local copy"
        copy /Y "%LOCAL_PATCH%" "%DL_DIR%\patch-discord.mjs" >nul
    )
)
if not exist "%DL_DIR%\patch-discord.mjs" goto :err_patchdl
call :ok "Assets downloaded"

if not exist "%VEN_DIR%\src\userplugins" mkdir "%VEN_DIR%\src\userplugins"
if exist "%VEN_DIR%\_extract" rmdir /s /q "%VEN_DIR%\_extract" >nul 2>&1

powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path '%DL_DIR%\src.zip' -DestinationPath '%VEN_DIR%\_extract' -Force"
if errorlevel 1 goto :err_extract

if exist "%VEN_DIR%\_extract\src\userplugins\questsManager\index.tsx" (
    xcopy /E /I /Y "%VEN_DIR%\_extract\src\userplugins\questsManager\*" "%VEN_DIR%\src\userplugins\questsManager\" >nul
    goto :plugin_copied
)
if exist "%VEN_DIR%\_extract\userplugins\questsManager\index.tsx" (
    xcopy /E /I /Y "%VEN_DIR%\_extract\userplugins\questsManager\*" "%VEN_DIR%\src\userplugins\questsManager\" >nul
    goto :plugin_copied
)
if exist "%VEN_DIR%\_extract\questsManager\index.tsx" (
    xcopy /E /I /Y "%VEN_DIR%\_extract\questsManager\*" "%VEN_DIR%\src\userplugins\questsManager\" >nul
    goto :plugin_copied
)
goto :err_plugin

:plugin_copied
rmdir /s /q "%VEN_DIR%\_extract" >nul 2>&1
if not exist "%VEN_DIR%\src\userplugins\questsManager\index.tsx" goto :err_plugin
call :ok "Plugin installed"
goto :step7

REM ============================================================
:step7
call :step 7 9 "Installing dependencies and building ..."
cd /d "%VEN_DIR%"
call :info "pnpm install - this may take a minute..."
call pnpm install --frozen-lockfile
if errorlevel 1 goto :err_install
call :info "pnpm build ..."
call pnpm build
if errorlevel 1 goto :err_build
if not exist "%VEN_DIR%\dist\patcher.js" goto :err_patcherjs
call :ok "Build complete"
goto :step8

REM ============================================================
:step8
call :step 8 9 "Checking existing Vencord patch ..."
taskkill /f /im Discord.exe >nul 2>&1
taskkill /f /im DiscordCanary.exe >nul 2>&1
taskkill /f /im DiscordPTB.exe >nul 2>&1
timeout /t 2 /nobreak >nul

set "WAS_PATCHED="
for /d %%D in ("%LOCALAPPDATA%\Discord\app-*") do (
    if exist "%%D\resources\_app.asar" set "WAS_PATCHED=1"
)

if not defined WAS_PATCHED (
    call :ok "No existing patch - skipped"
    goto :step9
)

call :info "Existing Vencord patch found - restoring stock Discord..."
for /d %%D in ("%LOCALAPPDATA%\Discord\app-*") do (
    if exist "%%D\resources\_app.asar" (
        if exist "%%D\resources\app.asar" del /f /q "%%D\resources\app.asar" >nul 2>&1
        ren "%%D\resources\_app.asar" app.asar >nul 2>&1
    )
)
call :ok "Previous patch removed"
goto :step9

REM ============================================================
:step9
call :step 9 9 "Installing into Discord ..."

if not exist "%DL_DIR%\patch-discord.mjs" (
    if exist "%LOCAL_PATCH%" (
        if not exist "%DL_DIR%" mkdir "%DL_DIR%"
        copy /Y "%LOCAL_PATCH%" "%DL_DIR%\patch-discord.mjs" >nul
    )
)
if not exist "%DL_DIR%\patch-discord.mjs" goto :err_nopatch
if not exist "%VEN_DIR%\dist\patcher.js" goto :err_patcherjs

call node "%DL_DIR%\patch-discord.mjs" "%VEN_DIR%" --quiet >nul
if errorlevel 1 goto :err_patchfail

set "PATCHED="
for /d %%D in ("%LOCALAPPDATA%\Discord\app-*") do (
    if exist "%%D\resources\_app.asar" set "PATCHED=1"
)
if not defined PATCHED goto :err_notpatched

call :ok "Discord patched"

if exist "%LOCALAPPDATA%\Discord\Update.exe" (
    start "" "%LOCALAPPDATA%\Discord\Update.exe" --processStart Discord.exe
) else (
    for /f "delims=" %%D in ('dir /b /ad /o-n "%LOCALAPPDATA%\Discord\app-*" 2^>nul') do (
        if exist "%LOCALAPPDATA%\Discord\%%D\Discord.exe" (
            start "" "%LOCALAPPDATA%\Discord\%%D\Discord.exe"
            goto :after_start
        )
    )
)
:after_start
call :ok "Discord started"

if exist "%DL_DIR%" rmdir /s /q "%DL_DIR%" >nul 2>&1

call :done
pause >nul
exit /b 0

REM ============================================================
REM Errors
REM ============================================================
:err_admin
echo.
call :fail "Do not run this script as Administrator. Close this window and double-click the .bat as a normal user."
:err_winget
call :fail "winget not found. Install App Installer from the Microsoft Store, then retry."
:err_node
call :fail "Node.js is still not available after install. Re-open this script after installing Node.js."
:err_git
call :fail "Git is still not available after install. Re-open this script after installing Git."
:err_npm
call :fail "npm not found. Re-open this script after Node.js install finishes."
:err_pnpm
call :fail "pnpm install failed or pnpm not on PATH."
:err_clone
call :fail "git clone failed."
:err_dlmkdir
call :fail "Could not create download folder _dl."
:err_srczip
call :fail "src.zip missing after download."
:err_patchdl
call :fail "patch-discord.mjs missing and no local copy found next to this .bat."
:err_extract
call :fail "Failed to extract src.zip."
:err_plugin
call :fail "questsManager plugin not found or not placed correctly."
:err_install
call :fail "pnpm install failed."
:err_build
call :fail "pnpm build failed."
:err_patcherjs
call :fail "dist\patcher.js missing after build."
:err_nopatch
call :fail "patch-discord.mjs not found. Place it next to this .bat or fix the GitHub release."
:err_patchfail
if exist "%DL_DIR%" rmdir /s /q "%DL_DIR%" >nul 2>&1
call :fail "Patch failed. Fully close Discord and re-run as a normal user - not Admin."
:err_notpatched
if exist "%DL_DIR%" rmdir /s /q "%DL_DIR%" >nul 2>&1
call :fail "Patch did not create resources\_app.asar. Close Discord and retry."

goto :eof

REM ============================================================
REM UI helpers - colors via PowerShell so cmd never parses ESC sequences
REM ============================================================
:banner
echo.
powershell -NoProfile -Command "Write-Host '============================================================' -ForegroundColor Cyan; Write-Host '        Vencord + Quests Manager Installer' -ForegroundColor Cyan; Write-Host '           Discord Quest Auto Completer setup' -ForegroundColor White; Write-Host '============================================================' -ForegroundColor Cyan"
exit /b 0

:pathline
set "UI_MSG=%~1"
powershell -NoProfile -Command "Write-Host '  Install path: ' -NoNewline -ForegroundColor DarkGray; Write-Host $env:UI_MSG -ForegroundColor Cyan"
exit /b 0

:step
echo.
powershell -NoProfile -Command "Write-Host '[%~1/%~2]' -NoNewline -ForegroundColor Cyan; Write-Host ' %~3' -ForegroundColor White"
exit /b 0

:ok
set "UI_MSG=%~1"
powershell -NoProfile -Command "Write-Host '  [OK]  ' -NoNewline -ForegroundColor Green; Write-Host $env:UI_MSG -ForegroundColor White"
exit /b 0

:skip
set "UI_MSG=%~1"
powershell -NoProfile -Command "Write-Host '  [SKIP]' -NoNewline -ForegroundColor Yellow; Write-Host (' ' + $env:UI_MSG) -ForegroundColor White"
exit /b 0

:info
set "UI_MSG=%~1"
powershell -NoProfile -Command "Write-Host ('  ' + $env:UI_MSG) -ForegroundColor DarkGray"
exit /b 0

:warn
set "UI_MSG=%~1"
powershell -NoProfile -Command "Write-Host '  [WARN]' -NoNewline -ForegroundColor Yellow; Write-Host (' ' + $env:UI_MSG) -ForegroundColor White"
exit /b 0

:fail
set "UI_MSG=%~1"
echo.
powershell -NoProfile -Command "Write-Host '  [FAIL]' -NoNewline -ForegroundColor Red; Write-Host (' ' + $env:UI_MSG) -ForegroundColor White"
echo.
pause
exit 1

:done
echo.
powershell -NoProfile -Command "Write-Host '============================================================' -ForegroundColor Cyan; Write-Host '                 Installation complete' -ForegroundColor Green; Write-Host '============================================================' -ForegroundColor Cyan; Write-Host ''; Write-Host '  Installed from: ' -NoNewline -ForegroundColor DarkGray; Write-Host $env:VEN_DIR -ForegroundColor Cyan; Write-Host ''; Write-Host '  Next steps:' -ForegroundColor White; Write-Host '  1. Wait for Discord to finish loading' -ForegroundColor White; Write-Host '  2. Open Settings  >  Vencord  >  Plugins' -ForegroundColor White; Write-Host '  3. Search for ' -NoNewline -ForegroundColor White; Write-Host ('\"' + 'Quests Manager' + '\"') -NoNewline -ForegroundColor Magenta; Write-Host ' and enable it' -ForegroundColor White; Write-Host ''"
exit /b 0

:refresh_path
for /f "tokens=2*" %%a in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "SYS_PATH=%%b"
for /f "tokens=2*" %%a in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USR_PATH=%%b"
set "PATH=%SYS_PATH%;%USR_PATH%;C:\Program Files\nodejs;C:\Program Files\Git\cmd;%APPDATA%\npm;%PATH%"
exit /b 0
