# Gestor de Bombas Key — Bridge Serial Headless (v1.4.0)

Agente leve da **Renov Tecnologia Agrícola®** que roda em segundo plano no PC da fazenda, comunicando-se com o Servidor ESP_A via porta Serial (RS-232) e sincronizando comandos/telemetria com o painel Renov na nuvem.

## ⚠️ Pré-requisitos OBRIGATÓRIOS no PC da fazenda

A partir da v1.4.0 a comunicação Serial é feita via **Python + pyserial** (resolve bug do Node.js SerialPort no Windows).

1. **Python 3.8+** instalado e disponível no `PATH` do Windows.
   - Baixe em: https://www.python.org/downloads/windows/
   - Durante a instalação, marque ✅ **"Add Python to PATH"**.
2. **pyserial**:
   ```cmd
   pip install pyserial
   ```
3. Para confirmar:
   ```cmd
   python --version
   python -c "import serial; print(serial.__version__)"
   ```

Sem Python+pyserial o agente NÃO consegue falar com a bomba.

## Características

- **Headless**: sem janela principal. Apenas ícone na bandeja do sistema.
- **Auto-start**: pode ser registrado no Windows para iniciar com o sistema.
- **Bridge Python persistente**: spawn único do `serial_bridge_persistent.py`, comunicação via stdin/stdout.
- **Auto-detect COM**: lista portas via `serial.tools.list_ports`.
- **Setup wizard**: na 1ª execução abre uma mini-janela pedindo email/senha/farm_id/COM.
- **Polling de comandos**: lê `commands` (status=pending) a cada 3s.
- **Heartbeat**: faz upsert em `site_health` a cada 30s.
- **Janela de log**: TX/RX/erros em tempo real (duplo-clique no tray ou "Ver Log").

## Build (gerar o .exe)

### Pré-requisitos do build
- Windows 10/11 x64
- [Node.js 18+](https://nodejs.org/)

### Passos
1. Copie a pasta `electron-agent/` inteira para sua máquina Windows.
2. Dê duplo-clique em `build-agent.bat` (ou rode `npm install && npm run build`).
3. Aguarde 2–5 minutos (1ª vez baixa o Electron ~150 MB).
4. O instalador final fica em: `dist\GestorDeBombasKey-Setup-<versão>.exe`
5. **IMPORTANTE**: o arquivo `serial_bridge_persistent.py` é copiado automaticamente para `resources/`. Não remova.

## Instalação na fazenda

1. Instale Python 3 + pyserial (ver "Pré-requisitos OBRIGATÓRIOS" acima).
2. Copie a pasta `Gestor de Bombas Key-win32-x64\` inteira para o PC da fazenda (ex.: `C:\GestorDeBombasKey\`).
3. Execute `Gestor de Bombas Key.exe`.
4. No 1º boot abrirá a janela de setup. Informe:
   - **Email/Senha**: conta de serviço da fazenda.
   - **Farm ID**: UUID da fazenda (visível em Configurações → Fazenda).
   - **Porta COM**: ex. `COM12`.
5. Após salvar, o agente fica na bandeja. Tooltip "Online (COMxx)" = rodando ok.

## Diagnóstico

- **Duplo-clique no ícone da bandeja** → abre janela de log (TX azul / RX verde).
- **Botão direito → "Ver Log"** → mesma janela.
- **Botão direito → "Reconfigurar"** apaga credenciais e força novo setup.
- Se a tooltip mostra "ERRO Python" → instale Python e `python -m pip install pyserial`.

## Arquitetura

```
Electron (main.cjs)
    │
    ├── stdin/stdout ──► Python (serial_bridge_persistent.py) ──► Serial (COMx) ──► Bomba
    │
    └── HTTPS ──► Supabase (commands, equipments, agent_logs, site_health)
```

## Auto-recuperação (v3.25.40)

Cenário-alvo: PC da fazenda com Starlink instável, **sem AnyDesk e sem acesso remoto**. O agente precisa voltar sozinho de qualquer situação.

| Camada | Gatilho | Ação |
|---|---|---|
| Restart preventivo | 03:00 local, 1x/dia | `relaunchAgent("preventive_restart")` — **espera** qualquer atuação em curso terminar (bomba ligando, reforço, safety, OTA); adia no máx. 2h |
| Memory guard | a cada 5 min: heap > 500 MB **ou** RSS > 70% da RAM | `relaunchAgent("memory_guard")` |
| Exceção não tratada | `uncaughtException` | log fatal → alerta → relaunch (exit 1). Nunca `process.exit()` direto |
| Rejeição não tratada | 3 `unhandledRejection` em 5 min | idem. Uma rejeição isolada só é logada — um `fetch` de nuvem rejeitado não pode derrubar a operação |
| Watchdog interno | bridge caída ~3 min | `relaunchAgent("watchdog_relaunch")` |
| Watchdog externo (.bat) | processo ausente, ou `liveness.txt` parado > 5 min | mata + relança, com **backoff** de 5 min após 5 relançamentos em 10 min |
| Alerta "estou morrendo" | antes de **todo** relaunch/exit | POST 3s em `whatsapp-automation-notify` (`alert_type: agent_dying`) |

**Fallback de último estado:** o agente **nunca** desliga bomba por falta de nuvem. Perda de conexão nunca vira comando de desligar; o estado local é soberano enquanto offline. Quando a nuvem volta, `resyncKnownStateToCloud()` reenvia o último payload RX real de cada PLC imediatamente. O agente só encerra por decisão **explícita** do servidor (403 / `revoked` / `farm_suspended`).

## Boot automático sem login do Windows

Registre as tarefas com o BAT (como **Administrador**):

```cmd
Instalar-Tarefas-Renov.bat
```

Ele cria duas tarefas: `RenovAgent` (ao iniciar o computador) e `RenovAgentWatchdog` (a cada 1 minuto). Equivalente manual:

```cmd
REM Agente no boot, sem precisar de login — rodando na CONTA DO USUÁRIO
schtasks /Create /TN "RenovAgent" /TR "C:\Renov\GestorDeBombasKey.exe" ^
  /SC ONSTART /RU "%USERDOMAIN%\%USERNAME%" /RP "<senha>" /RL HIGHEST /F

REM Watchdog a cada 1 minuto
schtasks /Create /SC MINUTE /MO 1 /TN "RenovAgentWatchdog" ^
  /TR "C:\Renov\renov-agent-watchdog.bat" /RU SYSTEM /RL HIGHEST /F
```

> ⚠️ **Não use `/RU SYSTEM` para a tarefa do agente numa instalação já configurada.** A config (`renov-agent-config.enc`) fica no AppData do usuário e é criptografada com DPAPI (`safeStorage`), que amarra a chave ao perfil. Como SYSTEM o agente lê `C:\Windows\System32\config\systemprofile\AppData\...` e **não consegue descriptografar a config existente** — sobe pedindo Setup, numa sessão invisível (sessão 0). Rodar na conta do usuário com `/RP` também dispensa login e preserva AppData + DPAPI. `/SYSTEM` só faz sentido em máquina nova que ainda vai passar pelo Setup nessa conta.

Conferir e testar sem reiniciar:

```cmd
schtasks /Query /TN "RenovAgent" /V /FO LIST
schtasks /Run   /TN "RenovAgent"
```

## Arquivos

| Arquivo | Função |
|---|---|
| `main.cjs` | Processo principal: tray, bridge Python, supabase, heartbeat |
| `renov-agent-watchdog.bat` | Watchdog externo: processo ausente/congelado, rollback, backoff anti crash-loop |
| `Instalar-Tarefas-Renov.bat` | Registra as Tarefas Agendadas de boot e do watchdog |
| `serial_bridge_persistent.py` | **Bridge Serial em Python (pyserial). Persistente via stdin/stdout.** |
| `setup.html` + `setup-preload.cjs` | Janela de setup (1º boot) |
| `log.html` + `log-preload.cjs` | Janela de log read-only |
| `package.json` | Deps + script `build` |
| `build-agent.bat` | Atalho para `npm install && npm run build` |
| `agent-config.json` | (gerado em runtime) `%APPDATA%\GestorDeBombasKey\agent-config.json` |

---
© Renov Tecnologia Agrícola®
