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
REM  RESULTADO (--onedir):
REM    dist\serial_bridge\  ->  copie a PASTA INTEIRA para resources\serial_bridge\
REM    do agente (fica ao lado do app.asar). Dentro dela vem serial_bridge.exe +
REM    _internal\ com as dependencias. O main.cjs (v3.25.60+) procura primeiro em
REM    resources\serial_bridge\serial_bridge.exe.
REM
REM  Por que --onedir (e NAO mais --onefile):
REM    --onefile extraia ~8MB em %TEMP%\_MEIxxxx a cada execucao; qualquer limpeza
REM    de Temp matava a bridge (bug recorrente da Sykue). --onedir mantem as
REM    dependencias numa subpasta FIXA e NAO usa %TEMP% -> imune a limpeza de Temp.
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

echo Compilando serial_bridge (--onedir) ...
pyinstaller --onedir --noconsole --name serial_bridge --clean --distpath dist --workpath build --specpath build serial_bridge_persistent.py
if errorlevel 1 (
  echo [ERRO] Falha no PyInstaller.
  pause & exit /b 1
)

echo.
echo ============================================================
echo  Gerado: dist\serial_bridge\ (pasta com serial_bridge.exe + _internal\)
echo  Copie a PASTA INTEIRA para resources\serial_bridge\ do pacote do agente
echo  (ao lado do app.asar). NAO usa mais %%TEMP%%\_MEI*.
echo ============================================================
pause
exit /b 0
