/**
 * publish-release.cjs — Publica release/app.asar como nova versão OTA.
 *
 * Pipeline:
 *   1. Lê release/app.asar (gerado por `npm run build`)
 *   2. Calcula SHA256 e tamanho em bytes
 *   3. Upload para bucket privado `agent-releases` em `<version>/app.asar`
 *   4. Insere/atualiza linha em `agent_releases`
 *      (artifact_type='asar', storage_path, file_hash, file_size_bytes, is_latest)
 *
 * O agente baixa via edge function `agent-release-signed-url` (URL assinada 1h)
 * — não precisa saber que o .asar está ofuscado.
 *
 * Pré-requisitos (env):
 *   SUPABASE_URL                 ex: https://dnyukgfedredvxpzjpqz.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY    chave service_role (NUNCA commitar)
 *
 * Uso:
 *   node scripts/publish-release.cjs <version> [--latest] [--mandatory] [--notes "texto"]
 *
 * Ex:
 *   node scripts/publish-release.cjs 1.4.2 --latest --notes "Hardening anti-clone"
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function log(m) { console.log("[PUBLISH] " + m); }
function die(m) { console.error("[PUBLISH] ERRO: " + m); process.exit(1); }

// --- Args ---
const args = process.argv.slice(2);
const version = args[0];
if (!version || version.startsWith("--")) {
  die("informe a versão. Ex: node scripts/publish-release.cjs 1.4.2 --latest");
}
const isLatest = args.includes("--latest");
const mandatory = args.includes("--mandatory");
const notesIdx = args.indexOf("--notes");
const releaseNotes = notesIdx >= 0 ? args[notesIdx + 1] : null;

// --- Env ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  die("defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no ambiente.");
}

// --- Artefato ---
const ASAR = path.resolve(__dirname, "..", "release", "app.asar");
if (!fs.existsSync(ASAR)) {
  die(`release/app.asar não encontrado. Rode \`npm run build\` antes. (${ASAR})`);
}
const buf = fs.readFileSync(ASAR);
const size = buf.length;
const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
log(`asar: ${(size / 1024 / 1024).toFixed(2)} MB  sha256=${sha256}`);

const storagePath = `${version}/app.asar`;

async function main() {
  // 1) Upload no bucket privado agent-releases (upsert)
  log(`upload → agent-releases/${storagePath}`);
  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/agent-releases/${storagePath}`;
  const upRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      apikey: SERVICE_KEY,
      "Content-Type": "application/octet-stream",
      "x-upsert": "true",
      "cache-control": "no-cache",
    },
    body: buf,
  });
  if (!upRes.ok) {
    const t = await upRes.text();
    die(`falha no upload (${upRes.status}): ${t}`);
  }
  log("upload concluído.");

  // 2) Upsert em agent_releases via PostgREST (resolve conflito pela coluna version)
  log(`registrando agent_releases version=${version} latest=${isLatest} mandatory=${mandatory}`);
  const row = {
    version,
    artifact_type: "asar",
    storage_path: storagePath,
    file_hash: sha256,
    file_size_bytes: size,
    is_latest: isLatest,
    mandatory,
    release_notes: releaseNotes,
    download_url: null,
  };
  const insertRes = await fetch(
    `${SUPABASE_URL}/rest/v1/agent_releases?on_conflict=version`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SERVICE_KEY}`,
        apikey: SERVICE_KEY,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify(row),
    },
  );
  if (!insertRes.ok) {
    const t = await insertRes.text();
    die(`falha no insert agent_releases (${insertRes.status}): ${t}`);
  }
  const inserted = await insertRes.json();
  log("registro gravado em agent_releases:");
  console.log(JSON.stringify(inserted, null, 2));

  log("✅ Release publicada. Agente fará OTA na próxima checagem.");
}

main().catch((e) => die(e.stack || String(e)));
