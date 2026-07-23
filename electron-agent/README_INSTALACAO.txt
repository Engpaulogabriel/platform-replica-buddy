INSTALAÇÃO DO AGENTE RENOV v3.10.1 — PC NOVO
=============================================

Este pacote instala o agente do ZERO em um PC que ainda não tem nada.
Para ATUALIZAR um agente já instalado, use o pacote "Atualizacao".

REQUISITOS
----------
- Windows 10 ou 11 (x64)
- Node.js LTS instalado: https://nodejs.org/pt-br/download
- Internet (para baixar o Electron na primeira vez, ~150MB)
- Python 3.8+ (para a bridge serial RS-232): https://www.python.org/downloads/
  Marque "Add Python to PATH" durante a instalação.

COMO USAR
---------
1. Instale Node.js LTS (se ainda não tiver).
2. Instale Python 3 (se ainda não tiver).
3. Conecte o cabo do rádio RS-232 na porta USB/Serial do PC.
4. Extraia este ZIP para uma pasta (ex: Área de Trabalho).
5. Clique com o botão direito em "Instalar-Agente-Renov.bat"
   e escolha "Executar como administrador" (recomendado).
6. Aguarde a instalação (5-10 minutos na primeira vez).
7. Quando abrir a tela de SETUP:
   - Faça login com o email/senha da fazenda
   - Selecione a porta COM do rádio (geralmente COM3, COM4, etc.)
   - Salve.
8. Pronto! O agente fica rodando em segundo plano (ícone na bandeja do
   sistema, ao lado do relógio do Windows). Inicia automaticamente
   junto com o Windows.

O QUE O INSTALADOR FAZ
----------------------
- Cria pasta em %LOCALAPPDATA%\Programs\gestor-de-bombas-key
- Copia main.cjs, package.json, bridge serial Python
- Roda npm install (baixa Electron + Supabase JS)
- Cria atalho na Área de Trabalho
- Configura auto-start no Windows (registro Run do usuário)
- Inicia o agente

DESINSTALAR
-----------
1. Feche o agente (botão direito no ícone da bandeja → Sair)
2. Apague a pasta: %LOCALAPPDATA%\Programs\gestor-de-bombas-key
3. Apague a chave do registro:
   reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "GestorDeBombasKey" /f
4. Apague o atalho da Área de Trabalho.

PROBLEMAS COMUNS
----------------
- "Node.js nao encontrado" → instale Node.js LTS e rode o BAT de novo.
- "npm install falhou" → verifique conexão com internet.
- Bridge serial não abre → instale Python 3 e a biblioteca pyserial:
    pip install pyserial
- Agente não inicia → veja o log em:
    %APPDATA%\GestorDeBombasKey\boot.log
    %APPDATA%\GestorDeBombasKey\logs\

ARQUIVOS DO PACOTE
------------------
- Instalar-Agente-Renov.bat            -> instalador automático corrigido
- Atualizar-Agente-Renov.bat           -> atualizador para instalação existente
- README_INSTALACAO.txt                -> este arquivo
- app\main.cjs                          -> código do agente v3.10.1
- app\setup.html / log.html             -> telas obrigatórias do agente
- app\package.json                      -> dependências
- app\serial_bridge_persistent.py       -> bridge serial RS-232

SE CLICAR E NÃO ABRIR
---------------------
- Use o atalho "Abrir-Diagnostico-Agente-Renov.cmd" criado na pasta instalada.
- Ele mantém a janela aberta e grava detalhes em:
    %APPDATA%\GestorDeBombasKey\launcher.log
    %APPDATA%\GestorDeBombasKey\boot.log
