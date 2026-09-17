@echo off
REM ===========================================================================
REM  RENOV Agent — Watchdog (v3.10.6 — suporta rollback de .exe e de app.asar)
REM ---------------------------------------------------------------------------
REM  Cadastrar como Tarefa Agendada do Windows rodando a cada 2 minutos:
REM
REM   schtasks /Create /SC MINUTE /MO 2 /TN "RenovAgentWatchdog" ^
REM     /TR "C:\Renov\renov-agent-watchdog.bat" /RL HIGHEST /F
REM
REM  O watchdog garante:
REM   1. O agente Electron está rodando. Se não, reinicia.
REM   2. Se uma atualização .exe recém-instalada falhar, restaura .exe.bak.
REM   3. Se uma atualização .asar (OTA novo) falhar, restaura app.asar.bak
REM      dentro de resources/ — assim o agente sobe de novo com a versão
REM      anterior e o ciclo de update na nuvem volta a ser tentado.
REM ===========================================================================

setlocal EnableDelayedExpansion

set "AGENT_DIR=C:\Renov"
set "AGENT_EXE=%AGENT_DIR%\renov-agent.exe"
set "AGENT_BAK=%AGENT_DIR%\renov-agent.exe.bak"
set "AGENT_NAME=renov-agent.exe"
set "ASAR=%AGENT_DIR%\resources\app.asar"
set "ASAR_BAK=%AGENT_DIR%\resources\app.asar.bak"
set "FAIL_FLAG=%AGENT_DIR%\update-in-progress.flag"

REM Está rodando?
tasklist /FI "IMAGENAME eq %AGENT_NAME%" 2>NUL | find /I "%AGENT_NAME%" >NUL
if not errorlevel 1 (
  REM Rodando — limpa flag de update se existir
  if exist "%FAIL_FLAG%" del /Q "%FAIL_FLAG%" >NUL 2>&1
  exit /b 0
)

REM ── Rollback 1: binário do agente (.exe.bak) — modelo legado
if exist "%AGENT_BAK%" (
  echo [%date% %time%] Agente offline com .exe.bak presente — rollback do binario
  if exist "%AGENT_EXE%" del /Q "%AGENT_EXE%"
  ren "%AGENT_BAK%" "%AGENT_NAME%"
)

REM ── Rollback 2: bundle de código (app.asar.bak) — OTA novo
if exist "%ASAR_BAK%" (
  echo [%date% %time%] Agente offline com app.asar.bak presente — rollback do bundle
  if exist "%ASAR%" del /Q "%ASAR%"
  ren "%ASAR_BAK%" "app.asar"
)

REM Reinicia o agente
if exist "%AGENT_EXE%" (
  echo [%date% %time%] Reiniciando agente
  start "" "%AGENT_EXE%"
)

endlocal
exit /b 0
