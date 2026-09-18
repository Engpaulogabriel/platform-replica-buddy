// ─────────────────────────────────────────────────────────────────────────────
// Centro de Evidências Técnicas — lado Agent. FASE 2: módulo PURO.
// ─────────────────────────────────────────────────────────────────────────────
// NÃO está ligado ao main.cjs. Nada aqui é chamado ainda — a instrumentação do
// loop é passo separado, com autorização própria, porque mexer no laço serial é
// exatamente onde o risco operacional mora.
//
// REGRA ABSOLUTA: auditoria é best-effort. Nenhuma função deste arquivo lança,
// bloqueia, faz I/O síncrono no caminho crítico ou toca em desired_running,
// pending_command_id, comandos ou automação.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ── HISTERESE ───────────────────────────────────────────────────────────────
// Uma falha isolada NÃO é queda. Sem histerese, um timeout de 1s vira
// "internet_offline" e a trilha forense fica cheia de falso positivo — o mesmo
// erro que já produziu falso alerta de falta de energia neste sistema.
const DEFAULTS = Object.freeze({
  failuresToOffline: 3,   // falhas consecutivas para declarar queda
  successesToOnline: 2,   // sucessos consecutivos para declarar retorno
  highLatencyMs: 3000,    // acima disso, latência elevada
  latencySamples: 3,      // amostras consecutivas para declarar/limpar
  probeIntervalMs: 60000, // cadência: 60s por fazenda ~ 1440 probes/dia
});

/**
 * Estado do monitor. `cloud` e `extern` são os dois alvos:
 *   cloud  = endpoint da própria RENOV/Supabase
 *   extern = endpoint externo independente
 * É a COMBINAÇÃO dos dois que distingue "a internet caiu" de "a nossa nuvem
 * caiu" — com um alvo só isso é indistinguível, que é o buraco de hoje.
 */
function createMonitor(opts) {
  const cfg = Object.assign({}, DEFAULTS, opts || {});
  return {
    cfg,
    cloudFail: 0, cloudOk: 0, externFail: 0, externOk: 0,
    latHigh: 0, latOk: 0,
    state: "unknown",        // unknown | online | internet_offline | cloud_unreachable
    latencyState: "normal",  // normal | high
    offlineSince: null,
    correlationId: null,
  };
}

const uuid = () => crypto.randomUUID();

/**
 * Aplica uma rodada de sondagem e devolve os eventos a registrar.
 * `probe` = { cloud: {ok, latencyMs, httpStatus, errorClass}, extern: {...} }
 *
 * Só devolve evento em TRANSIÇÃO. Sondagem normal não gera linha — é o que
 * impede a trilha de virar ruído (heartbeat OK a cada minuto explodiria volume
 * e destruiria a utilidade forense).
 */
function applyProbe(m, probe, nowMs) {
  const out = [];
  const c = probe && probe.cloud ? probe.cloud : { ok: false };
  const x = probe && probe.extern ? probe.extern : { ok: false };

  // DNS é classe própria: falha de resolução não é "internet caiu". Tratar
  // tudo como offline apagaria a distinção que o cliente precisa enxergar.
  const dnsFail = (c.errorClass === "dns" || x.errorClass === "dns");

  m.cloudFail  = c.ok ? 0 : m.cloudFail + 1;
  m.cloudOk    = c.ok ? m.cloudOk + 1 : 0;
  m.externFail = x.ok ? 0 : m.externFail + 1;
  m.externOk   = x.ok ? m.externOk + 1 : 0;

  const F = m.cfg.failuresToOffline, S = m.cfg.successesToOnline;
  const push = (type, severity, payload) => {
    if (!m.correlationId) m.correlationId = uuid();
    out.push({
      clientEventId: uuid(), eventType: type,
      category: type.startsWith("dns") ? "internet"
              : type.startsWith("cloud") ? "cloud" : "internet",
      severity, origin: "agent", occurredAt: new Date(nowMs).toISOString(),
      correlationId: m.correlationId,
      payload: Object.assign({
        consecutive_failures: Math.max(m.cloudFail, m.externFail),
      }, payload || {}),
    });
  };

  // AMBOS falharam → a internet da fazenda caiu.
  if (m.externFail >= F && m.cloudFail >= F && m.state !== "internet_offline") {
    m.state = "internet_offline"; m.offlineSince = nowMs;
    push(dnsFail ? "dns_failure" : "internet_offline", "critical",
      { endpoint: "both", error_class: dnsFail ? "dns" : (c.errorClass || x.errorClass || "network") });
  }
  // Externo OK e nuvem falhando → o problema é NOSSO, não do cliente.
  else if (m.externOk >= S && m.cloudFail >= F && m.state !== "cloud_unreachable") {
    m.state = "cloud_unreachable"; m.offlineSince = m.offlineSince || nowMs;
    push("cloud_unreachable", "error",
      { endpoint: "cloud", http_status: c.httpStatus ?? null, error_class: c.errorClass || "network" });
  }
  // Tudo voltou.
  else if (m.cloudOk >= S && m.externOk >= S &&
           (m.state === "internet_offline" || m.state === "cloud_unreachable")) {
    const dur = m.offlineSince ? Math.round((nowMs - m.offlineSince) / 1000) : null;
    push(m.state === "cloud_unreachable" ? "cloud_restored" : "internet_restored", "info",
      { duration_seconds: dur, latency_ms: c.latencyMs ?? null });
    m.state = "online"; m.offlineSince = null; m.correlationId = null;  // incidente fechado
  }
  else if (m.state === "unknown" && m.cloudOk >= S && m.externOk >= S) {
    m.state = "online";
  }

  // Latência elevada é evento próprio, independente do estado de queda.
  if (m.state === "online" && c.ok && typeof c.latencyMs === "number") {
    const alta = c.latencyMs >= m.cfg.highLatencyMs;
    m.latHigh = alta ? m.latHigh + 1 : 0;
    m.latOk   = alta ? 0 : m.latOk + 1;
    if (m.latHigh >= m.cfg.latencySamples && m.latencyState !== "high") {
      m.latencyState = "high";
      push("high_latency", "warning", { latency_ms: c.latencyMs, endpoint: "cloud" });
    } else if (m.latOk >= m.cfg.latencySamples && m.latencyState === "high") {
      m.latencyState = "normal";
      push("latency_recovered", "info", { latency_ms: c.latencyMs, endpoint: "cloud" });
    }
  }
  return out;
}

// ── BUFFER LOCAL DURÁVEL ────────────────────────────────────────────────────
// Sem buffer, o evento "internet_offline" nunca chega: no instante em que ele
// acontece, não há rede para enviá-lo. O arquivo é NDJSON append-only — resiste
// a restart do agente e a reboot da máquina, e um append truncado por queda de
// energia perde no máximo a última linha (as anteriores continuam legíveis).
const MAX_LINES = 5000;

function bufferAppend(file, ev) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(ev) + "\n");
    return true;
  } catch { return false; }   // best-effort: nunca lança
}

/** Lê preservando ORDEM e occurred_at originais. Linha corrompida é pulada. */
function bufferRead(file) {
  try {
    const txt = fs.readFileSync(file, "utf8");
    const out = [];
    for (const l of txt.split("\n")) {
      const t = l.trim(); if (!t) continue;
      try { out.push(JSON.parse(t)); } catch { /* linha truncada: ignora */ }
    }
    return out;
  } catch { return []; }
}

/** Remove os já confirmados. Dedup por clientEventId — retry não duplica. */
function bufferDrop(file, enviadosIds) {
  try {
    const ids = new Set(enviadosIds);
    const restantes = bufferRead(file).filter((e) => !ids.has(e.clientEventId));
    const corte = restantes.slice(-MAX_LINES);   // teto: nunca cresce sem limite
    fs.writeFileSync(file, corte.map((e) => JSON.stringify(e)).join("\n") + (corte.length ? "\n" : ""));
    return true;
  } catch { return false; }
}

module.exports = { DEFAULTS, createMonitor, applyProbe,
                   bufferAppend, bufferRead, bufferDrop, MAX_LINES };
