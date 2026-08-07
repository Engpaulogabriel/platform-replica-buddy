// loader.cjs — Bootstrap da FASE 3 (asar/main cifrado AES-256-GCM).
// ═══════════════════════════════════════════════════════════════════════════
// ⚠️  NÃO é o entry-point da frota. package.json.main continua = main.cjs. Este
//     loader só é usado num BUILD PILOTO (com package.json.main=loader.cjs e
//     main.enc empacotado em resources). Mantém main.cjs puro como FALLBACK.
//
// O que faz (mínimo, roda ANTES do app.whenReady):
//   1. calcula o fingerprint do hardware (idêntico ao getMachineFingerprint do main)
//   2. obtém a chave AES da versão:
//        a) do cache local embrulhado por KEK derivado do fingerprint (OFFLINE ok)
//        b) senão, do endpoint agent-asar-key (valida fingerprint+token no servidor)
//      e re-embrulha no cache (machine-bound: copiar a pasta p/ outro PC → KEK
//      diferente → cache não abre; e o servidor rejeita fingerprint divergente)
//   3. decifra main.enc EM MEMÓRIA e o executa (Module._compile)
//   4. QUALQUER falha → fallback para require('./main.cjs') (asar puro), para
//      NUNCA brickar: a resiliência (nunca morre por falta de nuvem) é preservada
//      pelo cache offline + pelo fallback.
//
// Segurança: a chave nunca fica em disco em claro (cache é AES-GCM sob KEK do
// fingerprint). O anon key/URL embutidos aqui são públicos (mesmos do main).
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

// KEK de 32 bytes derivado do fingerprint (machine-bound, disponível pré-app-ready).
function deriveKek(machineIdHash) {
  return crypto.scryptSync(machineIdHash, KEK_SALT, 32);
}
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

function cacheFileFor(version) {
  return path.join(CACHE_DIR, `asar-key-${String(version).replace(/[^0-9a-zA-Z.\-]/g, "_")}.wrap`);
}
function readCachedKey(version, kek) {
  try {
    const f = cacheFileFor(version);
    if (!fs.existsSync(f)) return null;
    return aesGcmOpen(kek, fs.readFileSync(f)); // 32 bytes
  } catch (_) { return null; } // copiado de outro PC / corrompido → ignora
}
function writeCachedKey(version, kek, keyBuf) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFileFor(version), aesGcmSeal(kek, keyBuf));
  } catch (_) {}
}

async function fetchKeyFromServer(version, fp) {
  try {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/agent-asar-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON, "Authorization": `Bearer ${SUPABASE_ANON}` },
      body: JSON.stringify({ machine_id_hash: fp.hash, fingerprint: fp.fingerprint, version }),
    });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok || !j || j.ok !== true || !j.aes_key) { log(`servidor não entregou chave (${(j && j.reason) || resp.status})`); return null; }
    return Buffer.from(j.aes_key, "base64");
  } catch (e) { log(`fetch chave falhou: ${e.message}`); return null; }
}

async function getAesKey(version, fp) {
  const kek = deriveKek(fp.hash);
  const cached = readCachedKey(version, kek);
  if (cached && cached.length === 32) { log("chave AES via cache (offline ok)"); return cached; }
  const fromServer = await fetchKeyFromServer(version, fp);
  if (fromServer && fromServer.length === 32) { writeCachedKey(version, kek, fromServer); log("chave AES via servidor + cache atualizado"); return fromServer; }
  return null;
}

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
  log(`fallback → main.cjs puro (${reason})`);
  try { require("./main.cjs"); }
  catch (e) { log(`FATAL: fallback main.cjs falhou: ${e && e.message || e}`); }
}

(async () => {
  try {
    const encPath = path.join(process.resourcesPath || __dirname, "main.enc");
    if (!fs.existsSync(encPath)) return fallbackPlaintext("main.enc ausente");

    let version = "0.0.0";
    try { version = require("./package.json").version || version; } catch (_) {}

    const fp = machineFingerprint();
    const key = await getAesKey(version, fp);
    if (!key) return fallbackPlaintext("sem chave (servidor+cache)");

    const sealed = fs.readFileSync(encPath); // [12 iv][ct][16 tag]
    let source;
    try { source = aesGcmOpen(key, sealed).toString("utf8"); }
    catch (e) { return fallbackPlaintext(`decrypt main.enc falhou: ${e.message}`); }

    log("main.enc decifrado — executando lógica de negócio");
    runDecryptedMain(source);
  } catch (e) {
    fallbackPlaintext(`erro inesperado: ${e && e.message || e}`);
  }
})();
