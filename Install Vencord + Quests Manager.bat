@echo off
chcp 65001 >nul
title Vencord Auto Installer

net session >nul 2>&1
if %errorlevel% EQU 0 (
    echo [!] Do not run this script as Administrator.
    echo     Close this window and double-click the .bat as a normal user.
    echo     https://vencord.dev/download/
    pause
    exit /b 1
)

cd /d "%~dp0"

set "SCRIPT_DIR=%~dp0"
set "VEN_DIR=%USERPROFILE%\Documents\Vencord"
set "DL_DIR=%SCRIPT_DIR%_dl"

echo ==================================================
echo         Vencord Auto Installer
echo ==================================================
echo     Install path: %VEN_DIR%
echo ==================================================
echo.

where winget >nul 2>&1
if %errorlevel% NEQ 0 (
    echo [!] winget not found. Install "App Installer" from Microsoft Store then try again.
    pause
    exit /b
)

echo [1/8] Checking Node.js ...
where node >nul 2>&1
if %errorlevel% NEQ 0 (
    echo     Installing Node.js via winget ...
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    if %errorlevel% NEQ 0 (
        echo [!] Could not install Node.js. Install it manually, then re-run this script as a normal user.
        pause
        exit /b
    )
) else (
    echo     Node.js is already installed.
)

echo [2/8] Checking Git ...
where git >nul 2>&1
if %errorlevel% NEQ 0 (
    echo     Installing Git via winget ...
    winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements
    if %errorlevel% NEQ 0 (
        echo [!] Could not install Git. Install it manually, then re-run this script as a normal user.
        pause
        exit /b
    )
) else (
    echo     Git is already installed.
)

for /f "tokens=2*" %%a in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "SYS_PATH=%%b"
for /f "tokens=2*" %%a in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USR_PATH=%%b"
set "PATH=%SYS_PATH%;%USR_PATH%;C:\Program Files\nodejs;C:\Program Files\Git\cmd"

echo [3/8] Installing pnpm ...
call npm install -g pnpm

echo.
echo [4/8] Versions:
call node --version
call pnpm --version
call git --version
echo.

echo [5/8] Preparing Vencord source in Documents ...
if not exist "%USERPROFILE%\Documents" (
    mkdir "%USERPROFILE%\Documents"
)

if exist "%VEN_DIR%" (
    echo     Vencord folder already exists, deleting it...
    rmdir /s /q "%VEN_DIR%"
)
echo     Cloning Vencord into %VEN_DIR% ...
git clone https://github.com/Vencord/Vencord.git "%VEN_DIR%"
if %errorlevel% NEQ 0 (
    echo [!] Clone failed!
    pause
    exit /b
)

cd /d "%VEN_DIR%"

echo [6/8] Downloading Quests Manager assets and installing plugin ...
if exist "%DL_DIR%" rmdir /s /q "%DL_DIR%" >nul 2>&1
mkdir "%DL_DIR%"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$headers=@{ 'User-Agent'='Vencord-QuestsManager-Installer'; 'Accept'='application/vnd.github+json' };" ^
  "$rel=Invoke-RestMethod -Uri 'https://api.github.com/repos/Afrsto/Discord-Quest-Auto-Completer/releases/latest' -Headers $headers;" ^
  "$src=$rel.assets | Where-Object { $_.name -eq 'src.zip' } | Select-Object -First 1;" ^
  "$patch=$rel.assets | Where-Object { $_.name -eq 'patch-discord.mjs' } | Select-Object -First 1;" ^
  "if (-not $src -or -not $patch) { throw 'Latest release is missing src.zip or patch-discord.mjs' };" ^
  "Invoke-WebRequest -Uri $src.browser_download_url -OutFile (Join-Path '%DL_DIR%' 'src.zip') -Headers $headers;" ^
  "Invoke-WebRequest -Uri $patch.browser_download_url -OutFile (Join-Path '%DL_DIR%' 'patch-discord.mjs') -Headers $headers;" ^
  "Write-Host ('    Downloaded release ' + $rel.tag_name)"
if %errorlevel% NEQ 0 (
    echo [!] Failed to download latest release assets from GitHub.
    echo     https://api.github.com/repos/Afrsto/Discord-Quest-Auto-Completer/releases/latest
    pause
    exit /b 1
)

if not exist "%DL_DIR%\src.zip" (
    echo [!] src.zip was not downloaded.
    pause
    exit /b 1
)
if not exist "%DL_DIR%\patch-discord.mjs" (
    echo [!] patch-discord.mjs was not downloaded.
    pause
    exit /b 1
)

if not exist "%VEN_DIR%\src\userplugins" mkdir "%VEN_DIR%\src\userplugins"

powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path '%DL_DIR%\src.zip' -DestinationPath '%VEN_DIR%\_extract' -Force"
if %errorlevel% NEQ 0 (
    echo [!] Extraction failed!
    pause
    exit /b 1
)

if exist "%VEN_DIR%\_extract\src\userplugins\questsManager\index.tsx" (
    xcopy /E /I /Y "%VEN_DIR%\_extract\src\userplugins\questsManager\*" "%VEN_DIR%\src\userplugins\questsManager\" >nul
) else if exist "%VEN_DIR%\_extract\userplugins\questsManager\index.tsx" (
    xcopy /E /I /Y "%VEN_DIR%\_extract\userplugins\questsManager\*" "%VEN_DIR%\src\userplugins\questsManager\" >nul
) else if exist "%VEN_DIR%\_extract\questsManager\index.tsx" (
    xcopy /E /I /Y "%VEN_DIR%\_extract\questsManager\*" "%VEN_DIR%\src\userplugins\questsManager\" >nul
) else (
    echo [!] Could not find questsManager\index.tsx in the extracted archive.
    pause
    exit /b 1
)

rmdir /s /q "%VEN_DIR%\_extract" >nul 2>&1

if not exist "%VEN_DIR%\src\userplugins\questsManager\index.tsx" (
    echo [!] ERROR: questsManager\index.tsx is not in the correct path!
    echo     Expected: %VEN_DIR%\src\userplugins\questsManager\index.tsx
    pause
    exit /b 1
) else (
    echo     questsManager files are correctly placed.
)

echo [7/8] Installing dependencies and building ...
call pnpm install --frozen-lockfile
if %errorlevel% NEQ 0 (
    echo [!] pnpm install failed! Check for errors above.
    pause
    exit /b
)

call pnpm build
if %errorlevel% NEQ 0 (
    echo [!] pnpm build failed! Check for errors above.
    pause
    exit /b
)

echo [8/8] Installing into Discord ...
taskkill /f /im Discord.exe >nul 2>&1
taskkill /f /im DiscordCanary.exe >nul 2>&1
taskkill /f /im DiscordPTB.exe >nul 2>&1
timeout /t 2 >nul

call node "%DL_DIR%\patch-discord.mjs" "%VEN_DIR%" --quiet >nul
if %errorlevel% NEQ 0 (
    echo [!] Patch failed. Fully close Discord and re-run as a normal user ^(not Admin^).
    rmdir /s /q "%DL_DIR%" >nul 2>&1
    pause
    exit /b 1
)

set "PATCHED="
for /d %%D in ("%LOCALAPPDATA%\Discord\app-*") do (
    if exist "%%D\resources\_app.asar" set "PATCHED=1"
)
if not defined PATCHED (
    echo [!] Patch finished but Discord was not patched.
    echo     Expected: %LOCALAPPDATA%\Discord\app-*\resources\_app.asar
    echo     Fully close Discord, then re-run this script as a normal user ^(not Admin^).
    rmdir /s /q "%DL_DIR%" >nul 2>&1
    pause
    exit /b 1
)

rmdir /s /q "%DL_DIR%" >nul 2>&1

if exist "%LOCALAPPDATA%\Discord\Update.exe" (
    start "" "%LOCALAPPDATA%\Discord\Update.exe" --processStart Discord.exe
) else (
    for /f "delims=" %%D in ('dir /b /ad /o-n "%LOCALAPPDATA%\Discord\app-*" 2^>nul') do (
        if exist "%LOCALAPPDATA%\Discord\%%D\Discord.exe" start "" "%LOCALAPPDATA%\Discord\%%D\Discord.exe" & goto :discord_started
    )
)
:discord_started

echo.
echo ==================================================
echo    Done! Vencord installed from: %VEN_DIR%
echo.
echo    Discord is starting. Then go to:
echo    Settings ^> Vencord ^> Plugins
echo    Search for "Quests Manager" and enable it.
echo ==================================================
pause >nul
