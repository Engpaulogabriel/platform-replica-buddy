#!/usr/bin/env python3
"""
RENOV Serial Bridge v7 — serial_bridge_persistent.py
=====================================================
Abordagem PRAGMATICA para PL2303GS:
  - Usa pyserial para abrir/configurar (simples e testado)
  - Apos abrir, acessa o handle Win32 DIRETAMENTE para:
    1. Ler o DCB e logar fBitFields
    2. Forcar fAbortOnError=0 via SetCommState
    3. Chamar ClearCommError antes de cada read
  - Se read parar de funcionar, FECHA e REABRE a porta (workaround PL2303)
  - Toda a serial (read+write) na MAIN thread
  - Thread separada APENAS para stdin

Protocolo stdout: READY, RX:<frame>, TX_OK, TX_ERR:<msg>, ERROR:<msg>
Protocolo stdin:  SEND:<frame>, QUIT
"""

import sys
import os
import time
import threading
import queue
import platform

if platform.system() != "Windows":
    print("ERROR:Este bridge so funciona no Windows", flush=True)
    sys.exit(1)

import ctypes
import ctypes.wintypes
import serial  # pyserial

kernel32 = ctypes.windll.kernel32

# DCB bit masks
DCB_fAbortOnError = 0x4000  # bit 14
DCB_fOutX         = 0x0100  # bit 8
DCB_fInX          = 0x0200  # bit 9

class DCB(ctypes.Structure):
    _fields_ = [
        ("DCBlength",    ctypes.wintypes.DWORD),
        ("BaudRate",     ctypes.wintypes.DWORD),
        ("fBitFields",   ctypes.wintypes.DWORD),
        ("wReserved",    ctypes.wintypes.WORD),
        ("XonLim",       ctypes.wintypes.WORD),
        ("XoffLim",      ctypes.wintypes.WORD),
        ("ByteSize",     ctypes.wintypes.BYTE),
        ("Parity",       ctypes.wintypes.BYTE),
        ("StopBits",     ctypes.wintypes.BYTE),
        ("XonChar",      ctypes.c_char),
        ("XoffChar",     ctypes.c_char),
        ("ErrorChar",    ctypes.c_char),
        ("EofChar",      ctypes.c_char),
        ("EvtChar",      ctypes.c_char),
        ("wReserved1",   ctypes.wintypes.WORD),
    ]

class COMSTAT(ctypes.Structure):
    _fields_ = [
        ("fBitFields", ctypes.wintypes.DWORD),
        ("cbInQue",    ctypes.wintypes.DWORD),
        ("cbOutQue",   ctypes.wintypes.DWORD),
    ]


stdin_queue = queue.Queue()


def stdin_reader_thread():
    buf = bytearray()
    try:
        while True:
            chunk = sys.stdin.buffer.read(1)
            if not chunk:
                stdin_queue.put(None)
                break
            b = chunk[0]
            if b == 0x0A:
                line = buf.decode("utf-8", errors="replace")
                buf.clear()
                if line:
                    stdin_queue.put(line)
            elif b == 0x0D:
                pass
            else:
                buf.append(b)
    except Exception:
        stdin_queue.put(None)


def log(msg):
    sys.stderr.write(f"{msg}\n")
    sys.stderr.flush()


def out(msg):
    sys.stdout.write(f"{msg}\n")
    sys.stdout.flush()


def get_win32_handle(ser):
    """Extrai o handle Win32 do objeto pyserial."""
    # pyserial armazena em ser._port_handle (Windows) ou ser.fd (Linux)
    if hasattr(ser, '_port_handle'):
        return ser._port_handle
    # Alternativa: usar msvcrt para converter fileno
    import msvcrt
    return msvcrt.get_osfhandle(ser.fileno())


def fix_pl2303_dcb(handle):
    """Le o DCB, loga, e forca fAbortOnError=0."""
    dcb = DCB()
    dcb.DCBlength = ctypes.sizeof(DCB)

    if not kernel32.GetCommState(handle, ctypes.byref(dcb)):
        log(f"[PY] GetCommState FALHOU: err={kernel32.GetLastError()}")
        return False

    old = dcb.fBitFields
    log(f"[PY] DCB fBitFields ANTES = 0x{old:04X}")
    log(f"[PY]   fAbortOnError = {1 if old & DCB_fAbortOnError else 0}")
    log(f"[PY]   fOutX = {1 if old & DCB_fOutX else 0}")
    log(f"[PY]   fInX = {1 if old & DCB_fInX else 0}")

    # Limpar bits perigosos
    dcb.fBitFields &= ~DCB_fAbortOnError
    dcb.fBitFields &= ~DCB_fOutX
    dcb.fBitFields &= ~DCB_fInX

    log(f"[PY] DCB fBitFields DEPOIS = 0x{dcb.fBitFields:04X}")

    if not kernel32.SetCommState(handle, ctypes.byref(dcb)):
        log(f"[PY] SetCommState FALHOU: err={kernel32.GetLastError()}")
        return False

    # Verificar
    dcb2 = DCB()
    dcb2.DCBlength = ctypes.sizeof(DCB)
    kernel32.GetCommState(handle, ctypes.byref(dcb2))
    log(f"[PY] DCB fBitFields VERIFICADO = 0x{dcb2.fBitFields:04X}")

    return True


def clear_comm_error(handle):
    """ClearCommError — retorna (errors, bytes_in_queue)."""
    errors = ctypes.wintypes.DWORD()
    comstat = COMSTAT()
    kernel32.ClearCommError(handle, ctypes.byref(errors), ctypes.byref(comstat))
    return errors.value, comstat.cbInQue


# PurgeComm flags
PURGE_TXABORT = 0x0001
PURGE_RXABORT = 0x0002
PURGE_TXCLEAR = 0x0004
PURGE_RXCLEAR = 0x0008


def purge_comm(handle, flags=PURGE_TXCLEAR | PURGE_RXCLEAR):
    """PurgeComm — limpa buffers TX/RX do driver."""
    try:
        kernel32.PurgeComm(handle, flags)
    except Exception:
        pass


def safe_write(ser, port_path, tx_bytes, max_retries=2):
    """
    Escreve no serial com tratamento robusto do bug PL2303 PermissionError(13).
    Em caso de erro, faz ClearCommError + PurgeComm e tenta novamente.
    Se ainda falhar, reabre a porta.
    Retorna (success, new_ser, error_msg).
    """
    last_err = None
    for attempt in range(max_retries + 1):
        try:
            # Resetar estado do driver ANTES do write
            try:
                handle = get_win32_handle(ser)
                errs, _ = clear_comm_error(handle)
                if errs:
                    log(f"[PY TX] ClearCommError pre-write: 0x{errs:04X}")
                purge_comm(handle, PURGE_TXCLEAR)
            except Exception:
                pass

            ser.write(tx_bytes)
            ser.flush()
            return True, ser, None
        except Exception as e:
            last_err = str(e)
            log(f"[PY TX] tentativa {attempt + 1} falhou: {last_err}")

            # Se for PermissionError(13) ou similar, reabrir porta
            if "PermissionError" in last_err or "13" in last_err or "WriteFile" in last_err:
                if attempt < max_retries:
                    log("[PY TX] Reabrindo porta apos PermissionError...")
                    try:
                        ser.close()
                    except Exception:
                        pass
                    time.sleep(0.15)
                    try:
                        ser = open_serial(port_path)
                        log("[PY TX] Porta reaberta para retry")
                    except Exception as reopen_err:
                        log(f"[PY TX] Falha ao reabrir: {reopen_err}")
                        return False, ser, f"reabertura falhou: {reopen_err}"
                    continue
            # outros erros: nao retry
            break
    return False, ser, last_err


def open_serial(port_path):
    """Abre a porta COM com pyserial e aplica fix PL2303."""
    ser = serial.Serial()
    ser.port = port_path
    ser.baudrate = 9600
    ser.bytesize = serial.EIGHTBITS
    ser.parity = serial.PARITY_NONE
    ser.stopbits = serial.STOPBITS_ONE
    ser.timeout = 0.05  # 50ms read timeout
    ser.write_timeout = 5
    ser.xonxoff = False
    ser.rtscts = False
    ser.dsrdtr = False
    ser.dtr = False
    ser.rts = False
    ser.open()

    log(f"[PY] Porta {port_path} aberta: 9600 8N1 dtr=False rts=False")

    # Aplicar fix PL2303 via Win32 API
    try:
        handle = get_win32_handle(ser)
        log(f"[PY] Win32 handle = {handle}")
        fix_pl2303_dcb(handle)
    except Exception as e:
        log(f"[PY] AVISO: fix PL2303 falhou: {e}")

    # Limpar buffers
    ser.reset_input_buffer()
    ser.reset_output_buffer()

    return ser


def main():
    if len(sys.argv) < 2:
        out("ERROR:uso: serial_bridge_persistent.py <PORT>")
        sys.exit(1)

    port_path = sys.argv[1]

    try:
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
    except Exception:
        pass

    try:
        ser = open_serial(port_path)
    except Exception as e:
        out(f"ERROR:Nao conseguiu abrir {port_path}: {e}")
        sys.exit(1)

    t = threading.Thread(target=stdin_reader_thread, daemon=True)
    t.start()
    log("[PY] Thread stdin iniciada")

    out("READY")

    rx_buf = ""  # acumulador string ASCII (frames podem chegar fragmentados)
    rx_last_data_time = 0  # timestamp do último byte recebido (para timeout de buffer parcial)
    RX_BUFFER_TIMEOUT = 8.0  # segundos — tolera repetidor LoRa lento (Poço 16 etc)
    REOPEN_AFTER_TX_SILENCE = 6.0  # só reabrir a porta se silêncio >6s após TX (não 2s)
    running = True
    consecutive_empty_reads = 0
    last_tx_time = 0
    reopen_count = 0
    chunk_count_this_frame = 0  # quantos chunks acumulados no frame atual (diagnóstico)

    while running:
        # --- 1. CLEAR COMM ERROR (fix PL2303) ---
        try:
            handle = get_win32_handle(ser)
            errs, in_queue = clear_comm_error(handle)
            if errs:
                log(f"[PY] ERRO SERIAL DETECTADO: 0x{errs:04X} (queue={in_queue})")
        except Exception:
            pass

        # --- 2. READ SERIAL ---
        data = b""
        try:
            # Ler o que tiver disponivel
            waiting = ser.in_waiting
            if waiting > 0:
                data = ser.read(waiting)
                consecutive_empty_reads = 0
            else:
                # Tentar ler 1 byte com timeout de 50ms
                data = ser.read(1)
                if data:
                    # Ler o resto se tiver mais
                    more = ser.in_waiting
                    if more > 0:
                        data += ser.read(more)
                    consecutive_empty_reads = 0
                else:
                    consecutive_empty_reads += 1
        except Exception as e:
            log(f"[PY] read error: {e}")
            consecutive_empty_reads += 1

        # Acumular bytes recebidos no buffer (string ASCII)
        if data:
            try:
                rx_buf += data.decode("ascii", errors="ignore")
            except Exception:
                pass
            rx_last_data_time = time.time()
            chunk_count_this_frame += 1
            # LOG DE DIAGNÓSTICO: chunk recebido (essencial para detectar fragmentação)
            log(f"[PARSER] Chunk #{chunk_count_this_frame}: {len(data)}b, buffer total: {len(rx_buf)}b, aguardando ETX")

            # Extrair TODOS os frames completos do buffer.
            # Delimitador de fim oficial: "_ETX_]" (opcionalmente seguido de \r).
            # Início do frame: primeiro "_[" ou "[".
            END_TOKEN = "_ETX_]"
            while END_TOKEN in rx_buf:
                end_idx = rx_buf.find(END_TOKEN) + len(END_TOKEN)
                # localizar início (preferir "_[" da resposta de bomba; senão "[")
                start_idx = rx_buf.find("_[")
                if start_idx == -1 or start_idx > end_idx:
                    start_idx = rx_buf.find("[")
                if start_idx == -1 or start_idx > end_idx:
                    # lixo antes do END sem início válido — descartar até depois do END
                    discarded = rx_buf[:end_idx]
                    log(f"[PY] Lixo descartado (sem inicio valido): {discarded!r}")
                    rx_buf = rx_buf[end_idx:]
                    continue

                # descartar lixo antes do início do frame
                if start_idx > 0:
                    log(f"[PY] Lixo descartado antes do frame: {rx_buf[:start_idx]!r}")

                frame_str = rx_buf[start_idx:end_idx]
                # consumir possível \r/\n imediatamente após o END_TOKEN
                consume = end_idx
                while consume < len(rx_buf) and rx_buf[consume] in ("\r", "\n"):
                    consume += 1
                rx_buf = rx_buf[consume:]

                out(f"RX:{frame_str}")
                log(f"[PY FRAME] {frame_str} (montado em {chunk_count_this_frame} chunk(s))")
                chunk_count_this_frame = 0  # reset para próximo frame

        # Timeout de buffer parcial: se ficou dado preso > 8s sem completar, descarta
        # (segurança — o timeout de polling de 13s no main.cjs cuida do retry)
        if rx_buf and rx_last_data_time > 0 and (time.time() - rx_last_data_time) > RX_BUFFER_TIMEOUT:
            preview = rx_buf[:80].replace("\r", "\\r").replace("\n", "\\n")
            log(f"[PARSER] Frame parcial descartado após {RX_BUFFER_TIMEOUT}s: \"{preview}\" ({len(rx_buf)} bytes, {chunk_count_this_frame} chunks)")
            rx_buf = ""
            rx_last_data_time = 0
            chunk_count_this_frame = 0

        # --- 3. DETECTAR TRAVAMENTO E REABRIR (workaround PL2303) ---
        # Reabrir apenas se: TX feito ha >6s, sem dados desde entao, E buffer vazio
        # (NUNCA reabrir com frame parcial em andamento — Poço 16 / repetidor LoRa lento)
        if (last_tx_time > 0 and
            consecutive_empty_reads > (REOPEN_AFTER_TX_SILENCE / 0.05) and
            time.time() - last_tx_time > REOPEN_AFTER_TX_SILENCE and
            len(rx_buf) == 0 and
            reopen_count < 50):
            log(f"[PY] PL2303 TRAVOU? Reabrindo porta... (tentativa {reopen_count + 1}, silêncio {REOPEN_AFTER_TX_SILENCE}s pós-TX, buffer vazio)")
            try:
                ser.close()
                time.sleep(0.1)
                ser = open_serial(port_path)
                reopen_count += 1
                consecutive_empty_reads = 0
                last_tx_time = 0
                log("[PY] Porta reaberta com sucesso")
            except Exception as e:
                log(f"[PY] ERRO ao reabrir: {e}")
                time.sleep(1)

        # --- 4. POLL STDIN ---
        try:
            while True:
                line = stdin_queue.get_nowait()
                if line is None:
                    running = False
                    break
                if line == "QUIT":
                    running = False
                    break
                if line == "PING":
                    out("PONG")
                    continue
                if line.startswith("SEND:"):
                    frame = line[5:]
                    tx_bytes = (frame + "\r").encode("ascii")
                    ok, ser, err = safe_write(ser, port_path, tx_bytes)
                    if ok:
                        out("TX_OK")
                        log(f"[PY TX] {len(tx_bytes)}b escritos: {frame}")
                        last_tx_time = time.time()
                        consecutive_empty_reads = 0
                        reopen_count = 0  # reset reopen counter on new TX
                    else:
                        out(f"TX_ERR:{err}")
                        log(f"[PY TX] FALHA DEFINITIVA: {err}")
                else:
                    out(f"ERROR:Comando desconhecido: {line}")
        except queue.Empty:
            pass

    try:
        ser.close()
        log("[PY] Porta fechada")
    except:
        pass


if __name__ == "__main__":
    main()
