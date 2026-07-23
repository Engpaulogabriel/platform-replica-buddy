@echo off
REM ============================================================
REM   Gestor de Bombas Key — Build script (Windows x64)
REM   © Renov Tecnologia Agrícola®
REM
REM   v7 (v3.9.1 — boot-safe):
REM     - npm run build usa main.cjs direto (sem bytenode/ofuscação).
REM     - A proteção por bytecode fica apenas no script release:protected.
REM     - Motivo: v3.9.0 podia encerrar antes de app.whenReady() em alguns PCs.
REM     - Hash do app.asar é calculado em BUILD-TIME (não em runtime).
REM     - Watchdog anti-debug embutido (5s, debugger latency).
REM ============================================================

cd /d "%~dp0"

echo.
echo === [1/4] Instalando dependencias ===
call npm install
if errorlevel 1 ( echo Falha no npm install. ^& pause ^& exit /b 1 )

REM ── Pass 1: build inicial para gerar o app.asar ───────────────
REM Cria placeholder vazio (electron-builder exige que o arquivo
REM listado em extraResources exista antes do empacotamento).
echo placeholder > asar-hash.txt

echo.
echo === [2/4] Build inicial (gera app.asar) ===
call npm run build
if errorlevel 1 ( echo Falha no build inicial. ^& pause ^& exit /b 1 )

REM ── Calcula hash SHA-256 do app.asar gerado ───────────────────
echo.
echo === [3/4] Calculando hash do app.asar ===
for /f "tokens=*" %%H in ('powershell -NoProfile -Command "(Get-FileHash -Algorithm SHA256 'dist\win-unpacked\resources\app.asar').Hash.ToLower()"') do set ASAR_HASH=%%H
if "%ASAR_HASH%"=="" ( echo Falha ao calcular hash. ^& pause ^& exit /b 1 )
echo Hash gerado: %ASAR_HASH%
echo %ASAR_HASH%> asar-hash.txt

REM ── Pass 2: rebuild com o hash correto incluido em resources ──
echo.
echo === [4/4] Build final (inclui hash assinado) ===
call npm run build
if errorlevel 1 ( echo Falha no build final. ^& pause ^& exit /b 1 )

echo.
echo === Pronto! ===
echo.
echo Instalador gerado em:
echo   %CD%\dist\
echo.
echo Hash do ASAR (anti-tampering): %ASAR_HASH%
echo.
echo Para PUBLICAR no GitHub Releases (e habilitar auto-update nos clientes):
echo   set GH_TOKEN=ghp_seu_token
echo   npm run release
echo.
pause
