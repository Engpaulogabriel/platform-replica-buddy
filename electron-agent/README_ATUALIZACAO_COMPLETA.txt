ATUALIZAÇÃO COMPLETA — AGENTE RENOV v3.10.5
==========================================

Este pacote inclui o BAT de atualização completa.

COMO USAR
---------
1. Extraia o ZIP em uma pasta normal, por exemplo na Área de Trabalho.
2. Clique duas vezes em: Atualizar-Agente-Renov.bat
3. Aguarde finalizar.
4. Abra o log do agente e confirme que aparece:
   - Agente RENOV v3.10.5
   - Reforco TX manual agendado (3 envios em 0s/15s/30s)
   - [REFORCO 2/3 +15s] e [REFORCO 3/3 +30s], se não houver RX antes

IMPORTANTE SOBRE app.asar
-------------------------
Se a instalação tiver resources\app.asar, o Electron carrega esse arquivo.
Nesse caso, trocar apenas resources\app\main.cjs NÃO resolve.

Por isso este BAT:
- fecha o agente;
- faz backup;
- extrai app.asar;
- troca main.cjs e package.json dentro dele;
- reempacota app.asar;
- atualiza serial_bridge_persistent.py solto em resources;
- reinicia o agente.

REQUISITO PARA app.asar
-----------------------
Para reempacotar app.asar, o Windows precisa ter Node.js/npx instalado.
Se não tiver, instale Node.js LTS ou rode o REBUILD-COMPLETO.bat em uma máquina com Node.

ARQUIVOS PRINCIPAIS
-------------------
- Atualizar-Agente-Renov.bat  -> atualizador automático no PC instalado
- REBUILD-COMPLETO.bat        -> rebuild do instalador a partir do código fonte
- app\main.cjs                -> agente completo v3.10.5
- app\serial_bridge_persistent.py -> bridge serial completo
- app\package.json            -> versão v3.10.5
- app\setup.html / log.html   -> telas obrigatórias do agente

CORREÇÕES INCLUÍDAS (v3.10.5)
------------------------------
- Corrige pacote de instalação solta: setup.html/log.html/preloads/icones agora vão dentro de app\.
- Launcher passa a iniciar electron.exe direto e cria launcher.log para diagnóstico.
- "Atualizar Status Agora" cria comando priority=1 + reinforcement=true e usa reforço 0s/15s/30s.
- Polling entre equipamentos respeita gap de 8s após RX bem sucedido (evita colisão no rádio).
- Após timeout, gap reduzido para 3s para não atrasar o ciclo.
- Comunicação do sistema padronizada para 10 segundos (redução de consumo Cloud).
- TSNN hexadecimal, incluindo 11A5, tratado corretamente.
- Regex de TX/RX aceita [0-9A-Fa-f]{4}, não só números.
- Associação TSNN -> equipamento normalizada para uppercase.
- Parser de RX mais tolerante a ruído/espaços.
- Atualização de estado via apply_pump_telemetry mantendo payload real recebido.
- Lógica de output_count preservada para PLCs com múltiplas saídas.
- Configuração criptografada (DPAPI Windows) — migração automática do JSON legado.
- Proteção anti-tampering com HMAC e hash do ASAR em build-time.
- Heartbeat de licença a cada 48h com fingerprint de hardware.
