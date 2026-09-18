// ─────────────────────────────────────────────────────────────────────────────
// Migração de backend — PARTE 2: persistência ATÔMICA do config.
// ─────────────────────────────────────────────────────────────────────────────
// Trocar de backend é reescrever o arquivo que diz com quem o agente fala. Um
// `writeFileSync` interrompido no meio (queda de energia, kill) deixaria um
// config truncado — e um agente que não carrega config nenhum é um agente que
// não volta. Daí: escreve em temporário, LÊ DE VOLTA e compara byte a byte, e
// só então renomeia por cima. `rename` é atômico no NTFS e no POSIX.
//
// `fs` é injetável — é o que torna a falha de escrita testável sem quebrar
// disco de verdade.
"use strict";

function mesmosBytes(a, b) {
  const ba = Buffer.isBuffer(a) ? a : Buffer.from(String(a), "utf8");
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(String(b), "utf8");
  return ba.length === bb.length && ba.equals(bb);
}

/**
 * Escrita atômica com verificação de leitura. Em QUALQUER falha o arquivo
 * anterior permanece intacto e o temporário é removido.
 */
function writeAtomicSync(fsImpl, filePath, data) {
  const tmp = `${filePath}.renov-tmp`;
  try {
    fsImpl.writeFileSync(tmp, data);
    const devolta = fsImpl.readFileSync(tmp);
    if (!mesmosBytes(devolta, data)) throw new Error("readback_divergente");
    fsImpl.renameSync(tmp, filePath);
    return { ok: true };
  } catch (e) {
    try { if (fsImpl.existsSync(tmp)) fsImpl.unlinkSync(tmp); } catch (_) {}
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

/**
 * Persiste o config novo e, em seguida, o espelho machine-bound.
 *
 * ORDEM DELIBERADA: config primeiro. `credentials.enc` só é lido quando o
 * config sumiu; se ele fosse gravado primeiro e o config falhasse, uma perda
 * futura do config faria o agente migrar de backend SOZINHO, sem comando. O
 * inverso — config novo e espelho velho — é apenas um espelho desatualizado,
 * que o próprio `ensureCredentialsEnc` reescreve no boot seguinte.
 *
 * Se o config falhar: `{ ok:false }`. O chamador ABORTA a promoção e NÃO
 * reinicia — a operação continua no backend antigo.
 */
function persistBackendConfig(opts) {
  const { fs: fsImpl, configPath, credsPath, config, creds, encode } = opts || {};
  if (!fsImpl || !configPath || !config) return { ok: false, reason: "parametros_ausentes" };
  const enc = typeof encode === "function" ? encode : ((o) => JSON.stringify(o, null, 2));

  let dadosConfig;
  try { dadosConfig = enc(config); }
  catch (e) { return { ok: false, reason: `encode_config: ${(e && e.message) || e}` }; }

  const r = writeAtomicSync(fsImpl, configPath, dadosConfig);
  if (!r.ok) return { ok: false, reason: `config: ${r.reason}` };

  // Espelho: best-effort declarado. Falhar aqui NÃO desfaz a promoção nem
  // impede o restart — o config, que é a fonte da verdade, já está gravado.
  let mirror = { ok: false, reason: "nao_solicitado" };
  if (credsPath && creds) {
    try { mirror = writeAtomicSync(fsImpl, credsPath, enc(creds)); }
    catch (e) { mirror = { ok: false, reason: String((e && e.message) || e) }; }
  }
  return { ok: true, mirror };
}

module.exports = { writeAtomicSync, persistBackendConfig, mesmosBytes };
