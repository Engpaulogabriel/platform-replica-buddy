---
name: Renova Agent (Headless Bridge v1.4.0)
description: Agente Electron headless v1.4.0 com bridge Serial em Python (pyserial) via stdin/stdout, resolvendo bug do Node.js SerialPort no Windows.
type: feature
---
# Arquitetura definitiva do Renova Agent (v1.4.0)

**Localização**: pasta isolada `electron-agent/`. Build via `build-agent.bat` em máquina Windows do cliente.

## Mudança crítica v1.4.0

A partir desta versão a comunicação Serial é feita por **Python + pyserial** (NÃO mais Node.js SerialPort). O SerialPort no Windows trava o readable stream após o primeiro ciclo TX/RX — testadas 8 estratégias (open/close per cmd, persistent + flush, DTR/RTS off, parser-readline, etc) sem solução. pyserial funciona perfeitamente (mesmo backend do Hercules).

```
Electron (main.cjs)
  ├─ stdin/stdout ──► Python (serial_bridge_persistent.py) ──► Serial COMx ──► Bomba
  └─ HTTPS ──► Supabase (commands, equipments, agent_logs, site_health)
```

### Pré-requisitos no PC da fazenda
- Python 3.8+ no PATH
- `pip install pyserial`

Se faltar, tooltip do tray mostra "ERRO Python".

### Protocolo stdin/stdout (NÃO ALTERAR)
- TX: `SEND:<frame>:<timeout_ms>\n`
- RX: `OK:<resposta>` | `TIMEOUT` | `ERROR:<msg>` | `READY` (handshake)

## Comportamento

- 100% headless: ícone na bandeja (icon.png com fallback verde).
- 1º boot: abre `setup.html` pedindo email/senha/farm_id/COM. Salva em `%APPDATA%\GestorDeBombasKey\renov-agent-config.json`.
- Polling de `commands` (status=pending) a cada 3s, ordenado por priority asc + created_at asc.
- Frame sempre termina com `\r` (adicionado pelo Python se faltar).
- Polling (type='polling'): parseia `_[TSNN_0_]{PAYLOAD}[TSNN_ETX_]` e chama RPC `apply_pump_telemetry` com signal_bars=4 (placeholder até latência real).
- 3 timeouts consecutivos → pausa TX por 60s.
- Bridge respawn automático após 5s se o processo Python morre.

## Heartbeat
Upsert em `site_health` (UNIQUE farm_id) a cada 30s: agent_status, last_heartbeat, com_port, com_connected (espelha bridgeReady), agent_version (1.4.0).

## Tray (UX preservada)
- Ícone real `icon.png`, fallback verde 16x16 RGBA.
- Menu: "RENOV Agent vX.Y.Z" | "Ver Log" | "Reconfigurar" | "Sair".
- Duplo-clique → abre janela de log (TX azul / RX verde, ringbuffer 1000 linhas via IPC `log:line` + `log:get-all`).

## Arquivos
- `electron-agent/main.cjs` — orquestração + tray + setup + log window + bridge spawn
- `electron-agent/serial_bridge_persistent.py` — pyserial loop persistente (NÃO ALTERAR)
- `electron-agent/setup.html` + `setup-preload.cjs`
- `electron-agent/log.html` + `log-preload.cjs`
- `electron-agent/package.json` — SEM `serialport` (removido); apenas `@supabase/supabase-js` + `electron`

## Listagem de portas COM
`ipcMain.handle("list-ports")` agora roda `python -c "import serial.tools.list_ports..."` (não usa mais `SerialPort.list()`).

**Não confundir** com `electron/main.cjs` (app Electron do painel web — descontinuado).
