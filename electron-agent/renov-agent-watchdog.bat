@echo off
REM ===========================================================================
REM  RENOV Agent — Watchdog (v3.25.39 — + deteccao de CONGELAMENTO via liveness)
REM ---------------------------------------------------------------------------
REM  Cadastrar como Tarefa Agendada do Windows rodando a cada 2 minutos:
REM
REM   schtasks /Create /SC MINUTE /MO 2 /TN "RenovAgentWatchdog" ^
REM     /TR "C:\Renov\renov-agent-watchdog.bat" /RL HIGHEST /F
REM
REM  O watchdog garante:
REM   1. O agente Electron esta rodando. Se nao, reinicia.
REM   2. NOVO (v3.25.39): se o agente esta rodando mas CONGELADO (deadlock/leak) —
REM      liveness.txt sem atualizacao ha > 5 min — mata o processo e relanca.
REM      O agente escreve liveness.txt a cada 30s pelo timer indestrutivel de
REM      site_health; um setInterval interno NAO detecta freeze do event-loop, por
REM      isso este arquivo externo e o detector real de congelamento.
REM   3. Se um update .exe recem-instalado falhar, restaura .exe.bak.
REM   4. Se um update .asar (OTA) falhar, restaura app.asar.bak dentro de resources/.
REM ===========================================================================

setlocal EnableDelayedExpansion

set "AGENT_DIR=C:\Renov"
set "AGENT_EXE=%AGENT_DIR%\renov-agent.exe"
set "AGENT_BAK=%AGENT_DIR%\renov-agent.exe.bak"
set "AGENT_NAME=renov-agent.exe"
set "ASAR=%AGENT_DIR%\resources\app.asar"
set "ASAR_BAK=%AGENT_DIR%\resources\app.asar.bak"
set "FAIL_FLAG=%AGENT_DIR%\update-in-progress.flag"
set "LIVENESS=%AGENT_DIR%\liveness.txt"

REM Esta rodando?
tasklist /FI "IMAGENAME eq %AGENT_NAME%" 2>NUL | find /I "%AGENT_NAME%" >NUL
if errorlevel 1 goto RELAUNCH

REM ── Rodando: checa CONGELAMENTO via liveness.txt (v3.25.39) ────────────────
REM  Se o arquivo existe E foi escrito ha > 5 min, o agente esta vivo mas travado.
REM  Se o arquivo NAO existe (agente antigo sem writer), NAO mata — retrocompativel.
set "STALE="
if exist "%LIVENESS%" for /f %%A in ('powershell -NoProfile -Command "try{ if(((Get-Date)-(Get-Item '%LIVENESS%').LastWriteTime).TotalMinutes -gt 5){'STALE'} }catch{}"') do set "STALE=%%A"
if defined STALE (
  echo [%date% %time%] Agente CONGELADO ^(liveness ^> 5min^) — matando para relancar
  taskkill /F /IM "%AGENT_NAME%" >NUL 2>&1
  timeout /t 2 /nobreak >NUL
  goto RELAUNCH
)

REM Vivo e saudavel — limpa flag de update se existir e sai
if exist "%FAIL_FLAG%" del /Q "%FAIL_FLAG%" >NUL 2>&1
endlocal
exit /b 0

:RELAUNCH
REM ── Rollback 1: binario do agente (.exe.bak) — modelo legado
if exist "%AGENT_BAK%" (
  echo [%date% %time%] Agente offline com .exe.bak presente — rollback do binario
  if exist "%AGENT_EXE%" del /Q "%AGENT_EXE%"
  ren "%AGENT_BAK%" "%AGENT_NAME%"
)

REM ── Rollback 2: bundle de codigo (app.asar.bak) — OTA novo
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
