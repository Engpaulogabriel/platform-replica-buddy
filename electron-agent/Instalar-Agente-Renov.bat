@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
title Instalador do Agente RENOV v3.10.1

REM ============================================================
REM  INSTALADOR — Gestor de Bombas Key / Agente RENOV
REM  Versão: 3.10.1
REM
REM  O que este BAT faz (PC NOVO, do zero):
REM   1) Verifica se Node.js está instalado (necessário para Electron)
REM   2) Cria pasta de instalação em:
REM        %LOCALAPPDATA%\Programs\gestor-de-bombas-key
REM   3) Copia main.cjs, package.json e bridge serial
REM   4) Roda npm install (baixa Electron + dependências)
REM   5) Cria atalho na Área de Trabalho
REM   6) Configura auto-start no Windows (registro Run)
REM   7) Inicia o agente e abre tela de Setup (1º boot)
REM
REM  REQUISITOS:
REM   - Windows 10/11 x64
REM   - Node.js LTS instalado (https://nodejs.org)
REM   - Conexão com internet (para baixar Electron na 1ª vez)
REM ============================================================

set "PKG_VERSION=3.10.1"
set "PKG_DIR=%~dp0"
set "PKG_DIR=%PKG_DIR:~0,-1%"
set "INSTALL_DIR=%LOCALAPPDATA%\Programs\gestor-de-bombas-key"
set "RES_DIR=%INSTALL_DIR%\resources"
set "APP_DIR=%RES_DIR%\app"

echo.
echo ============================================================
echo  Instalador do Agente RENOV v%PKG_VERSION%
echo  (c) Renov Tecnologia Agricola
echo ============================================================
echo.

REM ── [0/7] Verifica arquivos do pacote ───────────────────────
if not exist "%PKG_DIR%\app\main.cjs" (
  echo [ERRO] Nao encontrei: %PKG_DIR%\app\main.cjs
  echo Extraia o ZIP completo antes de executar este BAT.
  pause & exit /b 1
)
if not exist "%PKG_DIR%\app\package.json" (
  echo [ERRO] Nao encontrei: %PKG_DIR%\app\package.json
  pause & exit /b 1
)
if not exist "%PKG_DIR%\app\serial_bridge_persistent.py" (
  echo [ERRO] Nao encontrei: %PKG_DIR%\app\serial_bridge_persistent.py
  pause & exit /b 1
)

REM ── [1/7] Verifica Node.js ──────────────────────────────────
echo [1/7] Verificando Node.js...
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo [ERRO] Node.js nao encontrado.
  echo.
  echo Instale o Node.js LTS antes de continuar:
  echo   https://nodejs.org/pt-br/download
  echo.
  echo Apos instalar, FECHE este CMD e rode novamente.
  pause & exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo      Node: %%v
where npm >nul 2>&1
if errorlevel 1 (
  echo [ERRO] npm nao encontrado. Reinstale o Node.js LTS.
  pause & exit /b 1
)

REM ── [2/7] Verifica se ja existe instalacao ──────────────────
echo [2/7] Verificando instalacao existente...
if exist "%INSTALL_DIR%" (
  echo.
  echo [AVISO] Ja existe uma instalacao em:
  echo   %INSTALL_DIR%
  echo.
  echo Se voce quer ATUALIZAR, use o BAT "Atualizar-Agente-Renov.bat".
  echo Continuar vai SOBRESCREVER os arquivos do agente
  echo (configuracoes do usuario em AppData ficam preservadas).
  echo.
  set /p "CONFIRM=Deseja continuar com a reinstalacao? (S/N): "
  if /I not "!CONFIRM!"=="S" (
    echo Instalacao cancelada pelo usuario.
    pause & exit /b 0
  )
  echo Fechando agente em execucao...
  taskkill /F /IM "Gestor de Bombas Key.exe" >nul 2>&1
  taskkill /F /IM "gestor-de-bombas-key.exe" >nul 2>&1
  taskkill /F /IM "renov-agent.exe" >nul 2>&1
  timeout /t 2 /nobreak >nul
)

REM ── [3/7] Cria estrutura de pastas ──────────────────────────
echo [3/7] Criando pastas em: %INSTALL_DIR%
mkdir "%APP_DIR%" >nul 2>&1
if not exist "%APP_DIR%" (
  echo [ERRO] Falha ao criar %APP_DIR%
  pause & exit /b 1
)

REM ── [4/7] Copia arquivos do agente ──────────────────────────
echo [4/7] Copiando arquivos do agente...
copy /Y "%PKG_DIR%\app\main.cjs"                      "%APP_DIR%\main.cjs" >nul
copy /Y "%PKG_DIR%\app\package.json"                  "%APP_DIR%\package.json" >nul
copy /Y "%PKG_DIR%\app\serial_bridge_persistent.py"   "%RES_DIR%\serial_bridge_persistent.py" >nul

REM Copia tambem para resources/ direto (alguns lookups esperam la)
copy /Y "%PKG_DIR%\app\serial_bridge_persistent.py"   "%APP_DIR%\serial_bridge_persistent.py" >nul

REM Copia telas/preloads/icones. Aceita tanto dentro de app\ quanto na raiz
REM do ZIP para corrigir pacotes antigos que nao abriam a janela de Setup/Log.
for %%F in (setup.html setup-preload.cjs config.html config-preload.cjs log.html log-preload.cjs icon.ico icon.png renov-logo.png) do (
  if exist "%PKG_DIR%\app\%%F" (
    copy /Y "%PKG_DIR%\app\%%F" "%APP_DIR%\%%F" >nul
  ) else if exist "%PKG_DIR%\%%F" (
    copy /Y "%PKG_DIR%\%%F" "%APP_DIR%\%%F" >nul
  ) else (
    echo [AVISO] Arquivo opcional ausente no pacote: %%F
  )
)

if not exist "%APP_DIR%\setup.html" (
  echo [ERRO] setup.html nao foi copiado. O agente nao conseguiria abrir a tela inicial.
  pause & exit /b 1
)
if not exist "%APP_DIR%\setup-preload.cjs" (
  echo [ERRO] setup-preload.cjs nao foi copiado.
  pause & exit /b 1
)
if not exist "%APP_DIR%\log.html" (
  echo [ERRO] log.html nao foi copiado.
  pause & exit /b 1
)

REM Copia provisioning.json se vier no pacote (instalacao automatica de licenca)
if exist "%PKG_DIR%\provisioning.json" (
  copy /Y "%PKG_DIR%\provisioning.json" "%RES_DIR%\provisioning.json" >nul
  echo      Provisioning automatico detectado e copiado.
)

REM ── [5/7] npm install (baixa Electron) ──────────────────────
echo [5/7] Instalando dependencias (Electron + Supabase)...
echo      Isso pode demorar alguns minutos na primeira vez.
pushd "%APP_DIR%"
call npm install --omit=dev --no-audit --no-fund --loglevel=error
if errorlevel 1 (
  echo [ERRO] npm install falhou. Verifique sua conexao com a internet.
  popd
  pause & exit /b 1
)
REM Electron precisa estar disponivel para rodar o agente
call npm install electron@42.0.1 --no-save --no-audit --no-fund --loglevel=error
if errorlevel 1 (
  echo [ERRO] Falha ao instalar Electron.
  popd
  pause & exit /b 1
)
popd

if not exist "%APP_DIR%\node_modules\electron\dist\electron.exe" (
  echo [ERRO] Electron nao foi instalado corretamente em:
  echo   %APP_DIR%\node_modules\electron\dist\electron.exe
  pause & exit /b 1
)

REM ── [6/7] Cria atalho + auto-start ──────────────────────────
echo [6/7] Criando atalho e configurando auto-start...

REM Cria um launcher .cmd que vai chamar o Electron
set "LAUNCHER=%INSTALL_DIR%\Gestor-de-Bombas-Key.cmd"
> "%LAUNCHER%" echo @echo off
>>"%LAUNCHER%" echo setlocal
>>"%LAUNCHER%" echo set "APP_DIR=%%~dp0resources\app"
>>"%LAUNCHER%" echo set "LOG_DIR=%%APPDATA%%\GestorDeBombasKey"
>>"%LAUNCHER%" echo if not exist "%%LOG_DIR%%" mkdir "%%LOG_DIR%%" ^>nul 2^>^&1
>>"%LAUNCHER%" echo if not exist "%%APP_DIR%%\node_modules\electron\dist\electron.exe" ^(
>>"%LAUNCHER%" echo   echo [%%DATE%% %%TIME%%] Electron nao encontrado. Reinstale o Agente RENOV. ^>^> "%%LOG_DIR%%\launcher.log"
>>"%LAUNCHER%" echo   exit /b 1
>>"%LAUNCHER%" echo ^)
>>"%LAUNCHER%" echo echo [%%DATE%% %%TIME%%] Iniciando Agente RENOV... ^>^> "%%LOG_DIR%%\launcher.log"
>>"%LAUNCHER%" echo start "" "%%APP_DIR%%\node_modules\electron\dist\electron.exe" "%%APP_DIR%%"

REM Launcher de diagnostico: mantem a janela aberta e grava erros se algo falhar.
set "DIAG_LAUNCHER=%INSTALL_DIR%\Abrir-Diagnostico-Agente-Renov.cmd"
> "%DIAG_LAUNCHER%" echo @echo off
>>"%DIAG_LAUNCHER%" echo setlocal
>>"%DIAG_LAUNCHER%" echo set "APP_DIR=%%~dp0resources\app"
>>"%DIAG_LAUNCHER%" echo set "LOG_DIR=%%APPDATA%%\GestorDeBombasKey"
>>"%DIAG_LAUNCHER%" echo if not exist "%%LOG_DIR%%" mkdir "%%LOG_DIR%%" ^>nul 2^>^&1
>>"%DIAG_LAUNCHER%" echo echo Iniciando diagnostico do Agente RENOV...
>>"%DIAG_LAUNCHER%" echo echo Log: %%LOG_DIR%%\launcher.log
>>"%DIAG_LAUNCHER%" echo cd /d "%%APP_DIR%%"
>>"%DIAG_LAUNCHER%" echo call "%%APP_DIR%%\node_modules\.bin\electron.cmd" . ^>^> "%%LOG_DIR%%\launcher.log" 2^>^&1
>>"%DIAG_LAUNCHER%" echo echo.
>>"%DIAG_LAUNCHER%" echo echo Diagnostico finalizado. Se nao abriu, envie o arquivo:
>>"%DIAG_LAUNCHER%" echo echo %%LOG_DIR%%\launcher.log
>>"%DIAG_LAUNCHER%" echo pause

REM Atalho na Area de Trabalho
set "DESKTOP=%USERPROFILE%\Desktop"
set "SHORTCUT=%DESKTOP%\Gestor de Bombas Key.lnk"
set "ICON_PATH=%APP_DIR%\icon.ico"
if not exist "%ICON_PATH%" set "ICON_PATH=%LAUNCHER%"

powershell -NoProfile -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$s = $ws.CreateShortcut('%SHORTCUT%');" ^
  "$s.TargetPath = '%LAUNCHER%';" ^
  "$s.WorkingDirectory = '%INSTALL_DIR%';" ^
  "$s.IconLocation = '%ICON_PATH%';" ^
  "$s.WindowStyle = 7;" ^
  "$s.Description = 'Gestor de Bombas Key - Renov';" ^
  "$s.Save()"

REM Auto-start no Windows (chave Run do usuario)
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "GestorDeBombasKey" /t REG_SZ /d "\"%LAUNCHER%\"" /f >nul
if errorlevel 1 (
  echo [AVISO] Nao foi possivel configurar auto-start automatico.
) else (
  echo      Auto-start configurado.
)

REM ── [7/7] Inicia o agente ───────────────────────────────────
echo [7/7] Iniciando o agente...
call "%LAUNCHER%"
timeout /t 3 /nobreak >nul

echo.
echo ============================================================
echo  Instalacao concluida com sucesso!
echo.
echo  Agente instalado em:
echo    %INSTALL_DIR%
echo.
echo  Atalho criado na Area de Trabalho.
echo  O agente vai iniciar automaticamente no proximo boot.
echo.
echo  Na primeira execucao, sera aberta a tela de SETUP para:
echo    - Login (email/senha da fazenda)
echo    - Selecionar a porta COM do radio RS-232
echo.
echo  Apos o setup, o agente roda em segundo plano (system tray
echo  ao lado do relogio do Windows).
echo ============================================================
echo.
pause
exit /b 0
