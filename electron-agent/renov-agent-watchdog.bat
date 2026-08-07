@echo off
REM ===========================================================================
REM  RENOV Agent - Watchdog (v3.25.40)
REM ---------------------------------------------------------------------------
REM  Cenario-alvo: Starlink 200kbps, sem AnyDesk, sem acesso remoto ao desktop.
REM  O agente TEM que voltar sozinho de qualquer situacao.
REM
REM  Cadastrar como Tarefa Agendada rodando A CADA 1 MINUTO, independente de
REM  usuario logado (use Instalar-Tarefas-Renov.bat, ou manualmente):
REM
REM    schtasks /Create /SC MINUTE /MO 1 /TN "RenovAgentWatchdog" ^
REM      /TR "C:\Renov\renov-agent-watchdog.bat" /RU SYSTEM /RL HIGHEST /F
REM
REM  O que este watchdog garante:
REM   1. Processo inexistente (crash total) -> relanca IMEDIATAMENTE.
REM   2. Processo vivo mas CONGELADO (liveness.txt sem atualizacao ha > 5 min)
REM      -> mata e relanca. O agente escreve liveness.txt a cada 30s pelo timer
REM      dedicado de site_health; um setInterval interno NAO detecta freeze do
REM      event-loop, por isso este arquivo externo e o detector real.
REM   3. BACKOFF anti crash-loop (v3.25.40): 5 relancamentos em menos de 10 min
REM      -> espera 5 min antes de tentar de novo. Sem isso, um agente que morre
REM      no boot seria relancado 60x/hora queimando CPU.
REM   4. Rollback: se um update .exe falhou, restaura .exe.bak; se um update
REM      .asar (OTA) falhou, restaura app.asar.bak dentro de resources/.
REM   5. LOG de toda acao em C:\Renov\watchdog.log com timestamp (rotaciona a 1MB).
REM ===========================================================================

setlocal EnableDelayedExpansion

REM -- Descobre a pasta de instalacao (multiplos caminhos) --------------------
REM  v3.25.42: a instalacao pode estar em C:\Renov, C:\Gestor de Bombas ou na
REM  pasta deste proprio .bat. Vence a primeira que tiver o executavel.
set "AGENT_DIR="
for %%D in ("%~dp0." "C:\Renov" "C:\Gestor de Bombas" "C:\Program Files\Gestor de Bombas Key") do (
  for %%N in ("Gestor de Bombas.exe" "Gestor de Bombas Key.exe" "GestorDeBombasKey.exe" "renov-agent.exe" "Agente-Renov.exe") do (
    if not defined AGENT_DIR if exist "%%~D\%%~N" (
      set "AGENT_DIR=%%~D"
      set "AGENT_NAME=%%~N"
    )
  )
)
if not defined AGENT_DIR set "AGENT_DIR=C:\Renov"
if not defined AGENT_NAME set "AGENT_NAME=renov-agent.exe"
set "AGENT_EXE=%AGENT_DIR%\%AGENT_NAME%"
set "AGENT_BAK=%AGENT_DIR%\%AGENT_NAME%.bak"
set "ASAR=%AGENT_DIR%\resources\app.asar"
set "ASAR_BAK=%AGENT_DIR%\resources\app.asar.bak"
set "FAIL_FLAG=%AGENT_DIR%\update-in-progress.flag"
set "LIVENESS=%AGENT_DIR%\liveness.txt"
set "WDLOG=%AGENT_DIR%\watchdog.log"
set "STATE=%AGENT_DIR%\watchdog-relaunches.txt"
set "BACKOFF=%AGENT_DIR%\watchdog-backoff.txt"
set "BLOCKFLAG=%AGENT_DIR%\agent-blocked.flag"

REM Rotaciona o log do watchdog acima de 1MB (mantem 1 geracao).
if exist "%WDLOG%" for %%F in ("%WDLOG%") do if %%~zF GTR 1048576 (
  if exist "%WDLOG%.1" del /Q "%WDLOG%.1" >NUL 2>&1
  ren "%WDLOG%" "watchdog.log.1" >NUL 2>&1
)

REM -- v3.25.48: O WATCHDOG NAO VERIFICA MAIS agent-blocked.flag --------------
REM  Antes, se o flag existisse, o watchdog NAO relancava - e um falso positivo
REM  de seguranca (asar/clone) deixava a fazenda parada indefinidamente sem
REM  acesso remoto. Agora o agente decide sozinho no boot: a v3.25.48 tem
REM  enforcement OFF + self-heal (apaga o flag e inicia). Se o agente morreu, o
REM  watchdog SEMPRE relanca; quem decide operar ou nao e o proprio agente.
REM  (Removemos tambem a exclusao do flag aqui - o agente faz o self-heal.)

REM Esta rodando?
tasklist /FI "IMAGENAME eq %AGENT_NAME%" 2>NUL | find /I "%AGENT_NAME%" >NUL
if errorlevel 1 (
  call :LOG "Processo ausente (crash total) - relancando"
  goto RELAUNCH
)

REM -- Rodando: checa CONGELAMENTO via liveness.txt --------------------------
REM  Se o arquivo existe E foi escrito ha > 5 min, o agente esta vivo mas travado.
REM  Se o arquivo NAO existe (agente antigo sem writer), NAO mata - retrocompativel.
set "STALE="
if exist "%LIVENESS%" for /f %%A in ('powershell -NoProfile -Command "try{ if(((Get-Date)-(Get-Item '%LIVENESS%').LastWriteTime).TotalMinutes -gt 5){'STALE'} }catch{}"') do set "STALE=%%A"
if defined STALE (
  call :LOG "Agente CONGELADO (liveness > 5min) - matando para relancar"
  taskkill /F /IM "%AGENT_NAME%" >NUL 2>&1
  timeout /t 2 /nobreak >NUL
  goto RELAUNCH
)

REM Vivo e saudavel - limpa flag de update, zera historico de relancamentos e sai.
if exist "%FAIL_FLAG%" del /Q "%FAIL_FLAG%" >NUL 2>&1
if exist "%STATE%" del /Q "%STATE%" >NUL 2>&1
if exist "%BACKOFF%" del /Q "%BACKOFF%" >NUL 2>&1
endlocal
exit /b 0

:RELAUNCH
REM -- Backoff anti crash-loop: ja estamos em janela de espera? ---------------
set "INBACKOFF="
if exist "%BACKOFF%" for /f %%A in ('powershell -NoProfile -Command "try{ $t=[datetime]::Parse((Get-Content -Path '%BACKOFF%' -TotalCount 1)); if($t -gt (Get-Date)){'WAIT'} }catch{}"') do set "INBACKOFF=%%A"
if defined INBACKOFF (
  call :LOG "Em BACKOFF de crash-loop - relancamento adiado neste ciclo"
  endlocal
  exit /b 0
)

REM -- Registra este relancamento e detecta crash-loop (5 em 10 min) ----------
set "LOOP="
for /f %%A in ('powershell -NoProfile -Command "$f='%STATE%'; $b='%BACKOFF%'; $now=Get-Date; $l=@(); if(Test-Path $f){ $l=@(Get-Content $f ^| ForEach-Object { try{[datetime]::Parse($_)}catch{} } ^| Where-Object { $_ -ne $null -and ($now-$_).TotalMinutes -lt 10 }) }; $l=@($l)+@($now); $l ^| ForEach-Object { $_.ToString('o') } ^| Set-Content $f; if($l.Count -ge 5){ $now.AddMinutes(5).ToString('o') ^| Set-Content $b; 'LOOP' }"') do set "LOOP=%%A"
if defined LOOP (
  call :LOG "CRASH-LOOP detectado (5 relancamentos em <10min) - backoff de 5 min ativado"
)

REM -- Rollback 1: binario do agente (.exe.bak) - modelo legado ---------------
if exist "%AGENT_BAK%" (
  call :LOG "Rollback do binario (.exe.bak presente)"
  if exist "%AGENT_EXE%" del /Q "%AGENT_EXE%"
  ren "%AGENT_BAK%" "%AGENT_NAME%"
)

REM -- Rollback 2: bundle de codigo (app.asar.bak) - OTA ----------------------
if exist "%ASAR_BAK%" (
  call :LOG "Rollback do bundle OTA (app.asar.bak presente)"
  if exist "%ASAR%" del /Q "%ASAR%"
  ren "%ASAR_BAK%" "app.asar"
)

REM -- Reinicia o agente ------------------------------------------------------
if exist "%AGENT_EXE%" (
  call :LOG "Reiniciando agente"
  start "" "%AGENT_EXE%"
) else (
  call :LOG "ERRO: %AGENT_EXE% nao encontrado - nada a relancar"
)

endlocal
exit /b 0

:LOG
echo [%date% %time%] %~1>>"%WDLOG%"
exit /b 0
