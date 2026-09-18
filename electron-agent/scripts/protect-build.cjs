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
// FORA de app/ de propósito: `asar pack app` empacota tudo que estiver na
// pasta, e um backup ali dentro colocaria o fonte LIMPO dentro do artefato
// ofuscado — anulando a proteção e inflando o pacote.
const MAIN_BACKUP = path.join(ROOT, ".main.original.cjs");
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

  // 0) STAGING DETERMINÍSTICO — fonte canônica → app/
  //
  // Antes isto era cópia manual: o `main.cjs` autoritativo vivia na raiz de
  // electron-agent/ e alguém o copiava para app/ antes de buildar. Quando a
  // cópia não acontecia (ou acontecia ao contrário), o .asar saía com um main
  // de outra versão — foi assim que a fonte da 3.26 se perdeu e o app/ ficou
  // com um main 3.25.6. Agora o build sincroniza sozinho, sempre na mesma
  // direção, e falha alto se um arquivo de runtime faltar.
  log("staging: copiando fonte canônica → app/");
  const RUNTIME_FILES = [
    "main.cjs", "package.json",
    "auth.html", "auth-preload.cjs",
    "setup.html", "setup-preload.cjs",
    "log.html", "log-preload.cjs",
    "config.html", "config-preload.cjs",
    "icon.png", "icon.ico",
  ];
  for (const f of RUNTIME_FILES) {
    const src = path.join(ROOT, f);
    if (!fs.existsSync(src)) {
      console.error(`[PROTECT] arquivo de runtime ausente na raiz: ${f}`);
      process.exit(1);
    }
    fs.copyFileSync(src, path.join(APP_DIR, f));
  }
  // lib/ inteiro — os require("./lib/*.cjs") do main viram null sem isto.
  const LIB_SRC = path.join(ROOT, "lib");
  const LIB_DST = path.join(APP_DIR, "lib");
  if (!fs.existsSync(LIB_SRC)) {
    console.error("[PROTECT] lib/ não encontrada na raiz de electron-agent/");
    process.exit(1);
  }
  fs.mkdirSync(LIB_DST, { recursive: true });
  for (const f of fs.readdirSync(LIB_SRC).filter((n) => n.endsWith(".cjs"))) {
    fs.copyFileSync(path.join(LIB_SRC, f), path.join(LIB_DST, f));
  }
  // O backup do main anterior não pode sobreviver ao staging: ele restauraria
  // um main de outra versão no passo 6.
  if (fs.existsSync(MAIN_BACKUP)) fs.unlinkSync(MAIN_BACKUP);
  // Poda: nada além do runtime pode viajar no .asar. `serial_bridge.exe` e o
  // .py vão como extraResources (soltos em resources/) — Python não executa de
  // dentro do asar —, e qualquer sobra de build anterior sairia junto.
  const PERMITIDOS = new Set([...RUNTIME_FILES, "lib", "node_modules",
    "package-lock.json", "renov-logo.png"]);
  for (const nome of fs.readdirSync(APP_DIR)) {
    if (PERMITIDOS.has(nome)) continue;
    const alvo = path.join(APP_DIR, nome);
    fs.rmSync(alvo, { recursive: true, force: true });
    log(`staging: removido de app/ (não é runtime): ${nome}`);
  }
  log(`staging concluído: ${RUNTIME_FILES.length} arquivos + lib/`);

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
