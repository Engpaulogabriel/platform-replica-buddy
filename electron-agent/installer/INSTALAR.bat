@echo off
REM ===========================================================================
REM  INSTALAR.bat - RENOV Agent (instalacao segura, zero interacao)
REM ---------------------------------------------------------------------------
REM  100% ASCII + CRLF de proposito. Rode como Administrador (auto-eleva).
REM  Faz tudo sozinho: fecha o agente, copia, limpa, tranca NTFS, cria as
REM  tarefas de boot e watchdog, e inicia o agente. Sem pause/choice/confirmacao.
REM  Destino padrao: C:\Gestor de Bombas   (sobrescreva: INSTALAR.bat "D:\Path")
REM ===========================================================================
setlocal EnableExtensions EnableDelayedExpansion

REM -- Auto-elevacao UAC (sem pause) ------------------------------------------
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
  exit /b 0
)

title Instalador RENOV Agent
set "DEST=C:\Gestor de Bombas"
set "SRC=%~dp0"
if "%SRC:~-1%"=="\" set "SRC=%SRC:~0,-1%"
if not "%~1"=="" set "DEST=%~1"
set "RES=%DEST%\resources"

echo ============================================================
echo  RENOV Agent - Instalacao segura
echo  Origem:  %SRC%
echo  Destino: %DEST%
echo ============================================================

REM -- 1) FECHAR o agente se estiver rodando ----------------------------------
echo [1/9] Fechando o agente...
for %%N in ("Gestor de Bombas Key.exe" "GestorDeBombasKey.exe" "Agente-Renov.exe" "renov-agent.exe" "electron.exe" "serial_bridge.exe") do taskkill /F /IM %%~N >nul 2>&1
timeout /t 2 /nobreak >nul

REM -- 2) COPIAR o pacote para o destino (merge; exclui .py, logs, o instalador)
echo [2/9] Copiando arquivos...
if not exist "%RES%" mkdir "%RES%" >nul 2>&1
robocopy "%SRC%" "%DEST%" /E /NFL /NDL /NJH /NJS /NP /XF *.py debug.log INSTALAR.bat INSTALAR-PYSERIAL.bat main.original.cjs >nul
REM  robocopy: 0-7 sucesso, >=8 erro real.
if errorlevel 8 goto FAIL

REM -- 3) DELETAR o .py da bridge (protocolo exposto) -------------------------
echo [3/9] Removendo bridge .py exposta...
del /Q "%RES%\serial_bridge_persistent.py" >nul 2>&1
del /Q "%RES%\app\serial_bridge_persistent.py" >nul 2>&1
del /Q "%DEST%\serial_bridge_persistent.py" >nul 2>&1

REM -- 4) DELETAR lixos: app.asar.bak, debug.log, locales extras -------------
echo [4/9] Limpando lixos...
del /Q "%RES%\app.asar.bak" >nul 2>&1
del /Q "%DEST%\debug.log" >nul 2>&1
del /Q "%RES%\app\main.original.cjs" >nul 2>&1
del /Q "%DEST%\INSTALAR-PYSERIAL.bat" >nul 2>&1
REM  locales: mantem SO en-US.pak e pt-BR.pak. Apagar TODOS quebra o Electron
REM  (ele exige pelo menos o .pak do locale ativo / en-US para iniciar).
if exist "%DEST%\locales" (
  for %%F in ("%DEST%\locales\*.pak") do (
    if /I not "%%~nxF"=="pt-BR.pak" if /I not "%%~nxF"=="en-US.pak" del /Q "%%F" >nul 2>&1
  )
)

REM -- 8) Garante o watchdog e o provisioning no destino ---------------------
if not exist "%DEST%\renov-agent-watchdog.bat" if exist "%SRC%\renov-agent-watchdog.bat" copy /Y "%SRC%\renov-agent-watchdog.bat" "%DEST%\renov-agent-watchdog.bat" >nul 2>&1
if exist "%SRC%\provisioning.json" (
  if not exist "C:\ProgramData\Renov" mkdir "C:\ProgramData\Renov" >nul 2>&1
  copy /Y "%SRC%\provisioning.json" "C:\ProgramData\Renov\provisioning.json" >nul 2>&1
)

REM -- Descobre o executavel do agente no destino ----------------------------
set "AGENT_EXE="
for %%N in ("Agente-Renov.exe" "Gestor de Bombas Key.exe" "GestorDeBombasKey.exe" "renov-agent.exe") do (
  if not defined AGENT_EXE if exist "%DEST%\%%~N" set "AGENT_EXE=%DEST%\%%~N"
)
if not defined AGENT_EXE goto FAIL
echo       Agente: !AGENT_EXE!

REM -- 5) NTFS: so SYSTEM e Administrators leem app.asar e serial_bridge.exe --
echo [5/9] Aplicando permissoes NTFS...
set "ASAR=%RES%\app.asar"
set "BRIDGE=%RES%\serial_bridge.exe"
REM  Pasta: quebra heranca, mantem SYSTEM+Admins, remove Users/Everyone.
icacls "%DEST%" /inheritance:r >nul 2>&1
icacls "%DEST%" /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" >nul 2>&1
icacls "%DEST%" /remove:g "Users" "Everyone" "Authenticated Users" >nul 2>&1
REM  Arquivos sensiveis: heranca off + leitura SO para SYSTEM e Administrators.
for %%P in ("%ASAR%" "%BRIDGE%") do if exist "%%~P" icacls "%%~P" /inheritance:r /grant:r "SYSTEM:F" "Administrators:F" /remove:g "Users" "Everyone" "Authenticated Users" >nul 2>&1

REM -- 6) Tarefa de BOOT: inicia o agente como SYSTEM, sem login -------------
echo [6/9] Registrando tarefa de boot RENOV-Agent-Boot...
schtasks /Create /TN "RENOV-Agent-Boot" /TR "\"%AGENT_EXE%\"" /SC ONSTART /RU SYSTEM /RL HIGHEST /F >nul 2>&1

REM -- 7) Tarefa de WATCHDOG: a cada 1 minuto -------------------------------
echo [7/9] Registrando watchdog RENOV-Agent-Watchdog...
if exist "%DEST%\renov-agent-watchdog.bat" schtasks /Create /TN "RENOV-Agent-Watchdog" /TR "\"%DEST%\renov-agent-watchdog.bat\"" /SC MINUTE /MO 1 /RU SYSTEM /RL HIGHEST /F >nul 2>&1

REM -- Atalho no Desktop publico (uma linha, sem interacao) ------------------
echo [8/9] Criando atalho...
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([IO.Path]::Combine($env:PUBLIC,'Desktop','Gestor de Bombas.lnk')); $s.TargetPath='%AGENT_EXE%'; $s.WorkingDirectory='%DEST%'; $s.Save()" >nul 2>&1

REM -- 9) INICIAR o agente agora --------------------------------------------
echo [9/9] Iniciando o agente...
start "" "%AGENT_EXE%"

echo ============================================================
echo  Instalacao concluida. Agente iniciado.
echo  - Bridge: serial_bridge.exe sem Python
echo  - Boot: tarefa RENOV-Agent-Boot como SYSTEM sem login
echo  - Watchdog: RENOV-Agent-Watchdog a cada 1 min
echo  - app.asar e serial_bridge.exe travados por NTFS
echo ============================================================
exit /b 0

:FAIL
echo [ERRO] Instalacao falhou. Verifique o pacote e as permissoes de admin.
exit /b 1
