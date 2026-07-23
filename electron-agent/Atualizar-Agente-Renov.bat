@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

REM ============================================================
REM  Atualizador completo — Gestor de Bombas Key / Agente RENOV
REM  Versão do pacote: 3.10.1
REM
REM  O que este BAT faz:
REM   1) Fecha o agente em execução
REM   2) Localiza a instalação em AppData/Program Files
REM   3) Faz backup completo da pasta resources
REM   4) Atualiza serial_bridge_persistent.py solto em resources
REM   5) Se existir app.asar, extrai, troca main.cjs/package.json e reempacota
REM   6) Se existir resources\app, troca os arquivos soltos
REM   7) Reabre o agente
REM
REM  IMPORTANTE:
REM   - Para instalações com app.asar, este BAT precisa de Node.js/npx
REM     para reempacotar o ASAR usando @electron/asar.
REM   - Rode este BAT a partir da pasta extraída do ZIP.
REM ============================================================

set "PKG_VERSION=3.10.7"
set "PKG_DIR=%~dp0"
set "PKG_DIR=%PKG_DIR:~0,-1%"
set "MAIN_SRC=%PKG_DIR%\app\main.cjs"
set "SERIAL_SRC=%PKG_DIR%\app\serial_bridge_persistent.py"
set "PKG_JSON_SRC=%PKG_DIR%\app\package.json"

if not exist "%MAIN_SRC%" (
  echo [ERRO] Nao encontrei: %MAIN_SRC%
  echo Extraia o ZIP completo antes de executar este BAT.
  pause
  exit /b 1
)
if not exist "%SERIAL_SRC%" (
  echo [ERRO] Nao encontrei: %SERIAL_SRC%
  echo Extraia o ZIP completo antes de executar este BAT.
  pause
  exit /b 1
)
if not exist "%PKG_JSON_SRC%" (
  echo [ERRO] Nao encontrei: %PKG_JSON_SRC%
  echo Extraia o ZIP completo antes de executar este BAT.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo  Atualizador completo do Agente RENOV v%PKG_VERSION%
echo ============================================================
echo.

set "INSTALL_DIR="
set "RES_DIR="

call :try_dir "%LOCALAPPDATA%\Programs\gestor-de-bombas-key"
if defined INSTALL_DIR goto found_install
call :try_dir "%LOCALAPPDATA%\Programs\Gestor de Bombas Key"
if defined INSTALL_DIR goto found_install
call :try_dir "%LOCALAPPDATA%\Programs\GestorDeBombasKey"
if defined INSTALL_DIR goto found_install
call :try_dir "%ProgramFiles%\Gestor de Bombas Key"
if defined INSTALL_DIR goto found_install
call :try_dir "%ProgramFiles%\gestor-de-bombas-key"
if defined INSTALL_DIR goto found_install
call :try_dir "%ProgramFiles(x86)%\Gestor de Bombas Key"
if defined INSTALL_DIR goto found_install
call :try_dir "%ProgramFiles(x86)%\gestor-de-bombas-key"
if defined INSTALL_DIR goto found_install

echo [AVISO] Nao localizei automaticamente a instalacao.
echo Digite a pasta onde esta o .exe do agente, por exemplo:
echo   C:\Users\SEU_USUARIO\AppData\Local\Programs\gestor-de-bombas-key
echo.
set /p "MANUAL_DIR=Pasta da instalacao: "
call :try_dir "%MANUAL_DIR%"
if not defined INSTALL_DIR (
  echo [ERRO] Pasta invalida ou sem resources: %MANUAL_DIR%
  pause
  exit /b 1
)

:found_install
echo [OK] Instalacao: %INSTALL_DIR%
echo [OK] Resources:   %RES_DIR%
echo.

echo [1/7] Fechando agente...
taskkill /F /IM "Gestor de Bombas Key.exe" >nul 2>&1
taskkill /F /IM "gestor-de-bombas-key.exe" >nul 2>&1
taskkill /F /IM "renov-agent.exe" >nul 2>&1
taskkill /F /IM "RenovAgent.exe" >nul 2>&1
timeout /t 2 /nobreak >nul

for /f "tokens=1-4 delims=/ " %%a in ("%date%") do set "D=%%d%%b%%c"
for /f "tokens=1-3 delims=:,. " %%a in ("%time%") do set "T=%%a%%b%%c"
set "T=%T: =0%"
set "BACKUP_DIR=%RES_DIR%\backup-renov-%PKG_VERSION%-%D%-%T%"

echo [2/7] Criando backup em:
echo       %BACKUP_DIR%
mkdir "%BACKUP_DIR%" >nul 2>&1
if exist "%RES_DIR%\app.asar" copy /Y "%RES_DIR%\app.asar" "%BACKUP_DIR%\app.asar.bak" >nul
if exist "%RES_DIR%\serial_bridge_persistent.py" copy /Y "%RES_DIR%\serial_bridge_persistent.py" "%BACKUP_DIR%\serial_bridge_persistent.py.bak" >nul
if exist "%RES_DIR%\app" xcopy "%RES_DIR%\app" "%BACKUP_DIR%\app" /E /I /Y >nul

if errorlevel 1 (
  echo [ERRO] Falha ao criar backup. Abortando por seguranca.
  pause
  exit /b 1
)

echo [3/7] Atualizando bridge serial solto em resources...
copy /Y "%SERIAL_SRC%" "%RES_DIR%\serial_bridge_persistent.py" >nul
if errorlevel 1 (
  echo [ERRO] Falha ao copiar serial_bridge_persistent.py
  pause
  exit /b 1
)

set "UPDATED_APP=0"
set "UPDATED_ASAR=0"

if exist "%RES_DIR%\app" (
  echo [4/7] Atualizando arquivos soltos em resources\app...
  copy /Y "%MAIN_SRC%" "%RES_DIR%\app\main.cjs" >nul
  copy /Y "%PKG_JSON_SRC%" "%RES_DIR%\app\package.json" >nul
  for %%F in (setup.html setup-preload.cjs config.html config-preload.cjs log.html log-preload.cjs icon.ico icon.png renov-logo.png) do (
    if exist "%PKG_DIR%\app\%%F" (
      copy /Y "%PKG_DIR%\app\%%F" "%RES_DIR%\app\%%F" >nul
    ) else if exist "%PKG_DIR%\%%F" (
      copy /Y "%PKG_DIR%\%%F" "%RES_DIR%\app\%%F" >nul
    )
  )
  if errorlevel 1 (
    echo [ERRO] Falha ao atualizar resources\app
    pause
    exit /b 1
  )
  set "UPDATED_APP=1"
) else (
  echo [4/7] Pasta resources\app nao existe. Pulando modo solto.
)

if exist "%RES_DIR%\app.asar" (
  echo [5/7] Instalacao usa app.asar. Atualizando ASAR real...
  where npx >nul 2>&1
  if errorlevel 1 (
    echo.
    echo [ERRO] Esta instalacao carrega resources\app.asar, mas Node.js/npx nao foi encontrado.
    echo        Instale Node.js LTS ou use o REBUILD-COMPLETO.bat em um PC com Node.
    echo        Nada foi alterado no app.asar. Backup preservado em:
    echo        %BACKUP_DIR%
    pause
    exit /b 1
  )

  set "TMP_ROOT=%TEMP%\renov-asar-update-%RANDOM%-%RANDOM%"
  set "TMP_APP=!TMP_ROOT!\app"
  mkdir "!TMP_APP!" >nul 2>&1

  echo      Extraindo app.asar...
  call npx --yes @electron/asar extract "%RES_DIR%\app.asar" "!TMP_APP!"
  if errorlevel 1 (
    echo [ERRO] Falha ao extrair app.asar
    rmdir /S /Q "!TMP_ROOT!" >nul 2>&1
    pause
    exit /b 1
  )

  echo      Aplicando main.cjs, package.json e telas v%PKG_VERSION%...
  copy /Y "%MAIN_SRC%" "!TMP_APP!\main.cjs" >nul
  copy /Y "%PKG_JSON_SRC%" "!TMP_APP!\package.json" >nul
  for %%F in (setup.html setup-preload.cjs config.html config-preload.cjs log.html log-preload.cjs icon.ico icon.png renov-logo.png) do (
    if exist "%PKG_DIR%\app\%%F" (
      copy /Y "%PKG_DIR%\app\%%F" "!TMP_APP!\%%F" >nul
    ) else if exist "%PKG_DIR%\%%F" (
      copy /Y "%PKG_DIR%\%%F" "!TMP_APP!\%%F" >nul
    )
  )
  if errorlevel 1 (
    echo [ERRO] Falha ao aplicar arquivos no ASAR extraido
    rmdir /S /Q "!TMP_ROOT!" >nul 2>&1
    pause
    exit /b 1
  )

  echo      Reempacotando app.asar...
  call npx --yes @electron/asar pack "!TMP_APP!" "!TMP_ROOT!\app.asar.new"
  if errorlevel 1 (
    echo [ERRO] Falha ao reempacotar app.asar
    rmdir /S /Q "!TMP_ROOT!" >nul 2>&1
    pause
    exit /b 1
  )

  copy /Y "!TMP_ROOT!\app.asar.new" "%RES_DIR%\app.asar" >nul
  if errorlevel 1 (
    echo [ERRO] Falha ao substituir app.asar
    rmdir /S /Q "!TMP_ROOT!" >nul 2>&1
    pause
    exit /b 1
  )

  rmdir /S /Q "!TMP_ROOT!" >nul 2>&1
  set "UPDATED_ASAR=1"
) else (
  echo [5/7] app.asar nao existe. Instalacao provavelmente usa arquivos soltos.
)

if "%UPDATED_APP%"=="0" if "%UPDATED_ASAR%"=="0" (
  echo [ERRO] Nao encontrei resources\app nem resources\app.asar para atualizar.
  pause
  exit /b 1
)

echo [6/7] Verificando atualizacao...
if exist "%RES_DIR%\app.asar" (
  echo      app.asar atualizado: %UPDATED_ASAR%
)
if exist "%RES_DIR%\app\main.cjs" (
  findstr /C:"RX_TELEM_FALLBACK_RE" "%RES_DIR%\app\main.cjs" >nul 2>&1
  if errorlevel 1 (
    echo [AVISO] Nao consegui confirmar RX_TELEM_FALLBACK_RE no arquivo solto.
  ) else (
    echo      main.cjs solto confirmado com parser hexadecimal robusto.
  )
)

echo [7/7] Reiniciando agente...
set "EXE_TO_START="
if exist "%INSTALL_DIR%\Gestor de Bombas Key.exe" set "EXE_TO_START=%INSTALL_DIR%\Gestor de Bombas Key.exe"
if not defined EXE_TO_START if exist "%INSTALL_DIR%\gestor-de-bombas-key.exe" set "EXE_TO_START=%INSTALL_DIR%\gestor-de-bombas-key.exe"
if not defined EXE_TO_START if exist "%INSTALL_DIR%\renov-agent.exe" set "EXE_TO_START=%INSTALL_DIR%\renov-agent.exe"
if not defined EXE_TO_START if exist "%INSTALL_DIR%\Gestor-de-Bombas-Key.cmd" set "EXE_TO_START=%INSTALL_DIR%\Gestor-de-Bombas-Key.cmd"
if defined EXE_TO_START (
  start "" "%EXE_TO_START%"
  echo [OK] Agente reiniciado.
) else (
  echo [AVISO] Nao encontrei o .exe para reabrir automaticamente.
  echo         Abra manualmente pela area de trabalho/menu iniciar.
)

echo.
echo ============================================================
echo  Atualizacao concluida.
echo  Backup: %BACKUP_DIR%
echo.
echo  No log do agente, confirme:
echo    Agente RENOV v%PKG_VERSION%
echo    RX de 11A5 com nome do equipamento
echo    INF Estado de BOOSTER R6^>R5 atualizado
echo ============================================================
echo.
pause
exit /b 0

:try_dir
set "CAND=%~1"
if "%CAND%"=="" exit /b 0
if exist "%CAND%\resources" (
  set "INSTALL_DIR=%CAND%"
  set "RES_DIR=%CAND%\resources"
  exit /b 0
)
exit /b 0
