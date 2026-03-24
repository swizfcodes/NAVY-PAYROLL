@echo off
setlocal EnableDelayedExpansion
title Navy Payroll - SSL Setup Automation

:: ============================================================
::  Self-elevate to Administrator if not already
:: ============================================================
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [INFO] Requesting Administrator privileges...
    powershell -Command "Start-Process cmd.exe -ArgumentList '/c \"%~f0\"' -Verb RunAs -WorkingDirectory '%~dp0'"
    exit /b
)

echo.
echo ============================================================
echo   NAVY PAYROLL - Local HTTPS Setup
echo ============================================================
echo.
echo ============================================================
echo   *** WARNING - READ BEFORE CONTINUING ***
echo ============================================================
echo.
echo   This script MUST be run ONLY on the designated SERVER
echo   machine. It will:
echo.
echo     - CHANGE your network adapter IPv4 to a static IP
echo     - This can disconnect you from your router/hotspot
echo       if run on the wrong machine or wrong network
echo.
echo   DO NOT run this on:
echo     - Your personal laptop or daily-use machine
echo     - Any machine NOT acting as the Navy Payroll server
echo     - A machine connected to a different network/router
echo.
echo   If you lost connection after running this by mistake:
echo     netsh interface ip set address name="Wi-Fi" dhcp
echo     netsh interface ip set address name="Ethernet" dhcp
echo.
echo ============================================================
echo.
set /p "CONFIRM=Are you on the SERVER machine? Type YES to continue: "
if /i "!CONFIRM!" neq "YES" (
    echo [ABORTED] Run this script only on the server machine.
    pause
    exit /b 0
)
echo.


:: ============================================================
:: STEP 0 — Stop existing Navy Payroll tasks and free ports
:: ============================================================
echo [0/8] Stopping existing Navy Payroll services...

schtasks /end /tn "NavyPayroll-App"   >nul 2>&1
schtasks /end /tn "NavyPayroll-Proxy" >nul 2>&1
echo [INFO] Stopped existing tasks (if running)

timeout /t 3 /nobreak >nul

:: Force kill port 5500 — always ours
for /f "tokens=5" %%A in ('netstat -ano ^| findstr /i "0.0.0.0:5500 " ^| findstr /i "LISTENING"') do (
    echo [INFO] Killing process on port 5500 ^(PID %%A^)...
    taskkill /PID %%A /F >nul 2>&1
)

:: Port 443 — ask if something else is using it
set "P443_PID="
for /f "tokens=5" %%A in ('netstat -ano ^| findstr /i "0.0.0.0:443 " ^| findstr /i "LISTENING"') do (
    if not defined P443_PID set "P443_PID=%%A"
)
if defined P443_PID (
    set "P443_NAME=unknown"
    for /f "tokens=1" %%B in ('tasklist /fi "PID eq !P443_PID!" /fo csv /nh 2^>nul') do set "P443_NAME=%%B"
    echo [WARN] Port 443 is in use by !P443_NAME! ^(PID !P443_PID!^)
    echo   [1] Use a different HTTPS port
    echo   [2] Force kill it and use 443
    echo   [3] Abort
    set /p "C443=Choose [1/2/3]: "
    if "!C443!"=="1" (
        set /p "HTTPS_PORT=Enter alternative HTTPS port: "
        echo [OK] Will use HTTPS port !HTTPS_PORT!
    ) else if "!C443!"=="2" (
        taskkill /PID !P443_PID! /F >nul 2>&1
        echo [OK] Killed PID !P443_PID! — port 443 freed
    ) else (
        echo [ABORTED] Free port 443 manually then re-run.
        pause
        exit /b 0
    )
)

:: Port 80 — ask if something else is using it
set "P80_PID="
for /f "tokens=5" %%A in ('netstat -ano ^| findstr /i "0.0.0.0:80 " ^| findstr /i "LISTENING"') do (
    if not defined P80_PID set "P80_PID=%%A"
)
if defined P80_PID (
    set "P80_NAME=unknown"
    for /f "tokens=1" %%B in ('tasklist /fi "PID eq !P80_PID!" /fo csv /nh 2^>nul') do set "P80_NAME=%%B"
    echo [WARN] Port 80 is in use by !P80_NAME! ^(PID !P80_PID!^)
    echo   [1] Use a different HTTP port
    echo   [2] Force kill it and use 80
    echo   [3] Abort
    set /p "C80=Choose [1/2/3]: "
    if "!C80!"=="1" (
        set /p "HTTP_PORT=Enter alternative HTTP port: "
        echo [OK] Will use HTTP port !HTTP_PORT!
    ) else if "!C80!"=="2" (
        taskkill /PID !P80_PID! /F >nul 2>&1
        echo [OK] Killed PID !P80_PID! — port 80 freed
    ) else (
        echo [ABORTED] Free port 80 manually then re-run.
        pause
        exit /b 0
    )
)

echo [OK] Ports cleared
timeout /t 2 /nobreak >nul


:: ============================================================
:: STEP 1 — Verify .env.local exists
:: ============================================================
echo [1/8] Checking .env.local...

set "ENV_FILE=%~dp0.env.local"
if not exist "%ENV_FILE%" (
    echo [ERROR] .env.local not found at %ENV_FILE%
    echo         Please create it before running this script.
    pause
    exit /b 1
)

echo [OK] .env.local found


:: ============================================================
:: STEP 2 — Auto-detect active adapter + current IP + gateway
:: ============================================================
echo.
echo [2/8] Detecting active network adapter and IP...

set "ADAPTER="
for /f "skip=2 tokens=1,2,3,*" %%A in ('netsh interface show interface') do (
    if /i "%%B"=="Connected" (
        if not defined ADAPTER set "ADAPTER=%%D"
    )
)

if not defined ADAPTER (
    echo [ERROR] Could not detect an active network adapter.
    pause
    exit /b 1
)

echo [OK] Adapter = %ADAPTER%

set "LOCAL_IP="
for /f "tokens=2 delims=:" %%A in ('netsh interface ip show address name^="%ADAPTER%" ^| findstr /i "IP Address"') do (
    for /f "tokens=1" %%B in ("%%A") do (
        if not defined LOCAL_IP set "LOCAL_IP=%%B"
    )
)

if not defined LOCAL_IP (
    echo [ERROR] Could not detect IP for adapter "%ADAPTER%".
    pause
    exit /b 1
)

echo [OK] Detected IP = %LOCAL_IP%

set "GATEWAY="
for /f "tokens=2 delims=:" %%A in ('netsh interface ip show address name^="%ADAPTER%" ^| findstr /i "Default Gateway"') do (
    for /f "tokens=1" %%B in ("%%A") do (
        if not defined GATEWAY set "GATEWAY=%%B"
    )
)

if not defined GATEWAY (
    echo [WARN] Could not detect gateway. Defaulting to 192.168.0.1
    set "GATEWAY=192.168.0.1"
) else (
    echo [OK] Gateway = %GATEWAY%
)


:: ============================================================
:: STEP 3 — Prompt for friendly .local domain name
:: ============================================================
echo.
echo [3/8] Friendly LAN domain name setup...
echo       Must end in .local (e.g. navypayroll.local)
echo.

set "EXISTING_DOMAIN="
for /f "usebackq tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
    for /f "tokens=1 delims=# " %%C in ("%%B") do (
        if /i "%%A"=="LOCAL_DOMAIN" set "EXISTING_DOMAIN=%%C"
    )
)

if defined EXISTING_DOMAIN (
    echo [INFO] Existing domain found: %EXISTING_DOMAIN%
    set /p "KEEP_DOMAIN=Keep this domain? [Y/N]: "
    if /i "!KEEP_DOMAIN!"=="Y" (
        set "DOMAIN=%EXISTING_DOMAIN%"
        goto domain_ok
    )
)

:ask_domain
set /p "DOMAIN=Enter your preferred domain name: "
if /i "!DOMAIN:~-6!"==".local" goto domain_ok
echo [ERROR] Domain must end in .local - try again.
goto ask_domain
:domain_ok

echo [OK] Domain = %DOMAIN%


:: ============================================================
:: Write LOCAL_IP and LOCAL_DOMAIN to .env.local under SERVER_MODE=
:: ============================================================
echo.
echo [INFO] Writing LOCAL_IP and LOCAL_DOMAIN to .env.local...

:: ── Write LOCAL_IP + LOCAL_DOMAIN to an env file ─────────
:: Uses PowerShell for reliable single-pass dedup + inject
set "TEMP_PS=%TEMP%\write_env.ps1"

> "%TEMP_PS%" echo function Write-EnvVars($filePath, $ip, $domain) {
>> "%TEMP_PS%" echo     if (-not (Test-Path $filePath)) { return }
>> "%TEMP_PS%" echo     $lines = Get-Content $filePath ^| Where-Object { $_ -notmatch '^LOCAL_IP=' -and $_ -notmatch '^LOCAL_DOMAIN=' }
>> "%TEMP_PS%" echo     $out = @(); $written = $false
>> "%TEMP_PS%" echo     foreach ($line in $lines) {
>> "%TEMP_PS%" echo         $out += $line
>> "%TEMP_PS%" echo         if (-not $written -and $line -match '^SERVER_MODE=') {
>> "%TEMP_PS%" echo             $out += "LOCAL_IP=$ip"
>> "%TEMP_PS%" echo             $out += "LOCAL_DOMAIN=$domain"
>> "%TEMP_PS%" echo             $written = $true
>> "%TEMP_PS%" echo         }
>> "%TEMP_PS%" echo     }
>> "%TEMP_PS%" echo     if (-not $written) { $out += "LOCAL_IP=$ip"; $out += "LOCAL_DOMAIN=$domain" }
>> "%TEMP_PS%" echo     $out ^| Set-Content $filePath -Encoding UTF8
>> "%TEMP_PS%" echo }

>> "%TEMP_PS%" echo Write-EnvVars '%~dp0.env.local' '%LOCAL_IP%' '%DOMAIN%'
>> "%TEMP_PS%" echo Write-EnvVars '%~dp0.env.production' '%LOCAL_IP%' '%DOMAIN%'

powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP_PS%"
del "%TEMP_PS%" >nul 2>&1

echo [OK] LOCAL_IP=%LOCAL_IP% written to .env.local and .env.production
echo [OK] LOCAL_DOMAIN=%DOMAIN% written to .env.local and .env.production


:: ============================================================
:: STEP 4 - Lock in Static IP (preserving detected DNS)
:: ============================================================
echo.
echo [4/8] Setting static IP %LOCAL_IP% on adapter "%ADAPTER%"...

:: Detect current DNS before switching to static
set "DNS1="
for /f "tokens=2 delims=:" %%A in ('netsh interface ip show dns name^="%ADAPTER%" ^| findstr /i "DNS Servers\|statically"') do (
    for /f "tokens=1" %%B in ("%%A") do (
        if not defined DNS1 set "DNS1=%%B"
    )
)
:: Fallback via ipconfig
if not defined DNS1 (
    for /f "tokens=2 delims=:" %%A in ('ipconfig /all ^| findstr /i "DNS Servers"') do (
        for /f "tokens=1" %%B in ("%%A") do (
            if not defined DNS1 set "DNS1=%%B"
        )
    )
)
:: Final fallback - use gateway (routers usually handle DNS)
if not defined DNS1 set "DNS1=%GATEWAY%"
set "DNS2=8.8.8.8"

echo [OK] DNS1 = %DNS1%
echo [OK] DNS2 = %DNS2% (Google fallback)

:: Set static IP
netsh interface ip set address name="%ADAPTER%" static %LOCAL_IP% 255.255.255.0 %GATEWAY% >nul 2>&1

if errorlevel 1 (
    echo [WARN] Failed to set static IP. Falling back to DHCP...
    netsh interface ip set address name="%ADAPTER%" dhcp >nul 2>&1
    if errorlevel 1 (
        echo [ERROR] Could not set DHCP either. Check adapter manually.
        pause
        exit /b 1
    )
    echo [OK] Fallback to DHCP succeeded.
    echo [WARN] IP may change on reconnect - re-run script if that happens.
) else (
    echo [OK] Static IP locked to %LOCAL_IP%
    :: Re-apply DNS after static IP assignment (static clears DNS)
    netsh interface ip set dns name="%ADAPTER%" static %DNS1% >nul 2>&1
    netsh interface ip add dns name="%ADAPTER%" %DNS2% index=2 >nul 2>&1
    echo [OK] DNS preserved: %DNS1% + %DNS2%
)


:: ============================================================
:: STEP 5 — Generate SSL cert and key
:: ============================================================
echo.
echo [5/8] Generating SSL certificate and key...

set "KEY_FILE=%~dp0key.pem"
set "CERT_FILE=%~dp0cert.pem"

if exist "%KEY_FILE%" (
    del /f /q "%KEY_FILE%"
    echo [INFO] Removed old key.pem
)
if exist "%CERT_FILE%" (
    del /f /q "%CERT_FILE%"
    echo [INFO] Removed old cert.pem
)

set "OPENSSL_EXE="

:: 1) Check bundled bin/ folder first (always works, no internet needed)
if exist "%~dp0bin\openssl.exe" set "OPENSSL_EXE=%~dp0bin\openssl.exe"

:: 2) Check system PATH
if not defined OPENSSL_EXE (
    where openssl >nul 2>&1
    if not errorlevel 1 (
        for /f "delims=" %%P in ('where openssl') do (
            if not defined OPENSSL_EXE set "OPENSSL_EXE=%%P"
        )
    )
)

:: 3) Check common install locations
if not defined OPENSSL_EXE (
    for %%P in (
        "C:\Program Files\OpenSSL-Win64\bin\openssl.exe"
        "C:\Program Files\OpenSSL\bin\openssl.exe"
        "C:\OpenSSL-Win64\bin\openssl.exe"
        "C:\Program Files\Git\usr\bin\openssl.exe"
        "C:\Program Files (x86)\Git\usr\bin\openssl.exe"
        "C:\Git\usr\bin\openssl.exe"
    ) do (
        if not defined OPENSSL_EXE (
            if exist %%P set "OPENSSL_EXE=%%~P"
        )
    )
)

:: 4) Last resort — try winget
if not defined OPENSSL_EXE (
    echo [INFO] OpenSSL not found. Trying winget...
    winget install "OpenSSL Light" --source winget --silent --accept-package-agreements --accept-source-agreements >nul 2>&1
    for /f "skip=2 tokens=3*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v PATH') do set "SYS_PATH=%%A %%B"
    set "PATH=%SYS_PATH%;%PATH%"
    where openssl >nul 2>&1
    if not errorlevel 1 (
        for /f "delims=" %%P in ('where openssl') do (
            if not defined OPENSSL_EXE set "OPENSSL_EXE=%%P"
        )
    )
)

if not defined OPENSSL_EXE (
    echo [ERROR] OpenSSL not found.
    echo         bin\openssl.exe should be bundled in the project.
    echo         Contact the system administrator.
    pause
    exit /b 1
)

echo [INFO] Using OpenSSL at: %OPENSSL_EXE%

:: Add OpenSSL's directory to PATH so it can find its DLLs
for %%F in ("%OPENSSL_EXE%") do set "OPENSSL_DIR=%%~dpF"
set "PATH=%OPENSSL_DIR%;%PATH%"

:: Generate minimal openssl.cnf if not bundled
set "OPENSSL_CONF=%~dp0bin\openssl.cnf"
if not exist "%OPENSSL_CONF%" (
    if exist "%OPENSSL_DIR%openssl.cnf" (
        set "OPENSSL_CONF=%OPENSSL_DIR%openssl.cnf"
    ) else (
        echo [INFO] Generating minimal openssl.cnf...
        (
            echo [req]
            echo distinguished_name = req_distinguished_name
            echo x509_extensions = v3_req
            echo prompt = no
            echo [req_distinguished_name]
            echo CN = localhost
            echo [v3_req]
            echo keyUsage = critical, digitalSignature, keyEncipherment
            echo extendedKeyUsage = serverAuth
            echo subjectAltName = @alt_names
            echo [alt_names]
            echo DNS.1 = localhost
            echo DNS.2 = %DOMAIN%
            echo IP.1 = 127.0.0.1
            echo IP.2 = %LOCAL_IP%
        ) > "%~dp0bin\openssl.cnf"
        echo [OK] openssl.cnf generated
    )
)

set MSYS_NO_PATHCONV=1
"%OPENSSL_EXE%" req -x509 -newkey rsa:2048 ^
  -keyout "%KEY_FILE%" ^
  -out "%CERT_FILE%" ^
  -days 365 -nodes ^
  -config "%OPENSSL_CONF%" 2>&1

if errorlevel 1 (
    echo [ERROR] OpenSSL failed to generate certificate.
    echo         Make sure libssl-3-x64.dll and libcrypto-3-x64.dll are in the same folder as openssl.exe
    pause
    exit /b 1
)

echo [OK] cert.pem and key.pem generated


:: ============================================================
:: STEP 6 — Port conflict check + Firewall rules
:: ============================================================
echo.
echo [6/8] Configuring ports and firewall...

:: Default ports
set "APP_PORT=5500"
set "HTTPS_PORT=443"
set "HTTP_PORT=80"

:: Check for conflicts on all three ports
echo [INFO] Checking for port conflicts...
set "PORT_CONFLICT=0"

for %%P in (%HTTP_PORT% %HTTPS_PORT% %APP_PORT%) do (
    set "PORT_PID="
    for /f "tokens=5" %%A in ('netstat -ano ^| findstr /i "0.0.0.0:%%P " ^| findstr /i "LISTENING"') do (
        if not defined PORT_PID set "PORT_PID=%%A"
    )
    if defined PORT_PID (
        set "PORT_CONFLICT=1"
        set "PORT_NAME=unknown"
        if "%%P"=="%HTTP_PORT%"  set "PORT_NAME=HTTP redirect"
        if "%%P"=="%HTTPS_PORT%" set "PORT_NAME=HTTPS proxy"
        if "%%P"=="%APP_PORT%"   set "PORT_NAME=Node app"
        echo [WARN] Port %%P ^(!PORT_NAME!^) is already in use by PID !PORT_PID!
        for /f "tokens=1" %%B in ('tasklist /fi "PID eq !PORT_PID!" /fo csv /nh 2^>nul') do (
            echo       Process: %%B
        )
    )
)

if "!PORT_CONFLICT!"=="1" (
    echo.
    echo [WARN] One or more ports are in use.
    echo.
    echo   [1] Enter alternative ports
    echo   [2] Continue anyway ^(may cause startup errors^)
    echo   [3] Abort
    echo.
    set /p "PORT_CHOICE=Choose [1/2/3]: "

    if "!PORT_CHOICE!"=="1" (
        echo.
        echo   Current: App=%APP_PORT%  HTTPS=%HTTPS_PORT%  HTTP=%HTTP_PORT%
        echo   Press ENTER to keep existing value.
        echo.

        set /p "NEW_APP=New App port [%APP_PORT%]: "
        if defined NEW_APP set "APP_PORT=!NEW_APP!"

        set /p "NEW_HTTPS=New HTTPS proxy port [%HTTPS_PORT%]: "
        if defined NEW_HTTPS set "HTTPS_PORT=!NEW_HTTPS!"

        set /p "NEW_HTTP=New HTTP redirect port [%HTTP_PORT%]: "
        if defined NEW_HTTP set "HTTP_PORT=!NEW_HTTP!"

        echo.
        echo [OK] Using — App:%APP_PORT%  HTTPS:%HTTPS_PORT%  HTTP:%HTTP_PORT%

        :: Save updated PORT to .env.local
        set "TEMP_ENV2=%TEMP%\env_port_temp.txt"
        findstr /v /i "^PORT=" "%ENV_FILE%" > "%TEMP_ENV2%"
        echo PORT=%APP_PORT%>> "%TEMP_ENV2%"
        copy /y "%TEMP_ENV2%" "%ENV_FILE%" >nul
        echo [OK] PORT=%APP_PORT% saved to .env.local

    ) else if "!PORT_CHOICE!"=="3" (
        echo [ABORTED] Free up conflicting ports then re-run setup.
        pause
        exit /b 0
    ) else (
        echo [INFO] Continuing with current ports.
    )
) else (
    echo [OK] No port conflicts detected
)

:: Clear existing Navy Payroll firewall rules
netsh advfirewall firewall delete rule name="NAVY_PAYROLL_SSL"   >nul 2>&1
netsh advfirewall firewall delete rule name="NAVY_PAYROLL_PROXY" >nul 2>&1
netsh advfirewall firewall delete rule name="NAVY_PAYROLL_HTTP"  >nul 2>&1
echo [INFO] Cleared existing NAVY_PAYROLL rules (if any)

:: Port APP_PORT — Node app
netsh advfirewall firewall add rule name="NAVY_PAYROLL_SSL" dir=in action=allow protocol=TCP localport=%APP_PORT% profile=any >nul 2>&1
if errorlevel 1 ( echo [ERROR] Failed port %APP_PORT% firewall rule. & pause & exit /b 1 )
echo [OK] Firewall — port %APP_PORT% (Node app)

:: Port HTTPS_PORT — HTTPS proxy
netsh advfirewall firewall add rule name="NAVY_PAYROLL_PROXY" dir=in action=allow protocol=TCP localport=%HTTPS_PORT% profile=any >nul 2>&1
if errorlevel 1 ( echo [ERROR] Failed port %HTTPS_PORT% firewall rule. & pause & exit /b 1 )
echo [OK] Firewall — port %HTTPS_PORT% (HTTPS proxy)

:: Port HTTP_PORT — HTTP redirect
netsh advfirewall firewall add rule name="NAVY_PAYROLL_HTTP" dir=in action=allow protocol=TCP localport=%HTTP_PORT% profile=any >nul 2>&1
if errorlevel 1 ( echo [ERROR] Failed port %HTTP_PORT% firewall rule. & pause & exit /b 1 )
echo [OK] Firewall — port %HTTP_PORT% (HTTP redirect)


:: ============================================================
:: STEP 7 — Add friendly domain to Windows hosts file
:: ============================================================
echo.
echo [7/8] Updating Windows hosts file...

set "HOSTS_FILE=%SystemRoot%\System32\drivers\etc\hosts"
set "HOSTS_ENTRY=%LOCAL_IP%    %DOMAIN%"
set "TEMP_HOSTS=%TEMP%\hosts_temp.txt"

findstr /v /i "%DOMAIN%" "%HOSTS_FILE%" > "%TEMP_HOSTS%"
copy /y "%TEMP_HOSTS%" "%HOSTS_FILE%" >nul
echo %HOSTS_ENTRY%>> "%HOSTS_FILE%"
echo [OK] Hosts file updated: %HOSTS_ENTRY%


:: ============================================================
:: STEP 8 - Install OpenSSH + PM2 + Register autostart
:: ============================================================
echo.
echo [8/8] Installing services...

:: Install OpenSSH Server if not present
echo [INFO] Checking OpenSSH Server...
sc query sshd >nul 2>&1
if errorlevel 1 (
    echo [INFO] Installing OpenSSH Server...
    powershell -Command "Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0" >nul 2>&1
    echo [OK] OpenSSH Server installed
) else (
    echo [OK] OpenSSH Server already installed
)

:: Start and enable SSH service
cmd /c "sc start sshd" >nul 2>&1
cmd /c "sc config sshd start= auto" >nul 2>&1
echo [OK] SSH service enabled and set to auto-start

:: Allow SSH through firewall
netsh advfirewall firewall delete rule name="NAVY_PAYROLL_SSH" >nul 2>&1
netsh advfirewall firewall add rule name="NAVY_PAYROLL_SSH" dir=in action=allow protocol=TCP localport=22 profile=any >nul 2>&1
echo [OK] Firewall rule added -- port 22 (SSH)

echo.
echo   SSH Connection Details:
echo     Host : %LOCAL_IP%
echo     Port : 22
echo     User : %USERNAME%
echo.
echo   Add these to GitHub Secrets:
echo     SERVER_HOST     = %LOCAL_IP%
echo     SERVER_USER     = %USERNAME%
echo     SERVER_SSH_PORT = 22
echo     SERVER_SSH_KEY  = (your private key - see below)
echo.

:: Install PM2 and start services
echo [INFO] Setting up WinSW services...
cd /d "%~dp0"
node install-service.js
if errorlevel 1 (
    echo [WARN] WinSW setup failed. Place winsw.exe in project root then run: node install-service.js
) else (
    echo [OK] WinSW services registered and running
)

:: ============================================================
:: STEP 9 - Install GitHub Actions Self-Hosted Runner
:: ============================================================
echo.
echo [9/9] Installing GitHub Actions Runner...

:: Check GITHUB_RUNNER_TOKEN or GITHUB_PAT is set in .env.local
set "GITHUB_PAT="
set "GITHUB_RUNNER_TOKEN="
for /f "usebackq tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
    if /i "%%A"=="GITHUB_PAT"          set "GITHUB_PAT=%%B"
    if /i "%%A"=="GITHUB_RUNNER_TOKEN" set "GITHUB_RUNNER_TOKEN=%%B"
)

if not defined GITHUB_PAT (
    if not defined GITHUB_RUNNER_TOKEN (
        echo [WARN] Neither GITHUB_RUNNER_TOKEN nor GITHUB_PAT set in .env.local
        echo        Add one of these to .env.local:
        echo          GITHUB_RUNNER_TOKEN=token_from_github   ^(expires in 1hr^)
        echo          GITHUB_PAT=your_personal_access_token   ^(auto-generates token^)
        echo        Then run: node install-runner.js
        goto skip_runner
    )
)

:: Check runner chunks exist
if not exist "%~dp0bin\runner\runner.part0" (
    echo [WARN] Runner chunks not found in bin\runner\
    echo        Run chunk-runner.ps1 on your dev machine first.
    goto skip_runner
)

cd /d "%~dp0"
node install-runner.js
if errorlevel 1 (
    echo [WARN] Runner install failed. Run manually: node install-runner.js
) else (
    echo [OK] GitHub Actions Runner installed
)

:skip_runner


:: ============================================================
:: VERIFICATION
:: ============================================================
echo.
echo ============================================================
echo   Verification
echo ============================================================

timeout /t 5 /nobreak >nul

echo.
echo [TEST] Pinging %LOCAL_IP%...
ping -n 2 %LOCAL_IP% >nul 2>&1
if errorlevel 1 (
    echo [WARN] Ping failed - network may still be settling.
) else (
    echo [OK] Ping successful
)

echo.
echo [TEST] curl https://%DOMAIN%/health
echo.
curl -sk --max-time 8 https://%DOMAIN%/health
if errorlevel 1 (
    echo.
    echo [WARN] curl failed - services may still be starting.
    echo        Try manually: curl -k https://%DOMAIN%/health
)


:: ============================================================
:: SUMMARY
:: ============================================================
echo.
echo ============================================================
echo   Setup Complete!
echo ============================================================
echo.
echo   Adapter     : %ADAPTER%
echo   Static IP   : %LOCAL_IP%
echo   Gateway     : %GATEWAY%
echo.
echo   Ports:
echo     App (Node)    : %APP_PORT%
echo     HTTPS proxy   : %HTTPS_PORT%
echo     HTTP redirect : %HTTP_PORT%
echo.
echo   Access your app at:
echo     https://%DOMAIN%       (LAN domain)
echo     http://%DOMAIN%        (auto-redirects to HTTPS)
echo     https://%LOCAL_IP%     (by IP)
echo     http://localhost:%APP_PORT%  (local dev)
echo.
echo   Windows Services (WinSW):
echo     NavyPayroll-App.exe     status/start/stop/restart
echo     NavyPayroll-Proxy.exe   status/start/stop/restart
echo     NavyPayroll-Watcher.exe status/start/stop/restart
echo     services.msc            (Windows Service Manager GUI)
echo.
echo   Deploy (automatic on git push to master):
echo     GitHub Actions SSH deploys automatically
echo.
echo   Manual deploy on server:
echo     git pull ^&^& npm install ^&^& NavyPayroll-App.exe restart
echo.
echo   Manage:
echo     node install-service.js    (reinstall WinSW services)
echo     node uninstall-service.js  (remove WinSW services)
echo.
echo   .gitignore reminder:
echo     key.pem
echo     cert.pem
echo.
echo ============================================================
pause