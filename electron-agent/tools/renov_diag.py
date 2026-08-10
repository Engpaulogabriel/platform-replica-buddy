#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
RENOV Diagnóstico — GUI profissional (customtkinter) para o Repetidor/Servidor RENOV.
=====================================================================================
Funciona para REPETIDOR e SERVIDOR (detecção automática pelo PING).
Terminologia ao usuário: Controlador A/B, Endereço, Comando, Equipamento, Repetidor,
Servidor. NUNCA expõe termos internos (ESP/Arduino/firmware/I2C).

Modo Técnico [PIN online] e Acesso Remoto [código 8 díg] usam as edge functions
validate-diag-pin e diag-session. A senha de configuração NUNCA fica no binário —
vem do servidor cifrada (AES-GCM, chave derivada de PIN+machine_id) só após PIN válido.

Deps: pyserial, requests, cryptography, customtkinter
Compilar: pyinstaller --onefile --windowed --icon=renov_icon.ico --name "RENOV_Diagnostico"
          --add-data "renov_logo.png;." electron-agent/tools/renov_diag.py
"""

import os
import sys
import time
import json
import uuid
import ctypes
import hashlib
import base64
import random
import platform
import threading
import subprocess
from datetime import datetime

try:
    import customtkinter as ctk
    from tkinter import messagebox
except Exception:
    print("ERRO: customtkinter não instalado. pip install customtkinter"); raise
try:
    import serial
    from serial.tools import list_ports
except Exception:
    print("ERRO: pyserial não instalado. pip install pyserial"); raise
try:
    import requests
except Exception:
    print("ERRO: requests não instalado. pip install requests"); raise
try:
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    from cryptography.hazmat.primitives.hashes import SHA256
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except Exception:
    print("ERRO: cryptography não instalado. pip install cryptography"); raise

# ── Identidade visual ────────────────────────────────────────────────────────
VERDE      = "#16A34A"
NAVY       = "#1E4A73"
FUNDO      = "#F4F6F8"
CARD       = "#FFFFFF"
TEXTO      = "#131F2E"
VERM       = "#DC2626"
CINZA      = "#8A97A6"
APP_NAME   = "RENOV Diagnóstico"
RODAPE     = "RENOV Tecnologia Agrícola®  —  Todos os direitos reservados"
CONTATO    = "renovtecnologia.com.br  ·  @renovtecnologiaagricola  ·  gestor.renovtecnologia.com.br"

# ── Backend (URL/anon PÚBLICOS — nenhuma senha aqui) ────────────────────────
SUPABASE_URL  = os.environ.get("RENOV_SUPABASE_URL", "https://dnyukgfedredvxpzjpqz.supabase.co")
SUPABASE_ANON = os.environ.get("RENOV_SUPABASE_ANON",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRueXVrZ2ZlZHJlZHZ4cHpqcHF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2ODU1OTQsImV4cCI6MjA5MjI2MTU5NH0.OSg44w0CRVvD-f6Ts_U9DVeQkQ-4c37passKEK5X0kk")
SERIAL_TIMEOUT = 5.0
LOG_FILE = "renov_diag_log.txt"
PBKDF2_ITERS = 100_000


def ts():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def log(line):
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"[{ts()}] {line}\n")
    except Exception:
        pass

def resource_path(rel):
    """Caminho de recurso (compatível com PyInstaller --add-data)."""
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, rel)

def _wmic(query):
    """Roda 'wmic <query> /value' e retorna o 1º valor não vazio."""
    try:
        out = subprocess.check_output(f"wmic {query} /value", timeout=5, shell=True).decode(errors="ignore")
        for ln in out.splitlines():
            if "=" in ln:
                v = ln.split("=", 1)[1].strip()
                if v:
                    return v
    except Exception:
        pass
    return ""


def _hw_ids():
    host = platform.node() or "unknown"
    disk = mb = ""
    if platform.system() == "Windows":
        disk = _wmic("diskdrive get SerialNumber")
        mb = _wmic("csproduct get UUID")
    mac = f"{uuid.getnode():012x}"
    return host, disk, mb, mac


def machine_id():
    """Identificador da MÁQUINA (usado nas sessões). Estável no Windows."""
    host, disk, _mb, _mac = _hw_ids()
    return hashlib.sha256(f"{host}|{disk}".encode()).hexdigest()[:32]


def device_id():
    """Identidade ANTI-CLONE do PC: serial do HD + UUID da placa + hostname + MAC.
    Se o .exe for copiado p/ outro PC, muda → o servidor rejeita a licença."""
    host, disk, mb, mac = _hw_ids()
    return hashlib.sha256(f"{disk}|{mb}|{host}|{mac}".encode()).hexdigest()


# ── DPAPI (Windows Data Protection API) — cache local cifrado atrelado ao PC ──
def _dpapi(data: bytes, protect: bool) -> bytes:
    if platform.system() != "Windows":
        return data  # dev/fallback: sem DPAPI fora do Windows
    class BLOB(ctypes.Structure):
        _fields_ = [("cbData", ctypes.c_ulong), ("pbData", ctypes.POINTER(ctypes.c_char))]
    buf = ctypes.create_string_buffer(data, len(data))
    bin_ = BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    bout = BLOB()
    fn = ctypes.windll.crypt32.CryptProtectData if protect else ctypes.windll.crypt32.CryptUnprotectData
    if not fn(ctypes.byref(bin_), None, None, None, None, 0, ctypes.byref(bout)):
        raise OSError("DPAPI falhou")
    out = ctypes.string_at(bout.pbData, bout.cbData)
    ctypes.windll.kernel32.LocalFree(bout.pbData)
    return out


CFG_DIR = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "RENOV")
CFG_FILE = os.path.join(CFG_DIR, "diag_cfg.dat")


def load_cfg():
    try:
        with open(CFG_FILE, "rb") as f:
            return json.loads(_dpapi(f.read(), protect=False).decode())
    except Exception:
        return {}


def save_cfg(d):
    try:
        os.makedirs(CFG_DIR, exist_ok=True)
        with open(CFG_FILE, "wb") as f:
            f.write(_dpapi(json.dumps(d).encode(), protect=True))
    except Exception:
        pass


GRACE_HOURS = 24  # offline: funciona 24h com cache DPAPI; depois bloqueia


def check_license(did):
    """(allowed, status, offline). Online: valida e atualiza cache. Offline: usa
    cache DPAPI (mesmo device_id, autorizado, < 24h)."""
    try:
        _st, body = api_post("diag-license", {"action": "check", "device_id": did,
            "device_info": {"hostname": platform.node(), "os": platform.platform()}}, timeout=8)
        status = body.get("status", "unknown")
        cfg = load_cfg()
        cfg.update({"license_status": status, "checked_at": time.time(), "device_id": did})
        save_cfg(cfg)
        return (body.get("ok") is True and status == "authorized", status, False)
    except requests.exceptions.RequestException:
        cfg = load_cfg()
        if (cfg.get("device_id") == did and cfg.get("license_status") == "authorized"
                and (time.time() - cfg.get("checked_at", 0)) < GRACE_HOURS * 3600):
            return (True, "authorized_cache", True)
        return (False, "offline_sem_cache", True)


# ── Camada serial (thread-safe via lock) ─────────────────────────────────────
class SerialLink:
    def __init__(self):
        self.ser = None
        self.lock = threading.Lock()

    def open(self, port):
        try:
            self.ser = serial.Serial(port=port, baudrate=9600, bytesize=serial.EIGHTBITS,
                                     parity=serial.PARITY_NONE, stopbits=serial.STOPBITS_ONE, timeout=0.2)
            try: self.ser.reset_input_buffer(); self.ser.reset_output_buffer()
            except Exception: pass
            return True, None
        except Exception as e:
            return False, str(e)

    def close(self):
        try:
            if self.ser and self.ser.is_open:
                self.ser.close()
        except Exception:
            pass
        self.ser = None

    @property
    def connected(self):
        return self.ser is not None and self.ser.is_open

    def cmd(self, frame, timeout=SERIAL_TIMEOUT):
        if not self.connected:
            return "(sem conexão)"
        with self.lock:
            try:
                data = frame.encode("ascii", errors="ignore") if isinstance(frame, str) else frame
                self.ser.reset_input_buffer()
                self.ser.write(data); self.ser.flush()
                log(f"TX: {frame!r}")
                buf = bytearray(); deadline = time.time() + timeout
                while time.time() < deadline:
                    chunk = self.ser.read(256)
                    if chunk:
                        buf.extend(chunk); deadline = time.time() + 0.4
                    elif buf:
                        break
                    else:
                        time.sleep(0.02)
                resp = bytes(buf).decode("ascii", errors="replace").strip()
                log(f"RX: {resp!r}")
                return resp if resp else "(sem resposta em %.0fs)" % timeout
            except Exception as e:
                log(f"ERR serial: {e}")
                return f"(erro: {e})"


# ── Backend helpers ──────────────────────────────────────────────────────────
def _headers():
    return {"apikey": SUPABASE_ANON, "Authorization": f"Bearer {SUPABASE_ANON}", "Content-Type": "application/json"}

def api_post(path, payload, timeout=10):
    r = requests.post(f"{SUPABASE_URL}/functions/v1/{path}", json=payload, headers=_headers(), timeout=timeout)
    try: return r.status_code, r.json()
    except Exception: return r.status_code, {"raw": r.text[:300]}

def derive_key(pin, mid):
    return PBKDF2HMAC(algorithm=SHA256(), length=32, salt=mid.encode(), iterations=PBKDF2_ITERS).derive(pin.encode())

def decrypt_password_bytes(enc_b64, pin, mid):
    """Decifra a senha CFG em um bytearray MUTÁVEL (para poder zerar após o uso).
    A senha nunca vira str literal persistente."""
    raw = base64.b64decode(enc_b64)
    return bytearray(AESGCM(derive_key(pin, mid)).decrypt(raw[:12], raw[12:], None))

def build_frame(addr, saida, bit):
    # monta em BYTES (não deixa a frame como literal string concatenada em memória)
    return bytes(f"[{addr}_{saida}_]{{{bit}}}[{addr}_ETX_]\r", "ascii")


# ── App ──────────────────────────────────────────────────────────────────────
ctk.set_appearance_mode("light")

class RenovDiag(ctk.CTk):
    def __init__(self):
        super().__init__()
        self.title(APP_NAME)
        self.geometry("880x620")
        self.minsize(760, 560)
        self.configure(fg_color=FUNDO)
        try:
            ico = resource_path("renov_icon.ico")
            if os.path.exists(ico):
                self.iconbitmap(ico)
        except Exception:
            pass

        self.link = SerialLink()
        self.mid = machine_id()
        self.device_kind = None      # "repetidor" | "servidor" | None
        self.device_ver = ""
        self.tech_until = 0.0
        self.remote_stop = threading.Event()
        self.remote_thread = None
        self.remote_code = None

        self._build_sidebar()
        self._build_main()
        self.show_screen("conexao")
        self.protocol("WM_DELETE_WINDOW", self._on_close)

    # ── Sidebar ──
    def _build_sidebar(self):
        self.sidebar = ctk.CTkFrame(self, width=210, corner_radius=0, fg_color=NAVY)
        self.sidebar.pack(side="left", fill="y")
        self.sidebar.pack_propagate(False)

        # Logo (usa PNG embutido se existir; senão, texto estilizado)
        logo_shown = False
        try:
            png = resource_path("renov_logo.png")
            if os.path.exists(png):
                from tkinter import PhotoImage
                self._logo_img = ctk.CTkImage(light_image=__import__("PIL.Image", fromlist=["Image"]).open(png), size=(150, 46))
                ctk.CTkLabel(self.sidebar, image=self._logo_img, text="").pack(pady=(22, 6))
                logo_shown = True
        except Exception:
            logo_shown = False
        if not logo_shown:
            ctk.CTkLabel(self.sidebar, text="RENOV", font=ctk.CTkFont("Inter", 26, "bold"), text_color=VERDE).pack(pady=(24, 0))
            ctk.CTkLabel(self.sidebar, text="Tecnologia Agrícola", font=ctk.CTkFont("Inter", 11), text_color="#CFE8D6").pack(pady=(0, 8))
        ctk.CTkLabel(self.sidebar, text="Diagnóstico", font=ctk.CTkFont("Inter", 13, "bold"), text_color="#FFFFFF").pack(pady=(0, 14))

        self.nav_buttons = {}
        for key, label in [("conexao", "Conexão"), ("status", "Status"), ("diag", "Diagnóstico"),
                           ("comandos", "Comandos"), ("manut", "Manutenção"),
                           ("tecnico", "Modo Técnico"), ("remoto", "Acesso Remoto")]:
            b = ctk.CTkButton(self.sidebar, text=label, corner_radius=8, height=38,
                              fg_color="transparent", hover_color="#2A5C8A", anchor="w",
                              font=ctk.CTkFont("Inter", 13),
                              command=lambda k=key: self.show_screen(k))
            b.pack(fill="x", padx=12, pady=3)
            self.nav_buttons[key] = b

        # status conexão (rodapé da sidebar)
        self.conn_frame = ctk.CTkFrame(self.sidebar, fg_color="transparent")
        self.conn_frame.pack(side="bottom", fill="x", pady=14, padx=12)
        self.conn_dot = ctk.CTkLabel(self.conn_frame, text="●", text_color=VERM, font=ctk.CTkFont(size=16))
        self.conn_dot.pack(side="left")
        self.conn_lbl = ctk.CTkLabel(self.conn_frame, text="Desconectado", text_color="#DCE6F0", font=ctk.CTkFont("Inter", 12))
        self.conn_lbl.pack(side="left", padx=6)

    def _build_main(self):
        self.wrap = ctk.CTkFrame(self, fg_color=FUNDO, corner_radius=0)
        self.wrap.pack(side="left", fill="both", expand=True)
        self.content = ctk.CTkFrame(self.wrap, fg_color=FUNDO, corner_radius=0)
        self.content.pack(fill="both", expand=True, padx=18, pady=(16, 4))
        # rodapé
        foot = ctk.CTkFrame(self.wrap, fg_color=FUNDO, corner_radius=0)
        foot.pack(side="bottom", fill="x", padx=18, pady=(0, 8))
        ctk.CTkLabel(foot, text=RODAPE, font=ctk.CTkFont("Inter", 10), text_color=CINZA).pack()
        ctk.CTkLabel(foot, text=CONTATO, font=ctk.CTkFont("Inter", 9), text_color=CINZA).pack()

    def _clear(self):
        for w in self.content.winfo_children():
            w.destroy()

    def _title(self, txt):
        ctk.CTkLabel(self.content, text=txt, font=ctk.CTkFont("Inter", 20, "bold"), text_color=TEXTO).pack(anchor="w", pady=(0, 12))

    def _card(self):
        c = ctk.CTkFrame(self.content, fg_color=CARD, corner_radius=12)
        c.pack(fill="x", pady=6); return c

    def _out_box(self, height=220):
        box = ctk.CTkTextbox(self.content, height=height, fg_color="#0B1220", text_color="#DCEAF5",
                             font=ctk.CTkFont("Consolas", 12), corner_radius=10)
        box.pack(fill="both", expand=True, pady=(8, 0))
        return box

    def _log_out(self, box, kind, text):
        tag = {"tx": "TX ", "rx": "RX ", "info": ".. ", "err": "!! "}.get(kind, "   ")
        box.insert("0.0", f"[{datetime.now().strftime('%H:%M:%S')}] {tag}{text}\n")

    # ── navegação ──
    def show_screen(self, key):
        for k, b in self.nav_buttons.items():
            b.configure(fg_color=VERDE if k == key else "transparent")
        self._clear()
        {"conexao": self.scr_conexao, "status": self.scr_status, "diag": self.scr_diag,
         "comandos": self.scr_comandos, "manut": self.scr_manut,
         "tecnico": self.scr_tecnico, "remoto": self.scr_remoto}[key]()

    # ── helper de execução em thread ──
    def run_async(self, fn, on_done=None):
        def worker():
            try: res = fn()
            except Exception as e: res = f"(erro: {e})"
            if on_done: self.after(0, lambda: on_done(res))
        threading.Thread(target=worker, daemon=True).start()

    def _set_conn(self):
        if self.link.connected:
            kind = {"repetidor": "Repetidor", "servidor": "Servidor"}.get(self.device_kind, "Dispositivo")
            self.conn_dot.configure(text_color=VERDE)
            self.conn_lbl.configure(text=f"{kind} · {self.port}")
        else:
            self.conn_dot.configure(text_color=VERM)
            self.conn_lbl.configure(text="Desconectado")

    # ═══ TELAS ══════════════════════════════════════════════════════════════
    def scr_conexao(self):
        self._title("Conexão")
        card = self._card()
        ctk.CTkLabel(card, text="Selecione a porta e conecte ao dispositivo.",
                     font=ctk.CTkFont("Inter", 13), text_color=TEXTO).pack(anchor="w", padx=16, pady=(14, 6))
        row = ctk.CTkFrame(card, fg_color="transparent"); row.pack(fill="x", padx=16, pady=(0, 14))
        # portas com nome amigável: "COM1 — USB-SERIAL CH340"
        self.port_map = {}
        displays = []
        for p in list_ports.comports():
            desc = (p.description or "").strip()
            d = f"{p.device} — {desc}" if desc and desc.lower() != "n/a" else p.device
            self.port_map[d] = p.device
            displays.append(d)
        if not displays:
            displays = ["(nenhuma porta)"]
        self.port_menu = ctk.CTkOptionMenu(row, values=displays, fg_color=NAVY, button_color=NAVY,
                                           font=ctk.CTkFont("Inter", 13), width=300)
        last = load_cfg().get("last_com")
        if last:
            for d, dev in self.port_map.items():
                if dev == last:
                    self.port_menu.set(d); break
        self.port_menu.pack(side="left")
        ctk.CTkButton(row, text="Atualizar lista", width=110, fg_color=CINZA, hover_color="#6B7785",
                      command=self.scr_conexao).pack(side="left", padx=8)
        ctk.CTkButton(row, text="Conectar", width=120, fg_color=VERDE, hover_color="#12833B",
                      command=self._do_connect).pack(side="left", padx=8)
        ctk.CTkLabel(card, text="Baudrate 9600 · 8N1 (fixo)", font=ctk.CTkFont("Inter", 11),
                     text_color=CINZA).pack(anchor="w", padx=16, pady=(0, 12))
        self.conn_info = ctk.CTkLabel(self.content, text="", font=ctk.CTkFont("Inter", 13), text_color=TEXTO)
        self.conn_info.pack(anchor="w", pady=8)

    def _do_connect(self):
        disp = self.port_menu.get()
        port = self.port_map.get(disp, disp)
        if not port or port.startswith("("):
            messagebox.showwarning(APP_NAME, "Nenhuma porta selecionada."); return
        self.link.close()
        ok, err = self.link.open(port)
        if not ok:
            messagebox.showerror(APP_NAME, f"Porta {port} não disponível — verifique o cabo.\n\nDetalhe: {err}")
            return
        self.port = port
        cfg = load_cfg(); cfg["last_com"] = port; save_cfg(cfg)  # lembra a última COM usada
        self.conn_info.configure(text=f"Conectado em {port}. Identificando dispositivo...")
        self._set_conn()
        def ping():
            return self.link.cmd("PING\r")
        def done(resp):
            self._detect_device(resp)
            self.conn_info.configure(text=self._device_label() + f"\nResposta: {resp}")
            self._set_conn()
            self.show_screen("status")
        self.run_async(ping, done)

    def _detect_device(self, ping_resp):
        r = (ping_resp or "").upper()
        if "REP_A" in r or "REP:" in r or "REPETIDOR" in r:
            self.device_kind = "repetidor"
        elif "ESP_A" in r or "SERV" in r or "OK:ESP" in r:
            self.device_kind = "servidor"
        else:
            self.device_kind = None
        # versão (…:vX.Y)
        self.device_ver = ""
        for tok in r.replace("]", ":").split(":"):
            t = tok.strip().lower()
            if t.startswith("v") and any(c.isdigit() for c in t):
                self.device_ver = tok.strip(); break

    def _device_label(self):
        k = {"repetidor": "Repetidor", "servidor": "Servidor"}.get(self.device_kind, "Dispositivo (não identificado)")
        return f"Dispositivo: {k}" + (f"  ·  {self.device_ver}" if self.device_ver else "")

    def _require_conn(self):
        if not self.link.connected:
            messagebox.showinfo(APP_NAME, "Conecte-se a um dispositivo primeiro (tela Conexão).")
            self.show_screen("conexao"); return False
        return True

    def scr_status(self):
        self._title("Status")
        if not self.link.connected:
            self._card(); self.conn_hint = ctk.CTkLabel(self.content, text="Não conectado.", text_color=CINZA); self.conn_hint.pack(); return
        ctk.CTkLabel(self.content, text=self._device_label(), font=ctk.CTkFont("Inter", 13, "bold"), text_color=NAVY).pack(anchor="w")
        cards = ctk.CTkFrame(self.content, fg_color="transparent"); cards.pack(fill="x", pady=10)
        self.status_cards = {}
        for i, (k, title) in enumerate([("ctrlA", "Controlador A"), ("ctrlB", "Controlador B"),
                                        ("mem", "Memória"), ("uptime", "Tempo ligado"), ("reset", "Último reinício")]):
            c = ctk.CTkFrame(cards, fg_color=CARD, corner_radius=12, width=150, height=76)
            c.grid(row=i // 3, column=i % 3, padx=6, pady=6, sticky="w"); c.pack_propagate(False)
            ctk.CTkLabel(c, text=title, font=ctk.CTkFont("Inter", 11), text_color=CINZA).pack(anchor="w", padx=12, pady=(10, 0))
            v = ctk.CTkLabel(c, text="—", font=ctk.CTkFont("Inter", 15, "bold"), text_color=TEXTO)
            v.pack(anchor="w", padx=12); self.status_cards[k] = v
        ctk.CTkButton(self.content, text="Atualizar status", fg_color=VERDE, hover_color="#12833B",
                      command=self._load_status).pack(anchor="w", pady=6)
        self.status_raw = self._out_box(140)
        self._load_status()

    def _load_status(self):
        if not self._require_conn(): return
        self.run_async(lambda: self.link.cmd("STATUS\r"), self._render_status)

    def _render_status(self, resp):
        self.status_raw.delete("1.0", "end"); self._log_out(self.status_raw, "rx", resp)
        up = resp.upper()
        def ok(marker_ok, marker_fail):
            if marker_ok in up: return "OK", VERDE
            if marker_fail in up: return "FALHA", VERM
            return "—", CINZA
        for k, (mok, mfail) in {"ctrlA": ("A:OK", "A:FALHA"), "ctrlB": ("B:OK", "B:FALHA")}.items():
            txt, col = ok(mok, mfail)
            self.status_cards[k].configure(text=txt, text_color=col)
        import re
        def grab(*keys):
            for key in keys:
                m = re.search(key + r"[:=]\s*([^\s;,\]]+)", resp, re.I)
                if m: return m.group(1)
            return "—"
        self.status_cards["mem"].configure(text=grab("MEM", "MEMORIA", "RAM"))
        self.status_cards["uptime"].configure(text=grab("UPTIME", "UP"))
        self.status_cards["reset"].configure(text=grab("RESET", "LAST_RESET"))

    def scr_diag(self):
        self._title("Diagnóstico")
        card = self._card(); row = ctk.CTkFrame(card, fg_color="transparent"); row.pack(fill="x", padx=14, pady=14)
        out = self._out_box(300)
        def run(frame, label):
            if not self._require_conn(): return
            self._log_out(out, "tx", label)
            self.run_async(lambda: self.link.cmd(frame), lambda r: self._log_out(out, "rx", r))
        ctk.CTkButton(row, text="PING", width=110, fg_color=NAVY, command=lambda: run("PING\r", "PING")).pack(side="left", padx=4)
        ctk.CTkButton(row, text="Status Completo", width=140, fg_color=NAVY, command=lambda: run("STATUS\r", "STATUS")).pack(side="left", padx=4)
        rep = self.device_kind == "repetidor"
        ctk.CTkButton(row, text="Testar Rádios", width=120, fg_color=VERDE if rep else CINZA,
                      state=("normal" if rep else "disabled"),
                      command=lambda: run("TEST_RADIOS\r", "Testar Rádios")).pack(side="left", padx=4)
        ctk.CTkButton(row, text="Ver Parâmetros", width=130, fg_color=VERDE if rep else CINZA,
                      state=("normal" if rep else "disabled"),
                      command=lambda: run("PARAMS\r", "Parâmetros")).pack(side="left", padx=4)
        if not rep:
            ctk.CTkLabel(self.content, text="Testar Rádios e Parâmetros são exclusivos do Repetidor.",
                         font=ctk.CTkFont("Inter", 11), text_color=CINZA).pack(anchor="w", pady=(6, 0))

    def scr_comandos(self):
        self._title("Comandos — Equipamento")
        card = self._card(); row = ctk.CTkFrame(card, fg_color="transparent"); row.pack(fill="x", padx=14, pady=14)
        ctk.CTkLabel(row, text="Endereço", font=ctk.CTkFont("Inter", 12), text_color=TEXTO).pack(side="left")
        self.addr_e = ctk.CTkEntry(row, width=90, placeholder_text="1302"); self.addr_e.pack(side="left", padx=(6, 12))
        ctk.CTkLabel(row, text="Saída", font=ctk.CTkFont("Inter", 12), text_color=TEXTO).pack(side="left")
        self.saida_e = ctk.CTkEntry(row, width=50); self.saida_e.insert(0, "1"); self.saida_e.pack(side="left", padx=(6, 12))
        out = self._out_box(280)
        def send(bit, label):
            if not self._require_conn(): return
            addr = self.addr_e.get().strip(); saida = (self.saida_e.get().strip() or "1")
            if not (addr.isdigit() and len(addr) == 4):
                messagebox.showwarning(APP_NAME, "Endereço deve ter 4 dígitos."); return
            if label != "Consultar" and not messagebox.askyesno(APP_NAME, f"{label} equipamento {addr} (saída {saida})?"):
                return
            frame = build_frame(addr, saida, bit)  # bytes
            self._log_out(out, "tx", f"{label}: {frame.decode('ascii', 'replace').strip()}")
            self.run_async(lambda: self.link.cmd(frame), lambda r: self._log_out(out, "rx", r))
        ctk.CTkButton(row, text="Ligar", width=90, fg_color=VERDE, hover_color="#12833B",
                      command=lambda: send("1", "Ligar")).pack(side="left", padx=4)
        ctk.CTkButton(row, text="Desligar", width=90, fg_color=VERM, hover_color="#B91C1C",
                      command=lambda: send("0", "Desligar")).pack(side="left", padx=4)
        ctk.CTkButton(row, text="Consultar", width=100, fg_color=NAVY,
                      command=lambda: send("0", "Consultar")).pack(side="left", padx=4)

    def scr_manut(self):
        self._title("Manutenção")
        card = self._card(); box = ctk.CTkFrame(card, fg_color="transparent"); box.pack(fill="x", padx=16, pady=16)
        out = self._out_box(220)
        def reset(frame, nome):
            if not self._require_conn(): return
            if not messagebox.askyesno(APP_NAME, f"Reiniciar {nome}?\nO controlador ficará indisponível por alguns segundos."):
                return
            self._log_out(out, "tx", f"Reiniciar {nome}")
            self.run_async(lambda: self.link.cmd(frame), lambda r: self._log_out(out, "rx", r))
        ctk.CTkButton(box, text="Reiniciar Controlador A", width=220, height=40, fg_color=NAVY,
                      command=lambda: reset("RESET\r", "Controlador A")).pack(anchor="w", pady=6)
        ctk.CTkButton(box, text="Reiniciar Controlador B", width=220, height=40, fg_color=NAVY,
                      command=lambda: reset("RESET_B\r", "Controlador B")).pack(anchor="w", pady=6)

    def scr_tecnico(self):
        self._title("Modo Técnico")
        card = self._card()
        active = time.time() < self.tech_until
        if not active:
            ctk.CTkLabel(card, text="Informe o PIN de 6 dígitos (gerado na plataforma) para liberar a configuração avançada.",
                         font=ctk.CTkFont("Inter", 12), text_color=TEXTO, wraplength=520, justify="left").pack(anchor="w", padx=16, pady=(14, 6))
            row = ctk.CTkFrame(card, fg_color="transparent"); row.pack(fill="x", padx=16, pady=(0, 14))
            self.pin_e = ctk.CTkEntry(row, width=140, placeholder_text="000000"); self.pin_e.pack(side="left")
            ctk.CTkButton(row, text="Validar PIN", fg_color=VERDE, hover_color="#12833B",
                          command=self._validate_pin).pack(side="left", padx=8)
            return
        mins = int((self.tech_until - time.time()) / 60)
        ctk.CTkLabel(card, text=f"✅ Modo técnico ATIVO ({mins} min restantes).",
                     font=ctk.CTkFont("Inter", 13, "bold"), text_color=VERDE).pack(anchor="w", padx=16, pady=12)
        row = ctk.CTkFrame(self.content, fg_color="transparent"); row.pack(fill="x", pady=6)
        self.cfg_e = ctk.CTkEntry(row, placeholder_text="Comando avançado (ex: HELP, LIST:R1, DUMP, SET_S:3, SAVE)")
        self.cfg_e.pack(side="left", fill="x", expand=True)
        self.cfg_out = None
        out = self._out_box(260); self.cfg_out = out
        def send_cfg():
            c = self.cfg_e.get().strip()
            if not c: return
            frame = c if c.upper().startswith("CFG:") else f"CFG:{c}"
            self._log_out(out, "tx", c)
            self.run_async(lambda: self.link.cmd(frame + "\r"), lambda r: self._log_out(out, "rx", r))
            self.cfg_e.delete(0, "end")
        self.cfg_e.bind("<Return>", lambda e: send_cfg())
        ctk.CTkButton(row, text="Enviar", fg_color=NAVY, command=send_cfg).pack(side="left", padx=8)

    def _validate_pin(self):
        if not self._require_conn(): return
        pin = self.pin_e.get().strip()
        if not (pin.isdigit() and len(pin) == 6):
            messagebox.showwarning(APP_NAME, "PIN inválido (6 dígitos)."); return
        def work():
            try:
                st, body = api_post("validate-diag-pin", {"pin": pin, "machine_id": self.mid})
            except requests.exceptions.RequestException:
                return ("neterr", None)
            if st != 200 or not body.get("ok"):
                return ("bad", body.get("reason", "PIN rejeitado"))
            try:
                senha = decrypt_password_bytes(body["encrypted_password"], pin, self.mid)  # bytearray volátil
            except Exception as e:
                return ("dec", str(e))
            # monta a frame de login em bytes, envia, e ZERA a senha imediatamente.
            frame = bytearray(b"CFG:LOGIN:"); frame.extend(senha); frame.extend(b"\r")
            self.link.cmd(bytes(frame))
            for i in range(len(senha)): senha[i] = 0
            for i in range(len(frame)): frame[i] = 0
            del senha, frame
            return ("ok", int(body.get("expires_in", 600)))
        def done(res):
            kind, val = res
            if kind == "neterr": messagebox.showerror(APP_NAME, "Modo técnico indisponível sem internet.")
            elif kind == "bad": messagebox.showerror(APP_NAME, f"PIN rejeitado: {val}")
            elif kind == "dec": messagebox.showerror(APP_NAME, f"Falha ao liberar acesso: {val}")
            else:
                self.tech_until = time.time() + int(val)
                messagebox.showinfo(APP_NAME, "Modo técnico ativado.")
                self.show_screen("tecnico")
        self.run_async(work, done)

    def scr_remoto(self):
        self._title("Acesso Remoto")
        card = self._card()
        if not self.remote_code:
            ctk.CTkLabel(card, text="Gere um código e passe ao técnico RENOV. Ele controla este dispositivo pela plataforma, em tempo real, sem acesso remoto ao computador.",
                         font=ctk.CTkFont("Inter", 12), text_color=TEXTO, wraplength=540, justify="left").pack(anchor="w", padx=16, pady=(14, 8))
            ctk.CTkButton(card, text="Iniciar Acesso Remoto", fg_color=VERDE, hover_color="#12833B",
                          height=42, command=self._start_remote).pack(anchor="w", padx=16, pady=(0, 14))
        else:
            ctk.CTkLabel(card, text="🔗 ACESSO REMOTO ATIVO", font=ctk.CTkFont("Inter", 15, "bold"), text_color=VERDE).pack(anchor="w", padx=16, pady=(14, 2))
            ctk.CTkLabel(card, text="Código:", font=ctk.CTkFont("Inter", 12), text_color=CINZA).pack(anchor="w", padx=16)
            ctk.CTkLabel(card, text=self.remote_code, font=ctk.CTkFont("Consolas", 34, "bold"), text_color=NAVY).pack(anchor="w", padx=16)
            ctk.CTkLabel(card, text="Aguardando comandos do técnico...", font=ctk.CTkFont("Inter", 12), text_color=TEXTO).pack(anchor="w", padx=16, pady=(4, 12))
            ctk.CTkButton(card, text="Encerrar Acesso Remoto", fg_color=VERM, hover_color="#B91C1C",
                          command=self._stop_remote).pack(anchor="w", padx=16, pady=(0, 14))
            self.remote_out = self._out_box(240)

    def _start_remote(self):
        if not self._require_conn(): return
        code = f"{random.randint(0, 99999999):08d}"
        try:
            st, body = api_post("diag-session", {"action": "create", "code": code, "machine_id": self.mid, "com_port": self.port})
        except requests.exceptions.RequestException:
            messagebox.showerror(APP_NAME, "Sem internet — acesso remoto indisponível."); return
        if st != 200 or not body.get("ok"):
            messagebox.showerror(APP_NAME, f"Falha ao iniciar sessão: {body}"); return
        self.remote_code = code
        self.remote_stop.clear()
        self.remote_thread = threading.Thread(target=self._remote_loop, args=(code,), daemon=True)
        self.remote_thread.start()
        log(f"REMOTE {code} started on {self.port}")
        self.show_screen("remoto")

    def _stop_remote(self):
        self.remote_stop.set()
        code = self.remote_code
        self.remote_code = None
        if code:
            try: api_post("diag-session", {"action": "close", "code": code, "machine_id": self.mid})
            except Exception: pass
            log(f"REMOTE {code} closed")
        self.show_screen("remoto")

    def _remote_loop(self, code):
        while not self.remote_stop.is_set():
            try:
                st, body = api_post("diag-session", {"action": "poll", "code": code, "machine_id": self.mid}, timeout=8)
            except requests.exceptions.RequestException:
                time.sleep(2); continue
            if st != 200 or not body.get("ok"):
                if body.get("reason") in ("expired", "closed"):
                    self.after(0, lambda: self._remote_ended("Sessão encerrada/expirada.")); return
                time.sleep(2); continue
            for cmd in (body.get("commands") or []):
                frame = cmd.get("command", "")
                if not frame.endswith("\r"): frame += "\r"
                self.after(0, lambda f=frame: self._remote_log("tx", f.strip()))
                resp = self.link.cmd(frame)
                self.after(0, lambda r=resp: self._remote_log("rx", r))
                try:
                    api_post("diag-session", {"action": "respond", "code": code, "machine_id": self.mid,
                                              "command_id": cmd.get("id"), "response": resp})
                except requests.exceptions.RequestException:
                    pass
            time.sleep(2)

    def _remote_log(self, kind, text):
        if self.remote_code and hasattr(self, "remote_out"):
            try: self._log_out(self.remote_out, kind, text)
            except Exception: pass

    def _remote_ended(self, msg):
        self.remote_code = None
        messagebox.showinfo(APP_NAME, msg)
        self.show_screen("remoto")

    def _on_close(self):
        try: self._stop_remote()
        except Exception: pass
        self.link.close()
        self.destroy()


def show_block_window(did, status, offline):
    """Janela de ativação/bloqueio quando a licença não está autorizada. 'Tentar
    novamente' revalida; se autorizar, abre o app."""
    result = {"open": False}
    win = ctk.CTk()
    win.title(APP_NAME + " — Ativação")
    win.geometry("580x460"); win.configure(fg_color=FUNDO)
    ctk.CTkLabel(win, text="RENOV Diagnóstico", font=ctk.CTkFont("Inter", 22, "bold"), text_color=VERDE).pack(pady=(24, 2))
    ctk.CTkLabel(win, text="Ativação necessária", font=ctk.CTkFont("Inter", 13), text_color=NAVY).pack()
    msgs = {
        "pending": "Este computador ainda NÃO foi autorizado.\nPeça a liberação ao administrador RENOV (aba 'Licenças de Diagnóstico').",
        "revoked": "A licença deste computador foi REVOGADA.\nContate o administrador RENOV.",
        "offline_sem_cache": "Sem internet e sem licença válida no cache.\nConecte à internet para ativar (a 1ª ativação exige internet).",
        "unknown": "Não foi possível validar a licença.\nTente novamente.",
    }
    ctk.CTkLabel(win, text=msgs.get(status, "Licença não autorizada."), font=ctk.CTkFont("Inter", 12),
                 text_color=TEXTO, wraplength=520, justify="center").pack(pady=(14, 8), padx=20)
    ctk.CTkLabel(win, text="Código deste computador:", font=ctk.CTkFont("Inter", 11), text_color=CINZA).pack()
    idbox = ctk.CTkTextbox(win, height=48, width=520, font=ctk.CTkFont("Consolas", 11))
    idbox.insert("0.0", did); idbox.configure(state="normal"); idbox.pack(pady=(2, 10))
    st_lbl = ctk.CTkLabel(win, text=f"Status: {status}" + (" (offline)" if offline else ""),
                          font=ctk.CTkFont("Inter", 12, "bold"), text_color=(VERM if status == "revoked" else NAVY))
    st_lbl.pack(pady=(0, 8))

    def retry():
        a, s, off = check_license(did)
        if a:
            result["open"] = True; win.destroy()
        else:
            st_lbl.configure(text=f"Status: {s}" + (" (offline)" if off else ""))
            messagebox.showinfo(APP_NAME, "Ainda não autorizado. Peça a liberação ao administrador." if s == "pending" else f"Status: {s}")

    bar = ctk.CTkFrame(win, fg_color="transparent"); bar.pack(pady=6)
    ctk.CTkButton(bar, text="Tentar novamente", fg_color=VERDE, hover_color="#12833B", command=retry).pack(side="left", padx=6)
    ctk.CTkButton(bar, text="Sair", fg_color=CINZA, hover_color="#6B7785", command=win.destroy).pack(side="left", padx=6)
    ctk.CTkLabel(win, text=RODAPE, font=ctk.CTkFont("Inter", 9), text_color=CINZA).pack(side="bottom", pady=8)
    win.mainloop()
    return result["open"]


def main():
    # ── Gate de licença ANTI-CLONE: valida o device_id online (24h de graça offline).
    did = device_id()
    allowed, status, offline = check_license(did)
    log(f"license check: allowed={allowed} status={status} offline={offline} dev={did[:12]}")
    if not allowed:
        if show_block_window(did, status, offline):
            RenovDiag().mainloop()
        return
    RenovDiag().mainloop()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {e}")
        try:
            from tkinter import messagebox as mb
            mb.showerror("RENOV Diagnóstico", f"Erro inesperado: {e}")
        except Exception:
            print(f"Erro: {e}")
