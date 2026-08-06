@echo off
REM ===========================================================================
REM  build-bridge.bat - compila a bridge serial para .exe (rodar no WINDOWS)
REM ---------------------------------------------------------------------------
REM  O serial_bridge_persistent.py NAO pode mais ser distribuido em texto puro.
REM  Este script gera serial_bridge.exe com PyInstaller. Rode UMA vez por
REM  versao do .py, num Windows x64 com Python 3.8+ instalado.
REM
REM  PRE-REQUISITOS (uma vez):
REM    python -m pip install --upgrade pyinstaller pyserial
REM
REM  RESULTADO:
REM    dist\serial_bridge.exe  ->  copie para a pasta resources\ do agente
REM    (fica ao lado do app.asar). O main.cjs (v3.25.42+) da PRIORIDADE a esse
REM    .exe e nao precisa de Python nem pyserial na maquina da fazenda.
REM
REM  Por que --onefile --noconsole:
REM    --onefile  = um unico .exe, sem pasta de dependencias exposta
REM    --noconsole= sem janela de console (o agente fala por stdin/stdout)
REM    --name serial_bridge = nome fixo esperado pelo main.cjs
REM ===========================================================================
setlocal
cd /d "%~dp0"

where pyinstaller >nul 2>&1
if errorlevel 1 (
  echo [ERRO] PyInstaller nao encontrado. Rode:
  echo        python -m pip install --upgrade pyinstaller pyserial
  pause & exit /b 1
)

if not exist "serial_bridge_persistent.py" (
  echo [ERRO] serial_bridge_persistent.py nao encontrado nesta pasta.
  pause & exit /b 1
)

echo Compilando serial_bridge.exe ...
pyinstaller --onefile --noconsole --name serial_bridge --clean --distpath dist --workpath build --specpath build serial_bridge_persistent.py
if errorlevel 1 (
  echo [ERRO] Falha no PyInstaller.
  pause & exit /b 1
)

echo.
echo ============================================================
echo  Gerado: dist\serial_bridge.exe
echo  Copie para resources\ do pacote do agente (ao lado do app.asar).
echo ============================================================
pause
exit /b 0
