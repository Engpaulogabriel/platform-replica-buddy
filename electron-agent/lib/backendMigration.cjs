// ─────────────────────────────────────────────────────────────────────────────
// Migração de backend — PARTE 1: módulo PURO.
// ─────────────────────────────────────────────────────────────────────────────
// NÃO está ligado ao main.cjs. Nenhuma linha do arquivo operacional foi tocada.
// Aqui vive toda a DECISÃO (schema do config, validação de payload, promoção,
// rollback, anti-lockout, idempotência); o wiring — ler comando, chamar rede,
// gravar credentials.enc, reiniciar — é passo separado e autorizado à parte.
//
// REGRA ABSOLUTA: nada aqui toca serial, rádio, polling, filas, comandos
// físicos, segurança elétrica ou watchdog. Backend é assunto de NUVEM; a
// operação local segue idêntica mesmo com a nuvem inteira fora.
"use strict";

const ESTADOS = Object.freeze({
  IDLE: "idle", VALIDATING: "validating", PROMOTED: "promoted",
  COMMITTED: "committed",
  ROLLBACK_PENDING: "rollback_pending", ROLLED_BACK: "rolled_back", FAILED: "failed",
});

const PADROES = Object.freeze({
  validationTimeoutMs: 15000,
  rollbackAfterFailures: 5,   // falhas CRÍTICAS de nuvem consecutivas
  // ── JANELA DE VALIDAÇÃO ──────────────────────────────────────────────────
  // Depois deste tempo desde a promoção, a migração é considerada COMMITTED e
  // NENHUMA falha de nuvem pode mais trocar de backend sozinha. Ver comentário
  // extenso em noteOutcome.
  validationWindowMs: 30 * 60 * 1000,   // 30 min
  // Atalho: tantos sucessos consecutivos de nuvem já provam a migração antes
  // de a janela fechar. ~10 s por ciclo de polling ⇒ ~3 min de saúde contínua.
  commitAfterHealthySuccesses: 20,
});

// ── 1) CONFIG: migração de schema sem quebrar instalação antiga ─────────────
/**
 * Um credentials.enc de hoje tem só `supabaseUrl`/`supabaseAnonKey`. Depois do
 * OTA ele precisa continuar carregando — e o backend em uso não pode mudar.
 * Por isso a promoção do schema é SEMPRE para PRIMARY = o que já estava lá.
 * Nada muda operacionalmente ao instalar esta versão.
 */
function ensureBackendConfig(cfg) {
  const base = cfg && typeof cfg === "object" ? cfg : {};
  if (base.backendConfig && base.backendConfig.primaryUrl) return base;

  const url = base.supabaseUrl || null;
  const anon = base.supabaseAnonKey || null;
  return Object.assign({}, base, {
    backendConfig: {
      primaryUrl: url, primaryAnonKey: anon,
      // FALLBACK nasce igual ao PRIMARY: nunca existe config sem endpoint
      // recuperável, nem por um instante.
      fallbackUrl: url, fallbackAnonKey: anon,
      activeBackend: "primary",
      migrationState: ESTADOS.IDLE,
      lastSwitchAt: null, lastValidationAt: null, lastMigrationId: null,
      consecutiveCloudFailures: 0,
      // Campos da janela de validação. Config antigo não os tem — e é por isso
      // que toda leitura usa `|| 0` / `|| null`: instalação legada carrega sem
      // erro e sem mudar de backend.
      committedAt: null, healthySuccesses: 0,
    },
  });
}

/** Endpoint em uso AGORA. `supabaseUrl` legado continua sendo o último recurso,
 *  para que um config corrompido no campo ainda encontre um caminho. */
function activeEndpoint(cfg) {
  const b = (cfg && cfg.backendConfig) || {};
  if (b.activeBackend === "fallback" && b.fallbackUrl) {
    return { url: b.fallbackUrl, anonKey: b.fallbackAnonKey, which: "fallback" };
  }
  if (b.primaryUrl) return { url: b.primaryUrl, anonKey: b.primaryAnonKey, which: "primary" };
  return { url: (cfg && cfg.supabaseUrl) || null,
           anonKey: (cfg && cfg.supabaseAnonKey) || null, which: "legacy" };
}

// ── 2) VALIDAÇÃO DO PAYLOAD ────────────────────────────────────────────────
const URL_OK = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i;
// O `$` final quebrava o caso `127.0.0.1`: `127\.` só casava com a string
// exata "127.". Cada padrão agora é ancorado pelo que realmente descreve.
const LOCAL = /^(localhost|0\.0\.0\.0|::1|\[::1\])$|^127\.|^10\.|^192\.168\.|^169\.254\.|\.local$/i;

/** HTTPS obrigatório e host público. Aceitar HTTP ou localhost permitiria
 *  redirecionar a frota para um endpoint controlado por terceiro. */
function validarUrl(u) {
  if (typeof u !== "string" || !URL_OK.test(u)) return "url_invalida";
  let host;
  try { host = new URL(u).hostname; } catch { return "url_invalida"; }
  if (LOCAL.test(host)) return "url_local_proibida";
  return null;
}

function validateSetBackendPayload(p) {
  const erros = [];
  const o = p && typeof p === "object" ? p : {};
  for (const campo of ["primary_url", "primary_anon_key", "migration_id"]) {
    if (!o[campo] || typeof o[campo] !== "string") erros.push(`campo_ausente:${campo}`);
  }
  if (typeof o.primary_url === "string") {
    const e = validarUrl(o.primary_url); if (e) erros.push(`primary_url:${e}`);
  }
  if (o.fallback_url != null && typeof o.fallback_url === "string") {
    const e = validarUrl(o.fallback_url); if (e) erros.push(`fallback_url:${e}`);
  }
  // Chave curta demais nunca é anon key válida — barra erro de digitação
  // antes de qualquer chamada de rede.
  if (typeof o.primary_anon_key === "string" && o.primary_anon_key.length < 40) {
    erros.push("primary_anon_key:curta_demais");
  }
  const t = Number(o.validation_timeout_ms ?? PADROES.validationTimeoutMs);
  const n = Number(o.rollback_after_failures ?? PADROES.rollbackAfterFailures);
  if (!Number.isFinite(t) || t < 2000 || t > 120000) erros.push("validation_timeout_ms:fora_de_faixa");
  if (!Number.isFinite(n) || n < 2 || n > 50) erros.push("rollback_after_failures:fora_de_faixa");

  if (erros.length) return { ok: false, errors: erros };
  return { ok: true, value: {
    primaryUrl: o.primary_url, primaryAnonKey: o.primary_anon_key,
    fallbackUrl: o.fallback_url || null, fallbackAnonKey: o.fallback_anon_key || null,
    validationTimeoutMs: t, rollbackAfterFailures: n, migrationId: o.migration_id,
  } };
}

// ── 3) DECISÃO DE PROMOÇÃO ─────────────────────────────────────────────────
/** As checagens obrigatórias. Todas precisam passar — não há maioria. */
const CHECKS = Object.freeze(["connectivity", "rest_api", "agent_auth", "license_validate", "functions"]);

/**
 * Decide se promove, a partir de um relatório de validação já executado.
 * A EXECUÇÃO das checagens é do wiring; a DECISÃO é aqui, e é testável sem rede.
 */
function decidePromotion(resultados, cfg, migrationId) {
  const b = (cfg && cfg.backendConfig) || {};

  // IDEMPOTÊNCIA: reprocessar o mesmo comando não pode alternar backend de novo.
  if (migrationId && b.lastMigrationId === migrationId && b.migrationState === ESTADOS.PROMOTED) {
    return { promote: false, reason: "migration_ja_aplicada", idempotent: true };
  }
  // Reverteu sozinho? Então este migration_id JÁ se provou ruim. Reenviar o
  // mesmo comando recriaria o ciclo novo → antigo → novo. Exige id novo.
  if (migrationId && b.lastMigrationId === migrationId &&
      (b.migrationState === ESTADOS.ROLLED_BACK || b.migrationState === ESTADOS.ROLLBACK_PENDING)) {
    return { promote: false, reason: "migration_revertida_exige_id_novo", idempotent: true };
  }
  const faltando = CHECKS.filter((c) => resultados?.[c] !== true);
  if (faltando.length) {
    return { promote: false, reason: "validacao_falhou", failed: faltando };
  }
  return { promote: true };
}

/**
 * Novo config após promoção. ANTI-LOCKOUT: o endpoint que estava ativo vira
 * FALLBACK obrigatoriamente — nunca se descarta o último backend que funcionou.
 */
function buildPromotedConfig(cfg, aprovado, agoraIso) {
  const c = ensureBackendConfig(cfg);
  const atual = activeEndpoint(c);
  if (!atual.url) return { ok: false, reason: "sem_backend_atual_para_preservar" };
  if (!aprovado.primaryUrl || !aprovado.primaryAnonKey) {
    return { ok: false, reason: "candidato_incompleto" };
  }
  return { ok: true, config: Object.assign({}, c, {
    // `supabaseUrl` legado passa a espelhar o ativo, para que qualquer caminho
    // antigo do main.cjs continue apontando para o lugar certo.
    supabaseUrl: aprovado.primaryUrl, supabaseAnonKey: aprovado.primaryAnonKey,
    backendConfig: Object.assign({}, c.backendConfig, {
      primaryUrl: aprovado.primaryUrl, primaryAnonKey: aprovado.primaryAnonKey,
      fallbackUrl: aprovado.fallbackUrl || atual.url,
      fallbackAnonKey: aprovado.fallbackAnonKey || atual.anonKey,
      activeBackend: "primary",
      migrationState: ESTADOS.PROMOTED,
      lastSwitchAt: agoraIso, lastValidationAt: agoraIso,
      lastMigrationId: aprovado.migrationId, consecutiveCloudFailures: 0,
      // Janela de validação começa AGORA. `committedAt` nulo = ainda em prova.
      committedAt: null, healthySuccesses: 0,
    }),
  }) };
}

// ── 4/5) FALLBACK ──────────────────────────────────────────────────────────
/** Falhas que JUSTIFICAM voltar de backend. Rádio e PLC NÃO estão aqui — eles
 *  são problema de campo, e trocar de nuvem por causa deles seria absurdo. */
const FALHAS_DE_NUVEM = Object.freeze(["cloud_auth", "license_validate", "api_unavailable", "cloud_network"]);

function isCloudFailure(kind) { return FALHAS_DE_NUVEM.includes(String(kind)); }

/**
 * A migração já se provou? Depois disso, trocar de backend é decisão HUMANA.
 *
 * Derivada de `lastSwitchAt`, que já era persistido na promoção — de propósito.
 * Se fosse derivada só de `committedAt`, dependeria de o wiring persistir o
 * config a cada sucesso; e um wiring que não persiste deixaria a fazenda
 * eternamente "em validação", ou seja, eternamente a 5 falhas de voltar para o
 * servidor antigo. Com `lastSwitchAt`, a proteção vale mesmo que nada novo
 * seja gravado depois da promoção.
 */
function isCommitted(cfg, nowMs) {
  const b = (cfg && cfg.backendConfig) || {};
  if (b.migrationState === ESTADOS.COMMITTED || b.committedAt) return true;
  if (b.migrationState !== ESTADOS.PROMOTED) return false;
  const t = Date.parse(b.lastSwitchAt || "");
  if (!Number.isFinite(t)) return false;
  const agora = Number.isFinite(nowMs) ? nowMs : Date.now();
  return (agora - t) >= PADROES.validationWindowMs;
}

/**
 * Contabiliza uma falha e diz se é hora de reverter. Sucesso zera o contador —
 * a mesma histerese do monitor de conectividade: só conta o que é consecutivo.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * INCIDENTE 18/09/2026 — por que existe a janela de validação
 * ─────────────────────────────────────────────────────────────────────────
 * A versão anterior mantinha o gatilho de rollback ARMADO para sempre. Uma
 * fazenda que operou 12 horas perfeitamente no backend novo voltou sozinha ao
 * antigo depois de ~1 minuto sem internet: 5 falhas `cloud_network` seguidas
 * bastaram. Nada avisou — a plataforma seguiu lendo o servidor novo e mostrou
 * a fazenda offline, enquanto o Agent gravava telemetria no servidor velho.
 *
 * Rollback automático existe para salvar uma promoção que NASCEU quebrada, não
 * para reagir a instabilidade de rede em produção. Depois que a migração se
 * prova, voltar de servidor é pior que ficar offline: gera split-brain,
 * comandos órfãos e telemetria no banco errado. Ficar offline é reversível
 * sozinho; trocar de backend em produção, não.
 *
 * Por isso: COMMITTED ⇒ nenhuma falha de nuvem reverte. O fallback continua
 * guardado no config para uma volta DELIBERADA (set_backend/rollback_backend),
 * que é decisão humana autenticada.
 */
function noteOutcome(cfg, kind, sucesso, nowMs) {
  const c = ensureBackendConfig(cfg);
  const b = c.backendConfig;
  if (b.activeBackend !== "primary" ||
      (b.migrationState !== ESTADOS.PROMOTED && b.migrationState !== ESTADOS.COMMITTED)) {
    return { config: c, rollback: false, reason: "nao_migrado" };
  }

  const agora = Number.isFinite(nowMs) ? nowMs : Date.now();
  const agoraIso = new Date(agora).toISOString();
  const committed = isCommitted(c, agora);

  // Carimba o commit na primeira vez que ele é observado, para que o estado
  // fique explícito no config e visível no diagnóstico.
  const comCommit = (extra) => Object.assign({}, c, { backendConfig:
    Object.assign({}, b, {
      migrationState: ESTADOS.COMMITTED,
      committedAt: b.committedAt || agoraIso,
      consecutiveCloudFailures: 0,
    }, extra || {}) });

  if (committed) {
    if (sucesso) return { config: comCommit(), rollback: false, committed: true };
    // FALHA DEPOIS DE COMMITTED: registra e segue no mesmo backend. Sempre.
    return { config: comCommit(), rollback: false, committed: true,
             reason: isCloudFailure(kind) ? "committed_sem_rollback_automatico"
                                          : "falha_nao_e_de_nuvem" };
  }

  // ── Ainda dentro da janela de validação ──────────────────────────────────
  if (sucesso) {
    const h = (b.healthySuccesses || 0) + 1;
    if (h >= PADROES.commitAfterHealthySuccesses) {
      return { config: comCommit({ healthySuccesses: h }), rollback: false, committed: true };
    }
    return { config: Object.assign({}, c, { backendConfig:
      Object.assign({}, b, { consecutiveCloudFailures: 0, healthySuccesses: h }) }),
      rollback: false };
  }
  if (!isCloudFailure(kind)) {
    return { config: c, rollback: false, reason: "falha_nao_e_de_nuvem" };
  }
  const n = (b.consecutiveCloudFailures || 0) + 1;
  const limite = b.rollbackAfterFailures || PADROES.rollbackAfterFailures;
  return { config: Object.assign({}, c, { backendConfig:
            Object.assign({}, b, { consecutiveCloudFailures: n }) }),
           rollback: n >= limite, failures: n, limit: limite };
}

/** Volta ao FALLBACK. Nunca apaga o que estava ativo — os dois endpoints
 *  continuam no config, só troca qual está em uso. */
function buildRollbackConfig(cfg, agoraIso, motivo) {
  const c = ensureBackendConfig(cfg);
  const b = c.backendConfig;
  if (!b.fallbackUrl || !b.fallbackAnonKey) {
    return { ok: false, reason: "sem_fallback_disponivel" };
  }
  return { ok: true, config: Object.assign({}, c, {
    supabaseUrl: b.fallbackUrl, supabaseAnonKey: b.fallbackAnonKey,
    backendConfig: Object.assign({}, b, {
      activeBackend: "fallback", migrationState: ESTADOS.ROLLED_BACK,
      lastSwitchAt: agoraIso, consecutiveCloudFailures: 0,
      committedAt: null, healthySuccesses: 0,
      rollbackReason: String(motivo || "").slice(0, 120),
    }),
  }) };
}

// ── 15) TTL DO COMANDO ─────────────────────────────────────────────────────
/**
 * `expires_at` já é filtrado nas QUERIES de `agent_commands` (catch-up e poll
 * HTTP). O caminho Realtime, porém, entrega o INSERT direto ao handler, sem
 * passar por filtro nenhum. Para um comando que troca o backend da fazenda,
 * "quase sempre filtrado" não serve — daí a checagem explícita.
 * Comando sem `expires_at` NÃO é tratado como expirado: é o comportamento
 * atual de todos os outros kinds, e mudá-lo aqui seria mudar o que não foi
 * pedido.
 */
function isAgentCommandExpired(cmd, nowMs) {
  const raw = cmd && cmd.expires_at;
  if (!raw) return false;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return false;
  return t <= (Number.isFinite(nowMs) ? nowMs : Date.now());
}

// ── 12) ESTADO APÓS REINÍCIO ───────────────────────────────────────────────
/**
 * Reconciliação fail-safe no boot. `validating` nunca é gravado pelo caminho
 * feliz justamente para não sobreviver a uma morte do processo; se ele mesmo
 * assim aparecer (gravação parcial de uma versão futura, arquivo restaurado à
 * mão), a leitura correta é "a promoção não terminou" — e o backend ativo
 * continua sendo o que já estava lá, porque a promoção só persiste no fim.
 * `rollback_pending` é o oposto: a intenção de voltar já foi tomada, então o
 * boot COMPLETA a volta.
 */
function reconcileOnBoot(cfg, agoraIso) {
  const c = ensureBackendConfig(cfg);
  const b = c.backendConfig;
  if (b.migrationState === ESTADOS.VALIDATING) {
    return { config: Object.assign({}, c, { backendConfig: Object.assign({}, b, {
      migrationState: ESTADOS.FAILED, failedReason: "validacao_interrompida" }) }),
      changed: true, action: "validacao_interrompida" };
  }
  // COMMITTED é terminal para o automático: nem um `rollback_pending` gravado
  // por versão anterior pode desfazer uma migração já provada.
  if (b.migrationState === ESTADOS.COMMITTED) {
    return { config: c, changed: false, action: null };
  }
  if (b.migrationState === ESTADOS.ROLLBACK_PENDING) {
    const r = buildRollbackConfig(c, agoraIso, "rollback_pendente_no_boot");
    if (r.ok) return { config: r.config, changed: true, action: "rollback_concluido_no_boot" };
    return { config: Object.assign({}, c, { backendConfig: Object.assign({}, b, {
      migrationState: ESTADOS.FAILED, failedReason: "rollback_sem_fallback" }) }),
      changed: true, action: "rollback_impossivel" };
  }
  return { config: c, changed: false, action: null };
}

// ── 12) SEGURANÇA DE LOG ───────────────────────────────────────────────────
/** Nenhuma chave inteira em log. Só o suficiente para diagnosticar. */
function redact(v) {
  const s = String(v ?? "");
  if (s.length <= 12) return "***";
  return `${s.slice(0, 6)}…${s.slice(-4)} (${s.length})`;
}
function safeSummary(cfg) {
  const b = (cfg && cfg.backendConfig) || {};
  return {
    activeBackend: b.activeBackend || null,
    migrationState: b.migrationState || null,
    primaryHost: b.primaryUrl ? (() => { try { return new URL(b.primaryUrl).hostname; } catch { return null; } })() : null,
    fallbackHost: b.fallbackUrl ? (() => { try { return new URL(b.fallbackUrl).hostname; } catch { return null; } })() : null,
    consecutiveCloudFailures: b.consecutiveCloudFailures || 0,
    lastMigrationId: b.lastMigrationId || null,
    committedAt: b.committedAt || null,
    healthySuccesses: b.healthySuccesses || 0,
    lastSwitchAt: b.lastSwitchAt || null,
    rollbackReason: b.rollbackReason || null,
  };
}

module.exports = { ESTADOS, PADROES, CHECKS, FALHAS_DE_NUVEM,
  ensureBackendConfig, activeEndpoint, validarUrl, validateSetBackendPayload,
  decidePromotion, buildPromotedConfig, isCloudFailure, isCommitted, noteOutcome,
  buildRollbackConfig, isAgentCommandExpired, reconcileOnBoot, redact, safeSummary };
