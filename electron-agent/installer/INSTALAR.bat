@echo off
REM ===========================================================================
REM  INSTALAR.bat - RENOV Agent (pacote seguro)
REM ---------------------------------------------------------------------------
REM  Faz TUDO em uma execucao, sem interacao alem de "Executar como
REM  administrador":
REM    1. Auto-eleva via UAC se nao estiver como admin
REM    2. Copia a pasta para o destino (default C:\Gestor de Bombas)
REM    3. Remove locales desnecessarios (mantem so pt-BR e en-US)
REM    4. Remove lixo (.py, debug.log, INSTALAR-PYSERIAL.bat)
REM    5. Aplica permissoes NTFS (so o usuario do agente e o SYSTEM acessam)
REM    6. Registra Tarefas Agendadas: RenovAgent (boot) + RenovAgentWatchdog (1min)
REM    7. Cria atalho no Desktop
REM    8. Inicia o agente e mostra o resumo
REM
REM  ASCII puro + CRLF de proposito (o interpretador de .bat quebra com acentos
REM  fora da code page e com blocos ( ... ) terminados so em LF).
REM ===========================================================================
setlocal EnableExtensions EnableDelayedExpansion

REM -- 1) Auto-elevacao UAC ---------------------------------------------------
net session >nul 2>&1
if errorlevel 1 (
  echo Solicitando privilegios de administrador...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
  exit /b 0
)

title Instalador RENOV Agent
echo ============================================================
echo  RENOV Agent - Instalacao segura
echo ============================================================

set "SRC=%~dp0"
if "%SRC:~-1%"=="\" set "SRC=%SRC:~0,-1%"
set "DEST=C:\Gestor de Bombas"

REM Permite sobrescrever o destino:  INSTALAR.bat "D:\Outro\Caminho"
if not "%~1"=="" set "DEST=%~1"

echo.
echo  Origem:  %SRC%
echo  Destino: %DEST%
echo.

REM -- Nao instala em cima de um bloqueio de seguranca sem avisar -------------
if exist "%DEST%\agent-blocked.flag" (
  echo [AVISO] Existe um bloqueio de seguranca (agent-blocked.flag) no destino.
  echo         Ele sera REMOVIDO por esta reinstalacao (equivale a autorizar o PC).
  del /Q "%DEST%\agent-blocked.flag" >nul 2>&1
)

REM -- Fecha instancia em execucao para poder sobrescrever --------------------
for %%N in ("renov-agent.exe" "GestorDeBombasKey.exe" "Gestor de Bombas Key.exe" "Agente-Renov.exe") do (
  taskkill /F /IM %%~N >nul 2>&1
)
timeout /t 2 /nobreak >nul

REM -- 2) Copia arquivos ------------------------------------------------------
echo [1/8] Copiando arquivos...
if not exist "%DEST%" mkdir "%DEST%"
REM  /E subpastas, /PURGE remove no destino o que nao existe na origem,
REM  /XF exclui arquivos que nunca devem ir para producao.
robocopy "%SRC%" "%DEST%" /E /PURGE /NFL /NDL /NJH /NJS /NP ^
  /XF serial_bridge_persistent.py *.py debug.log INSTALAR-PYSERIAL.bat main.original.cjs INSTALAR.bat >nul
REM  robocopy retorna 0-7 em sucesso; >=8 e erro real.
if errorlevel 8 (
  echo [ERRO] Falha ao copiar arquivos para %DEST%.
  goto FAIL
)

REM -- 3) Remove locales desnecessarios (mantem pt-BR e en-US) ----------------
echo [2/8] Removendo idiomas nao usados...
if exist "%DEST%\locales" (
  for %%F in ("%DEST%\locales\*.pak") do (
    if /I not "%%~nxF"=="pt-BR.pak" if /I not "%%~nxF"=="en-US.pak" del /Q "%%F" >nul 2>&1
  )
)

REM -- 4) Remove lixo residual (caso ja existisse no destino) -----------------
echo [3/8] Limpando arquivos sensiveis...
del /Q "%DEST%\serial_bridge_persistent.py" >nul 2>&1
del /Q "%DEST%\resources\serial_bridge_persistent.py" >nul 2>&1
del /Q "%DEST%\resources\app\serial_bridge_persistent.py" >nul 2>&1
del /Q "%DEST%\debug.log" >nul 2>&1
del /Q "%DEST%\INSTALAR-PYSERIAL.bat" >nul 2>&1
del /Q "%DEST%\resources\app\main.original.cjs" >nul 2>&1

REM -- Provisioning headless: se houver provisioning.json no pacote, coloca em
REM    C:\ProgramData\Renov para o agente auto-ativar a fazenda sem tela de Setup.
if exist "%SRC%\provisioning.json" (
  echo       provisioning.json detectado - ativacao headless
  if not exist "C:\ProgramData\Renov" mkdir "C:\ProgramData\Renov" >nul 2>&1
  copy /Y "%SRC%\provisioning.json" "C:\ProgramData\Renov\provisioning.json" >nul 2>&1
  set "HAVE_PROV=1"
) else (
  set "HAVE_PROV="
)

REM -- Descobre o executavel do agente no destino -----------------------------
set "AGENT_EXE="
set "AGENT_NAME="
for %%N in ("renov-agent.exe" "GestorDeBombasKey.exe" "Gestor de Bombas Key.exe" "Agente-Renov.exe") do (
  if not defined AGENT_EXE if exist "%DEST%\%%~N" (
    set "AGENT_EXE=%DEST%\%%~N"
    set "AGENT_NAME=%%~N"
  )
)
if not defined AGENT_EXE (
  echo [ERRO] Executavel do agente nao encontrado em %DEST%.
  goto FAIL
)
echo       Agente: %AGENT_EXE%

REM -- 5) Permissoes NTFS -----------------------------------------------------
echo [4/8] Aplicando permissoes NTFS...
icacls "%DEST%" /inheritance:r >nul 2>&1
icacls "%DEST%" /grant:r "%USERNAME%:(OI)(CI)F" >nul 2>&1
icacls "%DEST%" /grant:r "SYSTEM:(OI)(CI)F" >nul 2>&1
icacls "%DEST%" /grant:r "Administrators:(OI)(CI)F" >nul 2>&1
icacls "%DEST%" /remove:g "Users" >nul 2>&1
icacls "%DEST%" /deny "Users:(OI)(CI)(RX)" >nul 2>&1

REM -- 6) Tarefas Agendadas ---------------------------------------------------
echo [5/8] Registrando tarefa de boot (RenovAgent)...
REM  Escolha automatica do modo (decidido com o Paulo):
REM   - provisioning.json presente OU senha passada como 2o argumento -> caminho
REM     definido; senao SYSTEM (zero interacao, o default do pendrive).
REM   - SYSTEM ONSTART: roda no boot sem login. Combina com provisioning headless.
REM   - Conta do usuario + /RP <senha>: preserva a config DPAPI do usuario e a
REM     tela de Setup; use quando o PC ja foi configurado manualmente.
set "WINPWD=%~2"
if defined WINPWD (
  echo       modo: conta de usuario %USERDOMAIN%\%USERNAME% (DPAPI preservado)
  schtasks /Create /TN "RenovAgent" /TR "\"%AGENT_EXE%\"" /SC ONSTART /RU "%USERDOMAIN%\%USERNAME%" /RP "%WINPWD%" /RL HIGHEST /F >nul 2>&1
  set "WINPWD="
) else (
  echo       modo: SYSTEM (boot sem login, zero interacao)
  schtasks /Create /TN "RenovAgent" /TR "\"%AGENT_EXE%\"" /SC ONSTART /RU SYSTEM /RL HIGHEST /F >nul 2>&1
)
if errorlevel 1 (echo       [AVISO] falha ao criar RenovAgent) else (echo       OK)

echo [6/8] Registrando watchdog (RenovAgentWatchdog, 1 min)...
set "WATCHDOG=%DEST%\renov-agent-watchdog.bat"
if exist "%WATCHDOG%" (
  schtasks /Create /SC MINUTE /MO 1 /TN "RenovAgentWatchdog" /TR "\"%WATCHDOG%\"" /RU SYSTEM /RL HIGHEST /F >nul 2>&1
  if errorlevel 1 (echo       [AVISO] falha ao criar watchdog) else (echo       OK)
) else (
  echo       [AVISO] renov-agent-watchdog.bat ausente em %DEST%
)

REM -- 7) Atalho no Desktop ---------------------------------------------------
echo [7/8] Criando atalho no Desktop...
set "ICON=%DEST%\%AGENT_NAME%"
powershell -NoProfile -Command ^
  "$ws=New-Object -ComObject WScript.Shell;" ^
  "$s=$ws.CreateShortcut([IO.Path]::Combine($env:PUBLIC,'Desktop','Gestor de Bombas.lnk'));" ^
  "$s.TargetPath='%AGENT_EXE%';" ^
  "$s.WorkingDirectory='%DEST%';" ^
  "$s.IconLocation='%ICON%';" ^
  "$s.Description='Gestor de Bombas Key - RENOV';" ^
  "$s.Save()" >nul 2>&1

REM -- 8) Inicia o agente -----------------------------------------------------
echo [8/8] Iniciando o agente...
start "" "%AGENT_EXE%"

echo.
echo ============================================================
echo  Instalacao concluida.
echo.
echo  - Bridge serial: serial_bridge.exe (NAO precisa de Python)
echo  - Boot automatico: tarefa RenovAgent (ao ligar o PC)
echo  - Watchdog: RenovAgentWatchdog (a cada 1 minuto)
echo  - Pasta protegida por permissoes NTFS
echo.
echo  Abra o "Gestor de Bombas" (atalho no Desktop) para configurar
echo  login e porta COM, caso ainda nao tenha provisioning.json.
echo ============================================================
echo.
pause
exit /b 0

:FAIL
echo.
echo  A instalacao FALHOU. Veja as mensagens acima.
echo.
pause
exit /b 1
