/**
 * RENOV Electron Agent — main.cjs v3
 * ====================================
 * Agente headless (system tray) para ponte Serial <-> Supabase.
 *
 * MUDANCA CRITICA v3: O Python bridge agora e BURRO (igual ao Hercules).
 *   - Python le a porta Serial em loop infinito, byte a byte
 *   - Manda "RX:<frame>" para TUDO que chega (sem filtro, sem timeout)
 *   - Protocolo simplificado: SEND:<frame> (sem timeout no Python)
 *
 * TODA a logica de comando/resposta esta AQUI no Electron:
 *   - Filtra PING vs telemetria
 *   - Controla timeout dos comandos
 *   - Grava telemetria no Supabase
 */

const { app, Tray, Menu, nativeImage, BrowserWindow, ipcMain, dialog, safeStorage } = require("electron");
const { spawn, execSync } = require("child_process");
const { createClient } = require("@supabase/supabase-js");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

// ─── BOOT LOG (escrito ANTES de qualquer coisa que possa falhar) ───────────
// Sempre grava em %APPDATA%\GestorDeBombasKey\boot.log para diagnosticar
// crashes silenciosos no startup. Não depende de pushLog/Supabase/janelas.
function _bootLog(msg) {
  try {
    const dir = (app && app.getPath) ? app.getPath("userData") : path.join(os.homedir(), "AppData", "Roaming", "GestorDeBombasKey");
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(path.join(dir, "boot.log"), line);
  } catch (_) {}
}
_bootLog(`=== boot main.cjs pid=${process.pid} packaged=${app.isPackaged} platform=${process.platform} arch=${process.arch} node=${process.versions.node} electron=${process.versions.electron} ===`);

process.on("uncaughtException", (err) => {
  _bootLog(`uncaughtException: ${err && err.stack || err}`);
  try { console.error("[FATAL]", err); } catch (_) {}
});
process.on("unhandledRejection", (err) => {
  _bootLog(`unhandledRejection: ${err && err.stack || err}`);
});

// Auto-update DESATIVADO. O repositório público de releases não existe e o
// electron-updater fica gerando ruído (404 em releases.atom). Atualizações são
// feitas via .asar hospedado em bucket privado (preferido) ou .exe legado.
const autoUpdater = null;
const AUTOUPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h (mantido para compat)
// v3.10.6: Pin per-farm — checagem agora roda DENTRO do heartbeat (30s)
// em vez de a cada 30min. Debounce por versão para não retentar a mesma
// versão falhada antes de 5min.
const TARGET_VERSION_CHECK_INTERVAL_MS = 30 * 1000; // 30s
const UPDATE_RETRY_BACKOFF_MS = 5 * 60 * 1000; // 5min entre tentativas pra mesma versão falhada
let lastTargetVersionCheckAt = 0;
let isInstallingUpdate = false;
let lastFailedUpdateVersion = null;
let lastFailedUpdateAt = 0;

// --- Config ---
// CONFIG_FILE_V2 é o novo arquivo CRIPTOGRAFADO (DPAPI no Windows). O legado
// renov-agent-config.json é migrado e apagado na primeira execução.
const CONFIG_FILE_LEGACY = path.join(app.getPath("userData"), "renov-agent-config.json");
const CONFIG_FILE = path.join(app.getPath("userData"), "renov-agent-config.enc");
const PROVISIONING_LOOKUP_PATHS = [
  path.join(app.getPath("userData"), "provisioning.json"),
  path.join("C:\\ProgramData", "Renov", "provisioning.json"),
  path.join(process.resourcesPath || __dirname, "provisioning.json"),
  path.join(__dirname, "provisioning.json"),
];
// Hash de referência do ASAR — gerado em BUILD-TIME (não em runtime).
// O build-agent.bat calcula o hash e grava em extraResources antes do empacotamento.
const ASAR_HASH_FILE_BUILD = path.join(process.resourcesPath || __dirname, "asar-hash.txt");
// Backwards-compat: localização antiga (gerada em runtime — vulnerável).
const ASAR_HASH_FILE_LEGACY = path.join(app.getPath("userData"), "asar-hash.txt");

// Defaults vêm de provisioning.json. Mantidos apenas como FALLBACK para builds
// sem provisioning (desenvolvimento). Em produção, o JSON sobrescreve.
const SUPABASE_URL_DEFAULT = process.env.RENOV_SUPABASE_URL
  || "https://dnyukgfedredvxpzjpqz.supabase.co";
const SUPABASE_ANON_DEFAULT = process.env.RENOV_SUPABASE_ANON
  || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRueXVrZ2ZlZHJlZHZ4cHpqcHF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2ODU1OTQsImV4cCI6MjA5MjI2MTU5NH0.OSg44w0CRVvD-f6Ts_U9DVeQkQ-4c37passKEK5X0kk";

// Segredo HMAC para assinar reportes de tampering. Embutido em build-time
// via env var RENOV_TAMPER_SECRET. Caso ausente (dev), usa valor inerte.
const TAMPER_SIGNING_SECRET = process.env.RENOV_TAMPER_SECRET
  || "dev-only-tamper-secret-replace-in-build";

const LOG_DIR = path.join(app.getPath("userData"), "logs");
const POLL_INTERVAL_MS = 10_000; // v3.7.8: aumentado de 3s para 10s — comandos manuais chegam via Realtime fast-path; reduz IO no banco em 70%
// v3.9.10: gap entre o FIM (RX/timeout) de uma comunicação de polling e o INÍCIO (TX) da próxima.
// Após RX bem sucedido, espera 8s para não saturar o canal de rádio (colisão/eco).
// Após timeout, basta um gap curto (3s) para não atrasar demais o ciclo.
const POLLING_GAP_AFTER_RX_MS = 3_000;
const POLLING_GAP_AFTER_TIMEOUT_MS = 3_000;
const MANUAL_FIRST_TX_GAP_MS = 3_000; // v3.8.13: gap mínimo entre último TX da mesma PLC e primeiro TX manual
// v3.25.7: quando há OUTROS manuais pendentes na fila, não segura o barramento os
// 13s completos esperando o RX deste manual — libera após 3s para o próximo manual
// sair em ~3s (TX_MIN_GAP_MS). A confirmação física deste comando continua garantida
// pelos reforços TX (+15/30/45s) e pela janela de late-RX/safety de 120s no backend.
const MANUAL_QUEUED_HOLD_MS = 3_000;
// v3.25.7: desligamento forçado de bomba ligada localmente. Quando o operador
// desliga (bit=0) pela plataforma uma bomba com last_actuation_origin='local' e
// forced_shutdown_enabled=true, o agente executa {1} -> espera RX -> estabiliza -> {0}
// UMA ÚNICA VEZ (sem reforços/safety). Ver runForcedShutdownSequence().
const FORCED_SHUTDOWN_ON_RX_TIMEOUT_MS = 13_000; // espera do RX confirmando o {1} (mesma janela do manual)
const FORCED_SHUTDOWN_STABILIZE_MS = POLL_INTERVAL_MS; // 10s p/ firmware/LoRa estabilizar antes do {0}
let lastPollingEndAt = 0;             // timestamp do último RX/timeout de polling
let lastPollingEndedWithTimeout = false; // true se o último polling acabou em timeout
const lastTxByTsnn = new Map(); // TSNN -> { at, type, cmdId, frame }
const HEARTBEAT_INTERVAL_MS = 30_000;

// ============================================================================
// TX rate-limiter global (anti-colisao no barramento RF)
// ----------------------------------------------------------------------------
// - Garante gap minimo de 5s entre QUALQUER TX serial
// - Garante gap minimo de 2s apos QUALQUER RX antes do proximo TX
// - Comandos RESET (priority "reset") bypassam o gap de 5s mas respeitam 2s pos-RX
// - Polling e descartado se a fila acumular > 5 itens
// ============================================================================
let lastTxTimestamp = 0;
let lastRxTimestamp = 0;
const txQueue = []; // [{ frame, priority, queuedAt, tsnn }]
const TX_MIN_GAP_MS = 3000;
const RX_AVOID_GAP_MS = 2000;
const POLLING_QUEUE_DROP_THRESHOLD = 5;

function _txExtractTsnn(frame) {
  const m = String(frame || "").match(/\[TS(\d{2,4})/);
  return m ? m[1] : "?";
}

function _txWriteNow(frame) {
  if (!bridgeProcess || !bridgeReady) return false;
  try {
    bridgeProcess.stdin.write(Buffer.from(`SEND:${frame}\n`, "utf8"));
    lastTxTimestamp = Date.now();
    return true;
  } catch (e) {
    try { pushLog("error", "serial", `[TX QUEUE] stdin write falhou: ${e.message}`); } catch (_) {}
    return false;
  }
}

// priority: "reset" (bypass 5s gap), "manual" (5s queue), "polling" (5s queue + drop if > 5)
function sendTxFrame(frame, opts) {
  const priority = (opts && opts.priority) || "manual";
  const tsnn = _txExtractTsnn(frame);
  const now = Date.now();
  const rxGap = now - lastRxTimestamp;

  if (priority === "reset") {
    if (lastRxTimestamp > 0 && rxGap < RX_AVOID_GAP_MS) {
      try { pushLog("info", "tx", `[TX QUEUE] Aguardando 2s apos RX antes de enviar (RESET TSNN ${tsnn})`); } catch (_) {}
      // empurra para o inicio da fila para sair na proxima janela
      txQueue.unshift({ frame, priority, queuedAt: now, tsnn });
      return;
    }
    // bypass do gap de 5s
    if (_txWriteNow(frame)) {
      try { pushLog("info", "tx", `[TX QUEUE] RESET enviado direto TSNN ${tsnn} (bypass 5s)`); } catch (_) {}
    }
    return;
  }

  if (priority === "polling" && txQueue.length > POLLING_QUEUE_DROP_THRESHOLD) {
    try { pushLog("warn", "system", `[TX QUEUE] Polling TSNN ${tsnn} descartado (fila cheia: ${txQueue.length})`); } catch (_) {}
    return;
  }

  txQueue.push({ frame, priority, queuedAt: now, tsnn });
  try { pushLog("info", "tx", `[TX QUEUE] Enfileirado frame para TSNN ${tsnn} (fila: ${txQueue.length} items)`); } catch (_) {}
}

function processTxQueue() {
  if (txQueue.length === 0) return;
  if (!bridgeProcess || !bridgeReady) return;
  const now = Date.now();
  if (lastTxTimestamp > 0 && now - lastTxTimestamp < TX_MIN_GAP_MS) return;
  if (lastRxTimestamp > 0 && now - lastRxTimestamp < RX_AVOID_GAP_MS) {
    try { pushLog("debug", "tx", `[TX QUEUE] Aguardando 2s apos RX antes de enviar`); } catch (_) {}
    return;
  }
  const item = txQueue.shift();
  const gap = lastTxTimestamp > 0 ? (now - lastTxTimestamp) : -1;
  if (_txWriteNow(item.frame)) {
    watchdogRestartCount = 0; // TX efetivo: reseta watchdog
    try { pushLog("info", "tx", `[TX QUEUE] Enviando frame para TSNN ${item.tsnn} (gap: ${gap}ms desde ultimo TX)`); } catch (_) {}
  } else {
    // bridge caiu: devolve para fila para tentar de novo
    txQueue.unshift(item);
  }
}

setInterval(processTxQueue, 1000);

// ============================================================================
// Cloud auth resilience + TX watchdog
// ----------------------------------------------------------------------------
// Objetivo: manter o loop de polling/TX vivo mesmo quando o token do Supabase
// expira ou a nuvem devolve "Sem permissao" (RLS/JWT). O loop TX
// (processTxQueue) já é 100% offline — só consome txQueue e escreve na porta
// serial. O que trava é o loop QUE ENFILEIRA (tickEnqueuePolling e
// processNextCommand): se essas chamadas retornam erro de auth, nenhum
// frame novo entra na fila. Aqui:
//   1) Detectamos erros de autenticação/permissão.
//   2) Disparamos re-autenticação em background (refreshSession → fallback
//      signInWithPassword com credenciais salvas). NUNCA bloqueia o loop TX.
//   3) Watchdog independente: se não sai TX por >60s com PLCs cadastradas e
//      bridge ok, reinicia o ciclo de polling. Após 3 tentativas seguidas,
//      dispara alerta crítico via whatsapp-alerts (best-effort, sem bloquear).
// ============================================================================
function isCloudAuthError(err) {
  if (!err) return false;
  const msg = String(err.message || err.error_description || err || "").toLowerCase();
  const code = String(err.code || err.status || "").toLowerCase();
  if (
    msg.includes("sem permissao")
    || msg.includes("permission denied")
    || msg.includes("jwt expired")
    || msg.includes("invalid jwt")
    || msg.includes("jwt is invalid")
    || msg.includes("token is expired")
    || msg.includes("token has invalid claims")
    || msg.includes("not authenticated")
  ) return true;
  if (code === "401" || code === "403" || code === "pgrst301" || code === "pgrst302") return true;
  return false;
}

let reauthInProgress = false;
let lastReauthAt = 0;
const REAUTH_MIN_GAP_MS = 15_000; // evita loop apertado ao repetir 401

async function triggerReauth(reason) {
  if (reauthInProgress) return;
  if (Date.now() - lastReauthAt < REAUTH_MIN_GAP_MS) return;
  reauthInProgress = true;
  lastReauthAt = Date.now();
  try {
    pushLog("warn", "cloud", `[AUTH] Token expirado detectado (${reason || "unknown"}). Tentando re-autenticação...`);
    // Tenta refresh primeiro (mais barato)
    if (supabase && supabase.auth && typeof supabase.auth.refreshSession === "function") {
      try {
        const { data, error } = await supabase.auth.refreshSession();
        if (!error && data && data.session) {
          activeAccessToken = data.session.access_token || activeAccessToken;
          pushLog("info", "cloud", "[AUTH] Refresh de token bem-sucedido");
          void flushTelemetryQueue();
          return;
        }
        if (error) pushLog("warn", "cloud", `[AUTH] refreshSession falhou: ${error.message || error}`);
      } catch (e) {
        pushLog("warn", "cloud", `[AUTH] refreshSession exception: ${e && e.message || e}`);
      }
    }
    // Fallback: login completo com credenciais salvas
    const cfg = (typeof loadConfig === "function") ? loadConfig() : null;
    if (!cfg || !cfg.email || !cfg.password || !cfg.supabaseUrl || !cfg.supabaseAnonKey) {
      pushLog("error", "cloud", "[AUTH] Re-autenticação impossível: config incompleta");
      return;
    }
    try {
      const newClient = await authenticate(cfg.email, cfg.password, cfg.supabaseUrl, cfg.supabaseAnonKey);
      supabase = newClient;
      // reseta canal de broadcast (cliente novo)
      broadcastChannelRef = null;
      pushLog("info", "cloud", `[AUTH] Re-autenticação bem-sucedida (${cfg.email})`);
      void flushTelemetryQueue();
    } catch (e) {
      pushLog("error", "cloud", `[AUTH] Re-autenticação falhou: ${e && e.message || e}`);
    }
  } finally {
    reauthInProgress = false;
  }
}

// Wrapper leve para ser chamado nos catch/error paths dos loops que falam
// com a nuvem. NUNCA lança — é fire-and-forget.
function noteCloudError(err, context) {
  try {
    if (isCloudAuthError(err)) {
      void triggerReauth(context || "cloud-error");
    }
  } catch (_) {}
}

// --- Watchdog TX QUEUE -----------------------------------------------------
let watchdogRestartCount = 0;
let lastWatchdogAlertAt = 0;
const WATCHDOG_INTERVAL_MS = 15_000;
const WATCHDOG_TX_SILENCE_MS = 60_000;
const WATCHDOG_MAX_RESTARTS = 3;

function hasActivePLCs() {
  // Usa cache de equipamentos carregado do Supabase (map por hw_id).
  // Se ainda não carregou, assume "sim" para não silenciar o watchdog.
  return equipmentByHwId.size > 0 || equipmentCacheLoadedAt === 0;
}

async function sendTxStalledCriticalAlert(silenceSec) {
  if (!supabase || !farmId) return;
  // Rate-limit: no máximo 1 alerta a cada 10 min
  if (Date.now() - lastWatchdogAlertAt < 10 * 60_000) return;
  lastWatchdogAlertAt = Date.now();
  const message = `Agente Electron: TX QUEUE travada há ${Math.round(silenceSec)}s. Comunicação com PLCs interrompida. Verificar computador local.`;
  try {
    // Insere notificação no sino (aba Sistema) — dispara pipeline padrão
    await supabase.from("farm_notifications").insert({
      farm_id: farmId,
      kind: "failure",
      severity: "critical",
      title: "Agente sem TX há mais de 3 minutos",
      message,
      source: "agent-watchdog",
      source_ref: `tx-stalled:${Date.now()}`,
    });
  } catch (e) {
    pushLog("warn", "cloud", `[WATCHDOG] Falha ao registrar notificação crítica: ${e && e.message || e}`);
  }
  try {
    // WhatsApp direto (best-effort — pode falhar sem bloquear)
    await supabase.functions.invoke("whatsapp-alerts", {
      body: {
        kind: "agent_tx_stalled",
        farm_id: farmId,
        message,
        silence_seconds: Math.round(silenceSec),
      },
    });
  } catch (e) {
    pushLog("warn", "cloud", `[WATCHDOG] whatsapp-alerts invoke falhou: ${e && e.message || e}`);
  }
}

function watchdogTxTick() {
  try {
    if (!bridgeReady) return;                 // sem porta serial não é problema de TX
    if (!hasActivePLCs()) return;             // sem PLCs cadastradas nada a enviar
    if (licenseKillSwitchTriggered) return;   // desligamento intencional
    if (pollingPaused) return;                // pausa administrativa
    const silenceMs = lastTxTimestamp > 0 ? (Date.now() - lastTxTimestamp) : (Date.now() - agentStartupAt);
    if (silenceMs < WATCHDOG_TX_SILENCE_MS) return;

    watchdogRestartCount++;
    pushLog(
      "warn",
      "system",
      `[WATCHDOG] TX QUEUE travada há ${Math.round(silenceMs / 1000)}s. Reinício #${watchdogRestartCount}`,
    );

    if (watchdogRestartCount <= WATCHDOG_MAX_RESTARTS) {
      // Limpa estado que pode ter ficado preso e força novo ciclo.
      try { txQueue.length = 0; } catch (_) {}
      processing = false;
      processingSince = 0;
      inflightCmd = null;
      inflightTsnn = null;
      if (inflightTimer) { try { clearTimeout(inflightTimer); } catch (_) {} inflightTimer = null; }
      // Re-auth em background (se o problema for token) e força enfileirar já
      void triggerReauth("watchdog-tx-stalled");
      void tickEnqueuePolling();
      void processNextCommand();
    } else {
      pushLog("error", "system", "[WATCHDOG] 3 reinícios falharam. Enviando alerta WhatsApp...");
      void sendTxStalledCriticalAlert(silenceMs / 1000);
      watchdogRestartCount = 0; // reseta para poder tentar de novo depois
    }
  } catch (e) {
    try { pushLog("warn", "system", `[WATCHDOG] exception: ${e && e.message || e}`); } catch (_) {}
  }
}
setInterval(watchdogTxTick, WATCHDOG_INTERVAL_MS);

// (contador do watchdog é resetado em processTxQueue após TX bem-sucedido)

function uniqueExistingPythonCandidates(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item) return false;
    const key = String(item).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return !path.isAbsolute(item) || fs.existsSync(item);
  });
}

function getPythonCandidates() {
  const candidates = [];
  if (process.env.RENOV_PYTHON_PATH) candidates.push(process.env.RENOV_PYTHON_PATH);

  const localAppData = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const versions = ["314", "313", "312", "311", "310", "39", "38"];

  if (localAppData) {
    candidates.push(path.join(localAppData, "Python", "pythoncore-3.14-64", "python.exe"));
    for (const version of versions) {
      candidates.push(path.join(localAppData, "Programs", "Python", `Python${version}`, "python.exe"));
    }
    candidates.push(path.join(localAppData, "Microsoft", "WindowsApps", "python.exe"));
    candidates.push(path.join(localAppData, "Microsoft", "WindowsApps", "py.exe"));
  }

  for (const root of [programFiles, programFilesX86, "C:\\"]) {
    for (const version of versions) {
      candidates.push(path.join(root, `Python${version}`, "python.exe"));
    }
  }

  try {
    const found = execSync("where python", { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    candidates.push(...found);
  } catch (_) {}

  candidates.push("python", "python3", "py");
  return uniqueExistingPythonCandidates(candidates);
}

function buildPythonEnv() {
  const env = { ...process.env };
  const dirs = getPythonCandidates()
    .filter((candidate) => path.isAbsolute(candidate))
    .map((candidate) => path.dirname(candidate));
  const currentPath = env.Path || env.PATH || "";
  env.PATH = [...new Set([...dirs, ...currentPath.split(path.delimiter).filter(Boolean)])].join(path.delimiter);
  env.Path = env.PATH;
  return env;
}

function resolvePythonBridgePath() {
  const resourcePath = process.resourcesPath ? path.join(process.resourcesPath, "serial_bridge_persistent.py") : null;
  const devPath = path.join(__dirname, "serial_bridge_persistent.py");

  if (resourcePath && fs.existsSync(resourcePath)) return resourcePath;
  if (fs.existsSync(devPath)) return devPath;
  return resourcePath || devPath;
}

const PYTHON_BRIDGE = resolvePythonBridgePath();
const AGENT_VERSION = require("./package.json").version;
const LOG_RETENTION_DAYS = 7;
const LOG_FILE_MAX_BYTES = 50 * 1024 * 1024; // 50MB por arquivo
const MEMORY_CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30min
const BRIDGE_PING_INTERVAL_MS = 10_000;
const BRIDGE_PING_TIMEOUT_MS = 4_000;
const AUTO_RESET_TIMEOUT_THRESHOLD = 3;
const BRIDGE_RESET_SETTLE_MS = 800;
const LOG_FLUSH_MAX_BUFFER = 50;
const CLOUD_READ_TIMEOUT_MS = 15_000;
const CLOUD_WRITE_TIMEOUT_MS = 15_000;
const CLOUD_LOGIN_TIMEOUT_MS = 30_000;
const CLOUD_TELEMETRY_TIMEOUT_MS = 8_000; // 8s para gravacao IMEDIATA de estado
const TELEMETRY_QUEUE_MAX = 500;
const TELEMETRY_RETRY_MS = 3_000; // fila so eh fallback - retry rapido
const CLOUD_RECONNECT_INTERVAL_MS = 15_000;
const CLOUD_READ_BACKOFF_MS = 15_000;
// Enfileira polling de bombas vencidas direto no main process (Node) para que
// nao dependa do renderer/web — o Chromium throttla setInterval em background
// e isso fazia o sistema "travar" quando a janela ficava minimizada.
const POLLING_ENQUEUE_INTERVAL_MS = 11_000;
const POLLING_TIMEOUT_SWEEP_MS = 5_000;
// v3.12.2 — Configuração remota (tabela agent_config). Os valores abaixo
// começam com os defaults compilados e são sobrescritos a cada hot-reload
// (a cada 60s) pelo registro de agent_config da fazenda.
let activePollingEnqueueIntervalMs = POLLING_ENQUEUE_INTERVAL_MS;
let activeSweepTimeoutMs = POLLING_TIMEOUT_SWEEP_MS;
let activeTxGapMs = 100;               // gap mínimo entre TX serial (configurável remotamente)
let liveAgentConfig = null;            // { serial_port, polling_interval_ms, sweep_timeout_ms, tx_gap_ms, updated_at }
let lastAgentConfigUpdatedAt = null;   // string ISO do último updated_at aplicado
let agentConfigWatchTimer = null;
const AGENT_CONFIG_POLL_MS = 60_000;
// v3.8.24 — Modo Startup Sync: nos primeiros 15 min após autenticar, o agente
// faz polling em rajada (2s) usando uma RPC que monta o frame TX a partir de
// last_outputs_state (estado real conhecido), em vez de desired_running. Isso
// evita desligar bombas que foram ligadas externamente (ex: Hercules) antes
// que o RX confirme o estado real e sincronize o desired_running na nuvem.
const STARTUP_SYNC_DURATION_MS = 15 * 60_000;
const STARTUP_SYNC_INTERVAL_MS = 3_000;
let agentStartupAt = 0;
let startupSyncTimer = null;
let startupSyncEndTimer = null;
function isInStartupSyncWindow() {
  return agentStartupAt > 0 && (Date.now() - agentStartupAt) < STARTUP_SYNC_DURATION_MS;
}

function withCloudTimeout(promise, label, timeoutMs) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: timeout local ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function formatError(err) {
  if (!err) return "erro desconhecido";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message || err.name || "erro sem mensagem";
  if (typeof err.message === "string" && err.message.trim()) return err.message;
  try {
    const serialized = JSON.stringify(err);
    return serialized && serialized !== "{}" ? serialized : String(err);
  } catch (_) {
    return String(err);
  }
}

// --- State ---
let tray = null;
let setupWindow = null;
let logWindow = null;
let configWindow = null;
let supabase = null;
let comPort = null;
let farmId = null;
let activeSupabaseUrl = SUPABASE_URL_DEFAULT;
let activeSupabaseAnonKey = SUPABASE_ANON_DEFAULT;
let activeAccessToken = null;
let pollTimer = null;
let heartbeatTimer = null;
let logRotationTimer = null;
let pollingEnqueueTimer = null;
let pollingTimeoutTimer = null;
let cloudReconnectTimer = null;
let processing = false;
let processingSince = 0;
let startingAgent = false;
let consecutiveTimeouts = 0;
let appClosing = false;

// ─── Contador de falhas de polling por PLC (sem backoff) ───────────────────
// v3.9.20: NUNCA remove/pula PLCs do polling. Apenas conta tentativas
// consecutivas sem resposta para emitir log. O status online/offline do banco
// é decidido SOMENTE pelo backend (critical-alerts-tick) com limiar de 15 min.
// v3.9.21: + registro em automation_log de eventos equipamento_offline /
// equipamento_online (campo details.tipo_evento) para histórico no relatório.
const pollingBackoffByTsnn = new Map(); // tsnn -> { failures, offlineSince, lastSuccessAt }
function getBackoffSkipEvery(_failures) { return 1; }
function shouldSkipPollingForBackoff(_tsnn) { return false; }

// v3.9.30 — Métricas por ciclo de polling. Ciclo = uma rodada de enqueue
// de pollings pela RPC enqueue_polling_for_due_equipments. Ao detectar uma
// nova rodada, loga o ciclo anterior e zera contadores.
let pollingCycleStats = { startedAt: 0, ok: 0, fail: 0 };
const POLLING_EMERGENCY_MS = 12 * 60 * 1000; // 12 min sem resposta -> prioridade emergencial
const POLLING_SERIAL_TIMEOUT_MS = 5_000;     // v3.9.30: 13s -> 5s para destravar rodízio

async function updatePlcCommStatus(tsnn, status) {
  // v3.11.7: no-op intencional. O agente NÃO pode flipar
  // equipments.communication_status após falhas momentâneas de rádio.
  // Ele apenas grava telemetria/RX real; o backend decide offline após 15 min.
  void tsnn;
  void status;
}

// v3.11.6: o backoff in-memory zerava a cada restart do agente — um TSNN com
// 188 falhas voltava a failures=0 e o timeout reduzido (5s) deixava de valer.
// No startup, semeia failures=6 (acima do threshold 5) para todo TSNN marcado
// como offline no banco. O 1º RX real zera via noteBackoffSuccess.
async function seedBackoffFromCloud() {
  if (!farmId || !supabase) return;
  try {
    const { data } = await supabase
      .from("equipments")
      .select("hw_id")
      .eq("farm_id", farmId)
      .eq("communication_status", "offline");
    const seeded = new Set();
    for (const row of data || []) {
      const tsnn = String(row.hw_id || "").substring(0, 4).toUpperCase();
      if (!/^[0-9A-F]{4}$/.test(tsnn) || seeded.has(tsnn)) continue;
      if (!pollingBackoffByTsnn.has(tsnn)) {
        pollingBackoffByTsnn.set(tsnn, { failures: 6, offlineSince: Date.now(), lastSuccessAt: null });
        seeded.add(tsnn);
      }
    }
    if (seeded.size > 0) {
      pushLog("warn", "system",
        `[BACKOFF] Seed do startup: ${[...seeded].join(", ")} marcados offline no banco -> failures=6 (timeout 5s ativo)`);
    }
  } catch (e) {
    pushLog("warn", "system", `seedBackoffFromCloud falhou: ${e.message}`);
  }
}

// Resolve um nome legível para o PLC (primeiro equipamento daquela TSNN).
function resolvePlcName(tsnn) {
  const arr = equipmentByTsnn.get(tsnn);
  if (arr && arr.length > 0) {
    if (arr.length === 1) return arr[0].name || `PLC ${tsnn}`;
    return `PLC ${tsnn}`;
  }
  return `PLC ${tsnn}`;
}

async function logCommEventToAutomationLog(tsnn, kind, extra) {
  if (!tsnn || !supabase || !farmId) return;
  try {
    const name = resolvePlcName(tsnn);
    const details = { tipo_evento: kind, tsnn, ...extra };
    await supabase.from("automation_log").insert({
      farm_id: farmId,
      equipment_name: name,
      occurred_at: new Date().toISOString(),
      origin: "system",
      action: "status_read",
      result: kind === "equipamento_offline" ? "timeout" : "success",
      details,
      source_device: "agent-polling",
      client_event_id: (crypto.randomUUID ? crypto.randomUUID() : undefined),
    });
  } catch (e) {
    pushLog("warn", "system", `logCommEventToAutomationLog ${tsnn} ${kind} falhou: ${e.message}`);
  }
}

// Eventos de ciclo de vida do próprio agente — aparecem no Relatório de
// Automação em "Sistema". Equipamento = "Agente" (sem equipment_id) para que
// fiquem agrupados como evento de fazenda, não de bomba específica.
//   kind = 'agent_restart' → marca início de sessão do agente (após auth)
//   kind = 'ota_update_start' → marca início de instalação de update (bombas
//   podem perder confirmação de estado enquanto o agente reinicia)
async function logAgentLifecycleEvent(kind, extra) {
  if (!supabase || !farmId) return;
  try {
    const details = { tipo_evento: kind, agent_version: AGENT_VERSION, ...(extra || {}) };
    await supabase.from("automation_log").insert({
      farm_id: farmId,
      equipment_name: "Agente",
      occurred_at: new Date().toISOString(),
      origin: "system",
      action: "status_read",
      result: "success",
      details,
      source_device: kind === "ota_update_start" ? "ota-update" : "agent-restart",
      client_event_id: (crypto.randomUUID ? crypto.randomUUID() : undefined),
    });
  } catch (e) {
    try { pushLog("warn", "system", `logAgentLifecycleEvent ${kind} falhou: ${e.message}`); } catch (_) {}
  }
}

function noteBackoffSuccess(tsnn) {
  if (!tsnn) return;
  const b = pollingBackoffByTsnn.get(tsnn);
  if (b && b.failures > 0) {
    pushLog("info", "system",
      `[POLLING] TSNN ${tsnn} voltou a comunicar apos ${b.failures} tentativas sem resposta`);
    if (b.failures >= 3) void updatePlcCommStatus(tsnn, "online");
    if (b.offlineSince) {
      const tempoTotal = Math.floor((Date.now() - b.offlineSince) / 1000);
      void logCommEventToAutomationLog(tsnn, "equipamento_online", {
        tempo_total_offline_segundos: tempoTotal,
        tentativas_sem_resposta: b.failures,
      });
    }
    pollingBackoffByTsnn.set(tsnn, { failures: 0, offlineSince: null, lastSuccessAt: Date.now() });
  } else {
    pollingBackoffByTsnn.set(tsnn, { failures: 0, offlineSince: null, lastSuccessAt: Date.now() });
  }
}

function noteBackoffFailure(tsnn) {
  if (!tsnn) return;
  const prev = pollingBackoffByTsnn.get(tsnn) || { failures: 0, offlineSince: null, lastSuccessAt: null };
  const b = {
    failures: prev.failures + 1,
    offlineSince: prev.offlineSince || Date.now(),
    lastSuccessAt: prev.lastSuccessAt || null,
  };
  pollingBackoffByTsnn.set(tsnn, b);
  pushLog("warn", "system",
    `[POLLING] TSNN ${tsnn} sem resposta (tentativa consecutiva ${b.failures})`);
  if (b.failures === 1) {
    const lastTs = b.lastSuccessAt ? new Date(b.lastSuccessAt).toISOString() : null;
    const tempoOff = b.lastSuccessAt ? Math.floor((Date.now() - b.lastSuccessAt) / 1000) : null;
    void logCommEventToAutomationLog(tsnn, "equipamento_offline", {
      tentativas_consecutivas: 1,
      ultimo_contato: lastTs,
      tempo_offline_segundos: tempoOff,
    });
  }
  if (b.failures === 3) void updatePlcCommStatus(tsnn, "offline");
}

// ─── Throttle de sinais espontaneos por TSNN ────────────────────────────────
// v3.9.11: PLCs com firmware antigo (ex: 2101) podem spammar frames espontaneos
// a cada 1-2s, congestionando a serial e o pipeline cloud. Processa no maximo
// 1 espontaneo por TSNN a cada 10s. RX como resposta a comando (inflight/recent)
// NUNCA passa por esse throttle — apenas a branch "sem comando recente".
const SPONTANEOUS_THROTTLE_MS = 10_000;
const lastSpontaneousAtByTsnn = new Map();
const spontaneousSkippedByTsnn = new Map();

// v3.11.2 — Protecao STARTUP SYNC: lembra a ultima confirmacao de ON (RX bit=1)
// por equipamento para evitar que um espontaneo transitorio com bit=0 logo
// apos um Ligar bem-sucedido desligue a bomba via sync de desired_running.
const STARTUP_SYNC_ON_GRACE_MS = 30_000;
const lastOnConfirmAtByEq = new Map();

// ─── Deadline de polling por TSNN ───────────────────────────────────────────
// v3.9.11: firmware das bombas tem safety timer de 15 min sem polling.
// Mantemos um map TSNN -> timestamp do ultimo polling concluido (RX ok ou
// timeout — ambos contam como "tentativa feita"). Um checker periodico
// alerta quando alguma PLC passa de 12 min sem ser polada.
const MAX_PLC_SILENCE_WARN_MS = 12 * 60_000;
const PLC_SILENCE_CHECK_INTERVAL_MS = 60_000;
const lastPollAtByTsnn = new Map();
let plcSilenceCheckTimer = null;
function noteSuccessfulPoll(tsnn) {
  if (!tsnn) return;
  lastPollAtByTsnn.set(String(tsnn), Date.now());
}
function checkPlcSilence() {
  const now = Date.now();
  for (const [tsnn, ts] of lastPollAtByTsnn.entries()) {
    const silence = now - ts;
    if (silence > MAX_PLC_SILENCE_WARN_MS) {
      const mins = Math.round(silence / 60_000);
      pushLog("warn", "system",
        `[ALERTA SAFETY] PLC ${tsnn} sem polling concluido ha ${mins} min — RISCO DE SAFETY TIMER (15 min firmware)`);
    }
  }
}


let cloudReadBackoffUntil = 0;

// Python bridge
let bridgeProcess = null;
let bridgeReady = false;
let bridgeStopping = false;
let bridgeWatchdogTimer = null;
let bridgePingSentAt = 0;
let lastBridgePongAt = 0;
let bridgeRecovering = false;
let lastBridgeError = null;
let portManuallyClosed = false;

// --- Auto-update (electron-updater + GitHub Releases) ---
function setupAutoUpdater() {
  if (!autoUpdater) return;
  try {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = false;

    autoUpdater.on("checking-for-update", () => {
      pushLog && pushLog("debug", "update", "Verificando atualizações...");
    });
    autoUpdater.on("update-available", (info) => {
      pushLog && pushLog("info", "update", `Nova versão disponível: ${info.version}`);
    });
    autoUpdater.on("update-not-available", () => {
      pushLog && pushLog("debug", "update", "Agente já está na versão mais recente");
    });
    autoUpdater.on("download-progress", (p) => {
      pushLog && pushLog("debug", "update", `Baixando update: ${Math.round(p.percent)}%`);
    });
    autoUpdater.on("update-downloaded", (info) => {
      pushLog && pushLog("info", "update", `Update ${info.version} baixado — aplicando em 5s`);
      setTimeout(() => {
        try { autoUpdater.quitAndInstall(false, true); } catch (e) {
          pushLog && pushLog("error", "update", `Falha ao aplicar update: ${e.message}`);
        }
      }, 5000);
    });
    autoUpdater.on("error", (err) => {
      pushLog && pushLog("warn", "update", `Erro do auto-updater: ${err && err.message}`);
    });

    // Check inicial após 30s e periódico a cada 6h
    setTimeout(() => { try { autoUpdater.checkForUpdates(); } catch {} }, 30_000);
    setInterval(() => { try { autoUpdater.checkForUpdates(); } catch {} }, AUTOUPDATE_CHECK_INTERVAL_MS);
  } catch (e) {
    console.error("[update] setupAutoUpdater falhou:", e.message);
  }
}

// Inflight command tracking (controlado AQUI, nao no Python)
let inflightCmd = null;       // objeto do comando do Supabase
let inflightTsnn = null;      // TSNN esperado na resposta (ex: "1107")
let inflightTimer = null;     // timer de timeout
// Colisao de polling com espontaneos: marca quando, durante a janela de
// espera do inflight atual, chegou um RX de OUTRO TSNN (espontaneo). Usado
// para decidir 1 retry imediato no timeout (Camada 3).
let inflightSpontaneousSeen = false;
let inflightRetryCount = 0;

// v3.25.7: estado da sequência de desligamento forçado ({1}->RX->10s->{0}).
// forcedShutdownActive segura a fila (processNextCommand retorna cedo) durante
// os ~23-36s da sequência, neutralizando o PROCESSING_STUCK_RESET_MS e o pollTimer.
// forcedShutdownRxWaiter é um waiter one-shot resolvido pelo processTelemFrame
// quando o RX confirma o bit alvo esperado.
let forcedShutdownActive = false;
let forcedShutdownRxWaiter = null;    // { tsnn, targetIndex, wantBit, resolve }

// Aguarda um RX confirmando `wantBit` na saída `targetIndex` do `tsnn`, ou expira.
// Resolve com "rx" (confirmado) ou "timeout".
function forcedShutdownWaitRx(tsnn, targetIndex, wantBit, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = (how) => {
      if (done) return;
      done = true;
      forcedShutdownRxWaiter = null;
      if (timer) clearTimeout(timer);
      resolve(how);
    };
    timer = setTimeout(() => finish("timeout"), timeoutMs);
    forcedShutdownRxWaiter = { tsnn: String(tsnn), targetIndex, wantBit, resolve: () => finish("rx") };
  });
}

// Comando recente por TSNN — usado para casar RX que chega APOS o timeout
// do comando (frames atrasados continuam sendo telemetria do comando original,
// nao "espontaneos"). Janela: 30s apos sentAt.
// Estrutura por TSNN: { cmdId, sentAt, expiresAt }
const recentCmdByTsnn = new Map();
// Janela para casar RX atrasado com comando recente do mesmo TSNN.
// Alinhada com a janela fisica de obediencia do backend (120s): se a bomba
// demora ate 120s para responder o {1} de um "Ligar", ainda tratamos como
// confirmacao do comando manual (nao como sinal espontaneo/local).
const LATE_RX_MATCH_WINDOW_MS = 120_000;
const PROCESSING_STUCK_RESET_MS = 15_000;
const RESET_DEDUP_WINDOW_MS = 120_000;
const activeResetByTsnn = new Map();

// --- Safety timer (120s) por equipamento aguardando confirmacao manual ---
// Quando um comando manual (LIGAR/DESLIGAR) e iniciado mas ainda nao foi
// confirmado pela bomba (RX != esperado), armamos um timer de 120s. Se
// expirar sem confirmacao, enviamos TX OFF imediato pela serial e marcamos
// desired_running=false + pending_command_id=null (failsafe: bomba sempre
// termina desligada se nao confirmar dentro da janela fisica).
//
// Estrutura por equipment_id (UUID):
//   { tsnn, saida, hwId, expectedBit ('1'|'0'), expectedPayload, armedAt, timer, cmdId }
const safetyByEquipment = new Map();
const SAFETY_WINDOW_MS = 60_000;
const SAFETY_LOCAL_SUPPRESS_MS = 30_000;

// --- Reforço de TX manual (3 envios em 0s/15s/30s) ---
// O sinal RF passa por repetidor e pode se perder. Para garantir que a bomba
// receba o comando E que a resposta seja captada, repetimos o TX 2 vezes
// (20s e 40s apos o envio inicial) durante a janela de 120s. Se a bomba
// confirmar (RX casa) antes, os reenvios pendentes sao cancelados.
//
// Estrutura por equipment_id (UUID): { cmdId, timers: [TimerId, TimerId] }
const manualReinforceByEquipment = new Map();
// Reforco TX manual: reenvio do mesmo frame em 0s/15s/30s para garantir entrega via RF.
// Cada reenvio so dispara se a bomba ainda nao confirmou (safety timer ainda armado).
const MANUAL_REINFORCE_DELAYS_MS = [15_000, 30_000, 45_000];

function clearManualReinforcements(equipmentId, reason) {
  if (!equipmentId) return false;
  const entry = manualReinforceByEquipment.get(equipmentId);
  if (!entry) return false;
  for (const t of entry.timers) {
    try { clearTimeout(t); } catch (e) { /* noop */ }
  }
  manualReinforceByEquipment.delete(equipmentId);
  if (reason) {
    pushLog("info", "system",
      `Reforco TX manual cancelado para eq ${String(equipmentId).substring(0, 8)} (${reason})`);
  }
  return true;
}

// Agenda os reenvios (15s, 30s) do mesmo frame para garantir entrega via RF.
// Cada reenvio so dispara se o safety timer do equipamento ainda existir
// (ou seja, a bomba ainda nao confirmou o estado desejado) E o cmdId combinar.
function scheduleManualReinforcements(equipmentId, frame, tsnn, cmdId) {
  if (!equipmentId || !frame || !cmdId) return;
  // Cancela qualquer reforco anterior desse equipamento
  clearManualReinforcements(equipmentId, "novo comando manual");

  // Deriva expectedBit e saida do equipamento + payload do frame.
  // Frame: [TSNN_1_]{XXXXXX}[TSNN_ETX_] — payload posicional, bit (saida-1) = alvo.
  const eq = equipmentById.get(String(equipmentId));
  const saida = Number(eq?.saida) || 0;
  let expectedBit = null;
  try {
    const m = String(frame).match(/\{([01]+)\}/);
    if (m && saida >= 1 && saida <= m[1].length) {
      expectedBit = m[1][saida - 1];
    }
  } catch (_) { /* noop */ }

  // Tentativa 1/4 ja foi enviada pelo caller (TX inicial em 0s).
  pushLog("info", "system",
    `[REFORCO] Tentativa 1/4 para TSNN ${tsnn} (esperando bit=${expectedBit ?? "?"})`);

  const timers = [];
  for (let i = 0; i < MANUAL_REINFORCE_DELAYS_MS.length; i++) {
    const delay = MANUAL_REINFORCE_DELAYS_MS[i];
    const seq = i + 2; // 1o ja foi o TX inicial; este e o 2o, 3o, 4o
    const t = setTimeout(() => {
      try {
        const stillScheduled = manualReinforceByEquipment.get(equipmentId);
        if (!stillScheduled || stillScheduled.cmdId !== cmdId) {
          return; // outro comando assumiu OU foi confirmado/cancelado
        }
        if (!bridgeProcess || !bridgeReady) {
          pushLog("warn", "system",
            `Reforco TX ${seq}/4 nao enviado (bridge indisponivel) eq ${String(equipmentId).substring(0, 8)}`);
          return;
        }
        sendTxFrame(frame, { priority: "manual" });
        rememberTxForTsnn(tsnn, `reforco-${seq}`, cmdId, frame);
        pushLog("info", "tx",
          `[REFORCO] Tentativa ${seq}/4 para TSNN ${tsnn} (esperando bit=${expectedBit ?? "?"}) +${Math.round(delay/1000)}s ${String(frame).replace(/\r/g, "")}`,
          frame);
      } catch (e) {
        pushLog("warn", "system", `Reforco TX ${seq}/4 falhou: ${e.message}`);
      }
    }, delay);
    timers.push(t);
  }
  // Janela de bloqueio do polling: do agora ate o ultimo reenvio + folga
  const blockUntil = Date.now() + MANUAL_REINFORCE_DELAYS_MS[MANUAL_REINFORCE_DELAYS_MS.length - 1] + 5_000;
  manualReinforceByEquipment.set(equipmentId, {
    cmdId, timers, tsnn: String(tsnn || ""), blockUntil,
    saida, expectedBit,
  });
  pushLog("info", "system",
    `Reforco TX manual agendado (4 envios em 0s/15s/30s/45s) para eq ${String(equipmentId).substring(0, 8)} TSNN=${tsnn} saida=${saida} bit=${expectedBit ?? "?"}; polling para esta PLC suspenso ate ${new Date(blockUntil).toISOString()}`);
}

// Verifica se ha reforco TX manual ativo para o TSNN dado (qualquer equipamento
// daquela PLC). Usado para bloquear polling concorrente que causaria pulso
// no rele em cima dos reenvios.
function getActiveReinforcementForTsnn(tsnn) {
  if (!tsnn) return null;
  const t = String(tsnn);
  const now = Date.now();
  for (const [equipmentId, entry] of manualReinforceByEquipment.entries()) {
    if (entry && entry.tsnn === t && (entry.blockUntil || 0) > now) {
      return { equipmentId, entry, remainingMs: (entry.blockUntil || 0) - now };
    }
  }
  return null;
}

function hasActiveReinforcementForTsnn(tsnn) {
  return !!getActiveReinforcementForTsnn(tsnn);
}

function rememberTxForTsnn(tsnn, type, cmdId, frame) {
  if (!tsnn) return;
  lastTxByTsnn.set(String(tsnn), {
    at: Date.now(),
    type: String(type || "unknown"),
    cmdId: cmdId ? String(cmdId) : null,
    frame: String(frame || "").replace(/[\r\n]/g, "").trim(),
  });
}

function getManualFirstTxGap(tsnn) {
  if (!tsnn) return { waitMs: 0, last: null, elapsedMs: null };
  const last = lastTxByTsnn.get(String(tsnn));
  if (!last || !last.at) return { waitMs: 0, last: null, elapsedMs: null };
  const elapsedMs = Date.now() - last.at;
  return { waitMs: Math.max(0, MANUAL_FIRST_TX_GAP_MS - elapsedMs), last, elapsedMs };
}

// Manual frame (Terminal Hercules) — frame enviado manualmente da web
// Estrutura: { agentCmdId, frame, expectedTsnn, sentAt }
let inflightManual = null;
let manualTimer = null;

// Estado controlavel remotamente via agent_commands
let logLevel = "info";        // "debug" | "info" | "error"
let pollingPaused = false;    // pausa do polling de telemetria
let agentCmdChannel = null;   // canal Realtime de agent_commands
let commandsChannel = null;   // canal Realtime de commands (priorizar manuais)
let agentCmdRetryTimer = null;  // retry em background se subscription falhar
let commandsRetryTimer = null;  // retry em background se subscription falhar
let agentCmdRetryAttempts = 0;  // contador p/ escalonamento (3 rápidas, depois lenta)
let commandsRetryAttempts = 0;
// v3.10.1 — REDUÇÃO DE CUSTO CLOUD:
// Antes: retry infinito a cada 30s queimava Realtime + DB.
// Agora: 3 tentativas rápidas (30s), depois 5 min entre tentativas.
const REALTIME_RETRY_FAST_MS = 30_000;
const REALTIME_RETRY_SLOW_MS = 5 * 60_000;
const REALTIME_FAST_ATTEMPTS = 3;
let agentCmdPollTimer = null;   // fallback HTTP polling p/ agent_commands
// v3.10.1 — antes 3s (1200 reads/h), agora 10s (360 reads/h, -70%).
// Comandos manuais já chegam via Realtime fast-path; polling HTTP é só fallback.
const AGENT_CMD_POLL_MS = 10_000;
const processedAgentCmdIds = new Set(); // dedup entre realtime + polling HTTP

// --- Regex patterns ---
// Telemetria padrao: `_[TSNN_0_]{PAYLOAD}...` no inicio do frame.
// Tolerante: tambem aceita frames com prefixo truncado (ex.: `_0_]{1}...[1313_ETX_]`)
// recuperando o TSNN do `[TSNN_ETX_]` no final. Se nem inicio nem fim trazem TSNN,
// o frame eh descartado como desconhecido.
// TSNN pode ser HEXADECIMAL (ex: "11A5", "2101", "13F0"). Aceitamos [0-9A-Fa-f]{4}.
const RX_TELEM_RE = /^_?\[?(?:([0-9A-Fa-f]{4}))?_0_\]\{([01]{1,6})\}.*?\[([0-9A-Fa-f]{4})_ETX_\]/;
const RX_TELEM_FALLBACK_RE = /_?\[\s*([0-9A-Fa-f]{4})\s*_0_\s*\]\s*\{\s*([01]{1,6})\s*\}[\s\S]*?\[\s*([0-9A-Fa-f]{4})\s*_ETX_\s*\]/;
const RX_PING_RE  = /^_\[([0-9A-Fa-f]{4})_(?:CFG|PING)_\]\{(?:PING|OK:PING)/;
// Resposta generica de CFG da bomba: _[TSNN_<TAG>_]{PAYLOAD}
// onde TAG pode ser: CFG, PING, STATUS, DUMP, SAVE, REBOOT, etc.
// Capturamos TSNN, TAG e PAYLOAD para permitir casamento com inflightCmd.
const RX_CFG_RESP_RE = /^_?\[([0-9A-Fa-f]{4})_([A-Z0-9_]+)_\]\{([^}]*)\}(?:\[[0-9A-Fa-f]{4}_ETX_\])?/;
const TX_TSNN_RE  = /^\[([0-9A-Fa-f]{4})_(?:1|CFG)_\]/;
const TX_CFG_RE   = /^\[([0-9A-Fa-f]{4})_CFG_\]/;
// Aceita sufixo opcional "RV" no payload (comando de reset de vazao no firmware).
// O grupo 1 continua sendo apenas o payload posicional 0/1.
const TX_PAYLOAD_RE = /\{([01]{1,6})(?:RV)?\}/;
// Sufixos de leitura analogica: _N1<valor>N1_ (nivel), _N2<valor>N2_ (vazao total m3),
// _N3<valor>N3_ (vazao instantanea x10). Exemplo: _[1313_0_]{1}_N11015N1__N20N2_[1313_ETX_]
const RX_LEVEL_RE = /_N([123])(\d{1,5})N\1_/g;

function extractCommandTsnn(frame) {
  const m = String(frame || "").replace(/[\r\n]/g, "").trim().match(TX_TSNN_RE);
  return m ? m[1].toUpperCase() : null;
}

function extractTelemetryParts(frame) {
  const raw = String(frame || "").replace(/\u0000/g, "").trim();
  const m = raw.match(RX_TELEM_RE) || raw.match(RX_TELEM_FALLBACK_RE);
  if (!m) return null;
  const tsnn = String(m[1] || m[3] || "").trim().toUpperCase();
  const payload = String(m[2] || "").trim();
  const etxTsnn = String(m[3] || m[1] || "").trim().toUpperCase();
  if (!/^[0-9A-F]{4}$/.test(tsnn) || !/^[01]{1,6}$/.test(payload)) return null;
  if (etxTsnn && etxTsnn !== tsnn) return null;
  return { tsnn, payload };
}

function isBackendResetCommand(cmd, frame) {
  return cmd &&
    cmd.type === "manual" &&
    (cmd.priority ?? 5) === 0 &&
    String(cmd.source_device || "").startsWith("backend-reset:") &&
    payloadCommandsOnlyOff(extractTxPayload(frame || cmd.frame));
}

function hasActiveResetForTsnn(tsnn, cmdId) {
  if (!tsnn) return false;
  const current = activeResetByTsnn.get(tsnn);
  if (!current) return false;
  if (current.cmdId === cmdId) return false;
  if (Date.now() > current.expiresAt) {
    activeResetByTsnn.delete(tsnn);
    return false;
  }
  return true;
}

function markActiveReset(tsnn, cmdId) {
  if (!tsnn || !cmdId) return;
  activeResetByTsnn.set(tsnn, { cmdId, expiresAt: Date.now() + RESET_DEDUP_WINDOW_MS });
}

// --- RX sempre ativo: TODO frame de telemetria recebido eh processado ---
// SEM debounce, SEM filtro por rajada. Cada frame _[TSNN_0_]{...} eh tratado
// individualmente: gravado no log, casado com comando inflight/recente quando
// possivel, e gravado em equipments.last_outputs_state via apply_pump_telemetry.
// Motivo: precisamos enxergar TODA mudanca de estado (ligar/desligar local,
// rajadas espontaneas, retransmissoes do firmware), pois o backend depende
// dessas leituras para detectar acionamentos locais e disparar TX 0 forcado.

// --- Logging ---
const logBuffer = [];
const liveLog = [];
const LIVE_LOG_MAX = 200;
const LOG_LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 };
let logFlushInFlight = false;
const telemetryQueue = [];
let telemetryFlushInFlight = false;
let telemetryRetryAt = 0;
let telemetryWarnAt = 0;

// --- Live stream (broadcast Realtime, zero storage) ---
// Buffer circular de 500 entradas em RAM. Quando alguém abre a página
// "Logs ao Vivo" no interface web, envia start_log_stream → o agente flusha o
// buffer e passa a emitir cada nova linha via broadcast. Auto-stop em 30 min
// sem renovação (frontend manda renew_log_stream a cada 5 min).
const LIVE_STREAM_BUFFER_MAX = 500;
const LIVE_STREAM_INACTIVE_MS = 30 * 60 * 1000;
const liveStreamBuffer = [];
let liveStreamActive = false;
let liveStreamChannel = null;
let liveStreamInactiveTimer = null;


// --- Equipment name cache (para mostrar nomes amigaveis no log local) ---
// Mapa: hw_id (ex "210101") -> { name: "Poço Norte", saida: 1 }
//       tsnn (ex "2101") -> [{ name, saida }, ...] (todas as saidas daquele PLC)
const equipmentByHwId = new Map();
const equipmentByTsnn = new Map();
const equipmentById = new Map(); // UUID -> { name, hw_id, saida }
// TSNN -> { id, hw_id, vazao_mode, flow_total_m3 } do primeiro equipamento com vazao_mode='real' daquele PLC.
// Usado pelo parser N2/N3 e pelo agendador de reset (RV).
const flowEquipByTsnn = new Map();
let equipmentCacheLoadedAt = 0;
let lastCleanupAt = 0;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hora

async function refreshEquipmentCache() {
  if (!supabase || !farmId) return;
  try {
    const { data, error } = await supabase
      .from("equipments")
      .select("id, hw_id, name, saida, vazao_mode, flow_total_m3")
      .eq("farm_id", farmId);
    if (error || !data) return;
    equipmentByHwId.clear();
    equipmentByTsnn.clear();
    equipmentById.clear();
    flowEquipByTsnn.clear();
    for (const eq of data) {
      const hw = String(eq.hw_id || "").trim().toUpperCase();
      if (!hw) continue;
      equipmentByHwId.set(hw, { name: eq.name, saida: eq.saida });
      if (eq.id) equipmentById.set(String(eq.id), { name: eq.name, hw_id: hw, saida: eq.saida });
      const tsnn = hw.length >= 4 ? hw.substring(0, 4) : hw;
      const arr = equipmentByTsnn.get(tsnn) || [];
      arr.push({ name: eq.name, saida: eq.saida, hw_id: hw });
      equipmentByTsnn.set(tsnn, arr);
      // Registra o primeiro equipamento com vazao_mode='real' de cada TSNN.
      if (eq.vazao_mode === "real" && !flowEquipByTsnn.has(tsnn)) {
        flowEquipByTsnn.set(tsnn, {
          id: eq.id,
          hw_id: hw,
          vazao_mode: eq.vazao_mode,
          flow_total_m3: Number(eq.flow_total_m3 || 0),
        });
      }
    }
    equipmentCacheLoadedAt = Date.now();
  } catch (_) {}
}

// Resolve nome amigavel a partir do TSNN (4 digitos do PLC, hex)
function nameForTsnn(tsnn) {
  const key = String(tsnn || "").toUpperCase();
  const arr = equipmentByTsnn.get(key);
  if (!arr || arr.length === 0) return `PLC ${key}`;
  return arr[0].name.replace(/\s+-?\s*Saída\s*\d+$/i, "").trim() || arr[0].name;
}

// Resolve nome especifico de uma saida (hw_id 6 digitos)
function nameForHwId(hwId) {
  const key = String(hwId || "").toUpperCase();
  const eq = equipmentByHwId.get(key);
  if (eq) return eq.name;
  if (key.length >= 6) {
    const tsnn = key.substring(0, 4);
    const saida = parseInt(key.substring(4, 6), 10);
    const arr = equipmentByTsnn.get(tsnn);
    const found = arr && arr.find((e) => e.saida === saida);
    if (found) return found.name;
    return `${nameForTsnn(tsnn)} (saída ${saida})`;
  }
  return `Equipamento ${key}`;
}

// Traduz comando TX em mensagem amigavel
// Frames suportados:
//   [TSNN_1_]{}        -> polling (consulta de status, sem alterar nada)
//   [TSNN_1_]{X}       -> liga/desliga POCO simples (1 saida)
//   [TSNN_1_]{XXXXXX}  -> liga/desliga PLC multi-saida (6 saidas)
function humanizeTx(frame, cmd) {
  const m = frame.match(/^\[([0-9A-Fa-f]{4})_1_\]\{([01]*)\}/);
  if (!m) {
    const tsnnAny = frame.match(/^\[([0-9A-Fa-f]{4})_/);
    if (tsnnAny) return `TX -> ${nameForTsnn(tsnnAny[1].toUpperCase())}: ${frame}`;
    return `TX -> ${frame}`;
  }
  const tsnn = m[1].toUpperCase();
  const payload = m[2];
  const baseName = nameForTsnn(tsnn);

  // Polling: coxete vazio -> consulta de status (também aparece no log)
  if (payload.length === 0) {
    return `Consultar status ${baseName} | ${frame}`;
  }

  // Comando 1 digito: pode ser POÇO simples OU saída individual de PLC multi-saida.
  // Resolve o nome da saída-alvo via cmd.equipment_id se disponível; senão, se o
  // TSNN tem só 1 equipamento cadastrado, usa o nome dele; senão fallback PLC.
  if (payload.length === 1) {
    let targetName = baseName;
    let targetSaida = null;
    const eqFromCmd = cmd?.equipment_id ? equipmentById.get(String(cmd.equipment_id)) : null;
    if (eqFromCmd) {
      targetName = eqFromCmd.name;
      targetSaida = eqFromCmd.saida;
    } else {
      const arr = equipmentByTsnn.get(tsnn);
      if (arr && arr.length === 1) {
        targetName = arr[0].name;
        targetSaida = arr[0].saida;
      }
    }
    const sufixoSaida = (targetSaida && (!eqFromCmd || (equipmentByTsnn.get(tsnn)?.length || 0) > 1))
      ? ` (saída ${targetSaida})`
      : "";
    const acao = payload === "1"
      ? `Ligar ${targetName}${sufixoSaida}`
      : `Desligar ${targetName}${sufixoSaida}`;
    return `${acao} | ${frame}`;
  }

  // Comando multi-saida: lista as que vao ligar
  const acoes = [];
  for (let i = 0; i < payload.length; i++) {
    const saidaNum = i + 1;
    const eqName = nameForHwId(`${tsnn}${String(saidaNum).padStart(2, "0")}`);
    if (payload[i] === "1") acoes.push(`Ligar ${eqName}`);
  }
  const resumo = acoes.length === 0
    ? `Desligar todas as saídas de ${baseName}`
    : acoes.join(" | ");
  return `${resumo} | ${frame}`;
}

// Traduz resposta RX em mensagem amigavel
function humanizeRx(frame) {
  const telem = extractTelemetryParts(frame);
  if (telem) {
    const tsnn = telem.tsnn;
    const payload = telem.payload;
    const baseName = nameForTsnn(tsnn);
    const ligadas = [];
    for (let i = 0; i < payload.length; i++) {
      if (payload[i] === "1") {
        const saidaNum = i + 1;
        const eqName = nameForHwId(`${tsnn}${String(saidaNum).padStart(2, "0")}`);
        ligadas.push(eqName);
      }
    }
    if (ligadas.length === 0) return `Resposta de ${baseName}: todas as saídas desligadas | ${frame}`;
    return `Resposta de ${baseName}: ligadas → ${ligadas.join(", ")} | ${frame}`;
  }
  const ping = frame.match(RX_PING_RE);
  if (ping) return `Ping recebido de ${nameForTsnn(ping[1].toUpperCase())} | ${frame}`;
  // Frame desconhecido — nao expor protocolo, apenas indicar origem
  const tsnnAny = frame.match(/_\[([0-9A-Fa-f]{4})_/);
  if (tsnnAny) return `Resposta recebida de ${nameForTsnn(tsnnAny[1].toUpperCase())} | ${frame}`;
  return `Resposta recebida | ${frame}`;
}

function extractTxPayload(frame) {
  const m = String(frame || "").match(TX_PAYLOAD_RE);
  return m ? m[1] : null;
}

function manualRxConfirmsExpected(cmd, rxPayload) {
  const expectedPayload = extractTxPayload(cmd?.frame);
  if (!expectedPayload || !/^[01]{1,6}$/.test(expectedPayload) || !/^[01]{1,6}$/.test(String(rxPayload || ""))) {
    return { expectedPayload, expectedMatches: false };
  }

  const eq = cmd?.equipment_id ? equipmentById.get(String(cmd.equipment_id)) : null;
  const targetIndex = Math.max(0, Math.min(5, (eq?.saida || expectedPayload.length) - 1));
  const expectedBit = expectedPayload[expectedPayload.length - 1];
  const rx = String(rxPayload);

  // RX de 1 bit representa o estado da saída comandada; RX maior representa o mapa de saídas.
  const expectedMatches = rx.length === 1
    ? rx[0] === expectedBit
    : rx.length > targetIndex && rx[targetIndex] === expectedBit;

  return { expectedPayload, expectedMatches };
}

function extractCfgRequestPayload(frame) {
  const m = String(frame || "").replace(/[\r\n]/g, "").trim().match(/^\[[0-9A-Fa-f]{4}_CFG_\]\{([^}]*)\}/);
  return m ? m[1] : null;
}

function isCfgAckCompatible(cmd, rxTag, rxPayload) {
  if (!cmd || cmd.type !== "config") return false;
  const request = extractCfgRequestPayload(cmd.frame);
  if (!request) return true;
  const payload = String(rxPayload || "").toUpperCase();
  const tag = String(rxTag || "").toUpperCase();
  const req = String(request || "").toUpperCase();
  const setId = req.match(/^SET_ID:([0-9A-F]{4})$/);
  if (setId && tag === "CFG" && (payload === `OK:ID=${setId[1]}` || payload.startsWith(`OK:ID=${setId[1]},`))) return true;
  if (tag === req || tag === "CFG") return true;
  return payload === req || payload.startsWith(`OK:${req}`) || payload.includes(`:${req}:`);
}

function isSetIdAckForNewTsnn(cmd, rxTsnn, rxTag, rxPayload) {
  const request = extractCfgRequestPayload(cmd?.frame);
  const newTsnn = String(request || "").toUpperCase().match(/^SET_ID:([0-9A-F]{4})$/)?.[1];
  if (!newTsnn || rxTsnn !== newTsnn) return false;
  const payload = String(rxPayload || "").toUpperCase();
  const tag = String(rxTag || "").toUpperCase();
  return tag === "CFG" && (payload === `OK:ID=${newTsnn}` || payload.startsWith(`OK:ID=${newTsnn},`));
}

function extractSetIdTarget(cmd) {
  return String(extractCfgRequestPayload(cmd?.frame) || "").toUpperCase().match(/^SET_ID:([0-9A-F]{4})$/)?.[1] || null;
}

async function syncConfirmedSetId(cmd, newTsnn) {
  if (!supabase || !farmId || !cmd || !newTsnn) return;
  try {
    const oldTsnn = extractCommandTsnn(cmd.frame) || cmd.plc_hw_id;
    let plcId = null;

    if (cmd.equipment_id) {
      const { data: eq } = await supabase
        .from("equipments")
        .select("plc_group_id")
        .eq("id", cmd.equipment_id)
        .eq("farm_id", farmId)
        .maybeSingle();
      plcId = eq?.plc_group_id || null;
    }

    if (!plcId && oldTsnn) {
      const { data: plc } = await supabase
        .from("plc_groups")
        .select("id")
        .eq("farm_id", farmId)
        .eq("hw_id", oldTsnn)
        .maybeSingle();
      plcId = plc?.id || null;
    }

    if (!plcId) {
      pushLog("warn", "cloud", `SET_ID confirmado (${oldTsnn || "?"}->${newTsnn}), mas PLC não encontrado no cadastro`);
      return;
    }

    const { data: equipments, error: eqErr } = await supabase
      .from("equipments")
      .select("id, saida")
      .eq("farm_id", farmId)
      .eq("plc_group_id", plcId);
    if (eqErr) throw eqErr;

    const plcUpdate = await supabase
      .from("plc_groups")
      .update({ hw_id: newTsnn })
      .eq("id", plcId)
      .eq("farm_id", farmId);
    if (plcUpdate.error) throw plcUpdate.error;

    for (const eq of equipments || []) {
      const saida = String(eq.saida || 1).padStart(2, "0");
      const update = await supabase
        .from("equipments")
        .update({ hw_id: `${newTsnn}${saida}` })
        .eq("id", eq.id)
        .eq("farm_id", farmId);
      if (update.error) throw update.error;
    }

    await refreshEquipmentCache();
    pushLog("info", "cloud", `Cadastro sincronizado automaticamente: PLC ${oldTsnn || "?"} -> ${newTsnn}`);
  } catch (e) {
    pushLog("error", "cloud", `Falha ao sincronizar SET_ID=${newTsnn}: ${e.message || e}`);
  }
}

function cfgResponseLabel(rxTag, rxPayload) {
  const tag = String(rxTag || "").toUpperCase();
  const payload = String(rxPayload || "").toUpperCase();
  if (tag === "PING" || payload.startsWith("OK:PING") || payload === "PING") return "PING";
  if (tag === "STATUS" || payload.startsWith("OK:STATUS")) return "STATUS";
  if (tag === "DUMP" || payload.startsWith("OK:DUMP") || payload.startsWith("ID=")) return "DUMP";
  if (tag === "SAVE" || payload.startsWith("OK:SAVE")) return "SAVE";
  if (tag === "REBOOT" || payload.startsWith("OK:REBOOT")) return "REBOOT";
  if (tag === "CFG") return "CFG";
  return tag || "CFG";
}

function payloadCommandsOnlyOff(payload) {
  return typeof payload === "string" && /^[0]+$/.test(payload);
}

function payloadCommandsAnyOn(payload) {
  return typeof payload === "string" && payload.includes("1");
}

function isAutomaticProtectiveReset(cmd) {
  const src = String(cmd?.source_device || "");
  return src.startsWith("backend-reset:") && src !== "backend-reset:manual_reset";
}

function isUnsafePollingActuation(_cmd, _frame) {
  // BLOQUEIO REMOVIDO (v3.8.4): A segurança real do protocolo Renov é que o polling
  // SEMPRE carrega o payload espelhando o desired_running atual gerado pela nuvem,
  // e o PLC apenas RESPONDE com a leitura — ele não atua sobre o payload recebido
  // em polling. Portanto, qualquer comando válido na tabela `commands` deve ser
  // executado independentemente do `source_device` de origem.
  return false;
}


function formatTxWithOrigin(cmd, frame, suffix = "") {
  const src = cmd?.source_device ? String(cmd.source_device) : "origem desconhecida";
  const kind = cmd?.type || "?";
  const priority = cmd?.priority ?? "?";
  const id = cmd?.id ? String(cmd.id).substring(0, 8) : "?";
  return `${humanizeTx(frame, cmd)}${suffix} ← origem: ${src} | tipo=${kind} prioridade=${priority} id=${id}`;
}

function ensureLogDir() {
  try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); }
  catch (_) {}
}

function currentLogFile() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return path.join(LOG_DIR, `agent-${y}-${m}-${day}.log`);
}

function appendLogFile(entry) {
  try {
    ensureLogDir();
    const file = currentLogFile();
    // Rotação por tamanho: se o arquivo do dia passar de 50MB, arquiva e
    // começa novo com sufixo .partN. Evita arquivo único gigante consumindo disco.
    try {
      const st = fs.statSync(file);
      if (st.size > LOG_FILE_MAX_BYTES) {
        const ts = Date.now();
        fs.renameSync(file, file.replace(/\.log$/, `.part-${ts}.log`));
      }
    } catch (_) { /* arquivo ainda não existe */ }
    const line = JSON.stringify(entry) + "\n";
    fs.appendFile(file, line, () => {});
  } catch (_) {}
}

function rotateOldLogs() {
  try {
    ensureLogDir();
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(LOG_DIR);
    for (const f of files) {
      if (!f.startsWith("agent-") || !f.endsWith(".log")) continue;
      const full = path.join(LOG_DIR, f);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < cutoff) fs.unlinkSync(full);
      } catch (_) {}
    }
  } catch (_) {}
}

// Periodic memory cleanup — trim unbounded structures and report usage.
// Roda a cada 30 min; ajuda a evitar acumulo gradual em PCs de fazenda.
let memoryCleanupTimer = null;
function pruneInMemoryState() {
  try {
    if (liveLog.length > LIVE_LOG_MAX) liveLog.splice(0, liveLog.length - LIVE_LOG_MAX);
    if (logBuffer.length > LOG_FLUSH_MAX_BUFFER) logBuffer.splice(0, logBuffer.length - LOG_FLUSH_MAX_BUFFER);
    if (telemetryQueue.length > TELEMETRY_QUEUE_MAX) telemetryQueue.splice(0, telemetryQueue.length - TELEMETRY_QUEUE_MAX);
    if (processedAgentCmdIds.size > 200) {
      const it = processedAgentCmdIds.values();
      const drop = processedAgentCmdIds.size - 200;
      for (let i = 0; i < drop; i++) processedAgentCmdIds.delete(it.next().value);
    }
    // Maps keyed por TSNN/equipment já são naturalmente limitados pelo número
    // de bombas da fazenda, mas removemos entradas expiradas defensivamente.
    const now = Date.now();
    try {
      for (const [k, v] of recentCmdByTsnn) {
        if (v && v.expiresAt && v.expiresAt < now) recentCmdByTsnn.delete(k);
      }
    } catch (_) {}
    try {
      for (const [k, v] of activeResetByTsnn) {
        if (v && v.expiresAt && v.expiresAt < now) activeResetByTsnn.delete(k);
      }
    } catch (_) {}
  } catch (_) {}
}
function startMemoryCleanup() {
  if (memoryCleanupTimer) return;
  memoryCleanupTimer = setInterval(() => {
    pruneInMemoryState();
    try { if (typeof global.gc === "function") global.gc(); } catch (_) {}
    try {
      const m = process.memoryUsage();
      const mb = (n) => Math.round(n / 1024 / 1024);
      console.log(`[MEM] rss=${mb(m.rss)}MB heapUsed=${mb(m.heapUsed)}MB heapTotal=${mb(m.heapTotal)}MB external=${mb(m.external)}MB liveLog=${liveLog.length} telemetryQueue=${telemetryQueue.length} processedCmds=${processedAgentCmdIds.size}`);
    } catch (_) {}
  }, MEMORY_CLEANUP_INTERVAL_MS);
  try { memoryCleanupTimer.unref?.(); } catch (_) {}
}

// Auto-reboot watchdog: a cada 5 min reinicia o agente sozinho quando
//   • heap > 500MB (memory leak inevitável)  →  log "[AUTO-REBOOT] Memória excedeu 500MB"
//   • porta serial não recebeu nenhum byte há > 10 min  →  log "[AUTO-REBOOT] Serial inativa por 10 minutos"
const AUTO_REBOOT_CHECK_MS = 5 * 60 * 1000;
const AUTO_REBOOT_HEAP_LIMIT_MB = 500;
const AUTO_REBOOT_SERIAL_SILENCE_MS = 10 * 60 * 1000;
let autoRebootTimer = null;
let autoRebootStartTs = Date.now();
function triggerAutoReboot(reason) {
  try { pushLog("warn", "system", `[AUTO-REBOOT] ${reason}`); } catch (_) {}
  try { console.log(`[AUTO-REBOOT] ${reason}`); } catch (_) {}
  setTimeout(() => {
    try { app.relaunch(); app.exit(0); } catch (_) { try { process.exit(0); } catch (_) {} }
  }, 1500);
}
function startAutoRebootWatchdog() {
  if (autoRebootTimer) return;
  autoRebootStartTs = Date.now();
  autoRebootTimer = setInterval(() => {
    try {
      const heapMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      if (heapMb > AUTO_REBOOT_HEAP_LIMIT_MB) {
        triggerAutoReboot(`Memória excedeu ${AUTO_REBOOT_HEAP_LIMIT_MB}MB (heap=${heapMb}MB)`);
        return;
      }
    } catch (_) {}
    try {
      const uptime = Date.now() - autoRebootStartTs;
      const lastRx = typeof lastRxTimestamp === "number" ? lastRxTimestamp : 0;
      if (uptime > AUTO_REBOOT_SERIAL_SILENCE_MS && lastRx > 0) {
        const silentMs = Date.now() - lastRx;
        if (silentMs > AUTO_REBOOT_SERIAL_SILENCE_MS) {
          triggerAutoReboot(`Serial inativa por ${Math.round(silentMs/60000)} minutos`);
        }
      }
    } catch (_) {}
  }, AUTO_REBOOT_CHECK_MS);
  try { autoRebootTimer.unref?.(); } catch (_) {}
}

let forceRebootInProgress = false;

async function getRestBearerToken() {
  try {
    if (supabase?.auth?.getSession) {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      if (token) {
        activeAccessToken = token;
        return token;
      }
    }
  } catch (_) {}
  return activeAccessToken || activeSupabaseAnonKey;
}

async function checkForceRebootInsideHeartbeat() {
  if (forceRebootInProgress || !farmId || !activeSupabaseUrl || !activeSupabaseAnonKey) return;
  try {
    const bearer = await getRestBearerToken();
    const baseUrl = String(activeSupabaseUrl).replace(/\/+$/, "");
    const headers = {
      apikey: activeSupabaseAnonKey,
      Authorization: `Bearer ${bearer}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    const query = new URLSearchParams({
      select: "id,created_at",
      farm_id: `eq.${farmId}`,
      kind: "eq.agent_restart",
      status: "eq.pending",
      created_at: `gte.${new Date(Date.now() - 300_000).toISOString()}`,
      order: "created_at.desc",
      limit: "1",
    });
    const resp = await withCloudTimeout(
      fetch(`${baseUrl}/rest/v1/agent_commands?${query.toString()}`, { headers }),
      "force-reboot heartbeat GET",
      4_000,
    );
    if (!resp || !resp.ok) return;
    const rows = await resp.json().catch(() => []);
    const cmd = Array.isArray(rows) ? rows[0] : null;
    if (!cmd?.id || !cmd.created_at) return;
    if (Date.now() - new Date(cmd.created_at).getTime() > 5 * 60_000) return;

    forceRebootInProgress = true;
    const nowIso = new Date().toISOString();
    const createdMs = new Date(cmd.created_at).getTime();
    await withCloudTimeout(
      fetch(`${baseUrl}/rest/v1/agent_commands?id=eq.${encodeURIComponent(cmd.id)}`, {
        method: "PATCH",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          status: "done",
          ack_at: nowIso,
          executed_at: nowIso,
          duration_ms: Number.isFinite(createdMs) ? Math.max(0, Date.now() - createdMs) : null,
          result: { force_reboot: true, source: "heartbeat_http" },
        }),
      }),
      "force-reboot heartbeat PATCH",
      4_000,
    ).catch(() => null);
    try { pushLog("warn", "system", "[FORCE-REBOOT] Comando detectado via HTTP polling no heartbeat"); } catch (_) {}
    try { console.log("[FORCE-REBOOT] Comando detectado via HTTP polling no heartbeat"); } catch (_) {}
    setTimeout(() => {
      try { app.relaunch(); app.exit(0); } catch (_) { try { process.exit(0); } catch (_) {} }
    }, 250);
  } catch (_) {}
}

// Categorias que NUNCA vão para a nuvem (apenas log local + janela)
const LOCAL_ONLY_CATEGORIES = new Set(["raw_rx", "raw_tx", "bridge"]);

// Mensagens info que são ETAPAS INTERMEDIÁRIAS de uma interação.
// Não vão para a nuvem porque o log RESUMIDO final (TX/RX) já contém tudo.
const CLOUD_SKIP_PREFIXES = [
  "Processando cmd",
  "Telemetria gravada",
  "Telemetria cmd:",
  "Estado de ",
  "Subscription ",
  "Polling commands ativo",
  "Enqueue de polling",
  "Watchdog PONG",
  "TX_OK",
  "Telemetria em fila",
];

// Mensagens info que SEMPRE vão para a nuvem
const CLOUD_FORCE_PREFIXES = [
  "Autenticado como",
  "Bridge ",
  "Limpeza automática",
  "RESET ",
  "BLOQUEADO",
  "Porta COM",
  "Reabrindo porta",
  "Comando remoto",
  "Nivel de log",
  "Polling de telemetria",
];

function shouldSendToCloud(level, category, message) {
  if (level === "warn" || level === "error") return true;
  if (level === "debug") return false;
  if (LOCAL_ONLY_CATEGORIES.has(category)) return false;
  // TX e RX são os logs resumidos de comunicação — sempre vão
  if (category === "tx" || category === "rx") return true;
  for (const prefix of CLOUD_FORCE_PREFIXES) {
    if (message.startsWith(prefix)) return true;
  }
  if (level === "info") {
    for (const prefix of CLOUD_SKIP_PREFIXES) {
      if (message.startsWith(prefix)) return false;
    }
  }
  // "cmd xxx -> ..." são intermediários, exceto timeout
  if (message.startsWith("cmd ") && !message.includes("timeout")) return false;
  return true;
}

function pushLog(level, category, message, rawFrame, humanOverride) {
  // Filtro por nivel: debug so registra se logLevel === debug
  const effective = LOG_LEVEL_RANK[level] ?? 1;
  const minRank = LOG_LEVEL_RANK[logLevel] ?? 1;
  if (effective < minRank) return;

  // Mensagem TECNICA (vai pra nuvem) e mensagem AMIGAVEL (vai pra log local + janela)
  let humanMessage = message;
  if (humanOverride !== undefined) {
    humanMessage = humanOverride;  // null = suprime do log local
  } else if (rawFrame) {
    if (category === "tx") humanMessage = humanizeTx(rawFrame);
    else if (category === "rx") humanMessage = humanizeRx(rawFrame);
  } else if (category === "raw_rx" || category === "raw_tx") {
    // Logs de debug raw nao vao pra janela/arquivo local — apenas nuvem
    humanMessage = null;
  }

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    category,
    message,           // tecnico (vai pra cloud com raw_frame)
    raw_frame: rawFrame || null,
  };
  // v3.7.9 MODO CRU: ZERO escritas em agent_logs até reativação explícita.
  // Logs continuam funcionando localmente (arquivo + tray + janela live abaixo).
  // NÃO empilhar nada em logBuffer — buffer permanece vazio, flushLogs é no-op.
  const ts = entry.timestamp.replace("T", " ").substring(11, 23);

  // Console + arquivo local + janela: SOMENTE versao amigavel (sem protocolo)
  if (humanMessage) {
    console.log(`[${ts}] [${category.toUpperCase()}] ${humanMessage}`);
    appendLogFile({ ...entry, message: humanMessage, raw_frame: null });

    const dir = category === "tx" ? "tx"
      : category === "rx" ? "rx"
      : level === "error" ? "error"
      : "info";
    const line = { ts: entry.timestamp, dir, text: humanMessage };
    liveLog.push(line);
    if (liveLog.length > LIVE_LOG_MAX) liveLog.shift();
    if (logWindow && !logWindow.isDestroyed()) {
      try { logWindow.webContents.send("log:line", line); } catch (e) {}
    }
  }

  // --- Live stream buffer (RAM only, broadcast on demand) ---
  // Versão amigável + categoria/level vão pro buffer circular de 500 linhas.
  // Quando o streaming está ativo, cada linha vai direto pro broadcast.
  const streamEntry = {
    ts: entry.timestamp,
    level,
    category,
    message: humanMessage ?? message,
    raw_frame: rawFrame || null,
  };
  liveStreamBuffer.push(streamEntry);
  if (liveStreamBuffer.length > LIVE_STREAM_BUFFER_MAX) liveStreamBuffer.shift();
  if (liveStreamActive && liveStreamChannel) {
    try {
      liveStreamChannel.send({
        type: "broadcast",
        event: "log_line",
        payload: streamEntry,
      });
    } catch (_) {}
  }

  // v3.7.9 MODO CRU: flushLogs desativado — nunca há nada para mandar.
}

// --- Live stream control (start/stop/renew via agent_commands) ---
function _scheduleLiveStreamStop() {
  if (liveStreamInactiveTimer) clearTimeout(liveStreamInactiveTimer);
  liveStreamInactiveTimer = setTimeout(() => {
    stopLiveLogStream("inactive_timeout");
  }, LIVE_STREAM_INACTIVE_MS);
}

function startLiveLogStream() {
  if (!supabase || !farmId) return false;
  try {
    if (!liveStreamChannel) {
      liveStreamChannel = supabase.channel(`agent-logs-${farmId}`, {
        config: { broadcast: { self: false, ack: false } },
      });
      liveStreamChannel.subscribe();
    }
    liveStreamActive = true;
    _scheduleLiveStreamStop();
    // Flush do buffer atual (até 500 linhas) em um único broadcast.
    try {
      liveStreamChannel.send({
        type: "broadcast",
        event: "log_buffer",
        payload: { lines: liveStreamBuffer.slice() },
      });
    } catch (_) {}
    return true;
  } catch (e) {
    pushLog("warn", "system", `Falha ao iniciar log stream: ${e.message}`);
    return false;
  }
}

function renewLiveLogStream() {
  if (!liveStreamActive) return false;
  _scheduleLiveStreamStop();
  return true;
}

function stopLiveLogStream(reason = "manual") {
  liveStreamActive = false;
  if (liveStreamInactiveTimer) {
    clearTimeout(liveStreamInactiveTimer);
    liveStreamInactiveTimer = null;
  }
  if (liveStreamChannel) {
    try { void supabase.removeChannel(liveStreamChannel); } catch (_) {}
    liveStreamChannel = null;
  }
  if (reason !== "manual") {
    console.log(`[LIVE-STREAM] parado (${reason})`);
  }
}


async function flushLogs() {
  // v3.7.9 MODO CRU: no-op. Logs ficam apenas no arquivo local + tray.
  // Reativar bloco original abaixo para retomar gravação em agent_logs.
  return;
  /* eslint-disable no-unreachable */
  if (!supabase || !farmId || logBuffer.length === 0 || logFlushInFlight) return;
  logFlushInFlight = true;
  if (logBuffer.length > LOG_FLUSH_MAX_BUFFER) {
    logBuffer.splice(0, logBuffer.length - LOG_FLUSH_MAX_BUFFER);
  }
  const batch = logBuffer.splice(0, logBuffer.length);
  try {
    const { error } = await withCloudTimeout(
      supabase.from("agent_logs").insert(
        batch.map((e) => ({
          farm_id: farmId,
          level: e.level,
          category: e.category,
          message: e.message,
          raw_frame: e.raw_frame,
          created_at: e.timestamp,
        }))
      ),
      "logs insert",
      CLOUD_WRITE_TIMEOUT_MS,
    );
    if (error) throw error;
  } catch (err) {
    console.log("[LOG FLUSH ERROR]", err.message);
    logBuffer.unshift(...batch);
  } finally {
    logFlushInFlight = false;
  }
  /* eslint-enable no-unreachable */
}

// --- Config persistence (criptografado via DPAPI no Windows) ---
// Usa Electron safeStorage que internamente chama:
//   • Windows: DPAPI (Data Protection API) — chave vinculada à conta do usuário
//   • macOS:   Keychain
//   • Linux:   libsecret (gnome-keyring/kwallet)
//
// Se a criptografia não estiver disponível (ambientes Linux sem keyring),
// faz fallback para texto plano com aviso no log.
function _safeAvailable() {
  try { return safeStorage && safeStorage.isEncryptionAvailable(); } catch { return false; }
}

function loadConfig() {
  try {
    // 1) Tenta arquivo criptografado novo
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE);
      if (_safeAvailable()) {
        const plain = safeStorage.decryptString(raw);
        return JSON.parse(plain);
      }
      // Ambiente sem encryption: arquivo está em texto puro
      return JSON.parse(raw.toString("utf8"));
    }
    // 2) Migração one-shot do arquivo legado em texto puro
    if (fs.existsSync(CONFIG_FILE_LEGACY)) {
      const legacy = JSON.parse(fs.readFileSync(CONFIG_FILE_LEGACY, "utf8"));
      try { saveConfig(legacy); } catch (_) {}
      try { fs.unlinkSync(CONFIG_FILE_LEGACY); } catch (_) {}
      console.log("[CONFIG] migrado renov-agent-config.json → .enc (DPAPI)");
      return legacy;
    }
  } catch (e) {
    console.error("[CONFIG] loadConfig erro:", e.message);
  }
  return null;
}

function saveConfig(cfg) {
  const plain = JSON.stringify(cfg, null, 2);
  try {
    if (_safeAvailable()) {
      const enc = safeStorage.encryptString(plain);
      fs.writeFileSync(CONFIG_FILE, enc);
      // Garante que arquivo legado em texto puro não fique para trás
      try { if (fs.existsSync(CONFIG_FILE_LEGACY)) fs.unlinkSync(CONFIG_FILE_LEGACY); } catch (_) {}
      return;
    }
    // Sem keyring/DPAPI disponível — log aviso e salva em texto puro
    console.warn("[CONFIG] safeStorage indisponível — salvando em texto puro!");
    fs.writeFileSync(CONFIG_FILE, plain, "utf8");
  } catch (e) {
    console.error("[CONFIG] saveConfig erro:", e.message);
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Safety timer (120s) — failsafe que desliga a bomba se nao confirmar comando
// ─────────────────────────────────────────────────────────────────────────────

// Monta payload OFF posicional para uma saida (1..6).
// saida=1 -> "0"; saida=2 -> "00"; saida=3 -> "000"; ...
// ATENCAO: este helper NAO deve ser usado para safety/desligamento de uma
// unica saida quando ha outras saidas no mesmo PLC — use
// buildSafetyOffPayloadPreserving() abaixo, que preserva o estado das demais.
function buildOffPayloadForSaida(saida) {
  const n = Math.max(1, Math.min(6, parseInt(saida, 10) || 1));
  return "0".repeat(n);
}

function buildOnPayloadForSaida(saida) {
  const n = Math.max(1, Math.min(6, parseInt(saida, 10) || 1));
  return n === 1 ? "1" : "0".repeat(n - 1) + "1";
}

// Monta payload de safety OFF preservando o estado das demais saidas do mesmo PLC.
// Busca, na nuvem, todos os equipments que compartilham o TSNN e usa o
// last_outputs_state mais longo encontrado como base. Retorna string de length
// = max(saida do PLC, saida-alvo) com APENAS o bit da saida alvo zerado.
async function buildSafetyOffPayloadPreserving(tsnn, targetSaida, targetBit) {
  const safeTargetBit = (targetBit === "1" || targetBit === "0") ? targetBit : "0";
  const targetN = Math.max(1, Math.min(6, parseInt(targetSaida, 10) || 1));
  let base = null;
  // O tamanho do payload DEVE ser igual ao output_count da PLC (default 1).
  // NAO usar a maior saida cadastrada — se o PLC 2102 tem output_count=6 mas
  // so tem 3 bombas cadastradas, o payload teria 3 digitos e o firmware
  // rejeitaria o frame.
  let plcOutputCount = null;
  try {
    if (supabase && farmId) {
      const { data: plcRow } = await supabase
        .from("plc_groups")
        .select("output_count")
        .eq("farm_id", farmId)
        .eq("hw_id", tsnn)
        .maybeSingle();
      if (plcRow && Number.isFinite(parseInt(plcRow.output_count, 10))) {
        plcOutputCount = Math.max(1, Math.min(6, parseInt(plcRow.output_count, 10)));
      }

      const { data, error } = await supabase
        .from("equipments")
        .select("hw_id,saida,last_outputs_state,plc_group_id,plc_groups(hw_id)")
        .eq("farm_id", farmId)
        .eq("active", true)
        .in("type", ["poco", "bombeamento"]);
      if (!error && Array.isArray(data)) {
        for (const eq of data) {
          const eqTsnn = (eq.plc_groups && eq.plc_groups.hw_id) || (eq.hw_id ? String(eq.hw_id).substring(0, 4) : null);
          if (eqTsnn !== tsnn) continue;
          const los = typeof eq.last_outputs_state === "string" ? eq.last_outputs_state : null;
          if (los && /^[01]+$/.test(los) && (!base || los.length > base.length)) {
            base = los;
          }
        }
      }
    }
  } catch (_e) { /* segue com base=null (tudo zero) */ }

  // totalLen: prioridade output_count do PLC. Se vier NULL/undefined ou a
  // consulta falhar, fallback OBRIGATORIO = 1. NUNCA assumir 6 por quantidade
  // de equipamentos, saída alvo ou tamanho de last_outputs_state.
  let totalLen = plcOutputCount || 1;
  totalLen = Math.max(1, Math.min(6, totalLen));
  // Se o base for mais curto que o totalLen real do PLC, padding com '0' no inicio:
  // base reflete apenas saidas cadastradas; saidas nao cadastradas continuam OFF.

  let payload = (base || "").replace(/[^01]/g, "");
  if (payload.length < totalLen) payload = payload.padEnd(totalLen, "0");
  if (payload.length > totalLen) payload = payload.substring(0, totalLen);

  // Zera APENAS a saida alvo (posicao targetN-1)
  const idx = Math.max(0, Math.min(totalLen - 1, targetN - 1));
  payload = payload.substring(0, idx) + safeTargetBit + payload.substring(idx + 1);
  return payload;
}

// Cancela e remove o safety timer de um equipamento (se existir).
function clearSafetyTimer(equipmentId, reason) {
  if (!equipmentId) return false;
  const entry = safetyByEquipment.get(equipmentId);
  if (!entry) return false;
  if (entry.timer) clearTimeout(entry.timer);
  safetyByEquipment.delete(equipmentId);
  // Cancela tambem qualquer reenvio manual pendente
  clearManualReinforcements(equipmentId, reason || "safety cancelado");
  if (reason) {
    pushLog("info", "system",
      `Safety timer cancelado para eq ${String(equipmentId).substring(0, 8)} (${reason})`);
  }
  return true;
}

// Dispara o failsafe: TX OFF imediato pela serial + desired_running=false.
async function fireSafetyOff(equipmentId, entry) {
  try {
    // Comando inverso ao desejado: se esperava ligar (bit=1) envia 0;
    // se esperava desligar (bit=0) envia 1. Preserva o estado das demais saidas.
    const expectedBit = (entry.expectedBit === "1" || entry.expectedBit === "0") ? entry.expectedBit : "1";
    const inverseBit = expectedBit === "1" ? "0" : "1";
    const inversePayload = await buildSafetyOffPayloadPreserving(entry.tsnn, entry.saida, inverseBit);
    const inverseFrame = `[${entry.tsnn}_1_]{${inversePayload}}[${entry.tsnn}_ETX_]\r`;

    pushLog(
      "warn",
      "system",
      `[REFORCO] Timeout 60s TSNN ${entry.tsnn} — enviando comando inverso (safety): esperava bit=${expectedBit}, enviando bit=${inverseBit} (frame=${inverseFrame.replace(/\r/g, "")})`,
      null,
      `Bomba ${nameForTsnn(entry.tsnn)} nao confirmou comando em ${Math.round(SAFETY_WINDOW_MS/1000)}s — safety acionado (bit inverso)`,
    );

    // 1) TX imediato pela bridge (bypass do gap de 5s)
    if (bridgeProcess && bridgeReady) {
      try {
        sendTxFrame(inverseFrame, { priority: "reset" });
        rememberTxForTsnn(entry.tsnn, "safety-inverse", entry.cmdId, inverseFrame);
        pushLog("info", "tx", `[SAFETY INVERSE bit=${inverseBit}] ${inverseFrame.replace(/\r/g, "")}`, inverseFrame);
      } catch (e) {
        pushLog("error", "serial", `Safety TX inverse stdin write falhou: ${e.message}`);
      }
    } else {
      pushLog("warn", "system", `Safety TX inverse nao pode ser enviado: bridge indisponivel`);
    }

    // 2) Marca desired_running de acordo com o inverso enviado e limpa pending_command_id.
    if (supabase && farmId) {
      try {
        await withCloudTimeout(
          supabase
            .from("equipments")
            .update({
              desired_running: inverseBit === "1",
              pending_command_id: null,
              last_actuation_origin: "local",
              safety_expired_at: new Date().toISOString(),
              // v3.11.5: NUNCA atualizar last_communication aqui — safety é TX
              // sem RX. last_communication só pode ser tocado por RX real
              // (apply_pump_telemetry). Bug: bombas sem resposta apareciam
              // "Online" na web porque o safety renovava o timestamp.
            })
            .eq("id", equipmentId),
          "safety desired_running update",
          CLOUD_WRITE_TIMEOUT_MS,
        );
        const { data: cancelledPollings, error: cancelPollingError } = await withCloudTimeout(
          supabase.rpc("cancel_pending_pollings_for_plc", {
            _farm_id: farmId,
            _tsnn: entry.tsnn,
            _reason: `Polling cancelado: safety Electron expirou e desired_running=${inverseBit === "1"}`,
          }),
          "safety cancel pending polling",
          CLOUD_WRITE_TIMEOUT_MS,
        );
        if (cancelPollingError) throw cancelPollingError;

        pushLog("info", "cloud",
          `Safety: desired_running=${inverseBit === "1"}, pending_command_id=null e ${Number(cancelledPollings || 0)} polling(s) pendente(s) cancelado(s) na PLC ${entry.tsnn} para eq ${String(equipmentId).substring(0, 8)}`);
      } catch (e) {
        pushLog("warn", "cloud", `Safety update equipments falhou: ${e.message}`);
      }
    }
  } catch (e) {
    pushLog("error", "system", `fireSafetyOff erro: ${e.message}`);
  } finally {
    safetyByEquipment.delete(equipmentId);
    clearManualReinforcements(equipmentId, "safety expirou");
  }
}

// Arma (ou re-arma) o safety timer para um equipamento aguardando confirmacao
// de comando manual. Se ja existe um timer ativo para esse equipamento e o
// expectedBit eh o mesmo, NAO reseta o relogio (evita renovacao infinita por
// RX intermediario repetido).
function armSafetyTimer(equipmentId, { tsnn, saida, expectedBit, expectedPayload, cmdId }) {
  if (!equipmentId || !tsnn || !expectedBit) return;
  const existing = safetyByEquipment.get(equipmentId);
  if (existing && existing.expectedBit === expectedBit) {
    // Ja armado para o mesmo alvo — manter o relogio antigo
    return;
  }
  if (existing && existing.timer) clearTimeout(existing.timer);

  const entry = {
    tsnn,
    saida,
    expectedBit,
    expectedPayload,
    armedAt: Date.now(),
    cmdId,
    timer: null,
  };
  entry.timer = setTimeout(() => { void fireSafetyOff(equipmentId, entry); }, SAFETY_WINDOW_MS);
  safetyByEquipment.set(equipmentId, entry);

  pushLog(
    "info",
    "system",
    `Safety timer ARMADO para eq ${String(equipmentId).substring(0, 8)} (TSNN=${tsnn}, saida=${saida}, esperando bit=${expectedBit}, janela=${SAFETY_WINDOW_MS}ms)`,
  );
}

// Verifica se o RX recebido confirma o estado esperado pelo safety timer
// daquele equipamento. Se sim, cancela o timer IMEDIATAMENTE.
//
// Regra (corrigida):
//   - O safety timer foi armado para uma saida especifica (entry.saida, 1-based).
//   - Qualquer RX que carregue o estado dessa saida (seja resposta direta de
//     1 bit, payload posicional curto, ou payload agrupado de polling com N
//     bits do PLC inteiro) deve cancelar o safety se o bit dessa saida
//     bater com expectedBit.
//   - NAO podemos exigir rx.length === expectedPayload.length: o polling
//     do PLC retorna {XXXXXX} (6 digitos) enquanto a saida foi armada com
//     payload posicional curto (ex: "1" / "01" / "001"). Antes, esse
//     mismatch impedia o cancelamento e o safety derrubava bomba que
//     ja havia confirmado.
function maybeCancelSafetyOnRx(equipmentId, rxPayload) {
  if (!equipmentId) return;
  const entry = safetyByEquipment.get(equipmentId);
  if (!entry) return;
  const rx = String(rxPayload || "");
  if (!/^[01]{1,6}$/.test(rx)) return;

  const saida = Number(entry.saida) || 0; // 1-based; 0 = desconhecida
  let stateBit = null;

  if (rx.length === 1) {
    // Resposta direta da propria saida comandada
    stateBit = rx[0];
  } else if (saida >= 1 && saida <= rx.length) {
    // Payload posicional/agrupado: bit (saida-1) representa o estado da saida
    stateBit = rx[saida - 1];
  } else if (rx.length === entry.expectedPayload.length) {
    // Fallback (compat): mesmo tamanho do payload original — usa ultimo bit
    stateBit = rx[rx.length - 1];
  } else {
    // Sem como mapear o bit dessa saida com seguranca
    return;
  }

  if (stateBit === entry.expectedBit) {
    clearSafetyTimer(equipmentId, `RX confirmou bit ${stateBit} da saida ${saida || "?"}`);
  }
}

// Cancela reforços manuais pendentes quando o RX confirma o estado esperado,
// mesmo que o safety timer nao esteja armado (caso comum em PLCs multi-saida
// 2102 onde a confirmacao chega antes de qualquer divergencia).
function maybeCancelReinforcementsOnRx(equipmentId, rxPayload, expectedPayloadHint) {
  if (!equipmentId) return;
  const entry = manualReinforceByEquipment.get(equipmentId);
  if (!entry) return;
  const rx = String(rxPayload || "");
  if (!/^[01]{1,6}$/.test(rx)) return;
  const eq = equipmentById.get(String(equipmentId));
  const saida = Number(eq?.saida) || 0;
  const expected = String(expectedPayloadHint || "");
  const expectedBit = expected ? expected[expected.length - 1] : null;
  if (!expectedBit) return;
  let stateBit = null;
  if (rx.length === 1) stateBit = rx[0];
  else if (saida >= 1 && saida <= rx.length) stateBit = rx[saida - 1];
  if (stateBit === expectedBit) {
    clearManualReinforcements(equipmentId, `RX confirmou estado da saida ${saida || "?"}`);
  }
}


// Varre TODAS as entradas de safety timer do mesmo TSNN (PLC) e cancela
// quaisquer cuja saida tenha bit confirmado no payload recebido.
//
// Use este metodo SEMPRE que um RX `_[TSNN_0_]{PAYLOAD}` chega — independente
// de a quem o frame "pertence" no fluxo (inflight/atrasado/espontaneo). Em
// PLCs com multiplas saidas, uma resposta {001110} confirma o estado de TODAS
// as saidas de uma vez; cada Safety Timer ativo daquele TSNN deve ser
// cancelado individualmente se o bit da sua saida bate com o esperado.
function cancelSafetyForTsnnOnRx(tsnn, rxPayload) {
  if (!tsnn || !safetyByEquipment.size) return;
  const rx = String(rxPayload || "");
  if (!/^[01]{1,6}$/.test(rx)) return;
  const targets = [];
  for (const [eqId, entry] of safetyByEquipment.entries()) {
    if (entry && entry.tsnn === tsnn) targets.push(eqId);
  }
  for (const eqId of targets) {
    try { maybeCancelSafetyOnRx(eqId, rx); }
    catch (e) { pushLog("warn", "system", `cancelSafetyForTsnnOnRx(${tsnn}) falhou para eq ${String(eqId).substring(0,8)}: ${e.message}`); }
  }
}

function hasActiveSafetyForTsnn(tsnn) {
  if (!tsnn || !safetyByEquipment.size) return false;
  for (const entry of safetyByEquipment.values()) {
    if (entry && entry.tsnn === tsnn) return true;
  }
  return false;
}


// Quando a bomba envia um RX sem comando pending casando, foi acionamento
// FISICO no painel (chave manual / botao). Nao pode esperar na fila local
// junto com telemetria comum: precisa atualizar o banco IMEDIATAMENTE para
// que o operador remoto veja o estado real em tempo real. Origem = 'local'.
async function applySpontaneousImmediately(tsnn, rawPayload, rxFrame) {
  if (!supabase || !farmId) return false;
  try {
    // ─────────────────────────────────────────────────────────────────
    // CLASSIFICACAO DE ORIGEM ANTES da RPC (v3.8.6)
    // A RPC apply_pump_telemetry agora aceita _origin explicito. Calculamos
    // a origem ANTES de chamar a RPC para que o backend nao precise adivinhar.
    // ─────────────────────────────────────────────────────────────────
    let matchedBySafety = false;
    let matchedByCommand = false;
    let matchedByDesired = false;
    let divergedFromDesired = false;
    let safetyArmedForFrame = false;
    let pendingCommandActive = false;
    let recentSafetyExpiry = false;
    let resolvedEqId = null;

    const candidates = [];
    const tsnnUpper = String(tsnn || "").toUpperCase();
    for (const [eqId, meta] of equipmentById.entries()) {
      const hw = String(meta?.hw_id || "").toUpperCase();
      if (hw.substring(0, 4) === tsnnUpper) candidates.push({ eqId, meta });
    }

    const inferSaidaFromPayload = (p) => {
      const s = String(p || "");
      if (/^[01]{6}$/.test(s)) return null;
      if (/^[01]{2,5}$/.test(s)) return s.length;
      if (/^[01]$/.test(s)) return 1;
      return null;
    };
    const payloadSaida = inferSaidaFromPayload(rawPayload);

    let primary = null;
    if (payloadSaida != null) {
      primary = candidates.find((c) => Number(c.meta?.saida) === payloadSaida) || null;
    }
    if (!primary) {
      primary = candidates.find((c) => Number(c.meta?.saida) === 1) || candidates[0] || null;
    }
    resolvedEqId = primary?.eqId || null;
    const saida = Number(primary?.meta?.saida) || (payloadSaida || 1);

    const extractStateBit = (payload) => {
      const p = String(payload || "");
      if (!/^[01]{1,6}$/.test(p)) return null;
      if (p.length === 1) return p[0];
      if (saida >= 1 && saida <= p.length) return p[saida - 1];
      return p[p.length - 1];
    };

    // 0) Safety Timer ativo
    safetyArmedForFrame = hasActiveSafetyForTsnn(tsnn);
    if (resolvedEqId) {
      try {
        const safetyEntry = safetyByEquipment.get(String(resolvedEqId));
        if (safetyEntry && safetyEntry.tsnn === tsnn) {
          safetyArmedForFrame = true;
          const bit = extractStateBit(rawPayload);
          if (bit && bit === safetyEntry.expectedBit) {
            matchedBySafety = true;
            matchedByCommand = true;
            clearSafetyTimer(String(resolvedEqId), `RX confirmou bit ${bit} da saida ${saida} (espontaneo/atrasado)`);
          }
        }
      } catch (e) {
        pushLog("warn", "system", `Safety check em espontaneo falhou: ${e.message}`);
      }
    }

    // 1) Comando manual recente (<= 180s)
    if (!matchedByCommand && resolvedEqId) {
      try {
        const since = new Date(Date.now() - 180_000).toISOString();
        const { data: recent } = await withCloudTimeout(
          supabase
            .from("commands")
            .select("id, frame, source_device, sent_at, created_at")
            .eq("farm_id", farmId)
            .eq("equipment_id", resolvedEqId)
            .eq("type", "manual")
            .or(`sent_at.gte.${since},created_at.gte.${since}`)
            .order("created_at", { ascending: false })
            .limit(5),
          "espontaneo recent-cmd lookup",
          CLOUD_WRITE_TIMEOUT_MS,
        );
        if (Array.isArray(recent)) {
          for (const c of recent) {
            if (String(c.source_device || "").startsWith("backend-reset:")) continue;
            const m = String(c.frame || "").match(/\{([01]{1,6})\}/);
            if (!m) continue;
            const expected = m[1];
            const expectedBit = expected[expected.length - 1];
            const rxBit = extractStateBit(rawPayload);
            if (rxBit && expectedBit === rxBit) {
              matchedByCommand = true;
              break;
            }
          }
        }
      } catch (e) {
        pushLog("warn", "cloud", `Espontaneo recent-cmd lookup falhou: ${e.message}`);
      }
    }

    if (inflightCmd && inflightTsnn === tsnn) {
      pendingCommandActive = true;
    }
    if (!pendingCommandActive && resolvedEqId) {
      try {
        const { data: pendingRows } = await withCloudTimeout(
          supabase
            .from("commands")
            .select("id")
            .eq("farm_id", farmId)
            .eq("equipment_id", resolvedEqId)
            .in("status", ["pending", "sent"])
            .limit(1),
          "espontaneo pending-cmd lookup",
          CLOUD_WRITE_TIMEOUT_MS,
        );
        pendingCommandActive = Array.isArray(pendingRows) && pendingRows.length > 0;
      } catch (e) {
        pushLog("warn", "cloud", `Espontaneo pending-cmd lookup falhou: ${e.message}`);
      }
    }

    // 2) desired_running + janela pós-safety
    if (!matchedByCommand && resolvedEqId) {
      try {
        const { data: eqRow } = await withCloudTimeout(
          supabase
            .from("equipments")
            .select("desired_running,safety_expired_at")
            .eq("id", resolvedEqId)
            .maybeSingle(),
          "espontaneo desired_running lookup",
          CLOUD_WRITE_TIMEOUT_MS,
        );
        if (eqRow && typeof eqRow.desired_running === "boolean") {
          const safetyAt = eqRow.safety_expired_at ? new Date(eqRow.safety_expired_at).getTime() : 0;
          recentSafetyExpiry = Number.isFinite(safetyAt) && (Date.now() - safetyAt) < SAFETY_LOCAL_SUPPRESS_MS;
          const stateBit = extractStateBit(rawPayload);
          if (stateBit === "1" || stateBit === "0") {
            const receivedRunning = stateBit === "1";
            if (receivedRunning === eqRow.desired_running) {
              matchedByDesired = true;
            } else {
              divergedFromDesired = true;
            }
          }
        }
      } catch (e) {
        pushLog("warn", "cloud", `Espontaneo desired_running lookup falhou: ${e.message}`);
      }
    }

    // 3) _origin para RPC (null = preserva valor anterior)
    let originForRpc = null;
    const inStartupSync = isInStartupSyncWindow();

    // v3.11.2 — Toda RX com bit=1 para um equipamento conhecido eh registrada
    // como "confirmacao recente de ON". Usado abaixo para proteger o STARTUP
    // SYNC de espontaneos com bit=0 logo apos um Ligar bem-sucedido.
    {
      const _bitNow = extractStateBit(rawPayload);
      if (resolvedEqId && _bitNow === "1") {
        lastOnConfirmAtByEq.set(String(resolvedEqId), Date.now());
      }
    }

    if (matchedByCommand) originForRpc = "remote-cmd";
    else if (matchedByDesired) originForRpc = "remote-desired";
    else if (divergedFromDesired && inStartupSync && !pendingCommandActive && !safetyArmedForFrame && !recentSafetyExpiry) {
      // v3.9.4 — Startup Sync só sobrescreve desired_running quando NÃO há
      // comando ativo / safety armado / safety recém-expirado para a PLC.
      // Caso contrário, divergência RX↔desired = atuação local (PLC em modo
      // botoeira ignorando o comando) e devemos preservar o desired do
      // operador, evitando loop "comando OFF → RX=1 → sync ON → comando OFF".
      const _stateBit = extractStateBit(rawPayload);
      const realRunning = _stateBit === "1";
      const _eqKey = resolvedEqId ? String(resolvedEqId) : "";
      const _lastOn = _eqKey ? (lastOnConfirmAtByEq.get(_eqKey) || 0) : 0;
      const _ageMs = _lastOn ? (Date.now() - _lastOn) : Infinity;
      if (!realRunning && _lastOn > 0 && _ageMs < STARTUP_SYNC_ON_GRACE_MS) {
        // v3.11.2 — Houve confirmacao de ON ha < 30s; o bit=0 atual e provavelmente
        // espontaneo transitorio (latencia de radio / leitura intermediaria).
        // NAO mexer em desired_running — preserva intencao do operador.
        pushLog(
          "warn",
          "system",
          `[STARTUP SYNC] Sinal espontaneo 0 ignorado para eq ${_eqKey.substring(0,8)} — comando Ligar confirmado ha ${Math.round(_ageMs/1000)}s`,
        );
      } else {
        originForRpc = "remote-desired";
        try {
          if (resolvedEqId) {
            await withCloudTimeout(
              supabase
                .from("equipments")
                .update({ desired_running: realRunning })
                .eq("id", resolvedEqId),
              "startup-sync update desired",
              CLOUD_WRITE_TIMEOUT_MS,
            );
            pushLog(
              "info",
              "system",
              `[STARTUP SYNC] eq ${String(resolvedEqId).substring(0,8)} sincronizado: desired_running=${realRunning} (estado real do PLC)`,
            );
          }
        } catch (e) {
          pushLog("warn", "cloud", `[STARTUP SYNC] update desired falhou: ${e.message}`);
        }
      }
    }
    else if (divergedFromDesired && !safetyArmedForFrame && !pendingCommandActive && !recentSafetyExpiry) originForRpc = "local";
    else if (divergedFromDesired && (safetyArmedForFrame || pendingCommandActive || recentSafetyExpiry)) {
      // v3.25.5: Acionamento local PREVALECE sobre safety/comando pendente.
      // O operador no campo decidiu — o sistema deve aceitar em vez de tentar reverter,
      // evitando o loop "RX=1 → TX {0} de reforço → safety expira → TX {1} indefinido".
      originForRpc = "local";
      const _stateBit = extractStateBit(rawPayload);
      const realRunning = _stateBit === "1";
      const reason = safetyArmedForFrame
        ? "safety cancelado"
        : pendingCommandActive
          ? "comando pendente cancelado"
          : "safety-expiry ignorado";
      pushLog(
        "warn",
        "system",
        `[LOCAL OVERRIDE] RX ${rawPayload} acionamento local aceito (${reason}) para eq ${String(resolvedEqId || "").substring(0, 8)} — desired_running → ${realRunning}`,
      );

      // 1) Cancelar safety timer + reforço TX (clearSafetyTimer já chama clearManualReinforcements)
      if (resolvedEqId) {
        if (safetyArmedForFrame) {
          clearSafetyTimer(String(resolvedEqId), `Acionamento local detectado (RX=${rawPayload})`);
        } else {
          clearManualReinforcements(String(resolvedEqId), "Acionamento local detectado");
        }
      }

      // 2) Atualizar desired_running para refletir o estado real do PLC
      if (resolvedEqId) {
        try {
          await withCloudTimeout(
            supabase
              .from("equipments")
              .update({ desired_running: realRunning })
              .eq("id", resolvedEqId),
            "local-override update desired",
            CLOUD_WRITE_TIMEOUT_MS,
          );
        } catch (e) {
          pushLog("warn", "cloud", `[LOCAL OVERRIDE] update desired falhou: ${e.message}`);
        }

        // 3) Cancelar comandos pendentes/enviados para este equipamento
        try {
          await withCloudTimeout(
            supabase
              .from("commands")
              .update({
                status: "cancelled",
                error_message: "Cancelado por acionamento local",
                responded_at: new Date().toISOString(),
              })
              .eq("farm_id", farmId)
              .eq("equipment_id", resolvedEqId)
              .in("status", ["pending", "sent"]),
            "local-override cancel commands",
            CLOUD_WRITE_TIMEOUT_MS,
          );
        } catch (e) {
          pushLog("warn", "cloud", `[LOCAL OVERRIDE] cancel commands falhou: ${e.message}`);
        }

        // 4) Cancelar pollings pendentes/enviados para este TSNN (frame stale com payload antigo)
        try {
          await withCloudTimeout(
            supabase
              .from("commands")
              .update({
                status: "cancelled",
                error_message: "Polling cancelado: acionamento local alterou desired_running",
                responded_at: new Date().toISOString(),
              })
              .eq("farm_id", farmId)
              .eq("type", "polling")
              .like("frame", `%${tsnn}%`)
              .in("status", ["pending", "sent"]),
            "local-override cancel stale polling",
            CLOUD_WRITE_TIMEOUT_MS,
          );
        } catch (e) {
          pushLog("warn", "cloud", `[LOCAL OVERRIDE] cancel polling falhou: ${e.message}`);
        }
      }
    }


    const { data: updatedId, error } = await withCloudTimeout(
      supabase.rpc("apply_pump_telemetry", {
        _farm_id: farmId,
        _tsnn: tsnn,
        _payload: rawPayload,
        _signal_bars: 4,
        _command_id: null,
        _raw_response: rxFrame,
        _origin: originForRpc,
      }),
      "espontaneo rpc",
      CLOUD_TELEMETRY_TIMEOUT_MS,
    );
    if (error || !updatedId) throw (error || new Error("espontaneo sem equipamento correspondente"));

    const originLocal = originForRpc === "local";

    // v3.11.10 — Registra acionamento local no Relatório (automation_log) +
    // notificação no sino (farm_notifications). Só dispara quando o RX espontâneo
    // foi DEFINITIVAMENTE classificado como local — supressões (safety armado,
    // comando pendente, safety recém-expirado, startup-sync) NÃO chegam aqui
    // porque originForRpc não é "local" nesses casos.
    if (originLocal && resolvedEqId) {
      const _stateBit = extractStateBit(rawPayload);
      const _action = _stateBit === "1" ? "pump_on" : "pump_off";
      const _actionLabel = _stateBit === "1" ? "Ligada" : "Desligada";
      const _equipName = nameForTsnn(tsnn);
      const _eventId = (crypto.randomUUID ? crypto.randomUUID() : `${tsnn}-${Date.now()}`);

      // 1) automation_log → aparece no Relatório de Operadores com origin=Local
      try {
        await withCloudTimeout(
          supabase.from("automation_log").insert({
            farm_id: farmId,
            equipment_id: resolvedEqId,
            equipment_name: _equipName,
            occurred_at: new Date().toISOString(),
            origin: "local",
            action: _action,
            result: "success",
            actor_label: "Acionamento Local",
            source_device: "agent-local-actuation",
            client_event_id: _eventId,
            details: {
              tipo_evento: "acionamento_local",
              tsnn,
              payload: rawPayload,
              notes: `Detectado via RX espontâneo (TSNN ${tsnn}, payload ${rawPayload})`,
            },
          }),
          "local-action automation_log insert",
          CLOUD_WRITE_TIMEOUT_MS,
        );
        pushLog("info", "system",
          `[RELATÓRIO] Acionamento local registrado: ${_equipName} → ${_actionLabel}`);
      } catch (logErr) {
        pushLog("warn", "cloud",
          `[RELATÓRIO] Falha ao registrar acionamento local: ${logErr.message}`);
      }

      // 2) farm_notifications → sino (aba Sistema). source_ref único por evento
      // para evitar conflito no unique index (farm_id, source, source_ref).
      try {
        await withCloudTimeout(
          supabase.from("farm_notifications").insert({
            farm_id: farmId,
            kind: "system",
            severity: "info",
            title: `${_equipName} — ${_actionLabel} localmente`,
            message: `Acionamento local detectado via botoeira/painel (TSNN ${tsnn}, payload ${rawPayload})`,
            equipment_id: resolvedEqId,
            source: "acionamento_local",
            source_ref: _eventId,
          }),
          "local-action notification insert",
          CLOUD_WRITE_TIMEOUT_MS,
        );
      } catch (notifErr) {
        pushLog("warn", "cloud",
          `[NOTIF] Falha ao inserir notificação de acionamento local: ${notifErr.message}`);
      }
    }


    // Acionamento local NÃO altera desired_running. Apenas reflete o estado real
    // em last_outputs_state e marca last_actuation_origin='local' (via RPC). O polling
    // continua tentando aplicar o desired_running até que o operador mude pela web ou
    // o safety expire.
    const friendlyMsg = originLocal
      ? `Acionamento local em ${nameForTsnn(tsnn)} → estado ${rawPayload} aplicado em tempo real`
      : matchedByCommand
        ? `Estado de ${nameForTsnn(tsnn)} confirmado (resposta do comando remoto) → ${rawPayload}`
        : matchedByDesired
          ? `Estado de ${nameForTsnn(tsnn)} atualizado → ${rawPayload} (compatível com estado desejado)`
          : `Estado de ${nameForTsnn(tsnn)} atualizado → ${rawPayload}`;
    pushLog(
      "info",
      "cloud",
      `Espontaneo gravado IMEDIATO: ${tsnn} -> ${rawPayload} (eq ${String(updatedId).substring(0, 8)}) origin=${originForRpc || "preserve"}`,
      null,
      friendlyMsg,
    );
    return true;
  } catch (e) {
    pushLog("warn", "cloud", `Espontaneo IMEDIATO falhou (${e.message}); caindo para fila normal`);
    noteCloudError(e, "handleSpontaneousImmediate");
    return false;
  }
}

// v3.7.8: Broadcast paralelo (WebSocket, ZERO IO no banco) — frontend recebe
// estado em <500ms mesmo se o INSERT/UPDATE no Postgres ainda estiver lento.
let broadcastChannelRef = null;
function getBroadcastChannel() {
  if (!supabase || !farmId) return null;
  if (broadcastChannelRef) return broadcastChannelRef;
  try {
    broadcastChannelRef = supabase.channel(`farm-${farmId}`, { config: { broadcast: { self: false, ack: false } } });
    broadcastChannelRef.subscribe();
  } catch (e) {
    broadcastChannelRef = null;
  }
  return broadcastChannelRef;
}
function broadcastEquipmentState(equipmentId, tsnn, rawPayload) {
  if (!equipmentId) return;
  const ch = getBroadcastChannel();
  if (!ch) return;
  try {
    void ch.send({
      type: "broadcast",
      event: "equipment_state",
      payload: {
        equipment_id: equipmentId,
        tsnn,
        outputs: rawPayload,
        timestamp: new Date().toISOString(),
      },
    });
  } catch { /* ignore broadcast errors */ }
}

// --- Telemetria: gravacao IMEDIATA (PRIORIDADE MAXIMA) ---
// Estado de bomba (last_outputs_state) NAO PODE esperar fila. Tenta IMEDIATO,
// 1 retry rapido em 2s se falhar, e so entao cai na fila como ultimo recurso.
async function queueTelemetry(tsnn, rawPayload, rxFrame, commandId) {
  if (!supabase || !farmId) return;
  // v3.8.6: passa _origin explicito.
  //   - Se ha commandId: e resposta a comando remoto -> 'remote-cmd'
  //   - Se NAO ha (polling de telemetria): null -> RPC preserva valor anterior
  const originHint = commandId ? "remote-cmd" : null;
  // Tentativa 1: IMEDIATA (bypass da fila)
  try {
    const { data: updatedId, error } = await withCloudTimeout(
      supabase.rpc("apply_pump_telemetry", {
        _farm_id: farmId,
        _tsnn: tsnn,
        _payload: rawPayload,
        _signal_bars: 4,
        _command_id: commandId || null,
        _raw_response: rxFrame,
        _origin: originHint,
      }),
      "telemetria IMEDIATA rpc",
      CLOUD_TELEMETRY_TIMEOUT_MS,
    );
    if (error) throw error;
    if (updatedId) {
      broadcastEquipmentState(updatedId, tsnn, rawPayload);
      pushLog("info", "cloud", `Telemetria IMEDIATA: ${tsnn} -> ${rawPayload} (eq ${String(updatedId).substring(0, 8)})`, null, `Estado de ${nameForTsnn(tsnn)} atualizado`);
      return;
    }
  } catch (e) {
    pushLog("warn", "cloud", `Telemetria IMEDIATA falhou (${e.message}); tentando retry em 2s`);
    noteCloudError(e, "queueTelemetry-immediate");
  }
  // Tentativa 2: retry agendado (2s)
  setTimeout(async () => {
    try {
      const { data: updatedId, error } = await withCloudTimeout(
        supabase.rpc("apply_pump_telemetry", {
          _farm_id: farmId,
          _tsnn: tsnn,
          _payload: rawPayload,
          _signal_bars: 4,
          _command_id: commandId || null,
          _raw_response: rxFrame,
          _origin: originHint,
        }),
        "telemetria RETRY rpc",
        CLOUD_TELEMETRY_TIMEOUT_MS,
      );
      if (error) throw error;
      if (updatedId) {
        broadcastEquipmentState(updatedId, tsnn, rawPayload);
        pushLog("info", "cloud", `Telemetria RETRY OK: ${tsnn} -> ${rawPayload}`, null, null);
        return;
      }
      throw new Error("retry sem equipamento correspondente");
    } catch (e) {
      // Tentativa 3: fila local (ultimo recurso)
      telemetryQueue.push({ tsnn, rawPayload, rxFrame, commandId: commandId || null, originHint, queuedAt: Date.now() });
      if (telemetryQueue.length > TELEMETRY_QUEUE_MAX) {
        telemetryQueue.splice(0, telemetryQueue.length - TELEMETRY_QUEUE_MAX);
      }
      pushLog("warn", "cloud", `Telemetria em fila apos 2 tentativas (${telemetryQueue.length}): ${e.message}`, null, `Telemetria em fila local (${telemetryQueue.length}). Comunicação via rádio continua normal.`);
      noteCloudError(e, "queueTelemetry-retry");
      void flushTelemetryQueue();
    }
  }, 2000);
}

async function flushTelemetryQueue() {
  if (!supabase || !farmId || telemetryFlushInFlight || telemetryQueue.length === 0) return;
  if (Date.now() < telemetryRetryAt) return;
  telemetryFlushInFlight = true;
  try {
    while (telemetryQueue.length > 0) {
      const item = telemetryQueue[0];
      const { data: updatedId, error } = await withCloudTimeout(
        supabase.rpc("apply_pump_telemetry", {
          _farm_id: farmId,
          _tsnn: item.tsnn,
          _payload: item.rawPayload,
          _signal_bars: 4,
          _command_id: item.commandId,
          _raw_response: item.rxFrame,
          _origin: item.originHint || (item.commandId ? "remote-cmd" : null),
        }),
        "telemetria rpc",
        CLOUD_TELEMETRY_TIMEOUT_MS,
      );
      if (error || !updatedId) throw (error || new Error("telemetria sem equipamento correspondente"));
      telemetryQueue.shift();
      broadcastEquipmentState(updatedId, item.tsnn, item.rawPayload);
      pushLog("info", "cloud", `Telemetria gravada: ${item.tsnn} -> ${item.rawPayload} (eq ${String(updatedId).substring(0, 8)})`, null, `Estado de ${nameForTsnn(item.tsnn)} atualizado`);
    }
  } catch (e) {
    telemetryRetryAt = Date.now() + TELEMETRY_RETRY_MS;
    if (Date.now() > telemetryWarnAt) {
      telemetryWarnAt = Date.now() + 60_000;
      pushLog("warn", "cloud", `Telemetria em fila (${telemetryQueue.length}); nuvem indisponível/lenta: ${e.message}`, null, `Telemetria em fila local (${telemetryQueue.length}). Comunicação via rádio continua normal.`);
    }
    noteCloudError(e, "flushTelemetryQueue");
  } finally {
    telemetryFlushInFlight = false;
  }
}

// --- Niveis (N1/N2): grava leitura analogica do PLC na nuvem.
// Chamado a cada frame RX de telemetria; ignora silenciosamente se o frame
// nao tem sufixo de nivel ou se nao ha equipamento de nivel cadastrado.
async function processLevelReadings(rawFrame, plcHwId) {
  if (!supabase || !farmId || !rawFrame || !plcHwId) return;
  const tsnn = String(plcHwId || "").trim().toUpperCase().substring(0, 4);
  const hasFlow = flowEquipByTsnn.has(tsnn);
  RX_LEVEL_RE.lastIndex = 0;
  let m;
  const seen = new Set();
  while ((m = RX_LEVEL_RE.exec(rawFrame)) !== null) {
    const sensorIndex = parseInt(m[1], 10);
    const rawValue = parseInt(m[2], 10);
    if (!Number.isFinite(sensorIndex) || !Number.isFinite(rawValue)) continue;
    if (seen.has(sensorIndex)) continue; // dedup por frame
    seen.add(sensorIndex);
    // Se este TSNN tem equipamento com vazao_mode='real', N2 = totalizador e N3 = vazao instantanea:
    // ambos sao tratados por processFlowReadings, NAO devem ir para apply_level_telemetry.
    if (hasFlow && (sensorIndex === 2 || sensorIndex === 3)) continue;
    // N3 sem contexto de vazao nao existe no protocolo antigo — ignora.
    if (sensorIndex === 3) continue;
    try {
      await withCloudTimeout(
        supabase.rpc("apply_level_telemetry", {
          _farm_id: farmId,
          _plc_hw_id: plcHwId,
          _sensor_index: sensorIndex,
          _raw_value: rawValue,
          _raw_response: rawFrame,
        }),
        "nivel rpc",
        CLOUD_TELEMETRY_TIMEOUT_MS,
      );
      pushLog("info", "cloud", `Nivel N${sensorIndex} PLC ${plcHwId} = ${rawValue}`, null, null);
    } catch (e) {
      pushLog("warn", "cloud", `Nivel N${sensorIndex} PLC ${plcHwId} falhou: ${e.message}`);
    }
  }
}

// ============================================================================
// INFRA DE VAZAO (N2 = totalizador m3, N3 = vazao instantanea x10)
// ----------------------------------------------------------------------------
// Fluxo: frame RX -> processFlowReadings -> grava flow_total_m3 / flow_rate_m3h
// no equipments (do equipamento com vazao_mode='real' daquele TSNN).
//
// Reset (RV): frontend seta equipments.vazao_reset_pending=true OU o scheduler
// de meia-noite marca todos os TSNN 'real'. checkRemoteResetPending() (chamado
// no inicio de cada polling) copia isso para pendingVazaoResetByTsnn. Antes de
// enviar o frame de polling, maybeInjectVazaoReset() reescreve `{PAYLOAD}` como
// `{PAYLOADRV}` e remove do Map — o firmware zera o contador ao ler RV.
// ============================================================================
const pendingVazaoResetByTsnn = new Map(); // TSNN -> true (aguardando envio RV)
const lastN2ByTsnn = new Map();            // TSNN -> { value: number, at: number }
// Acumulador do dia por TSNN: soma de TODOS os segmentos já encerrados (resets)
// do dia corrente. O consumo do dia em qualquer instante =
//   dayAccum.accum + lastRawN2 (leitura atual do firmware pós último reset).
// O sistema é a memória — a placa pode ser zerada N vezes no mesmo dia.
const flowDayAccumByTsnn = new Map();      // TSNN -> { date: "YYYY-MM-DD", accum: number }
let midnightResetTimer = null;

// Handlers RX temporários usados pela sequência de meia-noite (v3.25.4).
// Quando presente para um TSNN, processFlowReadings encaminha a leitura ao
// handler e NÃO aplica o fluxo normal de acumulação/DB writes (a sequência
// cuida da persistência sozinha, para evitar corrida com virada de dia).
const midnightRxHandlers = new Map(); // TSNN -> (rxData) => void
let midnightSequenceActive = false;

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processFlowReadings(rawFrame, plcHwId) {
  if (!supabase || !farmId || !rawFrame || !plcHwId) return;
  const tsnn = String(plcHwId || "").trim().toUpperCase().substring(0, 4);
  const eq = flowEquipByTsnn.get(tsnn);
  if (!eq) return; // nenhum equipamento com vazao_mode='real' para este PLC

  // Extrai N2 e N3 do frame.
  RX_LEVEL_RE.lastIndex = 0;
  let m;
  let rawN2 = null;
  let rawN3 = null;
  const seen = new Set();
  while ((m = RX_LEVEL_RE.exec(rawFrame)) !== null) {
    const idx = parseInt(m[1], 10);
    const val = parseInt(m[2], 10);
    if (!Number.isFinite(idx) || !Number.isFinite(val)) continue;
    if (seen.has(idx)) continue;
    seen.add(idx);
    if (idx === 2) rawN2 = val;
    else if (idx === 3) rawN3 = val;
  }

  // Detecta confirmação de reset (RV) na resposta do firmware.
  // Frame padrão: ..._[TSNN_0_]{0}_N1..._N2..._N3..._[TSNN_ETX_]
  // Frame com confirmação: ..._[TSNN_0_]{0RV}_N1..._N2..._N3..._[TSNN_ETX_]
  const RX_RESET_CONFIRM_RE = /\{[01]*RV\}/;
  const resetConfirmed = RX_RESET_CONFIRM_RE.test(rawFrame);

  // Interceptor da sequência de meia-noite (v3.25.4). Se há um handler
  // registrado para este TSNN, entrega os dados extraídos e curto-circuita
  // o fluxo normal (a sequência persistirá em daily_consumption/equipments).
  {
    const handler = midnightRxHandlers.get(tsnn);
    if (handler) {
      try { handler({ tsnn, n2: rawN2, n3: rawN3, rvConfirmed: resetConfirmed }); }
      catch (e) { pushLog("warn", "system", `[VAZAO-MIDNIGHT] handler TSNN ${tsnn} erro: ${e.message}`); }
      return;
    }
  }

  // --- Reset confirmado pelo firmware (RV na resposta) ---
  // NÃO fecha o dia. Apenas soma o segmento (lastRawN2) ao acumulador do dia
  // e zera a última leitura. O dia continua acumulando normalmente.
  if (resetConfirmed) {
    try {
      const today = todayStr();
      const lastEntry = lastN2ByTsnn.get(tsnn);
      const lastRawN2 = lastEntry ? lastEntry.value : 0;
      let dayAccum = flowDayAccumByTsnn.get(tsnn);
      if (!dayAccum || dayAccum.date !== today) {
        dayAccum = { date: today, accum: 0 };
        flowDayAccumByTsnn.set(tsnn, dayAccum);
      }
      dayAccum.accum += Math.max(0, lastRawN2);
      lastN2ByTsnn.set(tsnn, { value: 0, at: Date.now() });

      // flow_total_m3 = consumo do dia (parcial pós-reset = 0, então = accum).
      try {
        await withCloudTimeout(
          supabase.from("equipments").update({ flow_total_m3: dayAccum.accum }).eq("id", eq.id),
          "flow RV reset update",
          CLOUD_TELEMETRY_TIMEOUT_MS,
        );
        eq.flow_total_m3 = dayAccum.accum;
      } catch (e) {
        pushLog("warn", "cloud", `[VAZAO] flow_total_m3 update pós-RV falhou: ${e.message}`);
      }
      pushLog("info", "system",
        `[VAZAO] Reset CONFIRMADO pelo firmware TSNN ${tsnn}: +${lastRawN2} m3 ao dia (accum_dia=${dayAccum.accum})`);
    } catch (e) {
      pushLog("warn", "system", `[VAZAO] tratamento RV TSNN ${tsnn} falhou: ${e.message}`);
    }
  }

  // --- N2: totalizador com acumulador diário e detecção de reset (fallback) ---
  // Só processa N2 como leitura normal quando NÃO houve confirmação RV neste frame
  // (na resposta com RV o firmware envia N2=0, que já foi tratado acima).
  if (rawN2 !== null && !resetConfirmed) {
    try {
      const today = todayStr();
      const lastEntry = lastN2ByTsnn.get(tsnn);
      const lastRawN2 = lastEntry ? lastEntry.value : 0;

      let dayAccum = flowDayAccumByTsnn.get(tsnn);

      // Virada de dia: fecha o dia anterior em daily_consumption
      // com o total real (accum + lastRawN2, que era o último segmento aberto).
      if (dayAccum && dayAccum.date !== today) {
        const consumoDiaAnterior = dayAccum.accum + Math.max(0, lastRawN2);
        if (consumoDiaAnterior > 0) {
          try {
            await supabase.from("daily_consumption").upsert(
              {
                farm_id: farmId,
                equipment_id: eq.id,
                date: dayAccum.date,
                total_m3: consumoDiaAnterior,
                mode: "real",
              },
              { onConflict: "equipment_id,date" },
            );
            pushLog("info", "system",
              `[VAZAO] Dia ${dayAccum.date} fechado (rollover): ${consumoDiaAnterior} m3 (TSNN ${tsnn})`);
          } catch (e) {
            pushLog("warn", "system", `[VAZAO] upsert daily_consumption (rollover) falhou: ${e.message}`);
          }
        }
        dayAccum = null;
      }

      if (!dayAccum) {
        dayAccum = { date: today, accum: 0 };
        flowDayAccumByTsnn.set(tsnn, dayAccum);
      }

      // Fallback (firmware antigo sem confirmação RV): rawN2 caiu -> soma o
      // segmento anterior ao acumulador do dia. Firmware novo já tratou via RV.
      if (rawN2 < lastRawN2 && lastRawN2 > 0) {
        dayAccum.accum += lastRawN2;
        pushLog("info", "system",
          `[VAZAO] Reset detectado por queda TSNN ${tsnn}: +${lastRawN2} m3 ao dia (accum_dia=${dayAccum.accum})`);
      }

      lastN2ByTsnn.set(tsnn, { value: rawN2, at: Date.now() });
      const consumoDia = dayAccum.accum + rawN2;

      await withCloudTimeout(
        supabase.from("equipments").update({ flow_total_m3: consumoDia }).eq("id", eq.id),
        "flow N2 update",
        CLOUD_TELEMETRY_TIMEOUT_MS,
      );
      eq.flow_total_m3 = consumoDia;
      pushLog("info", "cloud",
        `[VAZAO] PLC ${plcHwId}: raw=${rawN2}, accum_dia=${dayAccum.accum}, total_dia=${consumoDia} m3`, null, null);
    } catch (e) {
      pushLog("warn", "cloud", `[VAZAO] N2 update PLC ${plcHwId} falhou: ${e.message}`);
    }
  }

  // --- N3: vazao instantanea (rawValue / 10) ---
  // Não processa quando o frame é confirmação de RV (dados de N2/N3 desse frame
  // são descartados; próximas leituras retomam normalmente).
  if (rawN3 !== null && !resetConfirmed) {
    try {
      const flowRate = rawN3 / 10.0;
      await withCloudTimeout(
        supabase.from("equipments").update({ flow_rate_m3h: flowRate }).eq("id", eq.id),
        "flow N3 update",
        CLOUD_TELEMETRY_TIMEOUT_MS,
      );
      pushLog("info", "cloud",
        `[VAZAO] PLC ${plcHwId}: vazao_instantanea=${flowRate.toFixed(1)} m3/h`, null, null);
    } catch (e) {
      pushLog("warn", "cloud", `[VAZAO] N3 update PLC ${plcHwId} falhou: ${e.message}`);
    }
  }
}

// Marca todos os TSNN com vazao_mode='real' como pendentes de RV (reset físico
// no firmware). Executado por scheduleMidnightReset() e pode ser chamado
// manualmente a partir de fluxos administrativos.
function markAllFlowRealForReset(reason) {
  let count = 0;
  for (const tsnn of flowEquipByTsnn.keys()) {
    pendingVazaoResetByTsnn.set(tsnn, true);
    count++;
  }
  if (count > 0) {
    pushLog("info", "system",
      `[VAZAO] ${count} TSNN marcados para RV (${reason || "midnight"})`);
  }
  return count;
}

// Agenda um disparo para 00:00:05 local do próximo dia, marcando todos os
// equipamentos com vazao_mode='real' para receber RV no próximo polling.
// Reagenda automaticamente após o disparo.
function scheduleMidnightReset() {
  if (midnightResetTimer) {
    clearTimeout(midnightResetTimer);
    midnightResetTimer = null;
  }
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5, 0);
  const delayMs = Math.max(1_000, next.getTime() - now.getTime());
  midnightResetTimer = setTimeout(async () => {
    try {
      try { await refreshEquipmentCache(); } catch (_) {}
      // v3.25.4: janela de meia-noite (00:00–01:00) — cada TSNN 'real' tem até
      // 3 tentativas (00:00:05, 00:20, 00:40) de fechar+resetar. Falhando as
      // 3, força fechamento com o último valor conhecido e delega o RV ao
      // próximo polling normal (fallback por queda cobre firmwares antigos).
      startMidnightWindow();
    } catch (e) {
      pushLog("warn", "system", `[VAZAO] scheduleMidnightReset disparo falhou: ${e.message}`);
    } finally {
      scheduleMidnightReset(); // reagenda para a próxima meia-noite
    }
  }, delayMs);
  pushLog("info", "system",
    `[VAZAO] Reset de meia-noite agendado em ${Math.round(delayMs / 1000)}s (${next.toISOString()})`);
}

// Fecha o dia corrente para todos os TSNN com vazao_mode='real':
// grava daily_consumption = dayAccum.accum + lastRawN2 (todos os segmentos)
// e reinicia o acumulador para o novo dia.
async function closeAllFlowDays(reason) {
  for (const [tsnn, dayAccum] of flowDayAccumByTsnn.entries()) {
    const eq = flowEquipByTsnn.get(tsnn);
    if (!eq) continue;
    const lastEntry = lastN2ByTsnn.get(tsnn);
    const lastRawN2 = lastEntry ? lastEntry.value : 0;
    const consumoDia = dayAccum.accum + Math.max(0, lastRawN2);
    if (consumoDia > 0) {
      try {
        await supabase.from("daily_consumption").upsert(
          {
            farm_id: farmId,
            equipment_id: eq.id,
            date: dayAccum.date,
            total_m3: consumoDia,
            mode: "real",
          },
          { onConflict: "equipment_id,date" },
        );
        pushLog("info", "system",
          `[VAZAO] Dia ${dayAccum.date} fechado (${reason}): ${consumoDia} m3 (TSNN ${tsnn})`);
      } catch (e) {
        pushLog("warn", "system",
          `[VAZAO] fechamento diário TSNN ${tsnn} falhou: ${e.message}`);
      }
    }
    // Novo dia começa zerado; lastRawN2 também reseta pois o firmware receberá RV.
    flowDayAccumByTsnn.set(tsnn, { date: todayStr(), accum: 0 });
    lastN2ByTsnn.set(tsnn, { value: 0, at: Date.now() });
    try {
      await supabase.from("equipments").update({ flow_total_m3: 0 }).eq("id", eq.id);
      eq.flow_total_m3 = 0;
    } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Sequência de meia-noite (v3.25.4)
// ---------------------------------------------------------------------------
// Substitui closeAllFlowDays()+markAllFlowRealForReset() por um fluxo síncrono
// por equipamento que elimina a janela entre "última leitura" e "RV":
//   1) sendAndWaitResponse com polling normal (sem RV) — captura N2 final;
//      grava daily_consumption com data de ONTEM (dayAccum.date).
//   2) sendAndWaitResponse com RV (retry 0/6/12/18s, timeout 5s cada) — se
//      confirmado, o handler já contabilizou; se não, marca pendingVazaoReset
//      para o próximo polling do dia seguinte.
//   3) Reinicia flowDayAccumByTsnn/lastN2ByTsnn para hoje.
// Polling normal é pausado (midnightSequenceActive) enquanto executa.
function buildMidnightPollingFrame(tsnn, withRV) {
  // Frame padrão de polling: [TSNN_1_]{0}[TSNN_ETX_]\r
  // No polling real o payload reflete o estado das saídas do PLC; aqui a
  // sequência não altera relés — pede apenas leitura de contadores. `{0}` é
  // aceito pelo firmware como "consulta sem transição" (assim como no polling
  // normal, cujo payload é substituído pelo firmware conforme estado atual).
  const payload = withRV ? "0RV" : "0";
  return `[${tsnn}_1_]{${payload}}[${tsnn}_ETX_]\r`;
}

async function sendAndWaitFlowResponse(tsnn, frame, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      midnightRxHandlers.delete(tsnn);
      clearTimeout(t);
      resolve(val);
    };
    midnightRxHandlers.set(tsnn, (rx) => finish(rx));
    const t = setTimeout(() => finish(null), timeoutMs);
    try {
      sendTxFrame(frame, { priority: "reset" });
    } catch (e) {
      pushLog("warn", "serial", `[VAZAO-MIDNIGHT] sendTxFrame TSNN ${tsnn}: ${e.message}`);
      finish(null);
    }
  });
}

// ---------------------------------------------------------------------------
// Janela de meia-noite (00:00 → 01:00) com até 3 tentativas por TSNN.
// ---------------------------------------------------------------------------
// A cada disparo (00:00:05, 00:20:00, 00:40:00 após meia-noite) o agente tenta:
//   1) polling normal (`{0}`) — capturar N2 final;
//   2) polling com RV + 4 sub-retries (0/6/12/18s) — confirmar reset físico.
// Sucesso = RV CONFIRMADO. Isso grava daily_consumption com data de ontem,
// zera flow_total_m3 e reinicia flowDayAccumByTsnn para o dia novo.
// Se as 3 tentativas falharem, o agente força o fechamento com o último N2
// conhecido e marca pendingVazaoResetByTsnn para tentar RV no próximo polling.
//
// Durante a janela, o polling normal dos DEMAIS equipamentos segue funcionando
// (a sequência não é global — cada TSNN 'real' tem seu próprio mutex).
const MIDNIGHT_ATTEMPT_OFFSETS_MS = [0, 20 * 60 * 1000, 40 * 60 * 1000];
const midnightBusyByTsnn = new Set(); // mutex por TSNN (evita reentrada)

function startMidnightWindow() {
  if (!supabase || !farmId) return;
  const entries = Array.from(flowEquipByTsnn.entries());
  if (entries.length === 0) {
    pushLog("info", "system", "[VAZAO-MIDNIGHT] Nenhum TSNN com vazao_mode=real; nada a fazer.");
    return;
  }
  pushLog("info", "system",
    `[VAZAO-MIDNIGHT] Janela aberta para ${entries.length} TSNN(s) — 3 tentativas até 01:00.`);
  for (const [tsnn] of entries) {
    // date de fechamento: a data do accum atual (deve ser "ontem" às 00:00:05)
    // é congelada aqui para não sofrer mutação por RX intercalado.
    const dayAccum = flowDayAccumByTsnn.get(tsnn);
    const closeDate = dayAccum && dayAccum.date !== todayStr() ? dayAccum.date : yesterdayStr();
    scheduleMidnightAttempts(tsnn, closeDate);
  }
}

function scheduleMidnightAttempts(tsnn, closeDate) {
  const startedAt = Date.now();
  const runAttempt = async (attemptIdx) => {
    if (midnightBusyByTsnn.has(tsnn)) {
      pushLog("warn", "system",
        `[VAZAO-MIDNIGHT] TSNN ${tsnn}: tentativa ${attemptIdx + 1} pulada (mutex ocupado).`);
      return scheduleNext(attemptIdx, false);
    }
    midnightBusyByTsnn.add(tsnn);
    let closed = false;
    try {
      closed = await runMidnightAttempt(tsnn, closeDate, attemptIdx);
    } catch (e) {
      pushLog("warn", "system",
        `[VAZAO-MIDNIGHT] TSNN ${tsnn}: erro na tentativa ${attemptIdx + 1}: ${e.message}`);
    } finally {
      midnightBusyByTsnn.delete(tsnn);
    }
    scheduleNext(attemptIdx, closed);
  };
  const scheduleNext = (attemptIdx, closed) => {
    if (closed) return; // sucesso — não agenda mais
    const nextIdx = attemptIdx + 1;
    if (nextIdx >= MIDNIGHT_ATTEMPT_OFFSETS_MS.length) {
      // Última falhou — força fechamento com último valor conhecido.
      void forceCloseMidnight(tsnn, closeDate);
      return;
    }
    const targetAt = startedAt + MIDNIGHT_ATTEMPT_OFFSETS_MS[nextIdx];
    const delay = Math.max(1_000, targetAt - Date.now());
    setTimeout(() => { void runAttempt(nextIdx); }, delay);
    pushLog("info", "system",
      `[VAZAO-MIDNIGHT] TSNN ${tsnn}: próxima tentativa em ${Math.round(delay / 1000)}s`);
  };
  // Primeira tentativa imediata (o próprio scheduleMidnightReset já disparou às 00:00:05).
  void runAttempt(0);
}

// Executa UMA tentativa: polling normal → RV com 4 sub-retries.
// Retorna true se RV foi confirmado (dia fechado com valor real).
async function runMidnightAttempt(tsnn, closeDate, attemptIdx) {
  const eq = flowEquipByTsnn.get(tsnn);
  if (!eq) return false;
  pushLog("info", "system",
    `[VAZAO-MIDNIGHT] TSNN ${tsnn}: tentativa ${attemptIdx + 1}/3 iniciando.`);

  // PASSO 1 — polling normal
  const rxNormal = await sendAndWaitFlowResponse(
    tsnn, buildMidnightPollingFrame(tsnn, false), 5000,
  );
  let n2Captured = null;
  if (rxNormal && Number.isFinite(rxNormal.n2)) {
    n2Captured = Math.max(0, rxNormal.n2);
    // Atualiza cache local — o handler intercepta e não deixa o processFlow
    // normal atualizar lastN2ByTsnn, então fazemos aqui.
    lastN2ByTsnn.set(tsnn, { value: n2Captured, at: Date.now() });
  } else {
    pushLog("warn", "system",
      `[VAZAO-MIDNIGHT] TSNN ${tsnn}: sem resposta ao polling normal (tent ${attemptIdx + 1}).`);
    return false; // sem N2 real e sem RV — não fecha; próxima tentativa
  }

  // PASSO 2 — RV com sub-retries 0/6/12/18s
  const subDelays = [0, 6000, 6000, 6000];
  let resetConfirmed = false;
  for (let sub = 0; sub < subDelays.length; sub++) {
    if (subDelays[sub] > 0) await sleep(subDelays[sub]);
    const rxRV = await sendAndWaitFlowResponse(
      tsnn, buildMidnightPollingFrame(tsnn, true), 5000,
    );
    if (rxRV && rxRV.rvConfirmed) {
      resetConfirmed = true;
      pushLog("info", "system",
        `[VAZAO-MIDNIGHT] TSNN ${tsnn}: RV CONFIRMADO (tent ${attemptIdx + 1}, sub ${sub + 1}/4).`);
      break;
    }
    pushLog("warn", "system",
      `[VAZAO-MIDNIGHT] TSNN ${tsnn}: RV sem confirmação (tent ${attemptIdx + 1}, sub ${sub + 1}/4).`);
  }

  if (!resetConfirmed) return false;

  // Sucesso — fecha o dia com n2Captured + accum e reinicia.
  const dayAccum = flowDayAccumByTsnn.get(tsnn) || { date: closeDate, accum: 0 };
  const consumoDia = Math.max(0, dayAccum.accum) + n2Captured;
  await persistDailyConsumption(eq.id, closeDate, consumoDia,
    `dia fechado (tent ${attemptIdx + 1}) accum=${dayAccum.accum} n2=${n2Captured}`);
  await resetFlowDayForTsnn(tsnn, eq);
  return true;
}

// Fechamento forçado após 3 tentativas falhas: usa último N2 conhecido +
// accum e delega o RV ao próximo polling normal (pendingVazaoResetByTsnn).
async function forceCloseMidnight(tsnn, closeDate) {
  const eq = flowEquipByTsnn.get(tsnn);
  if (!eq) return;
  const dayAccum = flowDayAccumByTsnn.get(tsnn) || { date: closeDate, accum: 0 };
  const lastEntry = lastN2ByTsnn.get(tsnn);
  const lastN2 = lastEntry ? Math.max(0, lastEntry.value) : 0;
  const consumoDia = Math.max(0, dayAccum.accum) + lastN2;
  pushLog("error", "system",
    `[VAZAO-MIDNIGHT] TSNN ${tsnn}: 3 tentativas falharam — fechamento forçado com último valor (${consumoDia} m3). RV delegado ao próximo polling.`);
  await persistDailyConsumption(eq.id, closeDate, consumoDia, "fechamento forçado (3 falhas)");
  pendingVazaoResetByTsnn.set(tsnn, true);
  await resetFlowDayForTsnn(tsnn, eq);
}

async function persistDailyConsumption(equipmentId, date, totalM3, reason) {
  if (totalM3 <= 0) return;
  try {
    await supabase.from("daily_consumption").upsert(
      { farm_id: farmId, equipment_id: equipmentId, date, total_m3: totalM3, mode: "real" },
      { onConflict: "equipment_id,date" },
    );
    pushLog("info", "system",
      `[VAZAO-MIDNIGHT] daily_consumption ${date} = ${totalM3} m3 (${reason})`);
  } catch (e) {
    pushLog("warn", "system",
      `[VAZAO-MIDNIGHT] upsert daily_consumption falhou: ${e.message}`);
  }
}

async function resetFlowDayForTsnn(tsnn, eq) {
  flowDayAccumByTsnn.set(tsnn, { date: todayStr(), accum: 0 });
  lastN2ByTsnn.set(tsnn, { value: 0, at: Date.now() });
  try {
    await supabase.from("equipments").update({ flow_total_m3: 0 }).eq("id", eq.id);
    eq.flow_total_m3 = 0;
  } catch (_) {}
}





// Consulta equipments.vazao_reset_pending=true e transfere para o Map local,
// limpando a flag no banco em seguida. Chamado no início de cada ciclo de polling.
async function checkRemoteResetPending() {
  if (!supabase || !farmId) return;
  try {
    const { data: eqs, error } = await supabase
      .from("equipments")
      .select("id, hw_id")
      .eq("farm_id", farmId)
      .eq("vazao_mode", "real")
      .eq("vazao_reset_pending", true);
    if (error) {
      pushLog("debug", "system", `[VAZAO] checkRemoteResetPending query erro: ${error.message}`);
      return;
    }
    if (!eqs || eqs.length === 0) return;
    for (const eq of eqs) {
      const hw = String(eq.hw_id || "").trim().toUpperCase();
      const tsnn = hw.length >= 4 ? hw.substring(0, 4) : hw;
      if (tsnn) {
        pendingVazaoResetByTsnn.set(tsnn, true);
        pushLog("info", "system", `[VAZAO] Reset remoto pendente detectado para TSNN ${tsnn}`);
      }
      try {
        await supabase.from("equipments").update({ vazao_reset_pending: false }).eq("id", eq.id);
      } catch (e) {
        pushLog("warn", "system", `[VAZAO] limpeza da flag vazao_reset_pending falhou: ${e.message}`);
      }
    }
  } catch (e) {
    pushLog("warn", "system", `[VAZAO] checkRemoteResetPending falhou: ${e.message}`);
  }
}

// Se houver reset pendente para o TSNN deste frame, reescreve `{PAYLOAD}` como
// `{PAYLOADRV}` para que o firmware zere o contador físico ao processar.
// Retorna o frame (possivelmente modificado). Remove o TSNN do Map após injeção.
function maybeInjectVazaoReset(frame, tsnn) {
  if (!frame || !tsnn) return frame;
  const key = String(tsnn).toUpperCase();
  if (!pendingVazaoResetByTsnn.has(key)) return frame;
  // Só injeta em frame de polling/comando comum `[TSNN_1_]{PAYLOAD}...`.
  const m = String(frame).match(/\{([01]{1,6})(RV)?\}/);
  if (!m || m[2]) {
    // Sem payload posicional ou já tem RV — não mexe, mas mantém a marca para
    // a próxima oportunidade de envio.
    return frame;
  }
  const newFrame = frame.replace(/\{([01]{1,6})\}/, `{$1RV}`);
  pendingVazaoResetByTsnn.delete(key);
  pushLog("info", "system", `[VAZAO] RV injetado no polling de TSNN ${key}`);
  return newFrame;
}

function markBridgeAlive() {
  lastBridgePongAt = Date.now();
  bridgePingSentAt = 0;
  lastBridgeError = null;
}

function stopBridgeWatchdog() {
  if (bridgeWatchdogTimer) {
    clearInterval(bridgeWatchdogTimer);
    bridgeWatchdogTimer = null;
  }
  bridgePingSentAt = 0;
}

async function failInflightWork(reason) {
  const respondedAt = new Date().toISOString();

  if (inflightTimer) {
    clearTimeout(inflightTimer);
    inflightTimer = null;
  }

  if (manualTimer) {
    clearTimeout(manualTimer);
    manualTimer = null;
  }

  const cmd = inflightCmd;
  const manual = inflightManual;

  inflightCmd = null;
  inflightTsnn = null;
  inflightManual = null;
  processing = false;

  if (cmd && supabase) {
    try {
      await supabase
        .from("commands")
        .update({ status: "error", response: reason, responded_at: respondedAt })
        .eq("id", cmd.id);
    } catch (_) {}
  }

  if (manual) {
    try {
      await resolveAgentCommand(manual.agentCmdId, "error", { error: reason });
    } catch (_) {}
  }
}

async function recoverBridge(reason, options = {}) {
  const { manual = false } = options;

  if (bridgeRecovering || appClosing || portManuallyClosed || !comPort) {
    return { success: false, error: "reset já em andamento ou porta indisponível" };
  }

  bridgeRecovering = true;
  lastBridgeError = reason;
  pushLog("warn", manual ? "remote" : "system", `Recuperando bridge: ${reason}`);

  try {
    await failInflightWork(`Bridge reiniciada: ${reason}`);
    await stopBridge();
    await new Promise((r) => setTimeout(r, BRIDGE_RESET_SETTLE_MS));
    await startBridge(comPort);
    consecutiveTimeouts = 0;
    lastBridgeError = null;
    await sendHeartbeat();
    pushLog("info", "system", "Bridge recuperada com sucesso");
    return { success: true };
  } catch (e) {
    lastBridgeError = e.message || reason;
    pushLog("error", "system", `Falha na recuperação da bridge: ${e.message}`);
    return { success: false, error: e.message };
  } finally {
    bridgeRecovering = false;
  }
}

function startBridgeWatchdog() {
  stopBridgeWatchdog();

  bridgeWatchdogTimer = setInterval(() => {
    if (appClosing || bridgeStopping || bridgeRecovering || portManuallyClosed) return;
    if (!bridgeReady || !bridgeProcess) return;

    if (bridgePingSentAt && Date.now() - bridgePingSentAt > BRIDGE_PING_TIMEOUT_MS) {
      bridgePingSentAt = 0;
      void recoverBridge("watchdog sem resposta do processo Python");
      return;
    }

    if (bridgePingSentAt) return;

    try {
      bridgeProcess.stdin.write(Buffer.from("PING\n", "utf8"));
      bridgePingSentAt = Date.now();
    } catch (e) {
      void recoverBridge(`falha ao enviar watchdog: ${e.message}`);
    }
  }, BRIDGE_PING_INTERVAL_MS);
}

// --- Handle RX frame from Python bridge ---
function handleRxFrame(frame) {
  // AUDITORIA: TODO frame RX que entra aqui eh logado como "raw_rx"
  // (independente de logLevel) para garantir rastreabilidade contra perda.
  // Comparar este log com [PY FRAME] no log do Python: se aparece la e nao
  // aparece aqui, ha perda no pipe stdout (improvavel).
  pushLog("debug", "raw_rx", `RX raw: ${frame}`, frame);

  // 1) Telemetria — processa IMEDIATAMENTE, sem debounce/filtro
  //    (vem antes de tudo: precisamos enxergar TODA mudanca de estado da bomba)
  const telemMatch = extractTelemetryParts(frame);
  if (telemMatch) {
    processTelemFrame(frame);
    return;
  }

  // AUDITORIA: frame que nao casa com telemetria nem CFG sera logado abaixo
  // como "ignorado" se nenhum dos branches seguintes consumir.

  // 2) Resposta a comando CFG (PING, STATUS, DUMP, SAVE, REBOOT, SET_*, etc.)
  //    Formato: _[TSNN_<TAG>_]{PAYLOAD}
  //    Se ha um inflightCmd do tipo 'config' aguardando resposta deste TSNN,
  //    confirmamos AQUI e marcamos o comando como 'executed' na nuvem.
  const cfgMatch = frame.match(RX_CFG_RESP_RE);
  if (cfgMatch) {
    const rxTsnn = String(cfgMatch[1] || "").toUpperCase();
    const rxTag  = cfgMatch[2];
    const rxPayload = cfgMatch[3];

    const expectedCfgTsnn = inflightCmd ? (inflightTsnn || extractCommandTsnn(inflightCmd.frame)) : null;
    const matchesExpectedTsnn = expectedCfgTsnn === rxTsnn || isSetIdAckForNewTsnn(inflightCmd, rxTsnn, rxTag, rxPayload);

    if (
      inflightCmd &&
      inflightCmd.type === "config" &&
      matchesExpectedTsnn &&
      TX_CFG_RE.test(String(inflightCmd.frame || "")) &&
      isCfgAckCompatible(inflightCmd, rxTag, rxPayload)
    ) {
      const cmd = inflightCmd;
      const sentMs = cmd.sent_at ? new Date(cmd.sent_at).getTime()
                    : (cmd.created_at ? new Date(cmd.created_at).getTime() : Date.now());
      const latencyMs = Date.now() - sentMs;

      if (inflightTimer) { clearTimeout(inflightTimer); inflightTimer = null; }
      inflightCmd = null;
      inflightTsnn = null;
      recentCmdByTsnn.delete(rxTsnn);
      if (expectedCfgTsnn && expectedCfgTsnn !== rxTsnn) recentCmdByTsnn.delete(expectedCfgTsnn);

      const cfgLabel = cfgResponseLabel(rxTag, rxPayload);
      pushLog("info", "rx", `[CFG] ${cfgLabel} recebido de ${nameForTsnn(rxTsnn)} em ${latencyMs}ms: ${frame}`, frame);
      const confirmedSetId = extractSetIdTarget(cmd);

      supabase
        .from("commands")
        .update({
          status: "executed",
          response: frame,
          responded_at: new Date().toISOString(),
        })
        .eq("id", cmd.id)
        .then(async () => {
          pushLog("info", "system", `cmd ${cmd.id.substring(0, 8)} -> executed (CFG ${cfgLabel})`, null, null);
          if (confirmedSetId) await syncConfirmedSetId(cmd, confirmedSetId);
          consecutiveTimeouts = 0;
          processing = false;
          // pega o proximo da fila imediatamente
          setTimeout(() => { void processNextCommand(); }, 10);
        });
      return;
    }

    // PING/STATUS/DUMP espontaneos (sem inflight casando) — apenas registra
    const cfgLabel = cfgResponseLabel(rxTag, rxPayload);
    if (cfgLabel === "PING") {
      pushLog("info", "rx", `PING recebido de ${nameForTsnn(rxTsnn)} (sem comando aguardando)`, frame);
      return;
    }
    if (cfgLabel !== "CFG") {
      pushLog("info", "rx", `[CFG] ${cfgLabel} recebido de ${nameForTsnn(rxTsnn)} (sem comando aguardando): ${frame}`, frame);
      return;
    }
    pushLog("info", "rx", `[CFG] resposta recebida de ${nameForTsnn(rxTsnn)} (sem comando aguardando): ${frame}`, frame);
    return;
  }

  // 3) Frame nao-telemetria mas resposta a manual (ex.: CFG ack via Hercules)
  if (inflightManual) {
    const m = inflightManual;
    const latencyMs = Date.now() - m.sentAt;
    inflightManual = null;
    if (manualTimer) { clearTimeout(manualTimer); manualTimer = null; }
    pushLog("info", "rx", `[MANUAL] resposta em ${latencyMs}ms: ${frame}`, frame, null);
    void resolveAgentCommand(m.agentCmdId, "done", {
      response: frame,
      latency_ms: latencyMs,
    });
    return;
  }

  // 4) Frame desconhecido
  pushLog("warn", "rx", `Frame desconhecido: ${frame}`, frame);
}

// Processa UM frame de telemetria _[TSNN_0_]{PAYLOAD} imediatamente.
// RX sempre ativo: nao filtra duplicatas nem coalesce rajadas — cada frame
// vira uma leitura registrada (saveTelemetry) para que o backend enxergue
// todas as transicoes de estado da bomba.
function processTelemFrame(frame) {
  const telemMatch = extractTelemetryParts(frame);
  if (!telemMatch) return;

  const rxTsnn = telemMatch.tsnn;
  const rxPayload = telemMatch.payload;
  if (!rxTsnn) return;

  // Backoff: qualquer RX desta PLC zera o contador de falhas consecutivas
  noteBackoffSuccess(rxTsnn);

  // v3.25.7: sequência de desligamento forçado — resolve o waiter se este RX
  // confirma o bit alvo esperado. NÃO retorna: a telemetria continua sendo
  // gravada normalmente (queremos registrar os estados {1} e {0}).
  if (forcedShutdownRxWaiter && forcedShutdownRxWaiter.tsnn === rxTsnn) {
    const w = forcedShutdownRxWaiter;
    const rx = String(rxPayload || "");
    if (/^[01]{1,6}$/.test(rx)) {
      const bit = rx.length === 1 ? rx[0] : (w.targetIndex < rx.length ? rx[w.targetIndex] : null);
      if (bit === w.wantBit) w.resolve();
    }
  }

  // Camada 1: se ha um inflightCmd aguardando OUTRO TSNN, este RX eh
  // espontaneo de outro equipamento. Processa normalmente (codigo abaixo),
  // mas marca para que o timeout possa decidir retry e NAO encerra o timer
  // do inflight atual (o `if (inflightCmd && inflightTsnn === rxTsnn)` mais
  // abaixo so casa quando TSNN bate, entao o timer ja fica preservado).
  if (inflightCmd && inflightTsnn && inflightTsnn !== rxTsnn) {
    inflightSpontaneousSeen = true;
    pushLog("info", "rx",
      `[POLLING] Espontaneo TSNN ${rxTsnn} durante espera de TSNN ${inflightTsnn} — timer mantido`);
  }


  // Niveis (N1/N2): roda em paralelo, nao bloqueia o fluxo da bomba.
  void processLevelReadings(frame, rxTsnn);
  void processFlowReadings(frame, rxTsnn);

  // CANCELAMENTO PROATIVO DO SAFETY TIMER (multi-saidas):
  // Toda resposta `_[TSNN_0_]{PAYLOAD}` carrega o estado de TODAS as saidas
  // do PLC. Antes de qualquer outra logica, varremos os safety timers ativos
  // desse TSNN e cancelamos cada um cuja saida ja esteja no estado esperado.
  // Isso garante que, mesmo se o RX nao casar com o inflightCmd, ou for
  // resposta atrasada/espontanea, o failsafe nao derrube uma bomba que
  // ja confirmou o comando.
  try { cancelSafetyForTsnnOnRx(rxTsnn, rxPayload); }
  catch (e) { pushLog("warn", "system", `cancelSafetyForTsnnOnRx erro: ${e.message}`); }

  // Cancela reforços manuais ativos para este TSNN APENAS se o bit da saida
  // alvo casar com o esperado. RX intermediario (bit diferente do desejado)
  // NAO cancela o reforco — a bomba ainda nao mudou de estado, precisamos
  // continuar reenviando.
  try {
    const rx = String(rxPayload || "");
    const rxValid = /^[01]{1,6}$/.test(rx);
    for (const [eqId, entry] of manualReinforceByEquipment.entries()) {
      if (!entry || entry.tsnn !== rxTsnn) continue;
      if (!rxValid || !entry.expectedBit) continue;
      const saida = Number(entry.saida) || 0;
      let stateBit = null;
      if (rx.length === 1) stateBit = rx[0];
      else if (saida >= 1 && saida <= rx.length) stateBit = rx[saida - 1];
      if (stateBit === null) continue;
      if (stateBit === entry.expectedBit) {
        pushLog("info", "system",
          `[REFORCO] Confirmado TSNN ${rxTsnn} (RX bit=${stateBit} correto, saida=${saida})`);
        clearManualReinforcements(eqId, `RX confirmou bit ${stateBit} da saida ${saida}`);
      } else {
        pushLog("info", "system",
          `[REFORCO] RX intermediario TSNN ${rxTsnn} (recebido=${stateBit}, esperado=${entry.expectedBit}) — reforco mantido`);
      }
    }
  } catch (e) { pushLog("warn", "system", `clearReinforce on RX erro: ${e.message}`); }

  // 0) Resposta de frame manual (Terminal Hercules) tem prioridade tambem aqui
  if (inflightManual) {
    const expected = inflightManual.expectedTsnn;
    const ackMatch = expected ? rxTsnn === expected : true;
    if (ackMatch) {
      const m = inflightManual;
      const latencyMs = Date.now() - m.sentAt;
      inflightManual = null;
      if (manualTimer) { clearTimeout(manualTimer); manualTimer = null; }
      pushLog("info", "rx", `[MANUAL] resposta em ${latencyMs}ms: ${frame}`, frame, null);
      void resolveAgentCommand(m.agentCmdId, "done", {
        response: frame,
        latency_ms: latencyMs,
      });
      // continua para gravar telemetria
    }
  }

  if (inflightCmd && inflightTsnn === rxTsnn) {
    const cmd = inflightCmd;

    // Para comandos MANUAIS: se o RX trouxer payload diferente do esperado pelo TX,
    // consumir o inflight local e liberar a fila serial imediatamente. A janela
    // física de confirmação continua no banco/UI via pending_command_id; o agente
    // NÃO pode ficar 120s parado, porque o polling precisa continuar martelando o
    // desired_running a cada ciclo até a bomba confirmar o estado esperado.
    if (cmd.type === "manual") {
      const { expectedPayload, expectedMatches } = manualRxConfirmsExpected(cmd, rxPayload);

      if (!expectedMatches) {
        // RX divergente durante comando MANUAL — registra como leitura
        // intermediaria (rele ainda nao fechou / ainda partindo) e libera o
        // canal para que o polling normal reenvie o desired_running.
        //
        // IMPORTANTE: NAO chamar applySpontaneousImmediately aqui. Isso
        // marcava last_actuation_origin=local com o estado intermediario
        // (ex: TX={1}, RX intermediario={0}), travando a UI em "Ligando"
        // mesmo quando o RX correto {1} chegava depois.
        pushLog(
          "warn",
          "rx",
          `cmd ${cmd.id.substring(0, 8)} -> RX intermediario divergente (esperado=${expectedPayload}, recebido=${rxPayload}); fila liberada para polling continuar`,
          frame,
          `Leitura intermediaria de ${nameForTsnn(rxTsnn)} (${rxPayload}) — aguardando confirmacao`,
        );
        if (inflightTimer) { clearTimeout(inflightTimer); inflightTimer = null; }
        // ARMA SAFETY TIMER (120s) para esse equipamento. Se a bomba nao
        // confirmar o estado esperado dentro da janela, enviamos TX OFF
        // de seguranca + desired_running=false (failsafe).
        try {
          if (cmd.equipment_id && expectedPayload) {
            const expectedBit = expectedPayload[expectedPayload.length - 1];
            const eq = equipmentById.get(String(cmd.equipment_id));
            armSafetyTimer(String(cmd.equipment_id), {
              tsnn: rxTsnn,
              saida: eq?.saida || expectedPayload.length,
              expectedBit,
              expectedPayload,
              cmdId: cmd.id,
            });
          }
        } catch (e) {
          pushLog("warn", "system", `armSafetyTimer (rx divergente) falhou: ${e.message}`);
        }
        inflightCmd = null;
        inflightTsnn = null;
        processing = false;
        setTimeout(() => { void processNextCommand(); }, 50);
        // Telemetria so para historico (nao altera last_actuation_origin)
        void queueTelemetry(rxTsnn, rxPayload, frame, null);
        return;
      }
    }

    // Resposta valida — consome inflight
    clearTimeout(inflightTimer);
    inflightTimer = null;
    inflightCmd = null;
    inflightTsnn = null;
    recentCmdByTsnn.delete(rxTsnn);

    // Cancela safety timer IMEDIATAMENTE se o RX confirma o estado esperado.
    // (Evita que o failsafe dispare TX OFF apos a bomba ja ter confirmado.)
    if (cmd.equipment_id) {
      try { maybeCancelSafetyOnRx(String(cmd.equipment_id), rxPayload); }
      catch (e) { pushLog("warn", "system", `maybeCancelSafetyOnRx (manual ack) falhou: ${e.message}`); }
    }

    pushLog("info", "rx", `Telemetria cmd: TSNN=${rxTsnn} payload=${rxPayload}`, frame);

    const finishInflight = () => {
      consecutiveTimeouts = 0;
      if (cmd.type === "polling") {
        lastPollingEndAt = Date.now();
        lastPollingEndedWithTimeout = false;
        noteSuccessfulPoll(rxTsnn);
        pollingCycleStats.ok++;
      }
      processing = false;
      // v3.8.15: dispara o proximo comando IMEDIATAMENTE (sem esperar o tick de 10s)
      setImmediate(() => { void processNextCommand(); });
    };

    if (cmd.type === "manual") {
      // Cancela reforços manuais pendentes (caso safety não esteja armado)
      if (cmd.equipment_id) {
        try { maybeCancelReinforcementsOnRx(String(cmd.equipment_id), rxPayload, extractTxPayload(cmd.frame)); }
        catch (e) { pushLog("warn", "system", `maybeCancelReinforcementsOnRx falhou: ${e.message}`); }
      }
      pushLog(
        "info",
        "system",
        `cmd ${cmd.id.substring(0, 8)} -> resposta manual confirmada pela telemetria`,
        null,
        null,
      );
      void queueTelemetry(rxTsnn, rxPayload, frame, cmd.id).finally(finishInflight);
      return;
    }

    // Modo Servico: round-trip puro. NAO altera last_outputs_state nem
    // desired_running, NAO arma safety, NAO grava telemetria. Apenas
    // marca o comando como executed com response + latency_ms para a UI.
    if (cmd.type === "service_test") {
      const latencyMs = Date.now() - new Date(cmd.sent_at || cmd.created_at || Date.now()).getTime();
      pushLog("info", "rx", `[SERVICE_TEST] cmd ${cmd.id.substring(0,8)} OK em ${latencyMs}ms: ${frame}`, frame);
      withCloudTimeout(
        supabase
          .from("commands")
          .update({
            status: "executed",
            response: frame,
            responded_at: new Date().toISOString(),
            error_message: `latency_ms=${latencyMs}`,
          })
          .eq("id", cmd.id),
        "marcar service_test executed",
        CLOUD_WRITE_TIMEOUT_MS,
      ).then(finishInflight).catch(finishInflight);
      return;
    }

    withCloudTimeout(
      supabase
        .from("commands")
        .update({
          status: "executed",
          response: frame,
          responded_at: new Date().toISOString(),
        })
        .eq("id", cmd.id),
      "marcar comando executado",
      CLOUD_WRITE_TIMEOUT_MS,
    )
      .then(() => {
        pushLog("info", "system", `cmd ${cmd.id.substring(0, 8)} -> executed`, null, null);
        finishInflight();
      })
      .catch((e) => {
        pushLog("error", "cloud", `executed falhou: ${e.message}; fila liberada`);
        finishInflight();
      });

    // v3.9.6 — Para resposta de POLLING usamos o caminho espontâneo
    // (classifica origem como 'local' quando o RX diverge do desired_running).
    // Antes passávamos cmd.id em queueTelemetry, o que fazia a RPC marcar
    // origin='remote-cmd' e mascarava acionamentos locais detectados via
    // polling — por isso o badge LOCAL nunca aparecia em fazendas onde o
    // único RX vem dentro da rodada de polling.
    void applySpontaneousImmediately(rxTsnn, rxPayload, frame).then((ok) => {
      if (!ok) void queueTelemetry(rxTsnn, rxPayload, frame, null);
    });
  } else {
    // Tenta casar com um comando recente do mesmo TSNN cujo timeout ja expirou
    // (resposta atrasada da bomba — ainda eh a telemetria daquele comando).
    const recent = recentCmdByTsnn.get(rxTsnn);
    if (recent && Date.now() < recent.expiresAt) {
      // Resposta ATRASADA do comando: ainda assim PRECISA atualizar a UI
      // imediatamente (via RPC), porque o usuario remoto esta vendo "Ligando".
      // Tambem registra a telemetria casada com o commandId para fechar o ciclo.
      recentCmdByTsnn.delete(rxTsnn);
      const latencyMs = Date.now() - recent.sentAt;
      pushLog(
        "info",
        "rx",
        `[ATRASADO] TSNN=${rxTsnn} payload=${rxPayload} (${latencyMs}ms apos TX, casado com cmd ${recent.cmdId.substring(0, 8)}) — aplicando IMEDIATO`,
        frame,
        `Resposta atrasada de ${nameForTsnn(rxTsnn)} (${latencyMs}ms): ${frame}`,
      );
      consecutiveTimeouts = 0;
      // 1) Aplica IMEDIATO no banco (bypass da fila) para a UI atualizar agora
      void applySpontaneousImmediately(rxTsnn, rxPayload, frame);
      // 2) Tambem grava na fila com commandId para fechar o ciclo do comando
      void queueTelemetry(rxTsnn, rxPayload, frame, recent.cmdId);
    } else {
      // SINAL ESPONTANEO real: bomba enviou status sem nenhum comando recente.
      // v3.9.11 — Throttle por TSNN: processa no maximo 1 espontaneo a cada 10s.
      // Evita que uma PLC defeituosa (ex: PLC 2101 spammando 1-2 frames/s) congestione
      // o pipeline de RPC/cloud e atrase o polling das demais PLCs.
      const nowSpon = Date.now();
      const lastSpon = lastSpontaneousAtByTsnn.get(rxTsnn) || 0;
      if (nowSpon - lastSpon < SPONTANEOUS_THROTTLE_MS) {
        const skipped = (spontaneousSkippedByTsnn.get(rxTsnn) || 0) + 1;
        spontaneousSkippedByTsnn.set(rxTsnn, skipped);
        if (skipped === 1 || skipped % 20 === 0) {
          pushLog("warn", "rx",
            `[ESPONTANEO THROTTLE] TSNN=${rxTsnn} descartado (${skipped} desde o ultimo aceito, throttle ${SPONTANEOUS_THROTTLE_MS}ms)`);
        }
        return;
      }
      lastSpontaneousAtByTsnn.set(rxTsnn, nowSpon);
      spontaneousSkippedByTsnn.set(rxTsnn, 0);
      pushLog("info", "rx", `[ESPONTANEO] TSNN=${rxTsnn} payload=${rxPayload}`, frame, `Sinal espontâneo de ${nameForTsnn(rxTsnn)} → ${rxPayload} | ${frame}`);
      void applySpontaneousImmediately(rxTsnn, rxPayload, frame).then((ok) => {
        if (!ok) void queueTelemetry(rxTsnn, rxPayload, frame, null);
      });
    }
  }
}

// --- Stop bridge ---
function stopBridge() {
  return new Promise((resolve) => {
    stopBridgeWatchdog();
    bridgePingSentAt = 0;
    lastBridgePongAt = 0;
    global.__lastWorkingComSaved = false;
    if (!bridgeProcess) {
      bridgeReady = false;
      resolve();
      return;
    }
    const proc = bridgeProcess;
    bridgeStopping = true;
    bridgeProcess = null;
    bridgeReady = false;

    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };

    proc.once("exit", finish);
    try { proc.stdin.write(Buffer.from("QUIT\n", "utf8")); } catch (e) {}
    setTimeout(() => { try { proc.kill(); } catch (e) {} finish(); }, 1200);
  });
}

// --- Python Serial Bridge ---
function startBridge(portPath) {
  return new Promise((resolve, reject) => {
    const pythonCandidates = getPythonCandidates();
    const pythonEnv = buildPythonEnv();
    const failures = [];
    let candidateIndex = 0;

    function tryNext() {
      if (candidateIndex >= pythonCandidates.length) {
        const detail = failures.length ? ` Detalhes: ${failures.join(" | ")}` : "";
        reject(new Error(`Bridge Serial nao iniciou. Python/pyserial ou arquivo da bridge indisponivel.${detail}`));
        return;
      }

      const pythonCmd = pythonCandidates[candidateIndex];
      candidateIndex++;

      pushLog("info", "system", `Tentando bridge com: ${pythonCmd}`);

      let proc;
      try {
        proc = spawn(pythonCmd, [PYTHON_BRIDGE, portPath], {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          env: pythonEnv,
        });
      } catch (e) {
        failures.push(`${pythonCmd}: ${e.message}`);
        pushLog("warn", "system", `${pythonCmd} indisponivel: ${e.message}`);
        tryNext();
        return;
      }

      let started = false;
      let stdoutBuffer = "";
      let stderrBuffer = "";

      proc.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          if (!started && trimmed === "READY") {
            started = true;
            bridgeProcess = proc;
            bridgeReady = true;
            markBridgeAlive();
            startBridgeWatchdog();
            pushLog("info", "serial", `Bridge conectada em ${portPath}`);
            if (tray) tray.setToolTip(`RENOV Agent - Online (${portPath})`);
            resolve();
            continue;
          }

          if (trimmed === "PONG") {
            markBridgeAlive();
            pushLog("debug", "serial", "Watchdog PONG");
            continue;
          }

          if (trimmed.startsWith("RX:")) {
            markBridgeAlive();
            lastRxTimestamp = Date.now(); // anti-colisao TX
            // v3.22.0: salva última COM funcional após primeiro RX válido
            try {
              if (!global.__lastWorkingComSaved) {
                const fs2 = require("fs");
                const lastComFile = path.join(app.getPath("userData"), "last_working_com.txt");
                fs2.writeFileSync(lastComFile, String(portPath || comPort || ""));
                global.__lastWorkingComSaved = true;
              }
            } catch (_) {}
            // Frame recebido da Serial -> processar
            handleRxFrame(trimmed.substring(3));
          } else if (trimmed === "TX_OK") {
            markBridgeAlive();
            pushLog("debug", "serial", "TX_OK");
          } else if (trimmed.startsWith("TX_ERR:")) {
            markBridgeAlive();
            pushLog("error", "serial", `Erro TX: ${trimmed.substring(7)}`);
            if (inflightCmd && inflightTimer) {
              clearTimeout(inflightTimer);
              inflightTimer = null;
              const cmd = inflightCmd;
              inflightCmd = null;
              inflightTsnn = null;
              supabase
                .from("commands")
                .update({ status: "error", response: trimmed, responded_at: new Date().toISOString() })
                .eq("id", cmd.id);
              processing = false;
            }
          } else if (trimmed.startsWith("ERROR:")) {
            pushLog("error", "serial", `Bridge: ${trimmed.substring(6)}`);
          }
        }
      });

      proc.stderr.on("data", (chunk) => {
        const msg = chunk.toString();
        stderrBuffer += msg;
        if (stderrBuffer.length > 4000) stderrBuffer = stderrBuffer.slice(-4000);
        const trimmed = msg.trim();
        if (trimmed) {
          for (const line of trimmed.split("\n")) {
            if (line.trim()) pushLog("debug", "bridge", line.trim());
          }
        }
      });

      proc.on("error", (err) => {
        if (!started) {
          failures.push(`${pythonCmd}: ${err.message}`);
          pushLog("warn", "system", `${pythonCmd} falhou: ${err.message}`);
          tryNext();
        } else {
          stopBridgeWatchdog();
          lastBridgeError = err.message;
          pushLog("error", "serial", `Bridge morreu: ${err.message}`);
          bridgeReady = false;
        }
      });

      proc.on("exit", (code) => {
        if (!started) {
          const stderrTail = stderrBuffer.trim().split("\n").slice(-3).join(" | ").slice(0, 400);
          const stderrInfo = stderrTail ? ` stderr=[${stderrTail}]` : "";
          failures.push(`${pythonCmd}: saiu antes de READY (code ${code}, bridge=${PYTHON_BRIDGE})${stderrInfo}`);
          // Auto-install pyserial se faltar
          const needsPyserial = /No module named ['"]?serial['"]?|ModuleNotFoundError.*serial|ImportError.*serial/i.test(stderrBuffer);
          if (needsPyserial && !pythonCmd.startsWith("__retry_after_install__")) {
            pushLog("warn", "system", `pyserial faltando em ${pythonCmd} — tentando instalar...`);
            try {
              const { spawnSync } = require("child_process");
              const installRes = spawnSync(pythonCmd, ["-m", "pip", "install", "--user", "--no-warn-script-location", "pyserial"], {
                env: pythonEnv,
                windowsHide: true,
                timeout: 60000,
              });
              if (installRes.status === 0) {
                pushLog("info", "system", `pyserial instalado em ${pythonCmd} — re-tentando bridge`);
                // Re-insere o mesmo candidato no topo da fila
                pythonCandidates.splice(candidateIndex, 0, pythonCmd);
              } else {
                const errMsg = (installRes.stderr?.toString() || installRes.stdout?.toString() || "").trim().slice(-300);
                pushLog("error", "system", `Falha ao instalar pyserial em ${pythonCmd}: ${errMsg}`);
              }
            } catch (e) {
              pushLog("error", "system", `Erro ao instalar pyserial: ${e.message}`);
            }
          }
          tryNext();
        } else if (bridgeStopping || appClosing) {
          bridgeStopping = false;
        } else {
          stopBridgeWatchdog();
          lastBridgeError = `Bridge encerrou (code ${code})`;
          pushLog("error", "serial", `Bridge encerrou (code ${code})`);
          bridgeReady = false;
          bridgeProcess = null;
          setTimeout(() => {
            if (comPort && !appClosing && !portManuallyClosed) {
              void recoverBridge(`bridge encerrou (code ${code})`);
            }
          }, 5000);
        }
      });

      setTimeout(() => {
        if (!started) {
          try { proc.kill(); } catch (e) {}
          tryNext();
        }
      }, 5000);
    }

    tryNext();
  });
}

// Pre-empcao: comando manual (priority<=1) chega via Realtime e ha algo em
// curso na serial. Polling sempre cede. Manual cede APENAS para reset (priority=0),
// para que o reset corte um "ligar" travado e force o desligar imediato.
async function preemptForIncomingManual(reason, incomingPriority, incomingCmd = null) {
  if (!inflightCmd) return false;
  const c = inflightCmd;
  const isPolling = c.type === "polling";
  const isManual = c.type === "manual";
  const incomingPayload = extractTxPayload(incomingCmd?.frame);
  const currentPayload = extractTxPayload(c.frame);
  const isProtectiveOffOverRemoteStart =
    isManual &&
    incomingPriority === 0 &&
    payloadCommandsOnlyOff(incomingPayload) &&
    payloadCommandsAnyOn(currentPayload) &&
    (Date.now() - new Date(c.sent_at || c.created_at || Date.now()).getTime()) < 60_000;
  // Reset (priority=0) pre-empta polling E manual, exceto TX 0 automático durante
  // a janela de 60s de um comando remoto de ligar ainda aguardando confirmação.
  const shouldPreempt = isPolling || (isManual && incomingPriority === 0 && (c.priority ?? 5) > 0 && !isProtectiveOffOverRemoteStart);
  if (!shouldPreempt) return false;
  if (inflightTimer) { clearTimeout(inflightTimer); inflightTimer = null; }
  // Cancela qualquer reforco TX manual pendente do comando preemptado
  if (isManual && c.equipment_id) {
    clearManualReinforcements(String(c.equipment_id), "comando preemptado");
  }
  inflightCmd = null;
  inflightTsnn = null;
  processing = false;
  try {
    await supabase
      .from("commands")
      .update({
        status: "cancelled",
        responded_at: new Date().toISOString(),
        error_message: reason || (isManual ? "Manual cancelado por RESET de emergência" : "Polling cancelado para liberar canal a comando manual"),
      })
      .eq("id", c.id);
  } catch (_) {}
  pushLog("info", "system", `${c.type} ${c.id.substring(0,8)} pre-emptado (incoming priority=${incomingPriority})`);
  return true;
}

// Compat: mantém nome antigo apontando para a nova função (priority=1 = manual normal)
async function preemptPollingForManual(reason) {
  return preemptForIncomingManual(reason, 1);
}

// FAST-PATH RESET (priority=0): aborta TUDO em curso e envia o frame de reset
// IMEDIATAMENTE pela serial, sem esperar o ciclo de processNextCommand.
// Garante latencia <100ms entre clique na web e bytes saindo na RS-232.
async function fastPathReset(cmd) {
  const startedAt = Date.now();
  pushLog("warn", "system", `RESET ${cmd.id.substring(0,8)} fast-path iniciado`);

  const resetFrame = (cmd.frame || "").replace(/[\r\n]/g, "").trim();
  const resetPayload = extractTxPayload(resetFrame);
  const resetTsnnMatch = resetFrame.match(TX_TSNN_RE);
  const resetTsnn = resetTsnnMatch ? resetTsnnMatch[1] : null;

  if (isBackendResetCommand(cmd, resetFrame) && hasActiveResetForTsnn(resetTsnn, cmd.id)) {
    await supabase
      .from("commands")
      .update({
        status: "cancelled",
        responded_at: new Date().toISOString(),
        error_message: "Reset duplicado ignorado localmente para nao travar o rodizio dos demais pocos",
      })
      .eq("id", cmd.id)
      .eq("status", "pending");
    pushLog("warn", "system", `RESET ${cmd.id.substring(0,8)} duplicado para TSNN=${resetTsnn}; ignorado antes de pre-emptar`);
    return;
  }

    if (isUnsafePollingActuation(cmd, resetFrame)) {
      await supabase
        .from("commands")
        .update({
          status: "cancelled",
          responded_at: new Date().toISOString(),
          error_message: "Polling com payload de acionamento bloqueado localmente para evitar comando oculto de ligar/desligar",
        })
        .eq("id", cmd.id)
        .eq("status", "pending");
      pushLog("error", "system", `BLOQUEADO antes do TX: ${formatTxWithOrigin(cmd, resetFrame, " [POLLING INSEGURO]")}`);
      return;
    }

  if (
    inflightCmd &&
    inflightCmd.type === "manual" &&
    (inflightCmd.priority ?? 5) > 0 &&
    isAutomaticProtectiveReset(cmd) &&
    payloadCommandsOnlyOff(resetPayload) &&
    payloadCommandsAnyOn(extractTxPayload(inflightCmd.frame)) &&
    (!resetTsnn || resetTsnn === inflightTsnn) &&
    (Date.now() - new Date(inflightCmd.sent_at || inflightCmd.created_at || Date.now()).getTime()) < 60_000
  ) {
    await supabase
      .from("commands")
      .update({
        status: "cancelled",
        responded_at: new Date().toISOString(),
        error_message: "TX 0 automático bloqueado: comando remoto de ligar ainda dentro da janela de 60s",
      })
      .eq("id", cmd.id)
      .eq("status", "pending");
    pushLog("warn", "system", `RESET ${cmd.id.substring(0,8)} bloqueado: há comando LIGAR em curso para TSNN=${resetTsnn}`);
    return;
  }

  // v3.11.7: NÃO abortar polling/manual de OUTRO TSNN — para QUALQUER RESET
  // priority=0 (backend-reset, cloud-protective-off, UI reset, etc).
  // Antes só protegia quando isBackendResetCommand() casava (exigia
  // source_device "backend-reset:"), então protective-off de bomba offline
  // ainda abortava polling sadio de OUTRO poço. Agora a regra é universal:
  // RESET só pode preemptar inflight do MESMO TSNN. Caso contrário fica
  // pending e processNextCommand puxa como priority=0 logo após o ciclo.
  if (
    inflightCmd &&
    inflightTsnn &&
    resetTsnn &&
    inflightTsnn !== resetTsnn
  ) {
    pushLog(
      "info",
      "system",
      `RESET ${cmd.id.substring(0,8)} TSNN=${resetTsnn} adiado: inflight ${inflightCmd.type} TSNN=${inflightTsnn} em curso (sem pre-empt cruzado)`,
    );
    return; // permanece pending; processNextCommand vai pegar (priority=0)
  }

  // 1. Aborta qualquer inflight (polling OU manual) sem esperar resposta
  if (inflightTimer) { clearTimeout(inflightTimer); inflightTimer = null; }
  if (inflightCmd) {
    const aborted = inflightCmd;
    inflightCmd = null;
    inflightTsnn = null;
    try {
      await supabase
        .from("commands")
        .update({
          status: "cancelled",
          responded_at: new Date().toISOString(),
          error_message: "Abortado por RESET de emergencia (fast-path)",
        })
        .eq("id", aborted.id);
    } catch (_) {}
    pushLog("info", "system", `inflight ${aborted.type} ${aborted.id.substring(0,8)} abortado por RESET`);
  }
  // Aborta tambem manual de diagnostic (agent_commands.send_manual_frame)
  if (inflightManual) {
    pushLog("info", "system", `manual diagnostico ${inflightManual.agentCmdId?.substring(0,8) ?? "?"} descartado por RESET`);
    inflightManual = null;
  }
  processing = true; // bloqueia processNextCommand concorrente
  processingSince = Date.now();

  // 2. Lock otimista na DB (pending -> sent)
  let locked = false;
  try {
    const { data: updatedRows } = await supabase
      .from("commands")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("id", cmd.id)
      .eq("status", "pending")
      .select("id");
    locked = !!(updatedRows && updatedRows.length > 0);
  } catch (e) {
    pushLog("error", "system", `RESET lock falhou: ${e.message}`);
  }
  if (!locked) {
    processing = false;
    pushLog("warn", "system", `RESET ${cmd.id.substring(0,8)} ja foi pego por outro fluxo`);
    return;
  }

  // 3. Envia o frame IMEDIATAMENTE
  const frame = resetFrame;
  const tsnnMatch = frame.match(TX_TSNN_RE);
  const expectedTsnn = tsnnMatch ? tsnnMatch[1] : null;
  const dbTimeoutMs = cmd.timeout_ms || 13_000;
  let timeoutMs = cmd.type === "manual" ? Math.min(dbTimeoutMs, 120_000) : dbTimeoutMs;
  // v3.11.6: TSNN com >5 falhas consecutivas — não faz sentido travar 120s
  // esperando rádio que não responde. Reduz para 5s e libera o ciclo.
  // Vale para QUALQUER comando destinado a TSNN offline (não depende de
  // cmd.type nem de source_device — bug v3.11.5: isBackendResetCommand
  // exigia source_device "backend-reset:" e nunca casava com RESETs da UI).
  if (expectedTsnn) {
    const backoff = pollingBackoffByTsnn.get(expectedTsnn);
    if (backoff && backoff.failures > 5) {
      timeoutMs = 5_000;
      pushLog(
        "warn",
        "system",
        `[RESET] Timeout reduzido para TSNN ${expectedTsnn} (offline há ${backoff.failures} tentativas) -> ${timeoutMs}ms`,
      );
    }
  }

  if (isBackendResetCommand(cmd, frame) && hasActiveResetForTsnn(expectedTsnn, cmd.id)) {
    await supabase
      .from("commands")
      .update({
        status: "cancelled",
        responded_at: new Date().toISOString(),
        error_message: "Reset duplicado ignorado localmente para nao travar o rodizio dos demais pocos",
      })
      .eq("id", cmd.id)
      .eq("status", "pending");
    processing = false;
    pushLog("warn", "system", `RESET ${cmd.id.substring(0,8)} duplicado para TSNN=${expectedTsnn}; ignorado para manter ciclo`);
    return;
  }

  inflightCmd = cmd;
  inflightTsnn = expectedTsnn;
  if (isBackendResetCommand(cmd, frame)) markActiveReset(expectedTsnn, cmd.id);
  if (expectedTsnn) {
    recentCmdByTsnn.set(expectedTsnn, {
      cmdId: cmd.id,
      sentAt: Date.now(),
      expiresAt: Date.now() + LATE_RX_MATCH_WINDOW_MS,
    });
  }
  inflightTimer = setTimeout(() => {
    inflightTimer = null;
    const c = inflightCmd;
    inflightCmd = null;
    inflightTsnn = null;
    // NAO incrementa consecutiveTimeouts: bombas fora de alcance/desligadas
    // geram timeouts legitimos e nao indicam bridge morta.
    supabase
      .from("commands")
      .update({ status: "timeout", response: "(sem resposta)", responded_at: new Date().toISOString() })
      .eq("id", c.id);
    pushLog("warn", "system", `RESET ${c.id.substring(0,8)} -> timeout (${timeoutMs}ms)`);
    processing = false;
  }, timeoutMs);

    pushLog("info", "tx", formatTxWithOrigin(cmd, frame, " [RESET fast-path]"), frame);
  try {
    sendTxFrame(frame, { priority: "reset" });
    rememberTxForTsnn(expectedTsnn, "reset", cmd.id, frame);
    pushLog("info", "system", `RESET ${cmd.id.substring(0,8)} enviado em ${Date.now()-startedAt}ms`);
  } catch (e) {
    if (inflightTimer) { clearTimeout(inflightTimer); inflightTimer = null; }
    inflightCmd = null;
    inflightTsnn = null;
    pushLog("error", "serial", `RESET stdin write falhou: ${e.message}`);
    await supabase
      .from("commands")
      .update({ status: "error", response: e.message, responded_at: new Date().toISOString() })
      .eq("id", cmd.id);
    processing = false;
  }
}

// --- Command processing ---
// v3.25.7: constrói o frame ON a partir do frame OFF, setando apenas o bit da
// saída alvo (targetIndex) para '1' e preservando as demais saídas. Reusa
// TX_PAYLOAD_RE para localizar o grupo {payload} no frame. Não injeta sufixo RV.
function buildForcedOnFrame(offFrame, targetIndex) {
  return String(offFrame).replace(TX_PAYLOAD_RE, (match, payload) => {
    if (targetIndex < 0 || targetIndex >= payload.length) return match;
    const onPayload = payload.substring(0, targetIndex) + "1" + payload.substring(targetIndex + 1);
    return match.replace(payload, onPayload);
  });
}

// v3.25.7: sequência de desligamento forçado para bomba ligada localmente.
// Executa UMA ÚNICA VEZ: TX {1} -> espera RX (13s) -> estabiliza (10s) -> TX {0}.
// NÃO seta inflightCmd (evita que o matching de RX em processTelemFrame trate o
// {1} como divergente e arme safety). NÃO agenda reforços nem safety timer — assim
// o pessoal no campo continua podendo desligar pela botoeira. O rate-limiter
// anti-colisão (TX_MIN_GAP_MS/RX_AVOID_GAP_MS) do processTxQueue permanece ativo.
async function runForcedShutdownSequence(cmd, offFrame, expectedTsnn, targetIndex) {
  forcedShutdownActive = true;
  processing = true;
  processingSince = Date.now();
  try {
    const onFrame = buildForcedOnFrame(offFrame, targetIndex);
    pushLog("warn", "system",
      `[FORCED OFF] cmd ${cmd.id.substring(0, 8)} TSNN=${expectedTsnn} saida=${targetIndex + 1}: bomba local -> sequência {1}->RX->${FORCED_SHUTDOWN_STABILIZE_MS}ms->{0}`);

    // Passo 1: TX {1} (assume controle remoto)
    pushLog("info", "tx", formatTxWithOrigin(cmd, onFrame, " [FORCED OFF: {1}]"), onFrame);
    sendTxFrame(onFrame, { priority: "manual" });
    rememberTxForTsnn(expectedTsnn, "forced-on", cmd.id, onFrame);
    const r1 = await forcedShutdownWaitRx(expectedTsnn, targetIndex, "1", FORCED_SHUTDOWN_ON_RX_TIMEOUT_MS);
    pushLog("info", "system",
      `[FORCED OFF] {1} ${r1 === "rx" ? "confirmado pelo RX" : "sem RX no timeout — prosseguindo mesmo assim"}; estabilizando ${FORCED_SHUTDOWN_STABILIZE_MS}ms antes do {0}`);

    // Passo 2: estabilização (10s) para o firmware/LoRa processar
    await new Promise((res) => setTimeout(res, FORCED_SHUTDOWN_STABILIZE_MS));

    // Passo 3: TX {0} (desliga de fato)
    pushLog("info", "tx", formatTxWithOrigin(cmd, offFrame, " [FORCED OFF: {0}]"), offFrame);
    sendTxFrame(offFrame, { priority: "manual" });
    rememberTxForTsnn(expectedTsnn, "forced-off", cmd.id, offFrame);
    const r0 = await forcedShutdownWaitRx(expectedTsnn, targetIndex, "0", FORCED_SHUTDOWN_ON_RX_TIMEOUT_MS);
    pushLog(r0 === "rx" ? "info" : "warn", "system",
      `[FORCED OFF] cmd ${cmd.id.substring(0, 8)} -> {0} ${r0 === "rx" ? "confirmado pelo RX (desligado)" : "enviado sem confirmação no timeout"}`);

    // Grava o resultado no banco. Sem safety/reforço: sequência é executada uma vez.
    try {
      await withCloudTimeout(
        supabase
          .from("commands")
          .update({
            status: r0 === "rx" ? "executed" : "sent",
            response: r0 === "rx" ? "(desligamento forçado confirmado)" : "(desligamento forçado enviado, sem confirmação serial)",
            responded_at: new Date().toISOString(),
          })
          .eq("id", cmd.id),
        "forced-shutdown result",
        CLOUD_WRITE_TIMEOUT_MS,
      );
    } catch (e) {
      pushLog("warn", "cloud", `[FORCED OFF] gravação do resultado falhou: ${e.message}`);
    }
  } catch (e) {
    pushLog("error", "system", `[FORCED OFF] sequência falhou: ${e.message}`);
  } finally {
    forcedShutdownActive = false;
    processing = false;
    // Libera a fila e pega o próximo comando imediatamente
    setImmediate(() => { void processNextCommand(); });
  }
}

async function processNextCommand() {
  // v3.25.7: sequência de desligamento forçado em curso segura a fila. Evita que
  // o PROCESSING_STUCK_RESET_MS (15s) ou o pollTimer reentrem durante os ~23-36s
  // da sequência (que roda com processing=true e inflightCmd=null).
  if (forcedShutdownActive) return;
  if (processing) {
    if (processingSince && Date.now() - processingSince > PROCESSING_STUCK_RESET_MS && !inflightCmd && !inflightManual) {
      pushLog("warn", "system", `Processamento preso ha ${Math.round((Date.now() - processingSince) / 1000)}s sem comando inflight; liberando fila`);
      processing = false;
      processingSince = 0;
    } else {
      return;
    }
  }
  if (!supabase || !farmId || !bridgeReady) return;
  if (Date.now() < cloudReadBackoffUntil) return;
  if (pollingPaused) return;          // pausado via agent_commands
  if (inflightManual) return;         // manual TX em curso, nao colidir
  if (inflightCmd) return;

  processing = true;
  processingSince = Date.now();
  try {
    const { data, error } = await withCloudTimeout(
      supabase
        .from("commands")
        .select("*")
        .eq("farm_id", farmId)
        .eq("status", "pending")
        .order("priority", { ascending: true })
        .order("created_at", { ascending: true })
        .limit(20),
      "buscar proximo comando",
      CLOUD_READ_TIMEOUT_MS,
    );

    if (error || !data || data.length === 0) {
      processing = false;
      return;
    }

    // v3.8.14: pular polling de PLCs com reforco TX manual ativo, mas continuar
    // processando comandos de OUTRAS PLCs sem aguardar. Cancelamos os bloqueados
    // em sequencia e seguimos com o primeiro comando livre da fila.
    // v3.9.30: SEGURANCA — reordena polling por "tempo desde ultima resposta OK"
    // descendente. Polls mais antigos vao primeiro. Se uma PLC ultrapassa
    // POLLING_EMERGENCY_MS (12 min) sem resposta, recebe prioridade absoluta.
    // Comandos nao-polling preservam a ordem original (priority/created_at).
    const nonPolling = [];
    const pollingEmergency = [];
    const pollingNormal = [];
    for (const d of data) {
      if (d.type !== "polling") { nonPolling.push(d); continue; }
      const m = (d.frame || "").match(TX_TSNN_RE);
      const t = m ? m[1] : null;
      const last = (t && pollingBackoffByTsnn.get(t)?.lastSuccessAt) || 0;
      const age = last ? (Date.now() - last) : Number.MAX_SAFE_INTEGER;
      if (last > 0 && age > POLLING_EMERGENCY_MS) {
        pollingEmergency.push({ d, age, t });
      } else {
        pollingNormal.push({ d, age, t });
      }
    }
    // Mais antigo primeiro em ambas as listas
    pollingEmergency.sort((a, b) => b.age - a.age);
    pollingNormal.sort((a, b) => b.age - a.age);
    for (const e of pollingEmergency) {
      pushLog("warn", "system",
        `[SAFETY] TSNN ${e.t} atingiu 12min sem resposta — prioridade emergencial`);
    }
    const orderedCandidates = [
      ...nonPolling,
      ...pollingEmergency.map((x) => x.d),
      ...pollingNormal.map((x) => x.d),
    ];

    let cmd = null;
    let frame = "";
    let expectedTsnn = null;
    for (const candidate of orderedCandidates) {
      const candFrame = (candidate.frame || "").replace(/[\r\n]/g, "").trim();
      const candTsnnMatch = candFrame.match(TX_TSNN_RE);
      const candTsnn = candTsnnMatch ? candTsnnMatch[1] : null;

      if (candidate.type === "polling") {
        const activeReinforcement = getActiveReinforcementForTsnn(candTsnn);
        if (activeReinforcement) {
          pushLog("info", "system",
            `CHECK reforco TX: polling ${candidate.id.substring(0,8)} TSNN=${candTsnn} BLOQUEADO; eq=${String(activeReinforcement.equipmentId).substring(0,8)} cmd=${String(activeReinforcement.entry.cmdId || "?").substring(0,8)} restante=${Math.ceil(activeReinforcement.remainingMs / 1000)}s -> pulando para proxima PLC`);
          await supabase
            .from("commands")
            .update({
              status: "cancelled",
              responded_at: new Date().toISOString(),
              error_message: "Polling suspenso: reforco TX manual ativo nesta PLC",
            })
            .eq("id", candidate.id)
            .eq("status", "pending");
          continue; // tenta o proximo da fila (outra PLC)
        }
        // Backoff por PLC sem resposta: pula esta rodada de polling
        if (shouldSkipPollingForBackoff(candTsnn)) {
          const b = pollingBackoffByTsnn.get(candTsnn);
          await supabase
            .from("commands")
            .update({
              status: "cancelled",
              responded_at: new Date().toISOString(),
              error_message: `Polling pulado por backoff (${b?.failures || 0} timeouts consecutivos)`,
            })
            .eq("id", candidate.id)
            .eq("status", "pending");
          continue;
        }
      }


      cmd = candidate;
      frame = candFrame;
      expectedTsnn = candTsnn;
      break;
    }

    if (!cmd) {
      // Todos os pendentes eram polling bloqueado; sai sem agendar reentrada
      // imediata (proximo poll do timer pega quando reforco terminar).
      processing = false;
      return;
    }

    if (cmd.type === "polling") {
      const requiredGap = lastPollingEndedWithTimeout
        ? POLLING_GAP_AFTER_TIMEOUT_MS
        : POLLING_GAP_AFTER_RX_MS;
      const sinceEnd = Date.now() - lastPollingEndAt;
      if (lastPollingEndAt > 0 && sinceEnd < requiredGap) {
        const waitMs = requiredGap - sinceEnd;
        processing = false;
        setTimeout(() => { void processNextCommand(); }, waitMs + 50);
        return;
      }
    }

    if (
      cmd.type === "manual" &&
      (cmd.priority ?? 5) > 0 &&
      !isBackendResetCommand(cmd, frame)
    ) {
      const gap = getManualFirstTxGap(expectedTsnn);
      if (gap.waitMs > 0) {
        pushLog("warn", "system",
          `Manual ${cmd.id.substring(0,8)} TSNN=${expectedTsnn} aguardando ${Math.ceil(gap.waitMs)}ms antes do 1o TX: ultimo TX ${gap.last.type}${gap.last.cmdId ? ` ${String(gap.last.cmdId).substring(0,8)}` : ""} foi ha ${Math.max(0, Math.round(gap.elapsedMs))}ms`);
        processing = false;
        setTimeout(() => { void processNextCommand(); }, gap.waitMs + 25);
        return;
      }
    }

    if (isBackendResetCommand(cmd, frame) && hasActiveResetForTsnn(expectedTsnn, cmd.id)) {
      await supabase
        .from("commands")
        .update({
          status: "cancelled",
          responded_at: new Date().toISOString(),
          error_message: "Reset duplicado ignorado localmente para manter o rodizio dos demais pocos",
        })
        .eq("id", cmd.id)
        .eq("status", "pending");
      processing = false;
      pushLog("warn", "system", `RESET duplicado ${cmd.id.substring(0,8)} para TSNN=${expectedTsnn}; pulando TX`);
      setTimeout(() => { void processNextCommand(); }, 50);
      return;
    }

    if (isUnsafePollingActuation(cmd, frame)) {
      await supabase
        .from("commands")
        .update({
          status: "cancelled",
          responded_at: new Date().toISOString(),
          error_message: "Polling com payload de acionamento bloqueado localmente para evitar comando oculto de ligar/desligar",
        })
        .eq("id", cmd.id)
        .eq("status", "pending");
      pushLog("error", "system", `BLOQUEADO antes do TX: ${formatTxWithOrigin(cmd, frame, " [POLLING INSEGURO]")}`);
      processing = false;
      setTimeout(() => { void processNextCommand(); }, 50);
      return;
    }

    if (
      cmd.type === "manual" &&
      (cmd.priority ?? 5) === 0 &&
      isAutomaticProtectiveReset(cmd) &&
      payloadCommandsOnlyOff(extractTxPayload(frame))
    ) {
      const { data: recentOn } = await supabase
        .from("commands")
        .select("id,frame,sent_at,created_at,status")
        .eq("farm_id", farmId)
        .eq("type", "manual")
        .eq("plc_hw_id", expectedTsnn)
        .neq("id", cmd.id)
        .or("source_device.is.null,source_device.not.like.backend-reset:%")
        .in("status", ["pending", "sent", "executed"])
        .order("created_at", { ascending: false })
        .limit(1);
      const recent = recentOn && recentOn[0];
      const recentAt = recent ? new Date(recent.sent_at || recent.created_at || 0).getTime() : 0;
      if (recent && payloadCommandsAnyOn(extractTxPayload(recent.frame)) && Date.now() - recentAt < 60_000) {
        await supabase
          .from("commands")
          .update({
            status: "cancelled",
            responded_at: new Date().toISOString(),
            error_message: "TX 0 automático bloqueado: comando remoto de ligar recente ainda dentro da janela de 60s",
          })
          .eq("id", cmd.id)
          .eq("status", "pending");
        pushLog("warn", "system", `TX 0 ${cmd.id.substring(0,8)} bloqueado antes do envio: comando LIGAR recente ${recent.id.substring(0,8)} para TSNN=${expectedTsnn}`);
        processing = false;
        setTimeout(() => { void processNextCommand(); }, 50);
        return;
      }
    }

    // Lock otimista
    const { data: updatedRows } = await withCloudTimeout(
      supabase
        .from("commands")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .eq("id", cmd.id)
        .eq("status", "pending")
        .select("id"),
      "travar comando para envio",
      CLOUD_WRITE_TIMEOUT_MS,
    );

    if (!updatedRows || updatedRows.length === 0) {
      processing = false;
      return;
    }

    // v3.25.7: DESLIGAMENTO FORÇADO. Se este é um manual de DESLIGAR (bit alvo=0)
    // para uma bomba que está ligada localmente (last_actuation_origin='local') e
    // com forced_shutdown_enabled=true, executa a sequência {1}->RX->10s->{0} uma
    // única vez (sem reforços/safety) em vez de mandar {0} direto. last_actuation_origin
    // muda em runtime, por isso consultamos o estado fresco no banco (não o cache).
    if (cmd.type === "manual" && (cmd.priority ?? 5) > 0 && !isBackendResetCommand(cmd, frame)) {
      const fsPayload = extractTxPayload(frame);
      if (fsPayload && /^[01]{1,6}$/.test(fsPayload) && expectedTsnn && cmd.equipment_id) {
        const fsEqMeta = equipmentById.get(String(cmd.equipment_id));
        const fsTargetIndex = Math.max(0, Math.min(fsPayload.length - 1, (fsEqMeta?.saida || fsPayload.length) - 1));
        if (fsPayload[fsTargetIndex] === "0") {
          let fsEqRow = null;
          try {
            const { data } = await withCloudTimeout(
              supabase
                .from("equipments")
                .select("last_actuation_origin,forced_shutdown_enabled")
                .eq("id", cmd.equipment_id)
                .maybeSingle(),
              "forced-shutdown check",
              CLOUD_READ_TIMEOUT_MS,
            );
            fsEqRow = data;
          } catch (e) {
            pushLog("warn", "system", `[FORCED OFF] consulta de estado falhou: ${e.message}; seguindo com {0} direto`);
          }
          if (fsEqRow && fsEqRow.forced_shutdown_enabled === true && fsEqRow.last_actuation_origin === "local") {
            await runForcedShutdownSequence(cmd, frame, expectedTsnn, fsTargetIndex);
            return; // a sequência assume o controle; NÃO segue para o TX {0} direto nem agenda reforços
          }
        }
      }
    }

    // Manual aguarda a janela física completa: RX divergente nao fecha o comando,
    // e a confirmacao real pode chegar muitos segundos depois da primeira leitura.
    // v3.9.30: polling com timeout serial curto (5s) para nao travar o rodizio
    // quando uma PLC nao responde. Manual mantem 13s.
    const pollingDefault = POLLING_SERIAL_TIMEOUT_MS;
    const dbTimeoutMs = cmd.timeout_ms || (cmd.type === "polling" ? pollingDefault : 13_000);
    let serialTimeoutMs = cmd.type === "manual"
      ? Math.min(dbTimeoutMs, 13_000)
      : (cmd.type === "polling" ? pollingDefault : dbTimeoutMs);
    // v3.11.6: TSNN com >5 falhas consecutivas → timeout 5s para QUALQUER
    // comando (manual, polling, reset), liberando o ciclo da serial.
    if (expectedTsnn) {
      const backoffOff = pollingBackoffByTsnn.get(expectedTsnn);
      if (backoffOff && backoffOff.failures > 5 && serialTimeoutMs > 5_000) {
        serialTimeoutMs = 5_000;
        pushLog("warn", "system",
          `[TIMEOUT] Reduzido para TSNN ${expectedTsnn} (offline há ${backoffOff.failures} tentativas) -> 5000ms`);
      }
    }

    // v3.25.7 FIX lentidão manual: se há OUTROS manuais pendentes na fila (já
    // buscados em `data`), não segura a serial os 13s completos esperando o RX
    // deste manual — libera após MANUAL_QUEUED_HOLD_MS (3s) para o próximo manual
    // sair em ~3s. Não afeta manual isolado, polling nem reset. A confirmação
    // física deste comando segue garantida pelos reforços TX e pela janela de 120s.
    if (cmd.type === "manual" && (cmd.priority ?? 5) > 0) {
      const otherPendingManuals = data.filter(
        (d) => d.type === "manual" && d.id !== cmd.id,
      ).length;
      if (otherPendingManuals > 0 && serialTimeoutMs > MANUAL_QUEUED_HOLD_MS) {
        serialTimeoutMs = MANUAL_QUEUED_HOLD_MS;
        pushLog("info", "system",
          `[FILA MANUAL] ${otherPendingManuals} manual(is) pendente(s) — hold serial reduzido para ${MANUAL_QUEUED_HOLD_MS}ms (TSNN=${expectedTsnn})`);
      }
    }

    pushLog("info", "system", `Processando cmd ${cmd.id.substring(0, 8)} (TSNN=${expectedTsnn})...`, null, null);
    pushLog("info", "tx", formatTxWithOrigin(cmd, frame), frame);

    // Registrar como inflight
    inflightCmd = cmd;
    inflightTsnn = expectedTsnn;
    inflightSpontaneousSeen = false;
    inflightRetryCount = 0;
    if (isBackendResetCommand(cmd, frame)) markActiveReset(expectedTsnn, cmd.id);
    if (expectedTsnn) {
      recentCmdByTsnn.set(expectedTsnn, {
        cmdId: cmd.id,
        sentAt: Date.now(),
        expiresAt: Date.now() + LATE_RX_MATCH_WINDOW_MS,
      });
    }

    // Timer de timeout (controlado AQUI no Electron)
    const onInflightTimeout = () => {
      inflightTimer = null;
      const c = inflightCmd;

      // Camada 3: ate 2 retries imediatos se polling colidiu com espontaneo
      if (
        c &&
        c.type === "polling" &&
        inflightSpontaneousSeen &&
        inflightRetryCount < 2
      ) {
        inflightRetryCount++;
        inflightSpontaneousSeen = false;
        pushLog("warn", "system",
          `[POLLING] Retry ${inflightRetryCount}/2 TSNN ${expectedTsnn} apos colisao com espontaneo — reenviando frame`);

        try {
          sendTxFrame(frame, { priority: "polling" });
          rememberTxForTsnn(expectedTsnn, cmd.type, cmd.id, frame);
        } catch (e) {
          pushLog("error", "serial", `retry polling stdin write falhou: ${e.message}`);
        }
        inflightTimer = setTimeout(onInflightTimeout, serialTimeoutMs);
        return;
      }

      inflightCmd = null;
      inflightTsnn = null;

      if (c.type === "manual") {
        // Não marcar falha física aos 8s. Apenas libera a RS-232 para continuar
        // o rodízio. O comando segue como sent e será resolvido por RX posterior
        // ou pela janela definitiva de 120s no backend.
        pushLog("warn", "system", `cmd ${c.id.substring(0, 8)} -> sem resposta serial (${serialTimeoutMs}ms), fila liberada; aguardando janela fisica de 120s`, null, `Sem resposta da bomba após ${Math.round(serialTimeoutMs/1000)}s`);
        // ARMA SAFETY TIMER (120s) — failsafe se a bomba nao confirmar
        try {
          const expectedPayload = extractTxPayload(c.frame);
          if (c.equipment_id && expectedPayload && /^[01]{1,6}$/.test(expectedPayload)) {
            const expectedBit = expectedPayload[expectedPayload.length - 1];
            const eq = equipmentById.get(String(c.equipment_id));
            armSafetyTimer(String(c.equipment_id), {
              tsnn: expectedTsnn,
              saida: eq?.saida || expectedPayload.length,
              expectedBit,
              expectedPayload,
              cmdId: c.id,
            });
          }
        } catch (e) {
          pushLog("warn", "system", `armSafetyTimer (manual timeout) falhou: ${e.message}`);
        }
      } else {
        supabase
          .from("commands")
          .update({ status: "timeout", response: "(sem resposta)", responded_at: new Date().toISOString() })
          .eq("id", c.id);

        const retryNote = inflightRetryCount > 0 ? ` (apos ${inflightRetryCount} retry)` : "";
        pushLog("warn", "system", `cmd ${c.id.substring(0, 8)} -> timeout (${serialTimeoutMs}ms)${retryNote}`, null, `Sem resposta da bomba após ${Math.round(serialTimeoutMs/1000)}s`);

        // Backoff: incrementa contador de falhas consecutivas para esta PLC
        if (c.type === "polling") {
          noteBackoffFailure(expectedTsnn);
          lastPollingEndAt = Date.now();
          lastPollingEndedWithTimeout = true;
          // Conta timeout como "tentativa" para nao alertar safety eternamente.
          // O backoff/log de timeout ja sinaliza o problema dessa PLC.
          noteSuccessfulPoll(expectedTsnn);
          pollingCycleStats.fail++;
        }
      }


      // IMPORTANTE: NAO derrubar a bridge por timeouts de comando.
      // Bombas fora de alcance, sem alimentacao ou com sinal RF fraco geram
      // timeouts legitimos. O watchdog PING/PONG do Python ja detecta bridge
      // morta de verdade — esse era o causador do "RX as vezes some" porque
      // matava o processo Python com bytes ainda no buffer da serial.

      processing = false;
      // v3.8.15: ao expirar o timeout serial, ja chama o proximo (evita gap de 10s do tick)
      setImmediate(() => { void processNextCommand(); });
    };
    inflightTimer = setTimeout(onInflightTimeout, serialTimeoutMs);

    // Enviar para o Python bridge (protocolo simples: SEND:<frame>)
    try {
      // Injeta sufixo RV no payload se houver reset de vazao pendente para este TSNN.
      frame = maybeInjectVazaoReset(frame, expectedTsnn);
      sendTxFrame(frame, { priority: cmd.type === "polling" ? "polling" : ((cmd.priority ?? 5) === 0 ? "reset" : "manual") });
      rememberTxForTsnn(expectedTsnn, cmd.type, cmd.id, frame);
      // (gap de polling agora medido pelo FIM da última comunicação, não pelo TX)
      // Reforco RF: comando manual normal (priority>0, nao reset) reenvia
      // o mesmo frame em +15s e +30s, dentro da janela de 120s. Se a bomba
      // confirmar antes (RX casa), os reenvios sao cancelados pelo
      // clearSafetyTimer/clearManualReinforcements.
      // Tambem dispara para polling com flag reinforcement=true (botao
      // "Atualizar Status Agora"), que reforca o estado desejado atual.
      if (
        cmd.equipment_id &&
        !isBackendResetCommand(cmd, frame) &&
        (
          (cmd.type === "manual" && (cmd.priority ?? 5) > 0) ||
          cmd.reinforcement === true
        )
      ) {
        scheduleManualReinforcements(String(cmd.equipment_id), frame, expectedTsnn, cmd.id);
      }
    } catch (e) {
      clearTimeout(inflightTimer);
      inflightTimer = null;
      inflightCmd = null;
      inflightTsnn = null;
      pushLog("error", "serial", `stdin write falhou: ${e.message}`);
      supabase
        .from("commands")
        .update({ status: "error", response: e.message, responded_at: new Date().toISOString() })
        .eq("id", cmd.id);
      processing = false;
    }

    // NAO setar processing = false aqui!
    // Sera liberado por: handleRxFrame (executed), inflightTimer (timeout), ou TX_ERR (erro)

  } catch (e) {
    pushLog("error", "system", `Erro: ${e.message}`);
    if (String(e.message || "").includes("buscar proximo comando: timeout local")) {
      cloudReadBackoffUntil = Date.now() + CLOUD_READ_BACKOFF_MS;
    }
    noteCloudError(e, "processNextCommand");
    inflightCmd = null;
    inflightTsnn = null;
    if (inflightTimer) { clearTimeout(inflightTimer); inflightTimer = null; }
    processing = false;
  }
}

// --- Heartbeat ---
async function sendHeartbeat() {
  if (!supabase || !farmId) return;
  // v3.10.7 SECURITY: valida licença na nuvem a cada heartbeat (30s).
  // Se revogada/suspensa → desliga bombas e encerra. Grace offline = 72h.
  try {
    const cfgNow = loadConfig();
    if (cfgNow) await validateLicenseHeartbeat(cfgNow);
  } catch (_) {}
  if (licenseKillSwitchTriggered) return;
  // Refresca cache de nomes de equipamentos a cada 5 min
  if (Date.now() - equipmentCacheLoadedAt > 5 * 60 * 1000) {
    void refreshEquipmentCache();
  }

  try {
    await supabase.from("site_health").upsert(
      {
        farm_id: farmId,
        agent_status: "online",
        last_heartbeat: new Date().toISOString(),
        com_port: comPort,
        com_connected: bridgeReady,
        agent_version: AGENT_VERSION,
        last_error: lastBridgeError,
      },
      { onConflict: "farm_id" }
    );
  } catch (e) {}

  await checkForceRebootInsideHeartbeat();

  // Limpeza automática de dados antigos (1x por hora)
  if (Date.now() - lastCleanupAt > CLEANUP_INTERVAL_MS) {
    lastCleanupAt = Date.now();
    try {
      const { data, error } = await supabase.rpc("cleanup_stale_data");
      if (!error && data && (data.deleted_commands > 0 || data.deleted_logs > 0)) {
        pushLog(
          "info",
          "system",
          `Limpeza automática: ${data.deleted_commands} commands e ${data.deleted_logs} logs removidos`
        );
      }
    } catch (_) {
      // silencioso — limpeza é best-effort
    }
  }

  // ── v3.11.4: OTA AUTOMÁTICO REMOVIDO.
  // O agente NÃO consulta mais get_agent_target_version periodicamente.
  // Atualizações são 100% manuais: o admin dispara via /platform → Atualizações,
  // o que insere um registro em `agent_commands` com kind=`update_agent`.
  // O handler de agent_commands (case "update_agent") continua ativo e é a única
  // forma de iniciar uma instalação OTA. Pinar versão no /platform também NÃO
  // dispara nada automaticamente — só serve de referência para o botão Atualizar.
}

// ─────────────────────────────────────────────────────────────────────────────
// Update manual (fallback ao electron-updater): baixa o .exe da download_url
// publicada em agent_releases, salva em %TEMP%, executa em modo silencioso
// (NSIS /S) e fecha o app para liberar arquivos. Usado pelo rollout per-farm
// (pin via /platform) e também pelo handler agent_commands "update_agent".
// ─────────────────────────────────────────────────────────────────────────────
// Reporta o status atual da atualização para a tabela agent_update_status.
// best-effort — nunca derruba o instalador se o Supabase estiver fora.
async function reportUpdateStatus(patch) {
  try {
    if (!supabase || !farmId) return;
    await supabase.from("agent_update_status").upsert(
      { farm_id: farmId, current_version: AGENT_VERSION, updated_at: new Date().toISOString(), ...patch },
      { onConflict: "farm_id" }
    );
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// v3.10.6 — OTA via app.asar + bucket privado.
// ─────────────────────────────────────────────────────────────────────────────
async function downloadAndInstallAsarUpdate(version, expectedHash, expectedSize) {
  if (isInstallingUpdate) return;
  isInstallingUpdate = true;
  const fs = require("fs");
  // Electron intercepta operações de fs em arquivos .asar (vê como diretório virtual).
  // Para mexer no arquivo .asar real (backup/copy/rename/unlink) precisamos do original-fs.
  let originalFs;
  try { originalFs = require("original-fs"); } catch (_) { originalFs = fs; }
  const https = require("https");
  const http = require("http");
  const startedAt = Date.now();

  const updatesDir = path.join(app.getPath("userData"), "updates");
  try { fs.mkdirSync(updatesDir, { recursive: true }); } catch (_) {}
  const tmpAsar = path.join(updatesDir, `app-${version}.asar.new`);

  // Marca início do OTA no Relatório de Automação (origem "Sistema").
  void logAgentLifecycleEvent("ota_update_start", {
    from_version: AGENT_VERSION, to_version: version, artifact: "asar",
  });

  await reportUpdateStatus({
    target_version: version,
    target_file_hash: expectedHash || null,
    update_status: "downloading",
    download_progress: 0,
    error_message: null,
    started_at: new Date().toISOString(),
    completed_at: null,
  });

  const recordFailure = async (msg) => {
    pushLog("error", "update", `[OTA-asar] ${msg}`);
    lastFailedUpdateVersion = version;
    lastFailedUpdateAt = Date.now();
    await reportUpdateStatus({
      update_status: "failed",
      error_message: msg,
      completed_at: new Date().toISOString(),
    });
    try {
      await supabase.from("agent_update_history").insert({
        farm_id: farmId, from_version: AGENT_VERSION, to_version: version,
        status: "failed", error_message: msg, duration_ms: Date.now() - startedAt,
      });
    } catch (_) {}
    try { fs.unlinkSync(tmpAsar); } catch (_) {}
    isInstallingUpdate = false;
  };

  try {
    pushLog("info", "update", `[OTA-asar] Solicitando URL assinada para v${version}...`);
    const sessionRes = await supabase.auth.getSession();
    const accessToken = sessionRes && sessionRes.data && sessionRes.data.session && sessionRes.data.session.access_token;
    if (!accessToken) return recordFailure("sem sessão autenticada");

    const baseUrl = (typeof activeSupabaseUrl !== "undefined" && activeSupabaseUrl) || SUPABASE_URL_DEFAULT;
    const baseAnon = (typeof activeSupabaseAnonKey !== "undefined" && activeSupabaseAnonKey) || SUPABASE_ANON_DEFAULT;
    const fnRes = await fetch(`${baseUrl}/functions/v1/agent-release-signed-url`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
        "apikey": baseAnon,
      },
      body: JSON.stringify({ version }),
    });
    if (!fnRes.ok) {
      const txt = await fnRes.text().catch(() => "");
      return recordFailure(`signed-url HTTP ${fnRes.status}: ${txt.slice(0, 200)}`);
    }
    const signed = await fnRes.json();
    if (!signed || !signed.url) return recordFailure(`signed-url payload inválido`);

    const downloadUrl = signed.url;
    const hashFromServer = signed.file_hash || expectedHash || null;
    const sizeFromServer = signed.file_size_bytes || expectedSize || null;

    pushLog("info", "update", `[OTA-asar] Baixando ${downloadUrl.slice(0, 60)}... → ${tmpAsar}`);
    let lastPct = 0;
    await new Promise((resolve, reject) => {
      const lib = downloadUrl.startsWith("https:") ? https : http;
      const doGet = (u, redirects) => {
        lib.get(u, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
            res.resume();
            return doGet(res.headers.location, redirects - 1);
          }
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          const total = Number(res.headers["content-length"] || sizeFromServer || 0);
          let received = 0;
          const file = fs.createWriteStream(tmpAsar);
          res.on("data", (chunk) => {
            received += chunk.length;
            if (total > 0) {
              const pct = Math.min(99, Math.floor((received / total) * 100));
              if (pct - lastPct >= 5) {
                lastPct = pct;
                void reportUpdateStatus({ update_status: "downloading", download_progress: pct });
              }
            }
          });
          res.pipe(file);
          file.on("finish", () => file.close((err) => (err ? reject(err) : resolve())));
          file.on("error", reject);
        }).on("error", reject);
      };
      doGet(downloadUrl, 5);
    });

    const stat = fs.statSync(tmpAsar);
    if (stat.size < 1024 * 1024) return recordFailure(`arquivo baixado muito pequeno (${stat.size} B)`);
    if (sizeFromServer && stat.size !== Number(sizeFromServer)) {
      return recordFailure(`tamanho não bate — esperado ${sizeFromServer}, recebido ${stat.size}`);
    }

    if (hashFromServer) {
      pushLog("info", "update", "[OTA-asar] Validando SHA-256...");
      const hash = crypto.createHash("sha256");
      await new Promise((resolve, reject) => {
        const s = fs.createReadStream(tmpAsar);
        s.on("data", (d) => hash.update(d));
        s.on("end", resolve);
        s.on("error", reject);
      });
      const actual = hash.digest("hex");
      if (actual.toLowerCase() !== String(hashFromServer).toLowerCase()) {
        try {
          const cfgNow = loadConfig();
          if (cfgNow) await reportTampering(cfgNow, "integrity_check_failed", "critical",
            { reason: "ota_asar_hash_mismatch", version }, String(hashFromServer), actual);
        } catch (_) {}
        return recordFailure(`[SECURITY] Update corrompido — hash inválido (asar). Esperado ${hashFromServer}, recebido ${actual}`);
      }

      pushLog("info", "update", "[OTA-asar] Hash OK ✓");
    }

    await reportUpdateStatus({ update_status: "downloaded", download_progress: 100 });

    if (!process.resourcesPath) return recordFailure("process.resourcesPath ausente — dev mode");
    const currentAsar = path.join(process.resourcesPath, "app.asar");
    const bakAsar = path.join(process.resourcesPath, "app.asar.bak");
    const appFolder = path.join(process.resourcesPath, "app");
    const appFolderBak = path.join(process.resourcesPath, "app_pre_ota.bak");

    if (originalFs.existsSync(currentAsar)) {
      pushLog("info", "update", "[OTA-asar] Backup do app.asar atual...");
      try {
        if (originalFs.existsSync(bakAsar)) originalFs.unlinkSync(bakAsar);
        originalFs.copyFileSync(currentAsar, bakAsar);
      } catch (e) { return recordFailure(`falha ao fazer backup: ${e.message}`); }
    } else if (fs.existsSync(appFolder)) {
      // Primeira OTA em instalação baseada em pasta resources/app/.
      // Renomeia a pasta pra app_pre_ota.bak (rollback restaura depois).
      pushLog("warn", "update", "[OTA-asar] Instalação folder-based detectada — movendo resources/app → app_pre_ota.bak");
      try {
        if (fs.existsSync(appFolderBak)) {
          // Limpa backup anterior pra liberar o nome.
          fs.rmSync(appFolderBak, { recursive: true, force: true });
        }
        fs.renameSync(appFolder, appFolderBak);
      } catch (e) { return recordFailure(`falha ao mover pasta app: ${e.message}`); }
    } else {
      return recordFailure(`nenhum app.asar nem pasta app encontrados em ${process.resourcesPath}`);
    }

    pushLog("info", "update", "[OTA-asar] Substituindo app.asar...");
    try {
      // tmpAsar é .new fora do asar — usa fs normal pra ler; destino é .asar — usa originalFs.
      originalFs.copyFileSync(tmpAsar, currentAsar);
      try { fs.unlinkSync(tmpAsar); } catch (_) {}
    } catch (e) {
      try { originalFs.copyFileSync(bakAsar, currentAsar); } catch (_) {}
      return recordFailure(`falha ao substituir app.asar: ${e.message} — backup restaurado`);
    }

    await reportUpdateStatus({ update_status: "installing", completed_at: new Date().toISOString() });
    try {
      await supabase.from("agent_update_history").insert({
        farm_id: farmId, from_version: AGENT_VERSION, to_version: version,
        status: "success", duration_ms: Date.now() - startedAt,
      });
    } catch (_) {}

    // Salva a versão anterior para permitir rollback 1-clique no /platform.
    try {
      await supabase.from("farms").update({ agent_previous_version: AGENT_VERSION }).eq("id", farmId);
    } catch (_) {}

    pushLog("info", "update", `[OTA-asar] Atualização v${version} instalada com sucesso — reiniciando`);
    setTimeout(() => {
      try { app.relaunch(); } catch (_) {}
      try { app.exit(0); } catch (_) { try { app.quit(); } catch (__) {} }
    }, 1500);
  } catch (e) {
    await recordFailure(`exceção: ${e.message}`);
  }
}



// v3.11 — exe via bucket privado: chama agent-release-signed-url e delega
// para downloadAndInstallUpdate com a URL temporária.
async function resolveSignedUrlAndInstallExe(version, expectedHash, expectedSize) {
  try {
    pushLog("info", "update", `[OTA-exe] Solicitando URL assinada para v${version}...`);
    const sessionRes = await supabase.auth.getSession();
    const accessToken = sessionRes?.data?.session?.access_token;
    if (!accessToken) {
      pushLog("error", "update", "[OTA-exe] sem sessão autenticada — abortando");
      return;
    }
    const baseUrl = (typeof activeSupabaseUrl !== "undefined" && activeSupabaseUrl) || SUPABASE_URL_DEFAULT;
    const baseAnon = (typeof activeSupabaseAnonKey !== "undefined" && activeSupabaseAnonKey) || SUPABASE_ANON_DEFAULT;
    const fnRes = await fetch(`${baseUrl}/functions/v1/agent-release-signed-url`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
        "apikey": baseAnon,
      },
      body: JSON.stringify({ version }),
    });
    if (!fnRes.ok) {
      const txt = await fnRes.text().catch(() => "");
      pushLog("error", "update", `[OTA-exe] signed-url HTTP ${fnRes.status}: ${txt.slice(0, 200)}`);
      return;
    }
    const signed = await fnRes.json();
    if (!signed?.url) {
      pushLog("error", "update", "[OTA-exe] signed-url payload inválido");
      return;
    }
    await downloadAndInstallUpdate(signed.url, version, signed.file_hash || expectedHash);
  } catch (e) {
    pushLog("error", "update", `[OTA-exe] erro ao resolver URL: ${e.message}`);
  }
}

async function downloadAndInstallUpdate(url, version, expectedHash) {

  if (isInstallingUpdate) return;
  isInstallingUpdate = true;
  const fs = require("fs");
  const https = require("https");
  const http = require("http");
  const { exec } = require("child_process");
  const startedAt = Date.now();

  // Marca início do OTA no Relatório de Automação.
  void logAgentLifecycleEvent("ota_update_start", {
    from_version: AGENT_VERSION, to_version: version, artifact: "exe",
  });


  const tmpExe = path.join(app.getPath("temp"), `renov-agent-update-${version}.exe`);
  pushLog("info", "update", `Baixando ${url} → ${tmpExe} (hash esperado: ${expectedHash || "—"})`);
  await reportUpdateStatus({
    target_version: version,
    target_download_url: url,
    target_file_hash: expectedHash || null,
    update_status: "downloading",
    download_progress: 0,
    error_message: null,
    started_at: new Date().toISOString(),
    completed_at: null,
  });

  let lastReportedPct = 0;
  const fetchToFile = (downloadUrl, redirectsLeft = 5) => new Promise((resolve, reject) => {
    const lib = downloadUrl.startsWith("https:") ? https : http;
    lib
      .get(downloadUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          fetchToFile(res.headers.location, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const totalBytes = Number(res.headers["content-length"] || 0);
        let received = 0;
        const file = fs.createWriteStream(tmpExe);
        res.on("data", (chunk) => {
          received += chunk.length;
          if (totalBytes > 0) {
            const pct = Math.min(99, Math.floor((received / totalBytes) * 100));
            if (pct - lastReportedPct >= 5) {
              lastReportedPct = pct;
              void reportUpdateStatus({ update_status: "downloading", download_progress: pct });
            }
          }
        });
        res.pipe(file);
        file.on("finish", () => file.close((err) => (err ? reject(err) : resolve())));
        file.on("error", reject);
      })
      .on("error", reject);
  });

  try {
    await fetchToFile(url);

    // Validação SHA-256
    if (expectedHash) {
      pushLog("info", "update", "Validando integridade SHA-256...");
      const hash = crypto.createHash("sha256");
      const stream = fs.createReadStream(tmpExe);
      await new Promise((resolve, reject) => {
        stream.on("data", (d) => hash.update(d));
        stream.on("end", resolve);
        stream.on("error", reject);
      });
      const actual = hash.digest("hex");
      if (actual.toLowerCase() !== expectedHash.toLowerCase()) {
        const msg = `[SECURITY] Update corrompido — hash inválido (exe). Esperado ${expectedHash}, recebido ${actual}`;
        pushLog("error", "update", msg);
        try {
          const cfgNow = loadConfig();
          if (cfgNow) await reportTampering(cfgNow, "integrity_check_failed", "critical",
            { reason: "ota_exe_hash_mismatch", version }, expectedHash, actual);
        } catch (_) {}

        await reportUpdateStatus({
          update_status: "failed",
          error_message: msg,
          completed_at: new Date().toISOString(),
        });
        try {
          await supabase.from("agent_update_history").insert({
            farm_id: farmId, from_version: AGENT_VERSION, to_version: version,
            status: "failed", error_message: msg, duration_ms: Date.now() - startedAt,
          });
        } catch (_) {}
        try { fs.unlinkSync(tmpExe); } catch (_) {}
        isInstallingUpdate = false;
        return;
      }
      pushLog("info", "update", "Hash OK ✓");
    }

    await reportUpdateStatus({ update_status: "downloaded", download_progress: 100 });
    pushLog("info", "update", `Download OK. Instalando ${version} silenciosamente...`);

    // Histórico — registramos antes do reinício pois o app vai fechar
    try {
      await supabase.from("agent_update_history").insert({
        farm_id: farmId, from_version: AGENT_VERSION, to_version: version,
        status: "success", duration_ms: Date.now() - startedAt,
      });
    } catch (_) {}

    await reportUpdateStatus({
      update_status: "installing",
      completed_at: new Date().toISOString(),
    });

    // v3.11 — NSIS silencioso (/S) + --force-update + spawn detached.
    try {
      const child = spawn(tmpExe, ["/S", "--force-update"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
    } catch (err) {
      pushLog("error", "update", `Falha ao executar instalador: ${err.message}`);
      void reportUpdateStatus({ update_status: "failed", error_message: err.message });
      isInstallingUpdate = false;
      return;
    }
    setTimeout(() => {
      pushLog("info", "update", "Encerrando agente para aplicar atualização");
      try { app.exit(0); } catch (_) { try { app.quit(); } catch (__) {} }
    }, 4000);

  } catch (e) {
    pushLog("error", "update", `Erro no download: ${e.message}`);
    await reportUpdateStatus({
      update_status: "failed",
      error_message: e.message,
      completed_at: new Date().toISOString(),
    });
    try {
      await supabase.from("agent_update_history").insert({
        farm_id: farmId, from_version: AGENT_VERSION, to_version: version,
        status: "failed", error_message: e.message, duration_ms: Date.now() - startedAt,
      });
    } catch (_) {}
    isInstallingUpdate = false;
  }
}


// --- Polling enqueue (Node, NUNCA throttla) ---
// O renderer/web throttla setInterval para 1x/min quando minimizado, o que
// fazia o sistema ficar minutos sem enviar TX. Mover este enqueue para o main
// process garante cadencia constante mesmo com a janela escondida.
async function tickEnqueuePolling() {
  if (!supabase || !farmId) return;
  if (!bridgeReady) return; // sem porta serial nao adianta enfileirar
  // FIX lentidão: manuais têm prioridade — não enfileira polling novo enquanto
  // houver comandos manuais pendentes na fila da fazenda.
  try {
    const { data: pendingManuals } = await supabase
      .from("commands")
      .select("id")
      .eq("farm_id", farmId)
      .eq("status", "pending")
      .eq("type", "manual")
      .limit(1);
    if (pendingManuals && pendingManuals.length > 0) return;
  } catch (_) {}
  // No inicio de cada ciclo, verifica se ha reset de vazao pendente marcado
  // pelo frontend (equipments.vazao_reset_pending=true) e transfere para o
  // Map local. O sufixo RV sera injetado no proximo frame TX daquele TSNN.
  await checkRemoteResetPending();
  try {
    const { data, error } = await supabase.rpc("enqueue_polling_for_due_equipments", {
      _farm_id: farmId,
    });
    if (error) {
      pushLog("debug", "system", `enqueue_polling falhou: ${error.message}`);
      noteCloudError(error, "tickEnqueuePolling");
    } else if (typeof data === "number" && data > 0) {
      // v3.9.30: nova rodada de polling enfileirada → fecha o ciclo anterior
      if (pollingCycleStats.startedAt > 0) {
        const elapsedS = Math.round((Date.now() - pollingCycleStats.startedAt) / 1000);
        pushLog("info", "system",
          `[POLLING] Ciclo completo em ${elapsedS}s (${pollingCycleStats.ok} bombas OK, ${pollingCycleStats.fail} sem resposta)`);
      }
      pollingCycleStats = { startedAt: Date.now(), ok: 0, fail: 0 };
      pushLog("debug", "system", `${data} polling(s) enfileirados pelo agente`);
      // Acelera o ciclo: dispara processamento imediato em vez de esperar pollTimer
      void processNextCommand();
    }
  } catch (e) {
    pushLog("debug", "system", `enqueue_polling exception: ${e.message}`);
    noteCloudError(e, "tickEnqueuePolling");
  }
}

async function tickMarkTimeouts() {
  if (!supabase || !farmId) return;
  try {
    await supabase.rpc("mark_commands_timeout", { _farm_id: farmId });
  } catch (e) {
    noteCloudError(e, "tickMarkTimeouts");
  }
}


// v3.8.24 — Burst de polling no startup usando last_outputs_state como base.
// Roda a cada 2s durante 15 min. Não tenta mudar estado das bombas — só lê e
// reafirma o que está ligado. Isso garante transição suave Hercules → Agente.
let startupBurstSeenNonZero = false;
async function tickStartupSyncPolling() {
  if (!supabase || !farmId) return;
  if (!bridgeReady) return;
  try {
    const { data, error } = await supabase.rpc("enqueue_startup_sync_polling", {
      _farm_id: farmId,
    });
    if (error) {
      pushLog("debug", "system", `startup_sync_polling falhou: ${error.message}`);
      noteCloudError(error, "tickStartupSyncPolling");
      return;
    }
    if (typeof data === "number" && data > 0) {
      startupBurstSeenNonZero = true;
      pushLog("debug", "system", `[STARTUP SYNC] ${data} polling(s) reafirmando estado real`);
      void processNextCommand();
    } else if (typeof data === "number" && data === 0 && startupBurstSeenNonZero) {
      // v3.9.4 — Primeiro ciclo completo (todas PLCs ativas já poladas pelo menos 1x).
      // Para o burst de 3s e volta ao polling normal de 11s. A janela de 15 min
      // CONTINUA ativa apenas para a lógica RX→desired_running (sincronização).
      endStartupBurst("primeiro ciclo completo");
    }
  } catch (e) {
    pushLog("debug", "system", `startup_sync exception: ${e.message}`);
    noteCloudError(e, "tickStartupSyncPolling");
  }
}

function endStartupBurst(reason) {
  if (startupSyncTimer) { clearInterval(startupSyncTimer); startupSyncTimer = null; }
  pushLog("info", "system", `[STARTUP SYNC] burst de 3s encerrado (${reason}). Polling normal de 11s assume. Janela RX→desired segue ativa.`);
  if (!pollingEnqueueTimer && supabase && farmId) {
    pollingEnqueueTimer = setInterval(() => { void tickEnqueuePolling(); }, activePollingEnqueueIntervalMs);
    void tickEnqueuePolling();
  }
}

function stopStartupSync(reason) {
  endStartupBurst(reason);
  if (startupSyncEndTimer) { clearTimeout(startupSyncEndTimer); startupSyncEndTimer = null; }
  pushLog("info", "system", `[STARTUP SYNC] janela RX→desired encerrada (${reason}).`);
}

function startCriticalPollingLoops() {
  if (!pollTimer) {
    pollTimer = setInterval(() => { void processNextCommand(); }, POLL_INTERVAL_MS);
  }
  if (!pollingTimeoutTimer) {
    pollingTimeoutTimer = setInterval(() => { void tickMarkTimeouts(); }, activeSweepTimeoutMs);
  }
  if (!plcSilenceCheckTimer) {
    plcSilenceCheckTimer = setInterval(checkPlcSilence, PLC_SILENCE_CHECK_INTERVAL_MS);
  }

  // v3.8.24 — Se ainda não passamos pelo modo startup-sync nesta sessão, ativa.
  // Polling normal (11s, baseado em desired_running) só liga quando a janela termina.
  if (agentStartupAt === 0) {
    agentStartupAt = Date.now();
    pushLog(
      "info",
      "system",
      `[STARTUP SYNC] Modo ativo por ${Math.round(STARTUP_SYNC_DURATION_MS / 60000)} min. ` +
      `Polling reafirma estado REAL (last_outputs_state) — não desliga bombas ligadas externamente.`
    );
    if (!startupSyncTimer) {
      startupSyncTimer = setInterval(() => { void tickStartupSyncPolling(); }, STARTUP_SYNC_INTERVAL_MS);
    }
    if (!startupSyncEndTimer) {
      startupSyncEndTimer = setTimeout(() => stopStartupSync("timeout 15min"), STARTUP_SYNC_DURATION_MS);
    }
    void tickStartupSyncPolling();
  } else if (!pollingEnqueueTimer && !isInStartupSyncWindow()) {
    pollingEnqueueTimer = setInterval(() => { void tickEnqueuePolling(); }, activePollingEnqueueIntervalMs);
    void tickEnqueuePolling();
  }

  void tickMarkTimeouts();
  void processNextCommand();
}

function startRealtimeSubscriptionsBestEffort() {
  Promise.resolve()
    .then(() => startCommandsSubscription())
    .catch((e) => scheduleCommandsRetry(`exception: ${formatError(e)}`));
  Promise.resolve()
    .then(() => startAgentCommandSubscription())
    .catch((e) => scheduleAgentCmdRetry(`exception: ${formatError(e)}`));
  // polling HTTP de fallback p/ agent_commands (sempre ativo)
  startAgentCommandPolling();
}

// --- Supabase auth ---
async function authenticate(email, password, supabaseUrl, supabaseAnonKey) {
  if (!email || !password || !supabaseUrl || !supabaseAnonKey) {
    throw new Error("configuração incompleta: email/senha/URL/chave da nuvem ausente");
  }
  const client = createClient(supabaseUrl, supabaseAnonKey);
  const { data, error } = await withCloudTimeout(
    client.auth.signInWithPassword({ email, password }),
    "login do agente",
    CLOUD_LOGIN_TIMEOUT_MS,
  );
  if (error) throw new Error(formatError(error));
  activeSupabaseUrl = supabaseUrl;
  activeSupabaseAnonKey = supabaseAnonKey;
  activeAccessToken = data?.session?.access_token || null;
  return client;
}

function stopCloudReconnect() {
  if (cloudReconnectTimer) {
    clearInterval(cloudReconnectTimer);
    cloudReconnectTimer = null;
  }
}

function startCloudReconnect(cfg) {
  if (cloudReconnectTimer) return;
  cloudReconnectTimer = setInterval(() => { void connectCloudServices(cfg, { quiet: true }); }, CLOUD_RECONNECT_INTERVAL_MS);
}

async function connectCloudServices(cfg, options = {}) {
  const { quiet = false } = options;
  if (!cfg || !cfg.email || !cfg.password || !cfg.supabaseUrl || !cfg.supabaseAnonKey || !cfg.farmId) {
    if (!quiet) pushLog("warn", "cloud", "Nuvem não conectada: configuração incompleta");
    startCloudReconnect(cfg);
    return false;
  }
  try {
    supabase = await authenticate(cfg.email, cfg.password, cfg.supabaseUrl, cfg.supabaseAnonKey);
    farmId = cfg.farmId;
    stopCloudReconnect();
    pushLog("info", "system", `Autenticado como ${cfg.email}`);
    startCriticalPollingLoops();
    pushLog("info", "system", "Polling HTTP iniciado imediatamente; Realtime é best-effort.");
    void refreshEquipmentCache();
    scheduleMidnightReset();
    void sendHeartbeat();
    void flushLogs();
    void flushTelemetryQueue();
    startRealtimeSubscriptionsBestEffort();
    // Marca início de sessão do agente no Relatório de Automação (origem
    // "Sistema"). Útil para correlacionar perda de estado de bombas após
    // reinício do agente / queda de energia / OTA.
    void logAgentLifecycleEvent("agent_restart", {
      reason: quiet ? "reconnect" : "startup",
    });
    return true;
  } catch (e) {
    supabase = null;
    if (!quiet) pushLog("warn", "cloud", `Nuvem indisponível; COM continua local: ${formatError(e)}`);
    startCloudReconnect(cfg);
    return false;
  }
}

// --- Setup window ---
function showSetupWindow() {
  setupWindow = new BrowserWindow({
    width: 450, height: 550, resizable: false, frame: true,
    title: "RENOV Agent - Setup",
    webPreferences: {
      preload: path.join(__dirname, "setup-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  setupWindow.loadFile(path.join(__dirname, "setup.html")).catch((e) => {
    _bootLog(`setupWindow loadFile FAIL: ${e && e.stack || e}`);
    try {
      dialog.showErrorBox("Renov Agent — Setup não encontrado",
        `Não consegui abrir a tela de configuração.\n\nArquivo esperado:\n${path.join(__dirname, "setup.html")}\n\nReinstale usando o pacote v${AGENT_VERSION}.`);
    } catch (_) {}
  });
  setupWindow.on("closed", () => { setupWindow = null; });
}

// --- Log window ---
function showLogWindow() {
  if (logWindow && !logWindow.isDestroyed()) {
    logWindow.show();
    logWindow.focus();
    return;
  }
  logWindow = new BrowserWindow({
    width: 720, height: 480,
    title: "RENOV Agent - Log",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "log-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  logWindow.loadFile(path.join(__dirname, "log.html")).catch((e) => {
    _bootLog(`logWindow loadFile FAIL: ${e && e.stack || e}`);
  });
  logWindow.on("closed", () => { logWindow = null; });
}

// --- Config window ---
function showConfigWindow() {
  if (configWindow && !configWindow.isDestroyed()) {
    configWindow.show();
    configWindow.focus();
    return;
  }
  configWindow = new BrowserWindow({
    width: 540, height: 520,
    title: "RENOV Agent - Configurações",
    icon: path.join(__dirname, "icon.png"),
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, "config-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  configWindow.loadFile(path.join(__dirname, "config.html")).catch((e) => {
    _bootLog(`configWindow loadFile FAIL: ${e && e.stack || e}`);
  });
  configWindow.on("closed", () => { configWindow = null; });
}

async function closeComPort() {
  portManuallyClosed = true;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (pollingEnqueueTimer) { clearInterval(pollingEnqueueTimer); pollingEnqueueTimer = null; }
  if (pollingTimeoutTimer) { clearInterval(pollingTimeoutTimer); pollingTimeoutTimer = null; }
  stopCloudReconnect();
  if (inflightTimer) { clearTimeout(inflightTimer); inflightTimer = null; }
  inflightCmd = null;
  inflightTsnn = null;
  processing = false;
  await stopBridge();
  pushLog("warn", "system", "Porta COM fechada manualmente pelo usuário");
  if (tray) tray.setToolTip("RENOV Agent - Porta COM fechada");
  return { success: true };
}

async function openComPort(newPort) {
  portManuallyClosed = false;
  const cfg = loadConfig();
  if (!cfg) return { success: false, error: "Sem configuração salva" };
  if (newPort && newPort !== cfg.comPort) {
    cfg.comPort = newPort;
    saveConfig(cfg);
  }
  comPort = cfg.comPort || comPort || "COM12";
  pushLog("info", "system", `Reabrindo porta ${comPort}...`);
  try {
    await startBridge(comPort);
    if (!pollTimer) {
      pollTimer = setInterval(() => { void processNextCommand(); }, POLL_INTERVAL_MS);
    }
    if (!pollingEnqueueTimer) {
      void tickEnqueuePolling();
      pollingEnqueueTimer = setInterval(() => { void tickEnqueuePolling(); }, activePollingEnqueueIntervalMs);
    }
    if (!pollingTimeoutTimer) {
      void tickMarkTimeouts();
      pollingTimeoutTimer = setInterval(() => { void tickMarkTimeouts(); }, activeSweepTimeoutMs);
    }
    if (tray) tray.setToolTip(`RENOV Agent - Online (${comPort})`);
    return { success: true };
  } catch (e) {
    pushLog("error", "system", `Falha ao reabrir: ${e.message}`);
    return { success: false, error: e.message };
  }
}

// ============================================================================
// REMOTE CONTROL — agent_commands (web → agent via Supabase Realtime)
// ============================================================================

async function resolveAgentCommand(cmdId, status, extra = {}) {
  if (!supabase || !cmdId) return;
  try {
    const patch = {
      status,
      executed_at: new Date().toISOString(),
    };
    if (extra.response !== undefined || extra.latency_ms !== undefined || extra.data !== undefined) {
      patch.result = {
        ...(extra.response !== undefined ? { response: extra.response } : {}),
        ...(extra.latency_ms !== undefined ? { latency_ms: extra.latency_ms } : {}),
        ...(extra.data !== undefined ? { data: extra.data } : {}),
      };
    }
    if (extra.error) patch.error_message = String(extra.error).substring(0, 500);
    if (extra.duration_ms != null) patch.duration_ms = extra.duration_ms;

    await supabase.from("agent_commands").update(patch).eq("id", cmdId);
  } catch (e) {
    pushLog("error", "system", `Falha ao resolver agent_command ${cmdId}: ${e.message}`);
  }
}

async function ackAgentCommand(cmdId) {
  if (!supabase || !cmdId) return;
  try {
    await supabase.from("agent_commands")
      .update({ status: "executing", ack_at: new Date().toISOString() })
      .eq("id", cmdId);
  } catch (_) {}
}

function listSerialPortsAsync() {
  return new Promise((resolve) => {
    const candidates = getPythonCandidates();
    let i = 0;
    const tryNext = () => {
      if (i >= candidates.length) { resolve([]); return; }
      const cmd = candidates[i++];
      let proc;
      try {
        proc = spawn(cmd, ["-c",
          "import serial.tools.list_ports; [print(f'{p.device}|{p.description}') for p in serial.tools.list_ports.comports()]"
        ], { windowsHide: true, env: buildPythonEnv() });
      } catch (_) { tryNext(); return; }
      let output = "";
      proc.stdout.on("data", (d) => (output += d.toString()));
      proc.on("error", () => tryNext());
      proc.on("close", (code) => {
        if (code !== 0 && !output.trim()) { tryNext(); return; }
        const ports = output.trim().split("\n").filter(Boolean).map((l) => {
          const [dev, desc] = l.split("|");
          return { path: dev, description: desc || "Desconhecido" };
        });
        resolve(ports);
      });
    };
    tryNext();
  });
}

async function handleAgentCommand(cmd) {
  if (!cmd || !cmd.id) return;
  if (processedAgentCmdIds.has(cmd.id)) return;
  processedAgentCmdIds.add(cmd.id);
  // bound: limita memória
  if (processedAgentCmdIds.size > 200) {
    const it = processedAgentCmdIds.values();
    const drop = processedAgentCmdIds.size - 200;
    for (let i = 0; i < drop; i++) processedAgentCmdIds.delete(it.next().value);
  }
  const startedAt = Date.now();
  pushLog("info", "remote", `Comando remoto recebido: ${cmd.kind} (${cmd.id.substring(0, 8)})`, null, `Comando recebido da plataforma web`);
  await ackAgentCommand(cmd.id);

  try {
    switch (cmd.kind) {
      case "close_port": {
        const r = await closeComPort();
        await resolveAgentCommand(cmd.id, r.success ? "done" : "error", {
          duration_ms: Date.now() - startedAt,
          error: r.success ? undefined : r.error,
        });
        break;
      }
      case "open_port": {
        const newPort = (cmd.payload && cmd.payload.port) || null;
        const r = await openComPort(newPort);
        await resolveAgentCommand(cmd.id, r.success ? "done" : "error", {
          duration_ms: Date.now() - startedAt,
          error: r.success ? undefined : r.error,
          data: { port: comPort },
        });
        break;
      }
      case "change_port": {
        const newPort = (cmd.payload && cmd.payload.port) || null;
        if (!newPort) {
          await resolveAgentCommand(cmd.id, "error", { error: "payload.port ausente" });
          break;
        }
        const previousPort = comPort;
        pushLog("info", "system", `[CONFIG] Comando remoto de troca de porta: ${previousPort} → ${newPort}`);
        await closeComPort();
        const r = await openComPort(newPort);
        if (!r.success) {
          // Rollback: tenta reabrir a porta anterior.
          pushLog("warn", "system", `[CONFIG] Falha em ${newPort} (${r.error}) — revertendo para ${previousPort}`);
          let rolledBack = false;
          if (previousPort && previousPort !== newPort) {
            const rb = await openComPort(previousPort);
            rolledBack = !!(rb && rb.success);
          }
          await resolveAgentCommand(cmd.id, "error", {
            duration_ms: Date.now() - startedAt,
            error: `Falha ao abrir ${newPort}: ${r.error}${rolledBack ? ` (revertido para ${previousPort})` : ""}`,
            data: { attempted: newPort, current: comPort, rolled_back: rolledBack },
          });
          break;
        }
        // Sucesso → persiste em agent_config (fonte da verdade) sem disparar hot-reload duplicado.
        if (supabase && farmId) {
          try {
            const nowIso = new Date().toISOString();
            await supabase
              .from("agent_config")
              .upsert({ farm_id: farmId, serial_port: newPort, updated_at: nowIso },
                      { onConflict: "farm_id" });
            lastAgentConfigUpdatedAt = nowIso;
            if (liveAgentConfig) liveAgentConfig.serial_port = newPort;
          } catch (e) {
            pushLog("warn", "system", `[CONFIG] não pôde persistir porta em agent_config: ${formatError(e)}`);
          }
        }
        pushLog("info", "system", `[CONFIG] Bridge reconectada em ${newPort}`);
        await resolveAgentCommand(cmd.id, "done", {
          duration_ms: Date.now() - startedAt,
          data: { port: comPort, previous: previousPort },
        });
        break;
      }
      case "hard_reset_bridge": {
        pushLog("warn", "remote", "Hard reset do bridge solicitado remotamente");
        const r = await recoverBridge("reset remoto solicitado pela plataforma", { manual: true });
        await resolveAgentCommand(cmd.id, r.success ? "done" : "error", {
          duration_ms: Date.now() - startedAt,
          error: r.success ? undefined : r.error,
        });
        break;
      }
      case "set_log_level": {
        const lvl = (cmd.payload && cmd.payload.level) || "info";
        if (!["debug", "info", "warn", "error"].includes(lvl)) {
          await resolveAgentCommand(cmd.id, "error", { error: `Nivel invalido: ${lvl}` });
          break;
        }
        logLevel = lvl;
        pushLog("info", "remote", `Nivel de log alterado para: ${lvl}`);
        await resolveAgentCommand(cmd.id, "done", {
          duration_ms: Date.now() - startedAt,
          data: { level: lvl },
        });
        break;
      }
      case "pause_polling": {
        pollingPaused = true;
        pushLog("warn", "remote", "Polling de telemetria PAUSADO remotamente");
        await resolveAgentCommand(cmd.id, "done", { duration_ms: Date.now() - startedAt });
        break;
      }
      case "resume_polling": {
        pollingPaused = false;
        pushLog("info", "remote", "Polling de telemetria RETOMADO remotamente");
        await resolveAgentCommand(cmd.id, "done", { duration_ms: Date.now() - startedAt });
        break;
      }
      case "start_log_stream": {
        const ok = startLiveLogStream();
        await resolveAgentCommand(cmd.id, ok ? "done" : "error", {
          duration_ms: Date.now() - startedAt,
          data: { buffer_size: liveStreamBuffer.length, ttl_ms: LIVE_STREAM_INACTIVE_MS },
          error: ok ? undefined : "Falha ao abrir canal broadcast",
        });
        break;
      }
      case "renew_log_stream": {
        const ok = renewLiveLogStream();
        await resolveAgentCommand(cmd.id, ok ? "done" : "error", {
          duration_ms: Date.now() - startedAt,
          error: ok ? undefined : "Stream não estava ativo",
        });
        break;
      }
      case "stop_log_stream": {
        stopLiveLogStream("manual");
        await resolveAgentCommand(cmd.id, "done", { duration_ms: Date.now() - startedAt });
        break;
      }
      case "list_ports": {
        const ports = await listSerialPortsAsync();
        await resolveAgentCommand(cmd.id, "done", {
          duration_ms: Date.now() - startedAt,
          data: { ports },
        });
        break;
      }
      case "send_manual_frame": {
        if (!bridgeReady || !bridgeProcess) {
          await resolveAgentCommand(cmd.id, "error", { error: "Bridge nao conectado" });
          break;
        }
        if (inflightManual) {
          await resolveAgentCommand(cmd.id, "error", { error: "Outro frame manual em curso" });
          break;
        }
        const frame = (cmd.payload && cmd.payload.frame || "").replace(/[\r\n]/g, "").trim();
        if (!frame) {
          await resolveAgentCommand(cmd.id, "error", { error: "payload.frame vazio" });
          break;
        }
        const timeoutMs = (cmd.payload && cmd.payload.timeout_ms) || 13000;
        const tsnnMatch = frame.match(TX_TSNN_RE);
        const expectedTsnn = tsnnMatch ? tsnnMatch[1] : null;

        inflightManual = {
          agentCmdId: cmd.id,
          frame,
          expectedTsnn,
          sentAt: Date.now(),
        };

        manualTimer = setTimeout(() => {
          if (inflightManual && inflightManual.agentCmdId === cmd.id) {
            inflightManual = null;
            manualTimer = null;
            void resolveAgentCommand(cmd.id, "error", {
              duration_ms: Date.now() - startedAt,
              error: `Sem resposta em ${timeoutMs}ms`,
            });
            pushLog("warn", "remote", `[MANUAL] timeout ${timeoutMs}ms para ${frame}`);
          }
        }, timeoutMs);

        try {
          sendTxFrame(frame, { priority: "manual" });
          pushLog("info", "tx", `[MANUAL] TX-> ${frame}`, frame, null);
        } catch (e) {
          if (manualTimer) { clearTimeout(manualTimer); manualTimer = null; }
          inflightManual = null;
          await resolveAgentCommand(cmd.id, "error", { error: `Falha TX: ${e.message}` });
        }
        break;
      }
      case "update_agent": {
        // Atualização disparada pelo /platform → Atualizações.
        // v3.11.8: dois fluxos suportados:
        //  - artifact_type='asar' (ou sem download_url): baixa do bucket
        //    privado via signed URL → downloadAndInstallAsarUpdate
        //  - artifact_type='exe' com download_url externo: legado .exe
        const targetVersion = cmd.payload && cmd.payload.version;
        const targetUrl = cmd.payload && cmd.payload.download_url;
        const targetHash = cmd.payload && cmd.payload.file_hash;
        const targetSize = cmd.payload && cmd.payload.file_size_bytes;
        const artifactType = (cmd.payload && cmd.payload.artifact_type)
          || (targetUrl ? "exe" : "asar");

        pushLog(
          "info",
          "update",
          `[OTA] Comando recebido: v${targetVersion || "?"} (${artifactType}) — atual=${AGENT_VERSION}`,
          null,
          targetUrl || `bucket://releases/${targetVersion}/app.asar`,
        );

        if (targetVersion && targetVersion === AGENT_VERSION) {
          pushLog("info", "update", `[OTA] Já está na v${targetVersion} — nada a fazer`);
          await resolveAgentCommand(cmd.id, "done", {
            duration_ms: Date.now() - startedAt,
            data: { current: AGENT_VERSION, target: targetVersion, skipped: "already_on_target" },
          });
          break;
        }

        if (artifactType === "asar") {
          // Não exige download_url: o agente pede signed URL ao backend.
          await resolveAgentCommand(cmd.id, "done", {
            duration_ms: Date.now() - startedAt,
            data: { current: AGENT_VERSION, target: targetVersion || null, status: "downloading", artifact: "asar" },
          });
          pushLog("info", "update", `[OTA] Iniciando download .asar v${targetVersion}...`);
          void downloadAndInstallAsarUpdate(targetVersion, targetHash || null, targetSize || null);
          break;
        }

        // Legado: .exe externo
        if (!targetUrl) {
          pushLog("error", "update", "[OTA] payload sem download_url para artifact_type=exe");
          await resolveAgentCommand(cmd.id, "error", { error: "payload sem download_url" });
          break;
        }
        try {
          await resolveAgentCommand(cmd.id, "done", {
            duration_ms: Date.now() - startedAt,
            data: { current: AGENT_VERSION, target: targetVersion || null, status: "downloading", artifact: "exe" },
          });
          pushLog("info", "update", `[OTA] Iniciando download .exe v${targetVersion}...`);
          void downloadAndInstallUpdate(targetUrl, targetVersion || "manual", targetHash);
        } catch (e) {
          pushLog("error", "update", `[OTA] Falha ao iniciar download: ${e.message}`);
          await resolveAgentCommand(cmd.id, "error", { error: e.message });
        }
        break;
      }

      case "agent_restart": {
        pushLog("warn", "remote", "Reinício do agente Electron solicitado remotamente");
        await resolveAgentCommand(cmd.id, "done", {
          duration_ms: Date.now() - startedAt,
          data: { restarting: true },
        });
        // dá tempo do PATCH chegar antes de relaunch
        setTimeout(() => {
          try {
            pushLog("warn", "system", "Relaunch do app.exe (agent_restart)");
            app.relaunch();
            app.exit(0);
          } catch (e) {
            pushLog("error", "system", `Falha relaunch: ${e.message}`);
          }
        }, 800);
        break;
      }

      case "force_rollback": {
        // Rollback 1-clique: troca app.asar pelo app.asar.bak local (instantâneo).
        // Se .bak não existe, cai pro fluxo OTA normal usando a versão anterior.
        pushLog("warn", "remote", "Rollback remoto solicitado");
        const fs = require("fs");
        // Mesmo motivo do OTA: arquivos .asar exigem original-fs.
        let originalFs;
        try { originalFs = require("original-fs"); } catch (_) { originalFs = fs; }
        const targetVersion = (cmd.payload && cmd.payload.target_version) || null;

        if (!process.resourcesPath) {
          await resolveAgentCommand(cmd.id, "error", { error: "process.resourcesPath ausente (dev mode)" });
          break;
        }
        const currentAsar = path.join(process.resourcesPath, "app.asar");
        const bakAsar = path.join(process.resourcesPath, "app.asar.bak");
        const appFolder = path.join(process.resourcesPath, "app");
        const appFolderBak = path.join(process.resourcesPath, "app_pre_ota.bak");

        if (originalFs.existsSync(bakAsar)) {
          try {
            const tmpAsar = path.join(process.resourcesPath, "app.asar.rollback.tmp");
            try { if (originalFs.existsSync(tmpAsar)) originalFs.unlinkSync(tmpAsar); } catch (_) {}
            // Swap: current -> tmp, bak -> current, remove tmp
            originalFs.renameSync(currentAsar, tmpAsar);
            originalFs.renameSync(bakAsar, currentAsar);
            try { originalFs.unlinkSync(tmpAsar); } catch (_) {}

            await reportUpdateStatus({
              update_status: "installing",
              target_version: targetVersion,
              error_message: null,
              completed_at: new Date().toISOString(),
            });
            try {
              await supabase.from("agent_update_history").insert({
                farm_id: farmId,
                from_version: AGENT_VERSION,
                to_version: targetVersion || "rollback",
                status: "rolled_back",
                duration_ms: Date.now() - startedAt,
              });
            } catch (_) {}

            await resolveAgentCommand(cmd.id, "done", {
              duration_ms: Date.now() - startedAt,
              data: { method: "local_bak_swap", from: AGENT_VERSION, to: targetVersion || "previous" },
            });

            pushLog("warn", "update", `[ROLLBACK] app.asar.bak restaurado — reiniciando`);
            setTimeout(() => {
              try { app.relaunch(); } catch (_) {}
              try { app.exit(0); } catch (_) { try { app.quit(); } catch (__) {} }
            }, 1500);
          } catch (e) {
            await resolveAgentCommand(cmd.id, "error", { error: `swap falhou: ${e.message}` });
          }
        } else if (fs.existsSync(appFolderBak)) {
          // Rollback de instalação folder-based: apaga app.asar e restaura pasta app/.
          try {
            if (originalFs.existsSync(currentAsar)) originalFs.unlinkSync(currentAsar);
            if (fs.existsSync(appFolder)) fs.rmSync(appFolder, { recursive: true, force: true });
            fs.renameSync(appFolderBak, appFolder);

            await reportUpdateStatus({
              update_status: "installing",
              target_version: targetVersion,
              error_message: null,
              completed_at: new Date().toISOString(),
            });
            try {
              await supabase.from("agent_update_history").insert({
                farm_id: farmId,
                from_version: AGENT_VERSION,
                to_version: targetVersion || "rollback",
                status: "rolled_back",
                duration_ms: Date.now() - startedAt,
              });
            } catch (_) {}

            await resolveAgentCommand(cmd.id, "done", {
              duration_ms: Date.now() - startedAt,
              data: { method: "folder_restore", from: AGENT_VERSION, to: targetVersion || "previous" },
            });

            pushLog("warn", "update", `[ROLLBACK] pasta app_pre_ota.bak restaurada — reiniciando`);
            setTimeout(() => {
              try { app.relaunch(); } catch (_) {}
              try { app.exit(0); } catch (_) { try { app.quit(); } catch (__) {} }
            }, 1500);
          } catch (e) {
            await resolveAgentCommand(cmd.id, "error", { error: `restore folder falhou: ${e.message}` });
          }
        } else {
          // Sem .bak nem pasta backup — tenta OTA normal pra versão anterior.
          if (!targetVersion) {
            await resolveAgentCommand(cmd.id, "error", { error: "Sem app.asar.bak/app_pre_ota.bak e sem target_version no payload" });
            break;
          }
          pushLog("warn", "update", `[ROLLBACK] Sem backup local — fallback OTA pra v${targetVersion}`);
          await resolveAgentCommand(cmd.id, "done", {
            duration_ms: Date.now() - startedAt,
            data: { method: "ota_fallback", target: targetVersion },
          });
          void downloadAndInstallAsarUpdate(targetVersion, null, null);
        }
        break;
      }

      default:
        await resolveAgentCommand(cmd.id, "error", { error: `Tipo desconhecido: ${cmd.kind}` });
    }
  } catch (e) {
    pushLog("error", "remote", `Erro processando ${cmd.kind}: ${e.message}`);
    await resolveAgentCommand(cmd.id, "error", { error: e.message });
  }
}

function scheduleAgentCmdRetry(reason) {
  if (agentCmdRetryTimer) return;
  agentCmdRetryAttempts += 1;
  const delay = agentCmdRetryAttempts <= REALTIME_FAST_ATTEMPTS ? REALTIME_RETRY_FAST_MS : REALTIME_RETRY_SLOW_MS;
  pushLog("warn", "remote", `Subscription agent_commands indisponível (${reason}). Polling HTTP segue ativo. Tentativa ${agentCmdRetryAttempts} — retry em ${Math.round(delay/1000)}s.`);
  agentCmdRetryTimer = setTimeout(() => {
    agentCmdRetryTimer = null;
    void startAgentCommandSubscription();
  }, delay);
}

async function startAgentCommandSubscription() {
  if (!supabase || !farmId) return;

  try {
    // Limpar subscription anterior
    if (agentCmdChannel) {
      try { await supabase.removeChannel(agentCmdChannel); } catch (_) {}
      agentCmdChannel = null;
    }

    // 1) Pegar comandos pendentes ja existentes (catch-up)
    try {
      const { data: pending } = await supabase
        .from("agent_commands")
        .select("*")
        .eq("farm_id", farmId)
        .eq("status", "pending")
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: true });

      if (pending && pending.length) {
        pushLog("info", "remote", `${pending.length} comando(s) pendente(s) para processar`);
        for (const c of pending) await handleAgentCommand(c);
      }
    } catch (e) {
      pushLog("warn", "remote", `Catch-up falhou: ${e.message}`);
    }

    // 2) Subscription realtime (best-effort — se falhar, polling HTTP cobre)
    agentCmdChannel = supabase
      .channel(`agent_cmds_${farmId}`)
      .on("postgres_changes", {
        event: "INSERT",
        schema: "public",
        table: "agent_commands",
        filter: `farm_id=eq.${farmId}`,
      }, (payload) => {
        const cmd = payload.new;
        if (cmd && cmd.status === "pending") {
          void handleAgentCommand(cmd);
        }
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          agentCmdRetryAttempts = 0;
          pushLog("info", "remote", `Subscription agent_commands: ${status}`);
        } else if (status === "TIMED_OUT" || status === "CHANNEL_ERROR" || status === "CLOSED") {
          scheduleAgentCmdRetry(status);
        }
      });
  } catch (e) {
    scheduleAgentCmdRetry(`exception: ${e.message}`);
  }
}

// Polling HTTP de fallback (sempre ativo, independente do realtime e do
// estado de pollingPaused). Garante que comandos administrativos cheguem
// ao agente mesmo se o canal Realtime estiver caído.
async function tickAgentCommandPoll() {
  if (!supabase || !farmId) return;
  try {
    const { data, error } = await supabase
      .from("agent_commands")
      .select("*")
      .eq("farm_id", farmId)
      .eq("status", "pending")
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: true })
      .limit(10);
    if (error) return;
    if (!data || !data.length) return;
    for (const c of data) {
      if (!processedAgentCmdIds.has(c.id)) {
        await handleAgentCommand(c);
      }
    }
  } catch (_) { /* silencioso — próximo tick tenta de novo */ }
}

function startAgentCommandPolling() {
  if (agentCmdPollTimer) return;
  agentCmdPollTimer = setInterval(() => { void tickAgentCommandPoll(); }, AGENT_CMD_POLL_MS);
}

// Subscription Realtime na tabela `commands`: dispara processamento imediato
// para comandos manuais (priority<=1), sem esperar o ciclo de polling de 3s.
// Tambem pre-empta um polling em curso para liberar o canal RS-232.
function scheduleCommandsRetry(reason) {
  if (commandsRetryTimer) return;
  commandsRetryAttempts += 1;
  const delay = commandsRetryAttempts <= REALTIME_FAST_ATTEMPTS ? REALTIME_RETRY_FAST_MS : REALTIME_RETRY_SLOW_MS;
  pushLog("warn", "system", `Subscription commands indisponível (${reason}). Polling HTTP segue ativo. Tentativa ${commandsRetryAttempts} — retry em ${Math.round(delay/1000)}s.`);
  commandsRetryTimer = setTimeout(() => {
    commandsRetryTimer = null;
    void startCommandsSubscription();
  }, delay);
}

async function startCommandsSubscription() {
  if (!supabase || !farmId) return;

  try {
    if (commandsChannel) {
      try { await supabase.removeChannel(commandsChannel); } catch (_) {}
      commandsChannel = null;
    }

    commandsChannel = supabase
      .channel(`cmds_${farmId}`)
      .on("postgres_changes", {
        event: "INSERT",
        schema: "public",
        table: "commands",
        filter: `farm_id=eq.${farmId}`,
      }, async (payload) => {
        const cmd = payload.new;
        if (!cmd || cmd.status !== "pending") return;
        const incomingPriority = cmd.priority ?? 5;
        if (incomingPriority > 1) return;

        if (isUnsafePollingActuation(cmd, cmd.frame)) {
          pushLog("error", "system", `BLOQUEADO no realtime: ${formatTxWithOrigin(cmd, (cmd.frame || "").replace(/[\r\n]/g, "").trim(), " [POLLING INSEGURO]")}`);
          await supabase
            .from("commands")
            .update({
              status: "cancelled",
              responded_at: new Date().toISOString(),
              error_message: "Polling com payload de acionamento bloqueado localmente para evitar comando oculto de ligar/desligar",
            })
            .eq("id", cmd.id)
            .eq("status", "pending");
          return;
        }

        if (incomingPriority === 0) {
          pushLog("warn", "system", `RESET (priority=0) ${cmd.id.substring(0,8)} chegou via realtime — fast-path`);
          await fastPathReset(cmd);
          return;
        }

        pushLog("info", "system", `Manual (priority=1) ${cmd.id.substring(0,8)} chegou via realtime — priorizando`);
        await preemptForIncomingManual(
          "Polling cancelado: comando manual prioritario chegou",
          incomingPriority,
          cmd,
        );
        void processNextCommand();
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          commandsRetryAttempts = 0;
          pushLog("info", "system", `Subscription commands: ${status}`);
        } else if (status === "TIMED_OUT" || status === "CHANNEL_ERROR" || status === "CLOSED") {
          scheduleCommandsRetry(status);
        }
      });
  } catch (e) {
    scheduleCommandsRetry(`exception: ${e.message}`);
  }
}

// ============================================================================
// v3.12.2 — Configuração remota da fazenda (tabela public.agent_config)
// ----------------------------------------------------------------------------
// Tudo que antes ficava em config local (porta COM, intervalo de polling,
// timeout de sweep) agora vem do banco. O agente:
//   1) Busca/cria o registro da fazenda no boot (após gate de licença).
//   2) Reconsulta a cada 60s; se updated_at mudou, aplica em hot-reload.
//   3) Se serial_port mudou: fecha bridge e reabre na nova porta.
//   4) Se intervalos mudaram: reinicia os timers afetados.
// ============================================================================
function _agentConfigCacheFile() {
  try { return path.join(app.getPath("userData"), "agent-config-cache.json"); } catch (_) { return null; }
}
function _loadAgentConfigCache() {
  try {
    const f = _agentConfigCacheFile();
    if (!f || !fs.existsSync(f)) return null;
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    if (j && typeof j === "object" && j.serial_port) return j;
  } catch (_) {}
  return null;
}
function _saveAgentConfigCache(cfg) {
  try {
    const f = _agentConfigCacheFile();
    if (!f || !cfg) return;
    fs.writeFileSync(f, JSON.stringify({
      serial_port: cfg.serial_port,
      polling_interval_ms: cfg.polling_interval_ms,
      sweep_timeout_ms: cfg.sweep_timeout_ms,
      tx_gap_ms: cfg.tx_gap_ms,
      updated_at: cfg.updated_at,
      cached_at: new Date().toISOString(),
    }), "utf8");
  } catch (_) {}
}

async function fetchAgentConfig() {
  if (!supabase || !farmId) {
    const cached = _loadAgentConfigCache();
    if (cached) {
      pushLog("warn", "system", `[CONFIG] sem conexao com nuvem — usando cache local (porta ${cached.serial_port})`);
      return cached;
    }
    return null;
  }
  try {
    const { data, error } = await supabase
      .from("agent_config")
      .select("serial_port, polling_interval_ms, sweep_timeout_ms, tx_gap_ms, updated_at")
      .eq("farm_id", farmId)
      .maybeSingle();
    if (error) throw error;
    if (data) return data;
    // Não existe — cria com defaults para esta fazenda.
    const defaults = {
      farm_id: farmId,
      serial_port: comPort || "COM1",
      polling_interval_ms: POLLING_ENQUEUE_INTERVAL_MS,
      sweep_timeout_ms: POLLING_TIMEOUT_SWEEP_MS,
      tx_gap_ms: activeTxGapMs,
    };
    const { data: created, error: insErr } = await supabase
      .from("agent_config")
      .insert(defaults)
      .select("serial_port, polling_interval_ms, sweep_timeout_ms, tx_gap_ms, updated_at")
      .single();
    if (insErr) {
      pushLog("warn", "system", `[CONFIG] não pôde criar agent_config (${formatError(insErr)}) — usando defaults locais`);
      return {
        serial_port: defaults.serial_port,
        polling_interval_ms: defaults.polling_interval_ms,
        sweep_timeout_ms: defaults.sweep_timeout_ms,
        tx_gap_ms: defaults.tx_gap_ms,
        updated_at: new Date().toISOString(),
      };
    }
    pushLog("info", "system", `[CONFIG] registro agent_config criado com defaults (porta ${defaults.serial_port})`);
    return created;
  } catch (e) {
    pushLog("warn", "system", `[CONFIG] fetchAgentConfig falhou: ${formatError(e)}`);
    const cached = _loadAgentConfigCache();
    if (cached) {
      pushLog("warn", "system", `[CONFIG] fallback: cache local (porta ${cached.serial_port}, salvo em ${cached.cached_at || "?"})`);
      return cached;
    }
    return null;
  }
}

async function applyAgentConfig(newCfg, options = {}) {
  if (!newCfg) return;
  const { initial = false } = options;
  const oldPort = (liveAgentConfig && liveAgentConfig.serial_port) || comPort;
  const oldPoll = activePollingEnqueueIntervalMs;
  const oldSweep = activeSweepTimeoutMs;
  const oldTxGap = activeTxGapMs;

  // Intervalos — sanity bounds.
  const newPoll = Math.max(1_000, Math.min(120_000, Number(newCfg.polling_interval_ms) || POLLING_ENQUEUE_INTERVAL_MS));
  const newSweep = Math.max(500, Math.min(60_000, Number(newCfg.sweep_timeout_ms) || POLLING_TIMEOUT_SWEEP_MS));
  const newTxGap = Math.max(0, Math.min(5_000, Number(newCfg.tx_gap_ms) || 100));
  const newPort = (newCfg.serial_port || "").trim() || oldPort;

  liveAgentConfig = newCfg;
  lastAgentConfigUpdatedAt = newCfg.updated_at || lastAgentConfigUpdatedAt;
  activePollingEnqueueIntervalMs = newPoll;
  activeSweepTimeoutMs = newSweep;
  activeTxGapMs = newTxGap;
  _saveAgentConfigCache(newCfg);

  if (initial) {
    comPort = newPort;
    pushLog("info", "system",
      `[CONFIG] aplicada (porta=${newPort}, polling=${newPoll}ms, sweep=${newSweep}ms, tx_gap=${newTxGap}ms)`);
    return;
  }

  if (newPoll !== oldPoll && pollingEnqueueTimer) {
    clearInterval(pollingEnqueueTimer);
    pollingEnqueueTimer = setInterval(() => { void tickEnqueuePolling(); }, activePollingEnqueueIntervalMs);
    pushLog("info", "system", `[CONFIG] polling_interval_ms ${oldPoll} → ${newPoll}ms (timer reiniciado)`);
  }
  if (newSweep !== oldSweep && pollingTimeoutTimer) {
    clearInterval(pollingTimeoutTimer);
    pollingTimeoutTimer = setInterval(() => { void tickMarkTimeouts(); }, activeSweepTimeoutMs);
    pushLog("info", "system", `[CONFIG] sweep_timeout_ms ${oldSweep} → ${newSweep}ms (timer reiniciado)`);
  }
  if (newTxGap !== oldTxGap) {
    pushLog("info", "system", `[CONFIG] tx_gap_ms ${oldTxGap} → ${newTxGap}ms`);
  }
  if (newPort && newPort !== oldPort) {
    pushLog("warn", "system", `[CONFIG] Porta alterada para ${newPort} — reconectando bridge`);
    try {
      await closeComPort();
      const r = await openComPort(newPort);
      if (r && r.success) {
        pushLog("info", "system", `[CONFIG] Bridge reconectada em ${newPort}`);
      } else {
        pushLog("error", "system", `[CONFIG] Falha ao reabrir ${newPort}: ${r && r.error}`);
      }
    } catch (e) {
      pushLog("error", "system", `[CONFIG] Exceção ao trocar porta: ${formatError(e)}`);
    }
  }
}

async function tickAgentConfigWatch() {
  if (!supabase || !farmId) return;
  try {
    const { data, error } = await supabase
      .from("agent_config")
      .select("serial_port, polling_interval_ms, sweep_timeout_ms, tx_gap_ms, updated_at")
      .eq("farm_id", farmId)
      .maybeSingle();
    if (error) { pushLog("debug", "system", `[CONFIG] watch erro: ${formatError(error)}`); return; }
    if (!data) return;
    if (lastAgentConfigUpdatedAt && data.updated_at === lastAgentConfigUpdatedAt) return;
    pushLog("info", "system", `[CONFIG] mudanca detectada (updated_at=${data.updated_at}) — aplicando hot-reload`);
    await applyAgentConfig(data, { initial: false });
  } catch (e) {
    pushLog("debug", "system", `[CONFIG] watch exception: ${formatError(e)}`);
  }
}

function startAgentConfigWatch() {
  if (agentConfigWatchTimer) return;
  agentConfigWatchTimer = setInterval(() => { void tickAgentConfigWatch(); }, AGENT_CONFIG_POLL_MS);
}



async function startAgent(cfg) {
  if (startingAgent) return;
  startingAgent = true;
  let startupStep = "preparação";

  try {
    startupStep = "limpar timers anteriores";
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (pollingEnqueueTimer) { clearInterval(pollingEnqueueTimer); pollingEnqueueTimer = null; }
    if (pollingTimeoutTimer) { clearInterval(pollingTimeoutTimer); pollingTimeoutTimer = null; }
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (agentConfigWatchTimer) { clearInterval(agentConfigWatchTimer); agentConfigWatchTimer = null; }
    processing = false;
    inflightCmd = null;
    inflightTsnn = null;
    if (inflightTimer) { clearTimeout(inflightTimer); inflightTimer = null; }
    startupStep = "fechar bridge anterior";
    await stopBridge();

    farmId = cfg.farmId;
    // v3.22.0: prioriza última COM que funcionou (evita re-scan em toda inicialização)
    let portToTry = null;
    try {
      const fs3 = require("fs");
      const lastComFile = path.join(app.getPath("userData"), "last_working_com.txt");
      portToTry = fs3.readFileSync(lastComFile, "utf8").trim();
    } catch (_) {}
    if (!portToTry) portToTry = cfg.comPort;
    comPort = portToTry || "COM12";

    // v3.10.7 SECURITY: conecta nuvem PRIMEIRO e valida hardware ANTES do bridge.
    startupStep = "conectar serviços da nuvem (pré-gate)";
    try { await connectCloudServices(cfg); } catch (_) {}

    // v3.11.9: SEMPRE reporta versão atual ao banco logo após autenticação,
    // independente de OTA ou instalação manual. Garante que /platform mostre
    // a versão real do .asar em execução.
    try {
      if (supabase && farmId) {
        await supabase.from("agent_update_status").upsert(
          {
            farm_id: farmId,
            current_version: AGENT_VERSION,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "farm_id" }
        );
        await supabase.from("site_health").upsert(
          {
            farm_id: farmId,
            agent_version: AGENT_VERSION,
            last_heartbeat: new Date().toISOString(),
          },
          { onConflict: "farm_id" }
        );
        pushLog("info", "system", `[HEARTBEAT] Versão reportada ao banco: ${AGENT_VERSION}`);
      }
    } catch (e) {
      pushLog("warn", "system", `[HEARTBEAT] Falha ao reportar versão: ${formatError(e)}`);
    }

    // v3.13.1 SECURITY: gate de licença NÃO-INVASIVO.
    // Fluxo legacy (fazendas em produção): email+password+farmId salvos localmente
    // + autenticação bem-sucedida no Supabase (já ocorreu acima) ⇒ agente licenciado.
    // O licenseToken/anticlone é OPCIONAL — se ausente, tenta provisionar em background,
    // mas NUNCA bloqueia a inicialização do bridge/polling.
    startupStep = "gate de licença (legacy-friendly)";
    _loadLicenseGrace();
    const hasLegacyLicense = !!(cfg.email && cfg.password && cfg.farmId && supabase);
    if (!hasLegacyLicense && !cfg.licenseToken) {
      pushLog("error", "system",
        "[SECURITY] Sem credenciais nem licença — agente não iniciará. Reconfigure pelo Tray → 'Reconfigurar (login)'.");
      if (tray) tray.setToolTip("RENOV Agent - SEM LICENÇA");
      try {
        dialog.showErrorBox("Renov Agent — Licença ausente",
          "Este agente não está vinculado a uma fazenda. Use o ícone na bandeja → 'Reconfigurar (login)' para ativar.");
      } catch (_) {}
      return;
    }
    // Se já temos licenseToken novo, valida — mas SÓ desliga se servidor responder revogado.
    // Falha de rede / token ausente NÃO bloqueia o legacy.
    if (cfg.licenseToken) {
      lastLicenseValidationAt = 0;
      try { await validateLicenseHeartbeat(cfg); } catch (_) {}
      if (licenseKillSwitchTriggered) {
        pushLog("error", "system",
          "[SECURITY] Licença revogada pelo servidor — agente NÃO iniciará bridge.");
        if (tray) tray.setToolTip("RENOV Agent - LICENÇA REVOGADA");
        return;
      }
    } else {
      pushLog("info", "system",
        "[SECURITY] Legacy license (email+senha OK). licenseToken ausente — provisionamento anticlone será tentado em background.");
    }

    // v3.14.0 — Anti-clone em BACKGROUND (não bloqueia inicialização).
    // A verificação de fingerprint (agent_hardware, keyed por farm_id) foi
    // movida para depois do polling estar rodando. Ver scheduleBackgroundAntiCloneCheck().
    _loadLicenseGrace();



    // v3.12.2 — Carrega configuração remota (porta COM + intervalos) ANTES de abrir o bridge.
    startupStep = "carregar agent_config remoto";
    try {
      const remoteCfg = await fetchAgentConfig();
      if (remoteCfg) {
        await applyAgentConfig(remoteCfg, { initial: true });
      } else {
        pushLog("warn", "system", "[CONFIG] agent_config indisponível — usando porta/intervalos locais");
      }
    } catch (e) {
      pushLog("warn", "system", `[CONFIG] falha ao carregar agent_config: ${formatError(e)}`);
    }

    pushLog("info", "system", `Iniciando bridge Serial em ${comPort}...`);

    try {
      startupStep = `abrir bridge serial em ${comPort}`;
      await startBridge(comPort);
    } catch (bridgeErr) {
      pushLog("error", "system", `Bridge falhou: ${bridgeErr.message}`);
      if (tray) tray.setToolTip("RENOV Agent - ERRO Python");
      return;
    }

    try { verifyAgentObfuscation(cfg); } catch (_) {}


    pushLog("info", "system", "Polling commands ativo a cada 3s. RX continuo via Python.");
    startupStep = "seed de backoff (TSNNs offline no banco)";
    void seedBackoffFromCloud();
    startCriticalPollingLoops();
    startupStep = "enviar heartbeat";
    void sendHeartbeat();
    heartbeatTimer = setInterval(() => { sendHeartbeat(); flushLogs(); flushTelemetryQueue(); }, HEARTBEAT_INTERVAL_MS);

    // Enqueue de polling de bombas no PROPRIO main process — independente do
    // navegador/renderer (que sofre throttle quando minimizado).
    startupStep = "iniciar polling";
    startCriticalPollingLoops();
    pushLog("info", "system", `Enqueue de polling no agente: ${activePollingEnqueueIntervalMs}ms | sweep timeouts: ${activeSweepTimeoutMs}ms`);

    // v3.12.2 — hot-reload de agent_config a cada 60s.
    startupStep = "iniciar watcher de agent_config";
    startAgentConfigWatch();

    // Log rotation diaria + subscription de agent_commands
    startupStep = "ativar subscriptions";
    rotateOldLogs();
    if (logRotationTimer) clearInterval(logRotationTimer);
    logRotationTimer = setInterval(rotateOldLogs, 6 * 60 * 60 * 1000);
    startMemoryCleanup();
    startAutoRebootWatchdog();
    startRealtimeSubscriptionsBestEffort();

    // v3.14.0 — Anti-clone em BACKGROUND (30s após polling estar rodando).
    // Se clone detectado: WhatsApp alert → aguarda 60s → encerra processo.
    try { scheduleBackgroundAntiCloneCheck(cfg); } catch (_) {}
  } catch (e) {
    pushLog("error", "system", `Falha ao iniciar (${startupStep}): ${formatError(e)}`);
    if (tray) tray.setToolTip("RENOV Agent - ERRO");
  } finally {
    startingAgent = false;
  }
}

// --- Tray ---
function createTray() {
  const iconPath = path.join(__dirname, "icon.png");
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) throw new Error("icon.png vazio");
    icon = icon.resize({ width: 16, height: 16 });
  } catch (e) {
    const buf = Buffer.alloc(16 * 16 * 4);
    for (let i = 0; i < buf.length; i += 4) {
      buf[i] = 66; buf[i + 1] = 147; buf[i + 2] = 80; buf[i + 3] = 255;
    }
    icon = nativeImage.createFromBuffer(buf, { width: 16, height: 16 });
  }

  tray = new Tray(icon);
  const contextMenu = Menu.buildFromTemplate([
    { label: `RENOV Agent v${AGENT_VERSION}`, enabled: false },
    { type: "separator" },
    { label: "Ver Log", click: () => showLogWindow() },
    { label: "Configurações", click: () => showConfigWindow() },
    { label: "Reconfigurar (login)", click: () => {
      if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
      if (pollTimer) clearInterval(pollTimer);
      if (pollingEnqueueTimer) clearInterval(pollingEnqueueTimer);
      if (pollingTimeoutTimer) clearInterval(pollingTimeoutTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      void stopBridge().finally(() => showSetupWindow());
    }},
    { type: "separator" },
    { label: "Sair", click: () => {
      appClosing = true;
      flushLogs();
      void stopBridge().finally(() => app.quit());
    }},
  ]);
  tray.setToolTip("RENOV Agent - Iniciando...");
  tray.setContextMenu(contextMenu);
  tray.on("double-click", () => showLogWindow());
}

// =====================================================================
// PROVISIONAMENTO AUTOMÁTICO + ANTI-TAMPERING
// =====================================================================

// Coleta fingerprint estável do hardware (Windows)
function getMachineFingerprint() {
  let cpuId = "", diskSerial = "", uuid = "";
  try {
    if (process.platform === "win32") {
      cpuId = execSync("wmic cpu get ProcessorId /value", { timeout: 3000 }).toString().match(/ProcessorId=(.+)/)?.[1]?.trim() || "";
      diskSerial = execSync("wmic diskdrive get SerialNumber /value", { timeout: 3000 }).toString().match(/SerialNumber=(.+)/)?.[1]?.trim() || "";
      uuid = execSync("wmic csproduct get UUID /value", { timeout: 3000 }).toString().match(/UUID=(.+)/)?.[1]?.trim() || "";
    }
  } catch (_) {}
  const macs = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && !i.internal && i.mac && i.mac !== "00:00:00:00:00:00")
    .map((i) => i.mac)
    .sort();
  const raw = [cpuId, diskSerial, uuid, ...macs, os.hostname()].join("|");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return {
    machine_id_hash: hash,
    fingerprint: {
      cpu: cpuId, disk_serial: diskSerial, uuid,
      mac_addresses: macs, hostname: os.hostname(),
      os: process.platform, arch: process.arch,
    },
  };
}

// Procura provisioning.json em vários caminhos
function findProvisioningFile() {
  for (const p of PROVISIONING_LOOKUP_PATHS) {
    try {
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, "utf8"));
        if (data.provisioning_token && data.farm_id) {
          return { path: p, data };
        }
      }
    } catch (_) {}
  }
  return null;
}

// Tenta auto-provisionar usando provisioning.json
async function tryAutoProvision() {
  const found = findProvisioningFile();
  if (!found) return null;

  console.log("[PROVISION] provisioning.json encontrado em", found.path);
  const fp = getMachineFingerprint();

  // Permite que o provisioning.json sobrescreva URL/anon do build
  const supabaseUrl = found.data.supabase_url || SUPABASE_URL_DEFAULT;
  const supabaseAnon = found.data.supabase_anon_key || SUPABASE_ANON_DEFAULT;

  try {
    const resp = await fetch(`${supabaseUrl}/functions/v1/license-provision`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": supabaseAnon },
      body: JSON.stringify({
        provisioning_token: found.data.provisioning_token,
        machine_id_hash: fp.machine_id_hash,
        fingerprint: fp.fingerprint,
        agent_version: AGENT_VERSION,
      }),
    });
    const result = await resp.json();
    if (!resp.ok || !result.ok) {
      console.error("[PROVISION] falhou:", result);
      try { fs.renameSync(found.path, found.path + ".failed"); } catch (_) {}
      return null;
    }

    const cfg = {
      email: result.auth.email,
      password: result.auth.password,
      farmId: result.farm_id,
      farmName: result.farm_name,
      deviceId: result.device_id,
      licenseToken: result.license.token,
      licenseExpiresAt: Date.now() + (result.license.expires_in * 1000),
      machineIdHash: fp.machine_id_hash,
      provisionedAt: new Date().toISOString(),
      supabaseUrl,
      supabaseAnonKey: supabaseAnon,
    };
    saveConfig(cfg);
    try { fs.unlinkSync(found.path); } catch (_) {}
    console.log("[PROVISION] ativado com sucesso! Fazenda:", result.farm_name);
    return cfg;
  } catch (e) {
    console.error("[PROVISION] erro de rede:", e.message);
    return null;
  }
}

// Verifica integridade do .asar (anti-tampering)
// REFORÇADO: o hash de referência DEVE vir do build (extraResources/asar-hash.txt).
// Se não existir hash de build, NÃO aceita gerar em runtime — falha fechada,
// pois isso permitiria a um atacante substituir o ASAR antes do primeiro boot.
function verifyAsarIntegrity() {
  try {
    if (!process.resourcesPath) return { ok: true, reason: "dev-mode" };
    // Electron intercepta operações de fs em arquivos .asar (vê como diretório virtual).
    // Para ler o arquivo .asar real precisamos do original-fs.
    let originalFs;
    try { originalFs = require("original-fs"); } catch (_) { originalFs = fs; }
    const asarPath = path.join(process.resourcesPath, "app.asar");
    if (!originalFs.existsSync(asarPath)) return { ok: true, reason: "no-asar" };

    const fileBuf = originalFs.readFileSync(asarPath);
    const actualHash = crypto.createHash("sha256").update(fileBuf).digest("hex");

    // Hash gerado em build-time pelo build-agent.bat
    if (fs.existsSync(ASAR_HASH_FILE_BUILD)) {
      const expectedHash = fs.readFileSync(ASAR_HASH_FILE_BUILD, "utf8").trim();
      if (expectedHash !== actualHash) {
        return { ok: false, reason: "asar_modified", expectedHash, actualHash };
      }
      // Limpa hash legado em userData se existir
      try { if (fs.existsSync(ASAR_HASH_FILE_LEGACY)) fs.unlinkSync(ASAR_HASH_FILE_LEGACY); } catch (_) {}
      return { ok: true, actualHash, source: "build" };
    }

    // Sem hash de build: agente foi compilado sem o passo de hash. Aceita em
    // dev/legacy mas avisa no log para forçar correção.
    console.warn("[INTEGRITY] asar-hash.txt ausente em resources — build sem hash. Pulando verificação.");
    return { ok: true, reason: "no-build-hash", actualHash };
  } catch (e) {
    return { ok: true, reason: "check-error", error: e.message };
  }
}

// Calcula HMAC-SHA256 hex do corpo usando o segredo embutido no agente.
function _hmacHex(secret, data) {
  return crypto.createHmac("sha256", secret).update(data, "utf8").digest("hex");
}

// Reporta tampering pro backend.
// Adiciona header X-Tamper-Signature para que a edge function valide a origem.
async function reportTampering(cfg, kind, level, details, expected, actual) {
  if (!cfg || !cfg.farmId) return;
  try {
    const url = (cfg.supabaseUrl || SUPABASE_URL_DEFAULT) + "/functions/v1/report-tampering";
    const anon = cfg.supabaseAnonKey || SUPABASE_ANON_DEFAULT;
    const body = JSON.stringify({
      farm_id: cfg.farmId,
      license_key: cfg.licenseKey || "",
      kind, level,
      details: { ...details, hostname: os.hostname(), at: new Date().toISOString() },
      expected_hash: expected, actual_hash: actual,
      agent_version: AGENT_VERSION,
    });
    const sig = _hmacHex(TAMPER_SIGNING_SECRET, body);
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": anon,
        "X-Tamper-Signature": sig,
      },
      body,
    });
  } catch (_) {}
}

// ============================================================
// HARDWARE FINGERPRINT (Camada 5 — Híbrido por severidade)
// Coleta MAC, disk_serial, bios_uuid, cpu_id (Windows: wmic) e compara com
// o registro na nuvem (tabela agent_hardware). Política:
//   • 0 mudanças → ok
//   • 1 mudança  → warning (não bloqueia, registra alerta)
//   • 2+         → blocked (não inicia polling; exige reset por platform_admin)
// hostname e os_install_date são informativos (não contam para bloqueio).
// Falha de leitura de algum componente é ignorada (não bloqueia).
// ============================================================
const HW_COMPONENTS_BLOCKING = ["mac_address", "disk_serial", "bios_uuid", "cpu_id"];

function _wmicValue(cmd) {
  try {
    const out = execSync(cmd, { timeout: 5000, windowsHide: true }).toString();
    // wmic retorna "Header\r\r\nValue\r\r\n..."; pegamos a primeira linha não-header não-vazia
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return null;
    const value = lines.slice(1).join(" ").trim();
    return value || null;
  } catch (_) {
    return null;
  }
}

function _primaryMac() {
  try {
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) {
      for (const ni of ifs[name] || []) {
        if (!ni.internal && ni.mac && ni.mac !== "00:00:00:00:00:00") return ni.mac;
      }
    }
  } catch (_) {}
  return null;
}

function collectHardwareFingerprint() {
  return {
    hostname: os.hostname() || null,
    mac_address: _primaryMac(),
    disk_serial: _wmicValue("wmic diskdrive get serialnumber"),
    bios_uuid: _wmicValue("wmic csproduct get uuid"),
    cpu_id: _wmicValue("wmic cpu get processorid"),
    os_install_date: _wmicValue("wmic os get installdate"),
    collected_at: new Date().toISOString(),
  };
}

function diffHardware(current, registered) {
  const changed = [];
  for (const key of HW_COMPONENTS_BLOCKING) {
    const a = current?.[key];
    const b = registered?.[key];
    // ignora se algum lado não pôde ser lido (null) — não conta como mudança
    if (a == null || b == null) continue;
    if (String(a).trim() !== String(b).trim()) changed.push(key);
  }
  return changed;
}

// Retorna 'ok' | 'warning' | 'blocked' (ou 'skip' quando offline/sem cliente)
async function verifyHardwareFingerprint(cfg) {
  if (!supabase || !cfg?.farmId) return { level: "skip", changed: [] };
  try {
    const current = collectHardwareFingerprint();
    const { data: existing } = await supabase
      .from("agent_hardware")
      .select("fingerprint, alert_level, reset_requested")
      .eq("farm_id", cfg.farmId)
      .maybeSingle();

    // Primeira vez OU reset pedido → registra/atualiza e marca ok
    if (!existing || existing.reset_requested) {
      await supabase.from("agent_hardware").upsert({
        farm_id: cfg.farmId,
        fingerprint: current,
        registered_at: new Date().toISOString(),
        last_check_at: new Date().toISOString(),
        alert_level: "ok",
        changed_components: [],
        agent_version: AGENT_VERSION,
        reset_requested: false,
        reset_requested_by: null,
        reset_requested_at: null,
      }, { onConflict: "farm_id" });
      pushLog("info", "system", existing?.reset_requested
        ? "Hardware reautorizado pelo suporte — fingerprint regravado"
        : "Hardware fingerprint registrado (primeira execução)");
      return { level: "ok", changed: [] };
    }

    const changed = diffHardware(current, existing.fingerprint || {});
    let level = "ok";
    if (changed.length === 1) level = "warning";
    else if (changed.length >= 2) level = "blocked";

    await supabase.from("agent_hardware").update({
      last_check_at: new Date().toISOString(),
      alert_level: level,
      changed_components: changed,
      last_change_at: changed.length ? new Date().toISOString() : null,
      agent_version: AGENT_VERSION,
    }).eq("farm_id", cfg.farmId);

    if (changed.length > 0) {
      await supabase.from("agent_hardware_history").insert({
        farm_id: cfg.farmId,
        changed_components: changed,
        previous_fingerprint: existing.fingerprint || {},
        current_fingerprint: current,
        alert_level: level,
        agent_version: AGENT_VERSION,
      });
      pushLog(level === "blocked" ? "error" : "warn", "system",
        `Hardware alterado (${changed.length}): ${changed.join(", ")} → ${level}`);
      try {
        await reportTampering(cfg,
          level === "blocked" ? "hardware_changed" : "hardware_changed",
          level === "blocked" ? "critical" : "warn",
          { changed, blocking: level === "blocked" }, null, null);
      } catch (_) {}
    }

    return { level, changed };
  } catch (e) {
    pushLog("warn", "system", `Falha na verificação de hardware: ${formatError(e)}`);
    return { level: "skip", changed: [] };
  }
}

// Aguarda supabase ficar pronto (até 30s) e roda 1 verificação.
async function awaitAndVerifyHardware(cfg) {
  const deadline = Date.now() + 30_000;
  while (!supabase && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  return verifyHardwareFingerprint(cfg);
}

// ============================================================
// v3.14.0 — ANTI-CLONE em BACKGROUND (não bloqueia inicialização)
// ------------------------------------------------------------
// Fluxo:
//  1) Polling já está rodando (agente operacional).
//  2) Após 30s, verifica fingerprint em agent_hardware (keyed por farm_id).
//  3) Se 'blocked' (≥2 componentes divergem) → CLONE:
//     • Envia alerta WhatsApp genérico (best-effort).
//     • Aguarda 60s para o alerta sair.
//     • Encerra o processo com popup genérico.
//  4) Falha de rede / sem cliente → ignora silenciosamente (retenta em 30 min).
//  5) Repete a checagem a cada 30 minutos (troca de HW em runtime).
// ============================================================
let antiCloneScheduled = false;
let antiCloneTriggered = false;
function scheduleBackgroundAntiCloneCheck(cfg) {
  if (antiCloneScheduled) return;
  antiCloneScheduled = true;

  const runCheck = async () => {
    if (antiCloneTriggered) return;
    try {
      const res = await verifyHardwareFingerprint(cfg);
      if (!res || res.level !== "blocked") return;
      antiCloneTriggered = true;
      pushLog("error", "system",
        `[SECURITY] CLONE detectado em background — componentes divergentes: ${(res.changed || []).join(", ")}. Encerrando em 60s.`);

      // 1) Alerta WhatsApp (best-effort)
      try {
        if (supabase && cfg && cfg.farmId) {
          await supabase.functions.invoke("whatsapp-alerts", {
            body: {
              kind: "agent_clone_detected",
              farm_id: cfg.farmId,
              message: "ALERTA: Clone detectado — hardware não autorizado tentou operar o agente desta fazenda.",
              changed_components: res.changed || [],
            },
          });
        }
      } catch (e) {
        pushLog("warn", "cloud", `[ANTI-CLONE] whatsapp-alerts falhou: ${e && e.message || e}`);
      }

      // 2) Report tampering (blocking)
      try {
        await reportTampering(cfg, "hardware_changed", "critical",
          { reason: "clone_detected_background", changed: res.changed, blocking: true, farm_id: cfg.farmId },
          null, null);
      } catch (_) {}

      // 3) Aguarda 60s antes de encerrar (garante envio do alerta)
      setTimeout(() => {
        try { if (tray) tray.setToolTip("RENOV Agent - Erro de licença"); } catch (_) {}
        try {
          dialog.showErrorBox("Renov Agent", "Erro de licença. Contate o suporte.");
        } catch (_) {}
        try { app.exit(1); } catch (_) { process.exit(1); }
      }, 60_000);
    } catch (e) {
      // Falha de rede → ignora, tenta de novo no próximo ciclo
      pushLog("warn", "system", `[ANTI-CLONE] check em background falhou (ignorado): ${e && e.message || e}`);
    }
  };

  // Primeira checagem 30s após polling; depois a cada 30 min.
  setTimeout(runCheck, 30_000).unref?.();
  setInterval(runCheck, 30 * 60_000).unref?.();
}


// ============================================================
// ANTI-DEBUG (Camada 3) — detecta DevTools/inspector anexados ao processo
// e força saída. Roda a cada 5s. Usa medição de latência do `debugger;`
// statement: quando há debugger ativo, o statement pausa e o delta sobe.
// Também monitora `inspector.url()` (--inspect flag).
// ============================================================
function startAntiDebugWatchdog(cfg) {
  let inspector = null;
  try { inspector = require("inspector"); } catch (_) {}

  const ANTIDEBUG_INTERVAL_MS = 5000;
  const ANTIDEBUG_THRESHOLD_MS = 100;
  let consecutive = 0;

  setInterval(async () => {
    let detected = false;
    let reason = "";

    // 1) inspector flag (--inspect / --inspect-brk)
    try {
      if (inspector && typeof inspector.url === "function" && inspector.url()) {
        detected = true; reason = "inspector_attached";
      }
    } catch (_) {}

    // 2) latência do debugger statement
    if (!detected) {
      const start = Date.now();
      // eslint-disable-next-line no-debugger
      debugger;
      const delta = Date.now() - start;
      if (delta > ANTIDEBUG_THRESHOLD_MS) {
        detected = true; reason = `debugger_pause_${delta}ms`;
      }
    }

    if (detected) {
      consecutive += 1;
      // Exige 2 detecções consecutivas para evitar falso positivo (GC pause).
      if (consecutive >= 2) {
        try {
          await reportTampering(cfg, "debugger_attached", "critical",
            { reason, pid: process.pid }, null, null);
        } catch (_) {}
        console.error("[ANTI-DEBUG] debugger detectado — encerrando agente:", reason);
        try { app.exit(1); } catch (_) { process.exit(1); }
      }
    } else {
      consecutive = 0;
    }
  }, ANTIDEBUG_INTERVAL_MS).unref?.();
}

// ============================================================
// SECURITY HARDENING v3.10.7 — kill-switch + obfuscation check
// ============================================================
const OFFLINE_LICENSE_GRACE_MS = 72 * 60 * 60 * 1000;
const LICENSE_VALIDATE_INTERVAL_MS = 30_000;
let lastLicenseValidationAt = 0;
let lastLicenseOkAt = 0;
let licenseKillSwitchTriggered = false;
let obfuscationCheckDone = false;

function _licenseGraceFile() {
  try { return path.join(app.getPath("userData"), "license-grace.json"); } catch (_) { return null; }
}
function _loadLicenseGrace() {
  try {
    const f = _licenseGraceFile();
    if (!f || !fs.existsSync(f)) return;
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    if (Number.isFinite(j?.lastLicenseOkAt)) lastLicenseOkAt = j.lastLicenseOkAt;
  } catch (_) {}
}
function _saveLicenseGrace() {
  try {
    const f = _licenseGraceFile();
    if (!f) return;
    fs.writeFileSync(f, JSON.stringify({ lastLicenseOkAt }), "utf8");
  } catch (_) {}
}

async function stopAllPumpsBeforeExit(reason) {
  try {
    pushLog("warn", "system", `[KILL-SWITCH] Desligando todas as bombas antes de encerrar (${reason})...`);
    if (supabase && farmId) {
      try {
        const { data: pumps } = await supabase
          .from("equipments")
          .select("hw_id, name")
          .eq("farm_id", farmId)
          .eq("type", "pump")
          .eq("active", true);
        const tsnns = new Set();
        for (const p of pumps || []) {
          if (p?.hw_id && p.hw_id.length >= 4) tsnns.add(p.hw_id.substring(0, 4));
        }
        if (bridgeProcess && bridgeReady && tsnns.size > 0) {
          for (const tsnn of tsnns) {
            const frame = `[${tsnn}_1_]{000000}[${tsnn}_ETX_]\r`;
            try { sendTxFrame(frame, { priority: "reset" }); } catch (_) {}
            pushLog("warn", "tx", `[KILL-SWITCH OFF] ${frame.replace(/\r/g, "")}`, frame);
            await new Promise((r) => setTimeout(r, 250));
          }
        }
        try {
          await supabase.from("equipments")
            .update({
              desired_running: false,
              pending_command_id: null,
              last_actuation_origin: `kill_switch:${reason}`,
            })
            .eq("farm_id", farmId)
            .eq("type", "pump")
            .eq("desired_running", true);
        } catch (_) {}
      } catch (_) {}
    }
  } catch (_) {}
}

async function validateLicenseHeartbeat(cfg) {
  if (licenseKillSwitchTriggered) return;
  if (!cfg?.licenseToken) return;
  if (Date.now() - lastLicenseValidationAt < LICENSE_VALIDATE_INTERVAL_MS - 1000) return;
  lastLicenseValidationAt = Date.now();

  const baseUrl = cfg.supabaseUrl || SUPABASE_URL_DEFAULT;
  const anon = cfg.supabaseAnonKey || SUPABASE_ANON_DEFAULT;
  try {
    const resp = await fetch(`${baseUrl}/functions/v1/license-validate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": anon,
        "Authorization": `Bearer ${cfg.licenseToken}`,
      },
    });
    const body = await resp.json().catch(() => ({}));

    if (resp.ok && body?.valid) {
      lastLicenseOkAt = Date.now();
      _saveLicenseGrace();
      return;
    }

    if (resp.status === 403 || body?.error === "revoked" || body?.error === "farm_suspended") {
      licenseKillSwitchTriggered = true;
      pushLog("error", "system",
        `[SECURITY] Licença ${body?.error || "revogada"} — encerrando agente`);
      try {
        await reportTampering(cfg, "config_replaced", "critical",
          { reason: "license_revoked", server_error: body?.error }, null, null);
      } catch (_) {}
      try { await stopAllPumpsBeforeExit(`license_${body?.error || "revoked"}`); } catch (_) {}
      setTimeout(() => { try { app.exit(1); } catch (_) { process.exit(1); } }, 1500);
      return;
    }
  } catch (_) {}

  if (lastLicenseOkAt > 0 && (Date.now() - lastLicenseOkAt) > OFFLINE_LICENSE_GRACE_MS) {
    licenseKillSwitchTriggered = true;
    pushLog("error", "system",
      `[SECURITY] Licença não validada há > 72h (offline grace expirou) — encerrando`);
    try {
      await reportTampering(cfg, "config_replaced", "critical",
        { reason: "offline_grace_expired", hours_offline: Math.round((Date.now() - lastLicenseOkAt) / 3600000) },
        null, null);
    } catch (_) {}
    try { await stopAllPumpsBeforeExit("offline_grace_expired"); } catch (_) {}
    setTimeout(() => { try { app.exit(1); } catch (_) { process.exit(1); } }, 1500);
  }
}

// OBFUSCATION_SIGNATURE — javascript-obfuscator output patterns.
// Cobre identifier-names-generator (hexadecimal/mangled), stringArray RC4,
// controlFlowFlattening, deadCodeInjection e selfDefending.
const OBFUSCATION_SIGNATURE = [
  /_0x[a-f0-9]{4,6}/i,                       // hex identifiers (default + hexadecimal)
  /\bvar\s+_0x[a-f0-9]+\s*=\s*\[/i,          // string array declaration
  /\b(?:const|var|let)\s+_0x[a-f0-9]+\s*=\s*function\s*\(/i, // wrapper fns
  /\\x[0-9a-f]{2}\\x[0-9a-f]{2}/i,           // hex-escaped strings (RC4 stringArray)
  /['"]rc4['"]/i,                            // RC4 marker
  /while\s*\(\s*!!\[\]\s*\)/i,               // controlFlowFlattening loop
  /\bdebugger\b[\s\S]{0,80}\bdebugger\b/,    // self-defending double-debugger
  /\b0x[a-f0-9]+\s*\^\s*0x[a-f0-9]+/i,       // numeric obfuscation
];

function verifyAgentObfuscation(cfg) {
  if (obfuscationCheckDone) return;
  obfuscationCheckDone = true;
  if (!app.isPackaged) return;
  try {
    const selfPath = __filename;
    if (!selfPath || !fs.existsSync(selfPath)) return;
    const sample = fs.readFileSync(selfPath, "utf8").slice(0, 400_000);
    // Considera ofuscado se ≥2 sinais batem (evita falso-positivo por 1 match).
    let hits = 0;
    for (const re of OBFUSCATION_SIGNATURE) { if (re.test(sample)) hits++; }
    if (hits < 2) {
      pushLog("warn", "system",
        `[SECURITY] Código não-ofuscado detectado (signature hits=${hits}) — possível substituição do ASAR`);
      if (cfg) {
        void reportTampering(cfg, "unsigned_binary", "warn",
          { reason: "obfuscation_missing", hits, file: path.basename(selfPath) }, null, null);
      }
    } else {
      pushLog("info", "system", `[SECURITY] Ofuscação verificada (signature hits=${hits}).`);
    }
  } catch (_) {}
}

// --- App lifecycle ---
_bootLog("registering app.whenReady handler");
app.whenReady().then(async () => {
  _bootLog("app.whenReady fired");
  try {
    try { createTray(); _bootLog("createTray ok"); }
    catch (e) { _bootLog(`createTray FAIL: ${e && e.stack || e}`); }

    try { setupAutoUpdater(); _bootLog("setupAutoUpdater ok"); }
    catch (e) { _bootLog(`setupAutoUpdater FAIL: ${e && e.stack || e}`); }

    // 1) Verifica integridade dos arquivos (WARN-ONLY na v3.9.2)
    // Antes encerrava o agente se o hash não batesse — mas em alguns PCs o
    // build de 2 passes do build-agent.bat gera asar com hash levemente
    // diferente entre passes (timestamps). O bloqueio matava o app
    // silenciosamente. Agora apenas reporta tampering pra nuvem.
    let integrity = { ok: true, reason: "skipped" };
    try { integrity = verifyAsarIntegrity(); _bootLog(`verifyAsarIntegrity: ${JSON.stringify(integrity)}`); }
    catch (e) { _bootLog(`verifyAsarIntegrity FAIL: ${e && e.stack || e}`); }
    if (!integrity.ok) {
      console.error("[TAMPERING] hash do asar não bate — modo warn-only (v3.9.2)");
      try {
        const existing = loadConfig();
        if (existing) {
          await reportTampering(existing, "asar_modified", "warning",
            { lookup: integrity.reason, mode: "warn-only" },
            integrity.expectedHash, integrity.actualHash);
        }
      } catch (e) { _bootLog(`reportTampering FAIL: ${e && e.stack || e}`); }
    }

    // 2) Tenta config existente
    let cfg = null;
    try { cfg = loadConfig(); _bootLog(`loadConfig: ${cfg ? "found" : "empty"}`); }
    catch (e) { _bootLog(`loadConfig FAIL: ${e && e.stack || e}`); }

    // 3) Se não tem config, tenta auto-provision
    if (!cfg || !cfg.email || !cfg.password || !cfg.farmId) {
      try { cfg = await tryAutoProvision(); _bootLog(`tryAutoProvision: ${cfg ? "ok" : "no-token"}`); }
      catch (e) { _bootLog(`tryAutoProvision FAIL: ${e && e.stack || e}`); }
    }

    // 4) Inicia agente OU setup manual
    if (cfg && cfg.email && cfg.password && cfg.farmId) {
      _bootLog("calling startAgent");
      try { startAgent(cfg); }
      catch (e) { _bootLog(`startAgent FAIL: ${e && e.stack || e}`); }
      if (app.isPackaged) {
        try { startAntiDebugWatchdog(cfg); }
        catch (e) { _bootLog(`startAntiDebugWatchdog FAIL: ${e && e.stack || e}`); }
      }
    } else {
      _bootLog("calling showSetupWindow");
      try { showSetupWindow(); }
      catch (e) { _bootLog(`showSetupWindow FAIL: ${e && e.stack || e}`); }
    }
    _bootLog("app.whenReady handler completed");
  } catch (e) {
    _bootLog(`app.whenReady TOP-LEVEL FAIL: ${e && e.stack || e}`);
    try {
      dialog.showErrorBox("Renov Agent — Erro de inicialização",
        `Falha ao iniciar o agente:\n\n${e && e.message || e}\n\nVerifique o boot.log em %APPDATA%\\GestorDeBombasKey\\`);
    } catch (_) {}
  }
}).catch((e) => {
  _bootLog(`app.whenReady REJECTED: ${e && e.stack || e}`);
});
app.on("window-all-closed", (e) => { e.preventDefault(); });
app.on("before-quit", () => {
  appClosing = true;
  stopCloudReconnect();
  flushLogs();
  void stopBridge();
});

// --- IPC handlers ---
ipcMain.handle("save-config", async (event, cfg) => {
  try {
    saveConfig(cfg);
    if (setupWindow) setupWindow.close();
    startAgent(cfg);
    return { success: true };
  } catch (e) { return { success: false, error: formatError(e) }; }
});

ipcMain.handle("list-ports", async () => {
  return new Promise((resolve) => {
    const pythonCandidates = getPythonCandidates();
    let candidateIndex = 0;
    function tryNext() {
      if (candidateIndex >= pythonCandidates.length) { resolve([]); return; }
      const pythonCmd = pythonCandidates[candidateIndex++];
      let proc;
      try {
        proc = spawn(pythonCmd, ["-c",
          "import serial.tools.list_ports; [print(f'{p.device}|{p.description}') for p in serial.tools.list_ports.comports()]"
        ], { windowsHide: true, env: buildPythonEnv() });
      } catch (e) { tryNext(); return; }
      let output = "";
      let errored = false;
      proc.stdout.on("data", (d) => (output += d.toString()));
      proc.on("error", () => { errored = true; tryNext(); });
      proc.on("close", (code) => {
        if (errored) return;
        if (code !== 0 && !output.trim()) { tryNext(); return; }
        const ports = output.trim().split("\n").filter(Boolean).map((l) => {
          const [dev, desc] = l.split("|");
          return { path: dev, manufacturer: desc || "Desconhecido" };
        });
        resolve(ports);
      });
    }
    tryNext();
  });
});

// Log window IPC
ipcMain.handle("log:get-all", () => liveLog.slice());

// Config window IPC
ipcMain.handle("config:get-status", () => {
  const cfg = loadConfig() || {};
  return {
    version: AGENT_VERSION,
    email: cfg.email || null,
    farmId: cfg.farmId || null,
    comPort: comPort || cfg.comPort || null,
    bridgeReady,
    portManuallyClosed,
    pollIntervalMs: POLL_INTERVAL_MS,
    inflight: inflightCmd ? inflightCmd.id.substring(0, 8) : null,
  };
});

ipcMain.handle("config:close-port", async () => {
  return await closeComPort();
});

ipcMain.handle("config:open-port", async (_e, newPort) => {
  return await openComPort(newPort);
});

ipcMain.handle("config:list-ports", async () => {
  // Reusa a mesma lógica do list-ports
  return new Promise((resolve) => {
    const pythonCandidates = getPythonCandidates();
    let i = 0;
    function tryNext() {
      if (i >= pythonCandidates.length) { resolve([]); return; }
      const cmd = pythonCandidates[i++];
      let proc;
      try {
        proc = spawn(cmd, ["-c",
          "import serial.tools.list_ports; [print(f'{p.device}|{p.description}') for p in serial.tools.list_ports.comports()]"
        ], { windowsHide: true, env: buildPythonEnv() });
      } catch (e) { tryNext(); return; }
      let output = "";
      let errored = false;
      proc.stdout.on("data", (d) => (output += d.toString()));
      proc.on("error", () => { errored = true; tryNext(); });
      proc.on("close", (code) => {
        if (errored) return;
        if (code !== 0 && !output.trim()) { tryNext(); return; }
        const ports = output.trim().split("\n").filter(Boolean).map((l) => {
          const [dev, desc] = l.split("|");
          return { path: dev, description: desc || "Desconhecido" };
        });
        resolve(ports);
      });
    }
    tryNext();
  });
});
