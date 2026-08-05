@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
title RENOV - Instalar Tarefas Agendadas (boot + watchdog)

REM ===========================================================================
REM  RENOV Agent v3.25.40 — item #11 (boot sem login) + #9 (watchdog)
REM ---------------------------------------------------------------------------
REM  Registra DUAS Tarefas Agendadas do Windows:
REM
REM   1) "RenovAgent"          -> Ao INICIAR O COMPUTADOR (nao "ao fazer logon"),
REM                               "executar mesmo sem usuario conectado".
REM                               Sobrevive a queda de energia + reboot sem
REM                               ninguem logar na maquina.
REM   2) "RenovAgentWatchdog"  -> A cada 1 minuto, roda renov-agent-watchdog.bat.
REM
REM  IMPORTANTE — POR QUE NAO USAMOS /RU SYSTEM POR PADRAO:
REM  ------------------------------------------------------------------------
REM  A configuracao do agente (renov-agent-config.enc) fica no AppData do
REM  USUARIO e e criptografada com DPAPI (safeStorage do Electron), que amarra
REM  a chave ao perfil. Rodando como SYSTEM, o agente:
REM    - le outro AppData (C:\Windows\System32\config\systemprofile\...), e
REM    - NAO consegue descriptografar a config existente.
REM  Resultado: sobe "do zero" pedindo Setup, numa sessao invisivel (sessao 0).
REM
REM  Por isso o padrao aqui e registrar a tarefa com a CONTA DO USUARIO + senha
REM  (/RU usuario /RP senha), que tambem roda no boot sem ninguem logar, mas
REM  mantem AppData e DPAPI corretos. Use SYSTEM apenas em maquina NOVA, que
REM  ainda vai passar pelo Setup rodando como SYSTEM.
REM
REM  Uso:
REM    Instalar-Tarefas-Renov.bat            -> pergunta a senha do usuario atual
REM    Instalar-Tarefas-Renov.bat /SYSTEM    -> registra como SYSTEM (ver aviso)
REM
REM  Precisa ser executado como ADMINISTRADOR.
REM ===========================================================================

net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo [ERRO] Execute este arquivo como ADMINISTRADOR.
  echo        Botao direito ^> "Executar como administrador".
  echo.
  pause & exit /b 1
)

set "AGENT_DIR=C:\Renov"
set "WATCHDOG=%AGENT_DIR%\renov-agent-watchdog.bat"
set "AGENT_EXE="

REM -- Descobre o executavel/launcher do agente -------------------------------
for %%P in (
  "%AGENT_DIR%\renov-agent.exe"
  "%AGENT_DIR%\GestorDeBombasKey.exe"
  "%AGENT_DIR%\Gestor de Bombas Key.exe"
  "%LOCALAPPDATA%\Programs\gestor-de-bombas-key\Gestor de Bombas Key.exe"
  "%LOCALAPPDATA%\Programs\gestor-de-bombas-key\Gestor-de-Bombas-Key.cmd"
) do (
  if not defined AGENT_EXE if exist %%P set "AGENT_EXE=%%~P"
)

if not defined AGENT_EXE (
  echo.
  echo [ERRO] Nao encontrei o executavel do agente nos caminhos conhecidos.
  echo        Informe o caminho completo manualmente:
  set /p "AGENT_EXE=Caminho do .exe/.cmd: "
)
if not exist "%AGENT_EXE%" (
  echo [ERRO] Caminho invalido: %AGENT_EXE%
  pause & exit /b 1
)

echo.
echo  Agente:   %AGENT_EXE%
echo  Watchdog: %WATCHDOG%
echo.

REM -- 1) Tarefa de BOOT ------------------------------------------------------
if /I "%~1"=="/SYSTEM" (
  echo [1/2] Registrando "RenovAgent" ao iniciar o computador ^(SYSTEM^)...
  echo       AVISO: como SYSTEM o agente usa OUTRO AppData e nao le a config
  echo       criptografada do usuario. So use em maquina que ainda vai passar
  echo       pelo Setup nessa conta.
  schtasks /Create /TN "RenovAgent" /TR "\"%AGENT_EXE%\"" /SC ONSTART /RU SYSTEM /RL HIGHEST /F
) else (
  echo [1/2] Registrando "RenovAgent" ao iniciar o computador ^(conta %USERDOMAIN%\%USERNAME%^)...
  echo       A senha e usada apenas pelo Agendador do Windows para rodar a
  echo       tarefa sem ninguem logado. Ela nao e gravada por este BAT.
  set "WINPWD="
  set /p "WINPWD=Senha do Windows de %USERDOMAIN%\%USERNAME%: "
  schtasks /Create /TN "RenovAgent" /TR "\"%AGENT_EXE%\"" /SC ONSTART /RU "%USERDOMAIN%\%USERNAME%" /RP "!WINPWD!" /RL HIGHEST /F
  set "WINPWD="
)
if errorlevel 1 (
  echo [ERRO] Falha ao registrar a tarefa de boot.
) else (
  echo       OK.
)

REM -- 2) Tarefa do WATCHDOG (1 min) -----------------------------------------
echo.
echo [2/2] Registrando "RenovAgentWatchdog" a cada 1 minuto...
if not exist "%WATCHDOG%" (
  echo [AVISO] %WATCHDOG% nao existe. Copie renov-agent-watchdog.bat para %AGENT_DIR% e rode de novo.
) else (
  schtasks /Create /SC MINUTE /MO 1 /TN "RenovAgentWatchdog" /TR "\"%WATCHDOG%\"" /RU SYSTEM /RL HIGHEST /F
  if errorlevel 1 (
    echo [ERRO] Falha ao registrar o watchdog.
  ) else (
    echo       OK.
  )
)

echo.
echo ============================================================
echo  Tarefas registradas. Conferir com:
echo    schtasks /Query /TN "RenovAgent" /V /FO LIST
echo    schtasks /Query /TN "RenovAgentWatchdog" /V /FO LIST
echo.
echo  Testar sem reiniciar:
echo    schtasks /Run /TN "RenovAgent"
echo    schtasks /Run /TN "RenovAgentWatchdog"
echo.
echo  Log do watchdog: %AGENT_DIR%\watchdog.log
echo ============================================================
echo.
pause
exit /b 0
