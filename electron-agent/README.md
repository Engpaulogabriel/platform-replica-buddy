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

## Arquivos

| Arquivo | Função |
|---|---|
| `main.cjs` | Processo principal: tray, bridge Python, supabase, heartbeat |
| `serial_bridge_persistent.py` | **Bridge Serial em Python (pyserial). Persistente via stdin/stdout.** |
| `setup.html` + `setup-preload.cjs` | Janela de setup (1º boot) |
| `log.html` + `log-preload.cjs` | Janela de log read-only |
| `package.json` | Deps + script `build` |
| `build-agent.bat` | Atalho para `npm install && npm run build` |
| `agent-config.json` | (gerado em runtime) `%APPDATA%\GestorDeBombasKey\agent-config.json` |

---
© Renov Tecnologia Agrícola®
