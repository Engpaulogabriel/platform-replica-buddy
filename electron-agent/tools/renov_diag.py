#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
RENOV DIAG — Ferramenta de diagnóstico do repetidor/servidor ESP (RS-485).
=========================================================================
Console (CMD) com menu numerado. Sem GUI.

Menu básico (sem senha): PING/STATUS/TEST_RADIOS/RESET/RESET_B/frame p/ bomba/PARAMS.
[8] Modo Técnico  — valida PIN online (edge validate-diag-pin) → recebe a senha CFG
    CRIPTOGRAFADA (AES-GCM, chave derivada de PIN+machine_id). A senha NUNCA está no
    binário. Sessão de 10 min. Libera comandos CFG:*.
[9] Acesso Remoto — gera código de 8 dígitos, registra a sessão (edge diag-session),
    faz polling a cada 2s de comandos enfileirados pela plataforma web, executa na
    serial e devolve a resposta. Terminal remoto sem AnyDesk. 30 min.

Dependências: pyserial, requests, cryptography
Compilar: pyinstaller --onefile --name renov_diag electron-agent/tools/renov_diag.py
"""

import sys
import os
import time
import hashlib
import base64
import random
import platform
import subprocess
from datetime import datetime

try:
    import serial
    from serial.tools import list_ports
except Exception:
    print("ERRO: pyserial não instalado. pip install pyserial")
    sys.exit(1)
try:
    import requests
except Exception:
    print("ERRO: requests não instalado. pip install requests")
    sys.exit(1)
try:
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    from cryptography.hazmat.primitives.hashes import SHA256
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except Exception:
    print("ERRO: cryptography não instalado. pip install cryptography")
    sys.exit(1)

# ── Config do backend (URL/anon são PÚBLICOS — nenhuma senha aqui) ───────────
SUPABASE_URL = os.environ.get("RENOV_SUPABASE_URL", "https://dnyukgfedredvxpzjpqz.supabase.co")
SUPABASE_ANON = os.environ.get(
    "RENOV_SUPABASE_ANON",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRueXVrZ2ZlZHJlZHZ4cHpqcHF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2ODU1OTQsImV4cCI6MjA5MjI2MTU5NH0.OSg44w0CRVvD-f6Ts_U9DVeQkQ-4c37passKEK5X0kk",
)
SERIAL_TIMEOUT = 5.0
LOG_FILE = "renov_diag_log.txt"
PBKDF2_ITERS = 100_000

LOGO = r"""
   ____  _____ _   _  ___ __     __
  |  _ \| ____| \ | |/ _ \\ \   / /   RENOV DIAG
  | |_) |  _| |  \| | | | |\ \ / /    Diagnóstico ESP / RS-485
  |  _ <| |___| |\  | |_| | \ V /     ---------------------------------
  |_| \_\_____|_| \_|\___/   \_/      Repetidor / Servidor / Bombas
"""

_ser = None  # porta serial global
_tech_until = 0.0  # epoch de expiração do Modo Técnico


# ── util ─────────────────────────────────────────────────────────────────────
def ts():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def log(line):
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"[{ts()}] {line}\n")
    except Exception:
        pass


def machine_id():
    """hash(hostname + serial do HD) — identifica o PC. Estável no Windows."""
    host = platform.node() or "unknown"
    disk = ""
    try:
        if platform.system() == "Windows":
            out = subprocess.check_output("wmic diskdrive get SerialNumber /value",
                                          timeout=5, shell=True).decode(errors="ignore")
            for ln in out.splitlines():
                if ln.strip().startswith("SerialNumber="):
                    disk = ln.split("=", 1)[1].strip()
                    if disk:
                        break
    except Exception:
        pass
    raw = f"{host}|{disk}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:32]


def clear():
    os.system("cls" if platform.system() == "Windows" else "clear")


# ── serial ───────────────────────────────────────────────────────────────────
def pick_port():
    ports = list(list_ports.comports())
    if not ports:
        print("Nenhuma porta COM encontrada. Conecte o cabo RS-485 e tente de novo.")
        return None
    print("\nPortas COM disponíveis:")
    for i, p in enumerate(ports, 1):
        print(f"  [{i}] {p.device}  {p.description}")
    while True:
        sel = input("Escolha a porta (número) ou 'q' p/ sair: ").strip()
        if sel.lower() == "q":
            return None
        if sel.isdigit() and 1 <= int(sel) <= len(ports):
            return ports[int(sel) - 1].device
        print("Opção inválida.")


def open_serial(port):
    global _ser
    try:
        _ser = serial.Serial(port=port, baudrate=9600, bytesize=serial.EIGHTBITS,
                             parity=serial.PARITY_NONE, stopbits=serial.STOPBITS_ONE,
                             timeout=0.2)
        try:
            _ser.reset_input_buffer(); _ser.reset_output_buffer()
        except Exception:
            pass
        return True
    except Exception as e:
        print(f"ERRO ao abrir {port}: {e}")
        return False


def serial_cmd(frame, timeout=SERIAL_TIMEOUT):
    """Envia frame (já com \\r) e lê a resposta até timeout. Retorna string ASCII."""
    global _ser
    if _ser is None or not _ser.is_open:
        return "(serial não conectada)"
    try:
        data = frame if isinstance(frame, (bytes, bytearray)) else frame.encode("ascii", errors="ignore")
        _ser.reset_input_buffer()
        _ser.write(data)
        _ser.flush()
        log(f"TX: {frame!r}")
        buf = bytearray()
        deadline = time.time() + timeout
        while time.time() < deadline:
            chunk = _ser.read(256)
            if chunk:
                buf.extend(chunk)
                deadline = time.time() + 0.4  # estende um pouco a cada byte
            else:
                if buf:
                    break
                time.sleep(0.02)
        resp = bytes(buf).decode("ascii", errors="replace").strip()
        log(f"RX: {resp!r}")
        return resp if resp else "(sem resposta em %.0fs)" % timeout
    except Exception as e:
        log(f"ERR serial: {e}")
        return f"(erro serial: {e})"


def send_and_show(label, frame):
    print(f"\n→ {label}")
    print(f"  TX: {frame.strip()}")
    resp = serial_cmd(frame)
    print(f"  RX: {resp}")
    return resp


def build_pump_frame(tsnn, action):
    tsnn = str(tsnn).strip()
    bit = "1" if action == "ligar" else "0"  # desligar/consultar → 0 (consultar = leitura de polling)
    return f"[{tsnn}_1_]{{{bit}}}[{tsnn}_ETX_]\r"


# ── backend (edge functions) ─────────────────────────────────────────────────
def _headers():
    return {"apikey": SUPABASE_ANON, "Authorization": f"Bearer {SUPABASE_ANON}",
            "Content-Type": "application/json"}


def api_post(path, payload, timeout=10):
    url = f"{SUPABASE_URL}/functions/v1/{path}"
    r = requests.post(url, json=payload, headers=_headers(), timeout=timeout)
    try:
        return r.status_code, r.json()
    except Exception:
        return r.status_code, {"raw": r.text[:300]}


def derive_key(pin, mid):
    kdf = PBKDF2HMAC(algorithm=SHA256(), length=32, salt=mid.encode("utf-8"), iterations=PBKDF2_ITERS)
    return kdf.derive(pin.encode("utf-8"))


def decrypt_password(enc_b64, pin, mid):
    """enc_b64 = base64(iv(12) || ciphertext || tag(16)). Chave = PBKDF2(pin, salt=mid)."""
    raw = base64.b64decode(enc_b64)
    iv, ct = raw[:12], raw[12:]
    key = derive_key(pin, mid)
    return AESGCM(key).decrypt(iv, ct, None).decode("utf-8")


# ── [8] Modo Técnico ─────────────────────────────────────────────────────────
def tech_mode():
    global _tech_until
    print("\n=== MODO TÉCNICO (autorização online) ===")
    pin = input("PIN de 6 dígitos (gerado na plataforma): ").strip()
    if not (pin.isdigit() and len(pin) == 6):
        print("PIN inválido (6 dígitos)."); return
    mid = machine_id()
    try:
        code, body = api_post("validate-diag-pin", {"pin": pin, "machine_id": mid})
    except requests.exceptions.RequestException:
        print("Modo técnico indisponível sem internet."); return
    if code != 200 or not body.get("ok"):
        print(f"PIN rejeitado: {body.get('reason', body)}"); return
    try:
        senha = decrypt_password(body["encrypted_password"], pin, mid)
    except Exception as e:
        print(f"Falha ao decifrar a senha ({e})."); return
    resp = send_and_show("CFG LOGIN", f"CFG:LOGIN:{senha}\r")
    _tech_until = time.time() + int(body.get("expires_in", 600))
    print("\n✅ Modo técnico ATIVO por %d min." % (int(body.get("expires_in", 600)) / 60))
    tech_shell()


def tech_active():
    return time.time() < _tech_until


def tech_shell():
    print("Comandos CFG liberados. Digite comandos (ex: HELP, LIST, DUMP, SET_PARAM ...).")
    print("'sair' volta ao menu.")
    while tech_active():
        c = input("CFG> ").strip()
        if not c:
            continue
        if c.lower() in ("sair", "exit", "q"):
            return
        frame = c if c.upper().startswith("CFG:") else f"CFG:{c}"
        send_and_show(c, frame + "\r")
    print("Sessão técnica expirou (10 min). Gere novo PIN.")


# ── [9] Acesso Remoto ────────────────────────────────────────────────────────
def remote_access(com_port):
    print("\n=== ACESSO REMOTO ===")
    code = f"{random.randint(0, 99999999):08d}"
    mid = machine_id()
    try:
        st, body = api_post("diag-session", {"action": "create", "code": code,
                                             "machine_id": mid, "com_port": com_port})
    except requests.exceptions.RequestException:
        print("Sem internet — acesso remoto indisponível."); return
    if st != 200 or not body.get("ok"):
        print(f"Falha ao registrar sessão: {body}"); return

    print("\n" + "=" * 52)
    print(f"  🔗 ACESSO REMOTO ATIVO — Código: {code}")
    print("  Passe este código para o técnico RENOV.")
    print("  Aguardando comandos... (Ctrl+C encerra)")
    print("=" * 52 + "\n")
    log(f"REMOTE session {code} started on {com_port}")

    net_warned = False
    try:
        while True:
            try:
                st, body = api_post("diag-session", {"action": "poll", "code": code, "machine_id": mid}, timeout=8)
                net_warned = False
            except requests.exceptions.RequestException:
                if not net_warned:
                    print("⚠️  Sem internet no momento — tentando reconectar (serial local segue ok)...")
                    net_warned = True
                time.sleep(2); continue
            if st != 200 or not body.get("ok"):
                if body.get("reason") == "expired" or body.get("reason") == "closed":
                    print("Sessão encerrada/expirada pelo servidor."); break
                time.sleep(2); continue
            cmds = body.get("commands") or []
            for cmd in cmds:
                frame = cmd.get("command", "")
                if not frame.endswith("\r"):
                    frame_tx = frame + "\r"
                else:
                    frame_tx = frame
                print(f"[{ts()}] ← comando remoto: {frame.strip()}")
                resp = serial_cmd(frame_tx)
                print(f"[{ts()}] → resposta: {resp}")
                try:
                    api_post("diag-session", {"action": "respond", "code": code,
                                              "machine_id": mid, "command_id": cmd.get("id"),
                                              "response": resp})
                except requests.exceptions.RequestException:
                    pass
            time.sleep(2)
    except KeyboardInterrupt:
        print("\nEncerrando acesso remoto...")
    finally:
        try:
            api_post("diag-session", {"action": "close", "code": code, "machine_id": mid})
        except Exception:
            pass
        log(f"REMOTE session {code} closed")
        print("Acesso remoto encerrado. Voltando ao menu.")


# ── menu ─────────────────────────────────────────────────────────────────────
def show_menu(port):
    clear()
    print(LOGO)
    tech = " [TÉCNICO ATIVO]" if tech_active() else ""
    print(f"  Porta: {port}   Máquina: {machine_id()[:12]}...{tech}\n")
    print("  [1] PING                     [6] Enviar frame para bomba")
    print("  [2] STATUS                   [7] PARAMS")
    print("  [3] TEST_RADIOS              [8] Modo Técnico (PIN online)")
    print("  [4] RESET ESP_A              [9] Acesso Remoto (código 8 díg.)")
    print("  [5] RESET ESP_B              [0] Sair")
    print()


def confirm(msg):
    return input(f"{msg} (S/N): ").strip().lower() in ("s", "sim", "y")


def main():
    clear(); print(LOGO)
    port = pick_port()
    if not port:
        return
    if not open_serial(port):
        input("Enter para sair..."); return
    log(f"Conectado em {port} @9600 8N1")

    while True:
        show_menu(port)
        op = input("Opção: ").strip()
        if op == "1":
            send_and_show("PING", "PING\r")
        elif op == "2":
            send_and_show("STATUS", "STATUS\r")
        elif op == "3":
            send_and_show("TEST_RADIOS", "TEST_RADIOS\r")
        elif op == "4":
            if confirm("RESET do ESP_A — tem certeza?"):
                send_and_show("RESET ESP_A", "RESET\r")
        elif op == "5":
            if confirm("RESET do ESP_B — tem certeza?"):
                send_and_show("RESET ESP_B", "RESET_B\r")
        elif op == "6":
            tsnn = input("TSNN (ex: 1302): ").strip()
            if not tsnn:
                continue
            print("  Ação: [1] Ligar  [2] Desligar  [3] Consultar (leitura)")
            a = input("  Escolha: ").strip()
            act = {"1": "ligar", "2": "desligar", "3": "consultar"}.get(a)
            if not act:
                print("Ação inválida.");
            else:
                if act in ("ligar", "desligar") and not confirm(f"{act.upper()} bomba TSNN {tsnn} — confirmar?"):
                    pass
                else:
                    send_and_show(f"Frame {act} TSNN {tsnn}", build_pump_frame(tsnn, act))
        elif op == "7":
            send_and_show("PARAMS", "PARAMS\r")
        elif op == "8":
            tech_mode()
        elif op == "9":
            remote_access(port)
        elif op == "0":
            break
        else:
            print("Opção inválida.")
        input("\nEnter para continuar...")

    try:
        if _ser and _ser.is_open:
            _ser.close()
    except Exception:
        pass
    print("Até logo.")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {e}")
        print(f"\nErro inesperado: {e}")
        input("Enter para sair...")
