// ─────────────────────────────────────────────────────────────────────────────
// Migração de backend — PARTE 2: as CINCO checagens reais contra o candidato.
// ─────────────────────────────────────────────────────────────────────────────
// Faz rede, mas não faz decisão: devolve um relatório booleano que
// `backendMigration.decidePromotion()` julga. `fetch` é injetável, então as
// cinco checagens são testáveis sem tocar em servidor nenhum.
//
// REGRA ABSOLUTA — NADA AQUI ESCREVE:
//   • nenhum comando é criado, nenhuma bomba é acionada, nenhum estado físico
//     é gravado, nenhuma tabela operacional é alterada;
//   • toda requisição tem AbortController + timer limpo no `finally`, então
//     nenhuma promise fica pendurada segurando o processo;
//   • o token obtido em `agent_auth` é DESCARTADO — nunca vira sessão. Só
//     depois da promoção o agente reinicia e autentica de verdade.
"use strict";

/** Classificação de erro de transporte — só para log, nunca para decisão. */
function classificarErro(e) {
  const m = String((e && e.message) || e).toLowerCase();
  if (/abort|timeout/.test(m)) return "timeout";
  if (/enotfound|eai_again|dns|getaddrinfo/.test(m)) return "dns";
  if (/certificate|tls|ssl|self.signed/.test(m)) return "tls";
  if (/econnrefused|econnreset|ehostunreach|enetunreach|socket/.test(m)) return "connection";
  return "network";
}

/** Uma requisição com teto de tempo. Nunca lança; nunca deixa timer vivo. */
async function pedir(fetchImpl, url, opts, timeoutMs) {
  let ctl = null;
  try { ctl = new AbortController(); } catch (_) { ctl = null; }
  let timer = null;
  if (ctl) {
    timer = setTimeout(() => { try { ctl.abort(); } catch (_) {} }, timeoutMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  }
  try {
    const r = await fetchImpl(url, Object.assign({}, opts, ctl ? { signal: ctl.signal } : {}));
    let body = null;
    try { body = await r.json(); } catch (_) { body = null; }
    return { respondeu: true, status: Number(r.status) || 0, body: body || {} };
  } catch (e) {
    return { respondeu: false, status: 0, erro: classificarErro(e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const semBarra = (u) => String(u || "").replace(/\/+$/, "");

/** 1) connectivity — DNS + TLS + o host responde HTTP. Só leitura. */
async function checkConnectivity(f, cand, t) {
  const r = await pedir(f, `${semBarra(cand.url)}/rest/v1/`,
    { method: "GET", headers: { apikey: cand.anonKey } }, t);
  return { ok: r.respondeu && r.status > 0 && r.status < 500,
           detalhe: { status: r.status, erro: r.erro || null } };
}

/** 2) rest_api — PostgREST responde e a anon key é aceita. SELECT, nunca write.
 *  Sob RLS o anon costuma receber `200 []`; é isso que se espera — o que se
 *  testa é a camada REST + a chave, não o conteúdo. */
async function checkRestApi(f, cand, t) {
  const r = await pedir(f, `${semBarra(cand.url)}/rest/v1/farms?select=id&limit=1`,
    { method: "GET", headers: { apikey: cand.anonKey, Authorization: `Bearer ${cand.anonKey}` } }, t);
  return { ok: r.respondeu && r.status === 200,
           detalhe: { status: r.status, erro: r.erro || null } };
}

/** 3) agent_auth — a autenticação REAL do agente (mesmo grant que
 *  `authenticate()` usa no main.cjs) contra o candidato. Se isto falhar, o
 *  agente sobe morto no backend novo.
 *  O access_token recebido é lido apenas para confirmar que veio, e descartado
 *  na mesma linha: NUNCA é devolvido, logado ou promovido a sessão. */
async function checkAgentAuth(f, cand, ctx, t) {
  if (!ctx || !ctx.email || !ctx.password) {
    return { ok: false, detalhe: { motivo: "sem_credenciais_locais" } };
  }
  const r = await pedir(f, `${semBarra(cand.url)}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: cand.anonKey },
    body: JSON.stringify({ email: ctx.email, password: ctx.password }),
  }, t);
  const temToken = !!(r.body && r.body.access_token);
  return { ok: r.respondeu && r.status === 200 && temToken,
           detalhe: { status: r.status, token_recebido: temToken, erro: r.erro || null } };
}

/** 4) license_validate — o fluxo real de licença.
 *
 *  Este é o check mais importante da migração inteira. No main.cjs,
 *  `validateLicenseHeartbeat` reage a 403/revoked/farm_suspended acionando o
 *  kill-switch: DESLIGA AS BOMBAS e encerra o agente. Promover para um backend
 *  que responderia 403 à licença derrubaria a fazenda. Por isso estas três
 *  respostas reprovam de forma dura, e por isso o check é obrigatório.
 *
 *  Uma resposta estruturada não-letal (token precisa ser reemitido) PASSA: ela
 *  prova que a função existe e que a resposta não mata o agente — que é
 *  exatamente o que a migração precisa garantir. 404/5xx/rede reprovam. */
const LETAIS = ["revoked", "farm_suspended"];
async function checkLicenseValidate(f, cand, ctx, t) {
  if (!ctx || !ctx.licenseToken) {
    // O agente não usa este caminho hoje (sem licenseToken em config, a função
    // retorna cedo e nada é validado). Não há o que quebrar na migração.
    return { ok: true, detalhe: { motivo: "sem_token_local" } };
  }
  const r = await pedir(f, `${semBarra(cand.url)}/functions/v1/license-validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: cand.anonKey,
               Authorization: `Bearer ${ctx.licenseToken}` },
    body: JSON.stringify({ machine_id_hash: ctx.machineIdHash || "",
                           fingerprint: ctx.fingerprint || {},
                           agent_version: ctx.agentVersion || null }),
  }, t);
  if (!r.respondeu) return { ok: false, detalhe: { erro: r.erro } };
  const erroBody = r.body && r.body.error ? String(r.body.error) : null;
  const letal = r.status === 403 || LETAIS.includes(String(erroBody));
  const existe = r.status !== 404 && r.status < 500;
  return { ok: existe && !letal,
           detalhe: { status: r.status, letal, valid: !!(r.body && r.body.valid),
                      motivo: letal ? "resposta_letal_derrubaria_bombas" : null } };
}

/** 5) functions — o runtime de Edge Functions responde e a função existe.
 *  OPTIONS é preflight CORS: não invoca o corpo da função, não escreve nada.
 *  404 reprova (função não publicada no backend novo). */
async function checkFunctions(f, cand, ctx, t) {
  const nome = (ctx && ctx.functionName) || "agent-auth";
  const r = await pedir(f, `${semBarra(cand.url)}/functions/v1/${nome}`,
    { method: "OPTIONS", headers: { apikey: cand.anonKey } }, t);
  return { ok: r.respondeu && r.status > 0 && r.status !== 404 && r.status < 500,
           detalhe: { status: r.status, funcao: nome, erro: r.erro || null } };
}

/**
 * Roda as cinco em sequência. Sequencial de propósito: com timeout de 15s cada,
 * o pior caso é 75s — e parar na primeira reprovação economiza rede sem mudar
 * o resultado, já que a promoção exige TODAS.
 *
 * `details` é sanitizado por construção: só status HTTP, classe de erro e
 * booleanos. Nenhuma chave, token ou corpo de resposta sai daqui.
 */
async function runBackendChecks(candidate, ctx, deps) {
  const f = (deps && deps.fetch) || (typeof fetch === "function" ? fetch : null);
  const t = Math.max(2000, Math.min(120000, Number(deps && deps.timeoutMs) || 15000));
  const results = {}; const details = {};
  if (typeof f !== "function") {
    return { results, details: { fatal: "sem_fetch" }, allOk: false };
  }
  const passos = [
    ["connectivity",     () => checkConnectivity(f, candidate, t)],
    ["rest_api",         () => checkRestApi(f, candidate, t)],
    ["agent_auth",       () => checkAgentAuth(f, candidate, ctx, t)],
    ["license_validate", () => checkLicenseValidate(f, candidate, ctx, t)],
    ["functions",        () => checkFunctions(f, candidate, ctx, t)],
  ];
  for (const [nome, fn] of passos) {
    let r;
    try { r = await fn(); } catch (e) { r = { ok: false, detalhe: { erro: classificarErro(e) } }; }
    results[nome] = r.ok === true;
    details[nome] = r.detalhe || null;
    if (!r.ok) break;   // curto-circuito: a promoção exige todas
  }
  const allOk = ["connectivity", "rest_api", "agent_auth", "license_validate", "functions"]
    .every((c) => results[c] === true);
  return { results, details, allOk };
}

module.exports = { runBackendChecks, classificarErro,
  checkConnectivity, checkRestApi, checkAgentAuth, checkLicenseValidate, checkFunctions };
