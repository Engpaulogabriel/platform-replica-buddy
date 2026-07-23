/**
 * protect-build.cjs — Pipeline de build + proteção do agente (somente ofuscação JS)
 *
 * Pipeline atual (bytenode desativado por enquanto):
 *   1. npm install --production em app/
 *   2. Backup app/main.cjs → app/main.original.cjs (idempotente)
 *   3. Ofusca main.cjs com javascript-obfuscator
 *      (controlFlowFlattening, stringArray rc4, selfDefending, etc.)
 *   4. Sobrescreve app/main.cjs com a versão ofuscada
 *   5. npx asar pack app release/app.asar
 *   6. Restaura app/main.cjs a partir de app/main.original.cjs
 *   7. Valida tamanho do .asar (5–15 MB esperado)
 *
 * Observação: a camada bytenode (bytecode V8 .jsc) está pronta no histórico,
 * mas requer um host com Electron funcional para compilar. Por ora usamos
 * apenas a ofuscação JavaScript, que já dificulta bastante a engenharia reversa.
 *
 * Uso: cd electron-agent && npm run build
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const APP_DIR = path.join(ROOT, "app");
const MAIN_SRC = path.join(APP_DIR, "main.cjs");
const MAIN_BACKUP = path.join(APP_DIR, "main.original.cjs");
const RELEASE_DIR = path.join(ROOT, "release");
const ASAR_OUT = path.join(RELEASE_DIR, "app.asar");

function log(msg) { console.log("[PROTECT] " + msg); }

async function main() {
  if (!fs.existsSync(APP_DIR)) {
    console.error("Diretório app/ não encontrado em " + APP_DIR);
    process.exit(1);
  }
  if (!fs.existsSync(MAIN_SRC)) {
    console.error("app/main.cjs não encontrado em " + MAIN_SRC);
    process.exit(1);
  }

  // 1) npm install --production em app/
  log("instalando dependências de produção em app/ ...");
  execSync("npm install --production", { cwd: APP_DIR, stdio: "inherit" });

  // 2) Backup do original (idempotente — se já existe, restaura primeiro)
  if (!fs.existsSync(MAIN_BACKUP)) {
    log("backup app/main.cjs → app/main.original.cjs");
    fs.copyFileSync(MAIN_SRC, MAIN_BACKUP);
  } else {
    log("backup já existe — restaurando antes de reprocessar");
    fs.copyFileSync(MAIN_BACKUP, MAIN_SRC);
  }

  const original = fs.readFileSync(MAIN_BACKUP, "utf8");

  try {
    // 3) Ofuscação
    let obfuscated;
    try {
      const JsObf = require("javascript-obfuscator");
      log("ofuscando código (controlFlowFlattening + rc4 stringArray)...");
      const result = JsObf.obfuscate(original, {
        compact: true,
        controlFlowFlattening: true,
        controlFlowFlatteningThreshold: 0.75,
        deadCodeInjection: true,
        deadCodeInjectionThreshold: 0.4,
        debugProtection: true,
        debugProtectionInterval: 2000,
        disableConsoleOutput: false,
        identifierNamesGenerator: "hexadecimal",
        renameGlobals: false, // evita quebrar require('electron') etc.
        selfDefending: true,
        stringArray: true,
        stringArrayEncoding: ["rc4"],
        stringArrayThreshold: 0.75,
        transformObjectKeys: true,
        unicodeEscapeSequence: false,
        target: "node",
      });
      obfuscated = result.getObfuscatedCode();
    } catch (e) {
      console.error("javascript-obfuscator não instalado. Rode: npm install --save-dev javascript-obfuscator");
      throw e;
    }

    // 4) Substitui main.cjs pela versão ofuscada
    fs.writeFileSync(MAIN_SRC, obfuscated, "utf8");
    log("main.cjs ofuscado (" + obfuscated.length + " bytes) gravado para empacotamento.");

    // 5) npx asar pack app release/app.asar
    if (!fs.existsSync(RELEASE_DIR)) fs.mkdirSync(RELEASE_DIR, { recursive: true });
    log("empacotando app/ → release/app.asar ...");
    execSync(`npx --yes asar pack "${APP_DIR}" "${ASAR_OUT}"`, { cwd: ROOT, stdio: "inherit" });
  } finally {
    // 6) Restaura main.cjs original (sempre, mesmo se algo falhou)
    if (fs.existsSync(MAIN_BACKUP)) {
      fs.copyFileSync(MAIN_BACKUP, MAIN_SRC);
      log("app/main.cjs restaurado a partir do backup.");
    }
  }

  // 7) Validação de tamanho do .asar
  if (!fs.existsSync(ASAR_OUT)) {
    console.error("[PROTECT] ERRO: release/app.asar não foi gerado.");
    process.exit(1);
  }
  const asarSize = fs.statSync(ASAR_OUT).size;
  const sizeMB = (asarSize / 1024 / 1024).toFixed(2);
  log(`release/app.asar gerado: ${sizeMB} MB`);
  if (asarSize < 5 * 1024 * 1024) {
    console.error("[PROTECT] ERRO: .asar menor que 5 MB — build provavelmente quebrado!");
    process.exit(1);
  }
  if (asarSize > 15 * 1024 * 1024) {
    console.warn("[PROTECT] AVISO: .asar maior que 15 MB — verificar dependências extras.");
  }

  log("✅ Build protegido concluído com sucesso (ofuscação JS).");
}

main().catch((e) => { console.error(e); process.exit(1); });
