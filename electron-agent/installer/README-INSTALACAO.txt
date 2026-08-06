===========================================================================
 RENOV Agent v3.25.42 - Pacote de Instalacao Seguro
 README para o TECNICO de campo
===========================================================================

OBJETIVO
  Copiar a pasta para o PC da fazenda e, em UMA acao, deixar o sistema
  funcional, seguro e resiliente. Sem Python, sem ler o codigo, sem clonar.


-------------------------------------------------------------------------
 INSTALACAO (o que o tecnico faz)
-------------------------------------------------------------------------
  1. Copie a pasta inteira do pacote para o pendrive.
  2. No PC da fazenda, cole a pasta em qualquer lugar (ex.: a Area de Trabalho).
  3. Clique com o botao direito em  INSTALAR.bat  ->  "Executar como
     administrador".
  4. Aceite o aviso do Windows (UAC). Pronto. Em ~30 segundos esta tudo feito.

  O INSTALAR.bat faz sozinho:
    - copia os arquivos para  C:\Gestor de Bombas
    - remove idiomas extras, .py, debug.log e o INSTALAR-PYSERIAL.bat
    - aplica permissoes NTFS (so o usuario do agente e o SYSTEM acessam a pasta)
    - registra a Tarefa Agendada RenovAgent (inicia no boot, sem login)
    - registra a Tarefa Agendada RenovAgentWatchdog (vigia a cada 1 minuto)
    - cria o atalho no Desktop e inicia o agente

  Nao precisa instalar Python. A bridge serial ja vem compilada
  (serial_bridge.exe).


-------------------------------------------------------------------------
 CONFIGURACAO DA FAZENDA (login + porta COM)
-------------------------------------------------------------------------
  DUAS opcoes:

  A) HEADLESS (recomendado, zero digitacao no PC):
     Coloque um arquivo  provisioning.json  na MESMA pasta do INSTALAR.bat
     antes de rodar. O instalador copia para C:\ProgramData\Renov e o agente
     se auto-ativa no primeiro boot - sem tela de Setup. Gere 1 provisioning
     por fazenda no painel (super_admin).
     Nesse modo a tarefa de boot roda como SYSTEM.

  B) MANUAL:
     Sem provisioning.json, abra o "Gestor de Bombas" (atalho no Desktop) e
     informe login/senha da fazenda e a porta COM do radio.
     Se o PC foi configurado assim (config no perfil do usuario) e voce quer
     boot sem login preservando essa config, rode:
         INSTALAR.bat "C:\Gestor de Bombas" SENHA_DO_WINDOWS
     (a senha e usada so pelo Agendador do Windows; nao e gravada.)


-------------------------------------------------------------------------
 SEGURANCA (ja incluida - o tecnico nao configura nada)
-------------------------------------------------------------------------
  - Bridge serial compilada (serial_bridge.exe): o protocolo nao fica exposto.
  - Codigo ofuscado dentro do app.asar: extrair o asar nao revela o codigo.
  - Verificacao de integridade: no boot o agente confere o SHA-256 do app.asar
    contra o hash oficial no servidor. Se alguem modificou o arquivo, o agente
    BLOQUEIA a operacao, alerta no WhatsApp e nao liga as bombas.
  - Anti-clone: fingerprint de hardware (placa de rede, disco, placa-mae, CPU).
    Se o pacote for copiado para outro PC, o clone e detectado, alerta no
    WhatsApp e o agente fica BLOQUEADO ate reautorizacao.
  - Permissoes NTFS: outros usuarios do PC nao conseguem nem listar a pasta.

  DESBLOQUEIO (apos bloqueio de seguranca legitimo):
    Existe um arquivo  agent-blocked.flag  na pasta de instalacao. Enquanto
    ele existir, o agente e o watchdog NAO iniciam a operacao. Para reautorizar
    um PC (ex.: troca de HD legitima), apague esse arquivo E autorize o novo
    hardware no painel (super_admin -> "Autorizar novo PC"). Reinstalar pelo
    INSTALAR.bat tambem remove o flag.


-------------------------------------------------------------------------
 RESILIENCIA (ja incluida)
-------------------------------------------------------------------------
  - COM-first: as bombas operam pela serial mesmo com 0% de internet.
  - Modo degradado para Starlink lento (200 kbps).
  - Restart preventivo diario as 03:00 (nunca durante uma atuacao).
  - Memory guard: reinicia sozinho se a memoria estourar.
  - Watchdog externo (.bat): revive o agente se ele cair ou congelar, com
    backoff anti crash-loop.
  - Alerta "estou morrendo" no WhatsApp antes de qualquer reinicio.
  - Ultimo estado soberano: NUNCA desliga bomba so por perder a nuvem; ao
    reconectar, reenvia o estado real.


-------------------------------------------------------------------------
 PARA QUEM MONTA O PACOTE (nao e o tecnico de campo)
-------------------------------------------------------------------------
  1. Compilar a bridge (num Windows, uma vez por versao do .py):
       python -m pip install --upgrade pyinstaller pyserial
       pyinstaller --onefile --noconsole --name serial_bridge serial_bridge_persistent.py
     (ou rode  build-bridge.bat  desta pasta). Copie dist\serial_bridge.exe
     para  resources\  do agente, ao lado do app.asar.

  2. Gerar o app.asar OFUSCADO (no Mac/Linux/Windows com Node):
       ./installer/build-secure-asar.sh
     Anote o sha256 impresso e registre em agent_releases.file_hash para a
     versao. O agente BLOQUEIA se o hash do asar em execucao divergir.

  3. Montar a pasta do pendrive com:
       Agente-Renov.exe (ou renov-agent.exe), resources\ (app.asar +
       serial_bridge.exe), locales\ (pt-BR.pak + en-US.pak),
       renov-agent-watchdog.bat, INSTALAR.bat, README-INSTALACAO.txt e,
       opcionalmente, provisioning.json.
     NAO inclua: serial_bridge_persistent.py, debug.log, INSTALAR-PYSERIAL.bat,
       main.original.cjs.

===========================================================================
 (c) Renov Tecnologia Agricola
===========================================================================
