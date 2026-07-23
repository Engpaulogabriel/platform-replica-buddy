const { contextBridge } = require("electron");

/* ── Serial port ── */
let SerialPort;
let ReadlineParser;
let serialLoadError = null;

try {
  SerialPort = require("serialport").SerialPort;
  ReadlineParser = require("@serialport/parser-readline").ReadlineParser;
} catch (e) {
  serialLoadError = e.message;
}

let port = null;
let parser = null;
const dataListeners = new Set();
const statusListeners = new Set();

/* ── RX via ReadlineParser (delimiter '\r', SEM timeout) ──
 * Regra obrigatória: o buffer acumula bytes até chegar \r (0x0D).
 * NÃO usar InterByteTimeoutParser. NÃO usar port.on('data') direto.
 * NÃO descartar dados parciais. Cada evento 'data' do parser = 1 frame.
 * Logamos TODOS os frames com timestamp ISO. */
function emitData(line) {
  // NÃO ignorar linha vazia — logar tudo
  console.log(`[RX] ${new Date().toISOString()} ${line}`);
  for (const cb of dataListeners) {
    try { cb(line); } catch (_) { /* never let one listener break others */ }
  }
}

function emitStatus(evt) {
  for (const cb of statusListeners) {
    try { cb(evt); } catch (_) { /* ignore */ }
  }
}

/* ── Heartbeat (PING) ── */
const HEARTBEAT_INTERVAL_MS = 30_000;
const PING_TIMEOUT_MS = 2_000;
let lastRxAt = 0;
let heartbeatTimer = null;
let pingTimer = null;

/* ── Watchdog de comunicação serial (RX ausente por 2 min) ── */
const WATCHDOG_CHECK_MS = 30_000;
const WATCHDOG_THRESHOLD_MS = 120_000;
let watchdogTimer = null;
let comAlertSent = false;
let watchdogCtx = { farmId: null, supabaseUrl: null, anonKey: null };

async function callWatchdogNotify(message) {
  try {
    const { supabaseUrl, anonKey, farmId } = watchdogCtx;
    if (!supabaseUrl || !anonKey || !farmId) {
      console.log("[WATCHDOG] contexto ausente — pulando notificação:", message);
      return;
    }
    const url = supabaseUrl.replace(/\/$/, "") + "/functions/v1/whatsapp-automation-notify";
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${anonKey}`,
        "apikey": anonKey,
      },
      body: JSON.stringify({
        type: "alert",
        immediate: true,
        source: "electron_watchdog",
        farm_id: farmId,
        equipment_name: "Agente RS-232",
        message,
      }),
    });
  } catch (e) {
    console.log("[WATCHDOG] erro ao notificar:", e && e.message);
  }
}

function startWatchdog() {
  stopWatchdog();
  watchdogTimer = setInterval(() => {
    if (!port || !port.isOpen) return;
    const elapsed = Date.now() - lastRxAt;
    if (elapsed > WATCHDOG_THRESHOLD_MS && !comAlertSent) {
      comAlertSent = true;
      console.log("[WATCHDOG] Sem RX há 2 min — alerta enviado");
      emitStatus({ type: "watchdog_alert", elapsedMs: elapsed });
      callWatchdogNotify("⚠️ Sem comunicação serial há 2 minutos — verificar cabo/adaptador USB-Serial e porta COM");
    }
  }, WATCHDOG_CHECK_MS);
}

function stopWatchdog() {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
}

function onRxReceived() {
  lastRxAt = Date.now();
  if (pingTimer) { clearTimeout(pingTimer); pingTimer = null; }
  if (comAlertSent) {
    comAlertSent = false;
    console.log("[WATCHDOG] Comunicação restabelecida");
    emitStatus({ type: "watchdog_recovered" });
    callWatchdogNotify("✅ Comunicação serial restabelecida após interrupção");
  }
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!port || !port.isOpen) return;
    const elapsed = Date.now() - lastRxAt;
    if (elapsed >= HEARTBEAT_INTERVAL_MS) {
      // No data received in 30s — send PING\r
      port.write("PING\r", (err) => {
        if (err) {
          emitStatus({ type: "ping_fail", message: err.message });
          return;
        }
        emitStatus({ type: "ping_sent" });
        // Wait 2s for OK:ESP_A response
        pingTimer = setTimeout(() => {
          emitStatus({ type: "ping_timeout", message: "Sem resposta ao PING após 2s" });
        }, PING_TIMEOUT_MS);
      });
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (pingTimer) { clearTimeout(pingTimer); pingTimer = null; }
}

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  isElectron: true,
});

contextBridge.exposeInMainWorld("serialAPI", {
  health: () => ({ serialAvailable: !!SerialPort, serialLoadError }),

  list: async () => {
    if (!SerialPort) throw new Error("serialport não carregado: " + serialLoadError);
    const ports = await SerialPort.list();
    return ports.map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer,
      serialNumber: p.serialNumber,
      vendorId: p.vendorId,
      productId: p.productId,
      friendlyName: p.friendlyName,
    }));
  },

  open: (config) => {
    return new Promise((resolve, reject) => {
      if (!SerialPort) return reject("serialport não carregado: " + serialLoadError);
      port = new SerialPort(
        {
          path: config.path,
          baudRate: Number(config.baudRate) || 9600,
          dataBits: Number(config.dataBits) || 8,
          parity: config.parity || "none",
          stopBits: Number(config.stopBits) || 1,
        },
        (err) => {
          if (err) {
            emitStatus({ type: "error", message: err.message });
            return reject(err.message);
          }
          // ─────────────────────────────────────────────────────────────
          // OBRIGATÓRIO: ReadlineParser com delimiter '\r' (0x0D).
          //   • SEM timeout (buffer acumula até chegar \r, sem limite).
          //   • SEM InterByteTimeoutParser.
          //   • NUNCA usar port.on('data') direto — sempre via parser.
          //   • Cada evento 'data' do parser = 1 frame completo.
          //   • Logamos TUDO com timestamp (em emitData).
          // ─────────────────────────────────────────────────────────────
          parser = port.pipe(new ReadlineParser({ delimiter: "\r", includeDelimiter: false }));
          parser.on("data", (line) => {
            onRxReceived();
            emitData(line);
          });
          port.on("close", () => {
            stopHeartbeat();
            stopWatchdog();
            parser = null;
            emitStatus({ type: "close", path: config.path });
          });
          port.on("error", (e) => emitStatus({ type: "error", message: e.message }));
          emitStatus({ type: "open", path: config.path });
          lastRxAt = Date.now();
          comAlertSent = false;
          startHeartbeat();
          startWatchdog();
          resolve(true);
        }
      );
    });
  },

  close: () => new Promise((resolve) => {
    stopHeartbeat();
    stopWatchdog();
    if (port && port.isOpen) {
      port.close(() => { port = null; parser = null; resolve(true); });
    } else { resolve(false); }
  }),

  // Watchdog: renderer fornece contexto para chamada da edge function
  configureWatchdog: (cfg) => {
    watchdogCtx = {
      farmId: cfg && cfg.farmId ? String(cfg.farmId) : null,
      supabaseUrl: cfg && cfg.supabaseUrl ? String(cfg.supabaseUrl) : null,
      anonKey: cfg && cfg.anonKey ? String(cfg.anonKey) : null,
    };
    return true;
  },


  // CRITICAL: always append \r (CR 0x0D) — firmware ignores frames without it
  write: (data) => new Promise((resolve, reject) => {
    if (!port || !port.isOpen) return reject("Porta não aberta");
    const frame = data.endsWith("\r") ? data : data + "\r";
    port.write(frame, (err) => { if (err) reject(err.message); else resolve(true); });
  }),

  isOpen: () => !!(port && port.isOpen),
  // Multi-listener: NUNCA sobrescrever um callback anterior, isso causaria
  // perda silenciosa de frames quando dois consumidores se registrassem.
  onData: (cb) => {
    dataListeners.add(cb);
    return () => { dataListeners.delete(cb); };
  },
  onStatus: (cb) => {
    statusListeners.add(cb);
    return () => { statusListeners.delete(cb); };
  },
});

/* ── License API ── */
const licenseAPI = global.licenseAPI;

contextBridge.exposeInMainWorld("licenseAPI", {
  getMachineId: () => licenseAPI.getMachineId(),
  activate: (licenseKey) => {
    const machineId = licenseAPI.getMachineId();
    const valid = licenseAPI.verifyLicenseKey(machineId, licenseKey);
    if (valid) {
      licenseAPI.saveLicense(machineId, licenseKey);
      return { success: true, machineId };
    }
    return { success: false, machineId };
  },
  checkLicense: () => {
    const machineId = licenseAPI.getMachineId();
    const saved = licenseAPI.readLicense();
    if (!saved) return { activated: false, machineId };
    const valid = licenseAPI.verifyLicenseKey(machineId, saved.licenseKey);
    return { activated: valid, machineId, activatedAt: saved.activatedAt };
  },
  generateKey: (targetMachineId) => {
    return licenseAPI.generateLicenseKey(targetMachineId);
  },
});
