@echo off
setlocal EnableExtensions EnableDelayedExpansion
title RENOV - Instalar Tarefas Agendadas (boot + watchdog)

REM ===========================================================================
REM  RENOV Agent - item #11 (boot sem login) + #9 (watchdog)
REM ---------------------------------------------------------------------------
REM  ASCII PURO e quebras de linha CRLF de proposito: o interpretador de .bat do
REM  Windows quebra com acentos fora da code page ativa e pode engasgar com
REM  linhas terminadas so em LF dentro de blocos ( ... ).
REM
REM  Registra DUAS Tarefas Agendadas do Windows:
REM
REM   1) "RenovAgent"          -> Ao INICIAR O COMPUTADOR (nao "ao fazer logon"),
REM                               "executar mesmo sem usuario conectado".
REM                               Sobrevive a queda de energia + reboot sem
REM                               ninguem logar na maquina.
REM   2) "RenovAgentWatchdog"  -> A cada 1 minuto, roda renov-agent-watchdog.bat.
REM
REM  IMPORTANTE - POR QUE NAO USAMOS /RU SYSTEM POR PADRAO:
REM  ------------------------------------------------------------------------
REM  A configuracao do agente (renov-agent-config.enc) fica no AppData do
REM  USUARIO e e criptografada com DPAPI (safeStorage do Electron), que amarra
REM  a chave ao perfil. Rodando como SYSTEM, o agente:
REM    - le outro AppData (C:\Windows\System32\config\systemprofile\...), e
REM    - NAO consegue descriptografar a config existente.
REM  Resultado: sobe "do zero" pedindo Setup, numa sessao invisivel (sessao 0).
REM
REM  Por isso o padrao aqui e registrar a tarefa com a CONTA DO USUARIO + senha
REM  (/RU usuario /RP senha), que tambem roda no boot sem ninguem logado, mas
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

REM -- Descobre o executavel/launcher do agente -------------------------------
REM  Procura em MULTIPLOS diretorios x MULTIPLOS nomes conhecidos. O primeiro
REM  que existir vence. A ordem coloca o diretorio do proprio .bat na frente,
REM  para que uma pasta portatil/copiada tenha prioridade sobre instalacoes
REM  antigas deixadas para tras em C:\Renov.
set "AGENT_EXE="
set "AGENT_DIR="
for %%D in (
  "%~dp0."
  "C:\Renov"
  "C:\Gestor de Bombas"
  "C:\Program Files\Gestor de Bombas Key"
  "%LOCALAPPDATA%\Programs\gestor-de-bombas-key"
) do (
  for %%N in (
    "renov-agent.exe"
    "GestorDeBombasKey.exe"
    "Gestor de Bombas Key.exe"
    "Gestor-de-Bombas-Key.cmd"
  ) do (
    if not defined AGENT_EXE if exist "%%~D\%%~N" (
      set "AGENT_EXE=%%~D\%%~N"
      set "AGENT_DIR=%%~D"
    )
  )
)

if not defined AGENT_EXE (
  echo.
  echo [AVISO] Nao encontrei o executavel do agente. Procurei por:
  echo           renov-agent.exe / GestorDeBombasKey.exe /
  echo           "Gestor de Bombas Key.exe" / Gestor-de-Bombas-Key.cmd
  echo         em:
  echo           %~dp0
  echo           C:\Renov
  echo           C:\Gestor de Bombas
  echo           C:\Program Files\Gestor de Bombas Key
  echo           %LOCALAPPDATA%\Programs\gestor-de-bombas-key
  echo.
  set /p "AGENT_EXE=Informe o caminho completo do .exe/.cmd: "
  for %%F in ("!AGENT_EXE!") do set "AGENT_DIR=%%~dpF."
)
if not exist "%AGENT_EXE%" (
  echo [ERRO] Caminho invalido: %AGENT_EXE%
  pause & exit /b 1
)

REM -- Descobre o watchdog (mesma lista de diretorios) ------------------------
set "WATCHDOG="
for %%D in (
  "%~dp0."
  "%AGENT_DIR%"
  "C:\Renov"
  "C:\Gestor de Bombas"
) do (
  if not defined WATCHDOG if exist "%%~D\renov-agent-watchdog.bat" set "WATCHDOG=%%~D\renov-agent-watchdog.bat"
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
if not defined WATCHDOG (
  echo [AVISO] renov-agent-watchdog.bat nao encontrado. Copie-o para a pasta do
  echo         agente e rode este instalador de novo.
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
echo  Log do watchdog: C:\Renov\watchdog.log
echo ============================================================
echo.
pause
exit /b 0
