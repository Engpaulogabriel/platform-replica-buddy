// loader.cjs — Bootstrap da FASE 3 (D-corrigido): código cifrado, OTA + cache local.
// ═══════════════════════════════════════════════════════════════════════════
// ⚠️  NÃO é o entry-point da frota. package.json.main só vira loader.cjs no BUILD
//     PILOTO (RENOV_ENCRYPT_ASAR=1). Mantém main.cjs OFUSCADO no asar como FALLBACK.
//
// Fluxo (roda ANTES do app.whenReady → NÃO pode usar safeStorage do Electron):
//   1. Tenta o CACHE LOCAL selado do código (%ProgramData%\Renov\main.enc.cache).
//   2. Se abre (selo bate com este hardware/usuário) e a versão confere → executa
//      o código EM MEMÓRIA (Module._compile). OFFLINE OK.
//   3. Cache ausente/inválido/versão nova:
//      a) COM internet → agent-asar-key valida device_license+fingerprint e devolve
//         a chave AES + signed URL do main.enc (OTA); baixa e decifra em memória.
//      b) Reсifra o CÓDIGO para este hardware e grava o cache local (nunca .js puro).
//      c) Executa em memória.
//   4. SEM internet e SEM cache → fallback require('./main.cjs') (ofuscado, no asar).
//
// Selo do cache (machine/usuário-bound, disponível pré-app-ready), com verificação
// de round-trip no write e degradação segura:
//   [0x01] DPAPI (ProtectedData, CurrentUser) — "mesmo mecanismo" do credentials.enc,
//          via PowerShell porque o safeStorage exige app.whenReady.
//   [0x02] KEK = scrypt(fingerprint) + AES-256-GCM (puro Node) — fallback se o DPAPI
//          não estiver disponível/consistente nesta máquina.
// Copiar a pasta p/ outro PC/usuário → DPAPI/KEK não abre → cache miss → re-baixa
// (se online) ou fallback. NUNCA grava código em texto claro em disco. NUNCA brica.
// Compatível com a FASE 2 (fingerprint idêntico ao getMachineFingerprint do main).
// ═══════════════════════════════════════════════════════════════════════════
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");

const SUPABASE_URL = process.env.RENOV_SUPABASE_URL || "https://dnyukgfedredvxpzjpqz.supabase.co";
const SUPABASE_ANON = process.env.RENOV_SUPABASE_ANON
  || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRueXVrZ2ZlZHJlZHZ4cHpqcHF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2ODU1OTQsImV4cCI6MjA5MjI2MTU5NH0.OSg44w0CRVvD-f6Ts_U9DVeQkQ-4c37passKEK5X0kk";
const KEK_SALT = "renov-asar-kek-v1";
const CACHE_DIR = path.join("C:\\ProgramData", "Renov");
const CODE_CACHE = path.join(CACHE_DIR, "main.enc.cache"); // código selado (DPAPI/KEK)

function log(msg) { try { console.log(`[LOADER] ${msg}`); } catch (_) {} }

// Fingerprint IDÊNTICO ao getMachineFingerprint() do main.cjs (o hash tem de bater
// com device_licenses.machine_id_hash registrado no provisioning).
function machineFingerprint() {
  let cpuId = "", diskSerial = "", uuid = "";
  try {
    if (process.platform === "win32") {
      cpuId = execSync("wmic cpu get ProcessorId /value", { timeout: 3000 }).toString().match(/ProcessorId=(.+)/)?.[1]?.trim() || "";
      diskSerial = execSync("wmic diskdrive get SerialNumber /value", { timeout: 3000 }).toString().match(/SerialNumber=(.+)/)?.[1]?.trim() || "";
      uuid = execSync("wmic csproduct get UUID /value", { timeout: 3000 }).toString().match(/UUID=(.+)/)?.[1]?.trim() || "";
    }
  } catch (_) {}
  const macs = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && !i.internal && i.mac && i.mac !== "00:00:00:00:00:00")
    .map((i) => i.mac).sort();
  const raw = [cpuId, diskSerial, uuid, ...macs, os.hostname()].join("|");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return { hash, fingerprint: { cpu: cpuId, disk_serial: diskSerial, uuid, mac_addresses: macs, hostname: os.hostname(), os: process.platform, arch: process.arch } };
}

// ── Cripto base ────────────────────────────────────────────────────────────
function deriveKek(machineIdHash) { return crypto.scryptSync(machineIdHash, KEK_SALT, 32); }
function aesGcmSeal(key, plaintextBuf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plaintextBuf), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]);
}
function aesGcmOpen(key, sealed) {
  const iv = sealed.subarray(0, 12);
  const tag = sealed.subarray(sealed.length - 16);
  const ct = sealed.subarray(12, sealed.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

// ── DPAPI (ProtectedData / CurrentUser) via PowerShell (pré-app-ready) ───────
// safeStorage exige app.whenReady; aqui usamos o MESMO DPAPI por baixo, direto.
// Dados trafegam em base64 por stdin/stdout (memória/pipe) — nunca em disco.
function runPs(script, inputB64) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const out = execSync(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`, {
    input: inputB64, timeout: 8000, maxBuffer: 48 * 1024 * 1024, windowsHide: true,
  });
  return out.toString("ascii").trim();
}
const PS_PROTECT =
  "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::ASCII;Add-Type -AssemblyName System.Security;" +
  "$i=[Console]::In.ReadToEnd();$b=[Convert]::FromBase64String($i.Trim());" +
  "$p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);" +
  "[Console]::Out.Write([Convert]::ToBase64String($p))";
const PS_UNPROTECT =
  "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::ASCII;Add-Type -AssemblyName System.Security;" +
  "$i=[Console]::In.ReadToEnd();$b=[Convert]::FromBase64String($i.Trim());" +
  "$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);" +
  "[Console]::Out.Write([Convert]::ToBase64String($p))";

function dpapiProtect(buf) {
  try {
    if (process.platform !== "win32") return null;
    const o = runPs(PS_PROTECT, buf.toString("base64"));
    return o ? Buffer.from(o, "base64") : null;
  } catch (_) { return null; }
}
function dpapiUnprotect(buf) {
  try {
    if (process.platform !== "win32") return null;
    const o = runPs(PS_UNPROTECT, buf.toString("base64"));
    return o ? Buffer.from(o, "base64") : null;
  } catch (_) { return null; }
}

// Sela um buffer para ESTE hardware/usuário. DPAPI primeiro (com verificação de
// round-trip: garante que o que gravo consigo reabrir NESTA máquina), senão KEK.
function localSeal(buf, fp) {
  const prot = dpapiProtect(buf);
  if (prot) {
    const back = dpapiUnprotect(prot);
    if (back && back.equals(buf)) return Buffer.concat([Buffer.from([1]), prot]);
    log("DPAPI round-trip falhou — usando KEK do fingerprint");
  }
  return Buffer.concat([Buffer.from([2]), aesGcmSeal(deriveKek(fp.hash), buf)]);
}
function localOpen(sealed, fp) {
  try {
    if (!sealed || sealed.length < 2) return null;
    const tag = sealed[0];
    const rest = sealed.subarray(1);
    if (tag === 1) return dpapiUnprotect(rest);       // copiado p/ outro user/PC → null
    if (tag === 2) return aesGcmOpen(deriveKek(fp.hash), rest); // fingerprint diferente → throw → null
    return null;
  } catch (_) { return null; }
}

// ── Cache do CÓDIGO (selado; versão embutida no cabeçalho) ───────────────────
function readCodeCache(version, fp) {
  try {
    if (!fs.existsSync(CODE_CACHE)) return null;
    const opened = localOpen(fs.readFileSync(CODE_CACHE), fp);
    if (!opened) return null; // selo não abre (outro PC/usuário) → miss
    const s = opened.toString("utf8");
    const nl = s.indexOf("\n");
    if (nl < 0) return null;
    if (s.slice(0, nl) !== version) { // OTA: versão nova → invalida o cache
      try { fs.unlinkSync(CODE_CACHE); } catch (_) {}
      return null;
    }
    return s.slice(nl + 1);
  } catch (_) { return null; }
}
function writeCodeCache(version, fp, code) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CODE_CACHE, localSeal(Buffer.from(`${version}\n${code}`, "utf8"), fp));
  } catch (_) { /* cache é best-effort */ }
}

// ── Servidor: chave AES + signed URL do main.enc (OTA) ───────────────────────
async function fetchKeyAndUrl(version, fp) {
  try {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/agent-asar-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON, "Authorization": `Bearer ${SUPABASE_ANON}` },
      body: JSON.stringify({ machine_id_hash: fp.hash, fingerprint: fp.fingerprint, version }),
    });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok || !j || j.ok !== true || !j.aes_key) { log(`servidor não entregou chave (${(j && j.reason) || resp.status})`); return null; }
    return { key: Buffer.from(j.aes_key, "base64"), encUrl: j.enc_url || null };
  } catch (e) { log(`fetch chave/url falhou: ${e.message}`); return null; }
}
async function downloadBytes(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) { log(`download main.enc HTTP ${r.status}`); return null; }
    return Buffer.from(await r.arrayBuffer());
  } catch (e) { log(`download main.enc falhou: ${e.message}`); return null; }
}

// ── Execução em memória / fallback ───────────────────────────────────────────
function runDecryptedMain(plaintextSource) {
  const Module = require("module");
  const asarDir = path.join(process.resourcesPath || __dirname, "app.asar");
  const filename = path.join(asarDir, "main.cjs"); // nome virtual; ./package.json resolve no asar
  const m = new Module(filename, null);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(path.dirname(filename));
  m._compile(plaintextSource, filename);
}
function fallbackPlaintext(reason) {
  log(`fallback → main.cjs ofuscado (${reason})`);
  try { require("./main.cjs"); }
  catch (e) { log(`FATAL: fallback main.cjs falhou: ${e && e.message || e}`); }
}

(async () => {
  try {
    let version = "0.0.0";
    try { version = require("./package.json").version || version; } catch (_) {}
    const fp = machineFingerprint();

    // 1-2) CACHE LOCAL (offline ok)
    const cached = readCodeCache(version, fp);
    if (cached) { log("código via cache local selado (offline ok)"); return runDecryptedMain(cached); }

    // 3a) ONLINE: chave + main.enc (OTA); fallback de fonte = resources/ (build antigo)
    const srv = await fetchKeyAndUrl(version, fp);
    let key = srv && srv.key ? srv.key : null;
    let encBytes = null;
    if (srv && srv.encUrl) encBytes = await downloadBytes(srv.encUrl);
    if (!encBytes) {
      const bundled = path.join(process.resourcesPath || __dirname, "main.enc");
      if (fs.existsSync(bundled)) { encBytes = fs.readFileSync(bundled); log("main.enc via resources/ (bundled)"); }
    }
    if (!key || !encBytes) return fallbackPlaintext("sem chave/main.enc e sem cache (offline)");

    // 3b) decifra em memória
    let code;
    try { code = aesGcmOpen(key, encBytes).toString("utf8"); }
    catch (e) { return fallbackPlaintext(`decrypt main.enc falhou: ${e.message}`); }

    // 3b') re-sela o CÓDIGO para este hardware e grava o cache (nunca .js puro)
    writeCodeCache(version, fp, code);

    // 3c) executa em memória
    log("main.enc decifrado (OTA) — executando; cache local selado atualizado");
    runDecryptedMain(code);
  } catch (e) {
    fallbackPlaintext(`erro inesperado: ${e && e.message || e}`);
  }
})();
