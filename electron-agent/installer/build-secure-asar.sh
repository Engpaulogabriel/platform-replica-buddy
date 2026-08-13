#!/usr/bin/env bash
# ===========================================================================
#  build-secure-asar.sh - RENOV Agent
#  Gera o app.asar de distribuicao com o main.cjs OFUSCADO.
# ---------------------------------------------------------------------------
#  Por que ofuscar: "npx asar extract app.asar ./" extrai o bundle inteiro.
#  A ofuscacao nao impede a extracao - ela torna o main.cjs ILEGIVEL depois
#  de extraido (control-flow flattening + string array RC4 + dead code).
#
#  IMPORTANTE: a ofuscacao NAO e opcional em producao. O agente faz um
#  self-check (verifyAgentObfuscation): se o main.cjs em execucao NAO tiver a
#  assinatura de ofuscacao, ele reporta tampering ("unsigned_binary"). Ou seja,
#  um asar empacotado a partir do fonte limpo dispara alarme de seguranca.
#  SEMPRE gere o asar de distribuicao por este script.
#
#  Uso:
#    ./installer/build-secure-asar.sh            # gera release/app.asar
#    ./installer/build-secure-asar.sh /caminho/app.asar
#
#  O QUE ELE FAZ
#    1. Sincroniza main.cjs -> app/main.cjs (o app/ e a raiz do asar)
#    2. Faz backup de app/main.cjs em app/main.original.cjs
#    3. Ofusca app/main.cjs no lugar
#    4. node --check no arquivo ofuscado (falha cedo se quebrou a sintaxe)
#    5. Remove o .py da raiz do asar (a bridge vai como serial_bridge.exe em
#       extraResources; o .py nunca deve entrar no bundle de distribuicao)
#    6. Empacota o asar
#    7. RESTAURA app/main.cjs a partir do backup (o fonte NUNCA fica ofuscado)
#    8. Imprime sha256 + tamanho, que sao o que deve ir para agent_releases
#
#  DEPOIS DE GERAR - obrigatorio:
#    O agente compara o sha256 do app.asar em execucao com
#    agent_releases.file_hash e, a partir da v3.25.42, BLOQUEIA a operacao se
#    divergir. Registre SEMPRE o hash impresso ao final na tabela agent_releases
#    (via installer/../scripts/publish-release.cjs ou o fluxo de deploy).
# ===========================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "$HERE/.." && pwd)"
APP_DIR="$AGENT_DIR/app"
MAIN_SRC="$AGENT_DIR/main.cjs"
MAIN_APP="$APP_DIR/main.cjs"
# CRITICO: o backup do fonte limpo fica FORA de app/. Se ficar dentro (como era
# ate v3.25.44), o `asar pack app` o empacota e VAZA o main.cjs nao-ofuscado
# dentro do asar de distribuicao — anulando a ofuscacao.
MAIN_BAK="$AGENT_DIR/.main.original.cjs.bak"
OUT="${1:-$AGENT_DIR/release/app.asar}"

echo "[build-secure] agente:  $AGENT_DIR"
echo "[build-secure] saida:   $OUT"

# --- Ferramentas ----------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }
OBF="npx --no-install javascript-obfuscator"
if ! (cd "$AGENT_DIR" && $OBF --version >/dev/null 2>&1); then
  echo "[build-secure] ERRO: javascript-obfuscator nao encontrado."
  echo "               rode: (cd '$AGENT_DIR' && npm install javascript-obfuscator)"
  exit 1
fi
ASAR="npx --no-install asar"
if ! (cd "$AGENT_DIR" && $ASAR --version >/dev/null 2>&1); then
  echo "[build-secure] ERRO: asar nao encontrado. rode: (cd '$AGENT_DIR' && npm install @electron/asar)"
  exit 1
fi

if [ ! -f "$MAIN_SRC" ]; then
  echo "[build-secure] ERRO: $MAIN_SRC nao existe"; exit 1
fi

# --- 1) sincroniza o fonte instalador -> raiz do asar ---------------------
cp "$MAIN_SRC" "$MAIN_APP"
echo "[build-secure] main.cjs sincronizado -> app/"

# --- 1b) sincroniza a VERSAO -> app/package.json --------------------------
# BUG historico (ate 3.25.48): so o main.cjs era sincronizado, entao o
# package.json DENTRO do asar ficava na versao antiga. Como
# AGENT_VERSION = require("./package.json").version le esse package.json,
# uma release "3.25.48" rodava o codigo novo mas se IDENTIFICAVA como 3.25.47
# (nenhuma fazenda reportava a versao nova). Sincronizar aqui e obrigatorio.
SRC_VER=$(node -p "require('$AGENT_DIR/package.json').version")
node -e "const fs=require('fs');const p='$APP_DIR/package.json';const d=JSON.parse(fs.readFileSync(p,'utf8'));d.version='$SRC_VER';fs.writeFileSync(p,JSON.stringify(d,null,2)+'\n');"
echo "[build-secure] versao sincronizada -> app/package.json = $SRC_VER"

# --- 2) backup do fonte limpo (idempotente) -------------------------------
# Se ja existe backup de uma rodada anterior, restaura antes (garante que
# nunca ofuscamos um arquivo ja ofuscado).
if [ -f "$MAIN_BAK" ]; then
  cp "$MAIN_BAK" "$MAIN_APP"
else
  cp "$MAIN_APP" "$MAIN_BAK"
fi

# O .py (bridge fallback) e o .exe (bridge compilada, se algum packager a deixou
# em app/) NAO podem entrar no asar: Python/exe nao rodam de dentro do asar e o
# .exe so incha o bundle (vai em resources/, ao lado do app.asar). Movemos ambos
# para fora da raiz do asar durante o pack e devolvemos no trap.
PY_APP="$APP_DIR/serial_bridge_persistent.py"
PY_STASH="$AGENT_DIR/.serial_bridge_persistent.py.stash"
EXE_APP="$APP_DIR/serial_bridge.exe"
EXE_STASH="$AGENT_DIR/.serial_bridge.exe.stash"

restore() {
  [ -f "$MAIN_BAK" ] && cp "$MAIN_BAK" "$MAIN_APP" && rm -f "$MAIN_BAK"
  [ -f "$PY_STASH" ] && mv "$PY_STASH" "$PY_APP"
  [ -f "$EXE_STASH" ] && mv "$EXE_STASH" "$EXE_APP"
  # FASE 3: remove o ofuscado temporario se o build abortou antes de cifrar
  [ -f "${OBF_TMP:-}" ] && [ "${RENOV_ENCRYPT_ASAR:-0}" != "1" ] && rm -f "$OBF_TMP"
  # FASE 3 piloto: reverte o entry-point no FONTE (o asar ja foi empacotado com
  # loader.cjs dentro). O fonte volta a main=main.cjs e sem loader.cjs em app/.
  rm -f "$APP_DIR/loader.cjs"
  node -e "try{const fs=require('fs');const p='$APP_DIR/package.json';const d=JSON.parse(fs.readFileSync(p,'utf8'));if(d.main!=='main.cjs'){d.main='main.cjs';fs.writeFileSync(p,JSON.stringify(d,null,2)+'\n');}}catch(_){}" 2>/dev/null || true
  return 0
}
trap restore EXIT

# --- 3) ofusca no lugar ---------------------------------------------------
echo "[build-secure] ofuscando main.cjs ..."
(cd "$AGENT_DIR" && $OBF "$MAIN_APP" --output "$MAIN_APP" \
  --compact true \
  --control-flow-flattening true \
  --control-flow-flattening-threshold 0.75 \
  --dead-code-injection true \
  --dead-code-injection-threshold 0.4 \
  --string-array true \
  --string-array-encoding rc4 \
  --string-array-threshold 0.75 \
  --self-defending true \
  --disable-console-output false \
  --reserved-names "^_bootLog$")

# --- 4) valida sintaxe do arquivo ofuscado --------------------------------
node --check "$MAIN_APP"
echo "[build-secure] node --check OK (ofuscado)"

# --- 4b) FASE 3: captura o main.cjs OFUSCADO antes do restore (para cifrar) -
# O alvo da cifragem AES e a LOGICA DE NEGOCIO (main.cjs ofuscado), nao os bytes
# do asar — nao da para montar/executar um asar a partir de um buffer em memoria,
# mas da para compilar o JS decifrado. So captura quando RENOV_ENCRYPT_ASAR=1.
OBF_TMP="$AGENT_DIR/.main.obf.tmp"
if [ "${RENOV_ENCRYPT_ASAR:-0}" = "1" ]; then
  cp "$MAIN_APP" "$OBF_TMP"
fi

# --- 4c) FASE 3 build PILOTO: entry-point do asar vira loader.cjs ----------
# Automatiza o corte que antes era manual. Com RENOV_ENCRYPT_ASAR=1 o asar passa a
# ter loader.cjs como main (decifra main.enc no boot); main.cjs OFUSCADO fica no
# asar como FALLBACK (loader cai em require('./main.cjs') se a decifragem falhar →
# nunca brica; ver enforcement OFF). Sem a env, o build e NORMAL (main=main.cjs).
# O fonte e revertido pelo trap restore() apos o pack.
if [ "${RENOV_ENCRYPT_ASAR:-0}" = "1" ]; then
  if [ ! -f "$AGENT_DIR/loader.cjs" ]; then
    echo "[build-secure] ERRO FASE 3: $AGENT_DIR/loader.cjs ausente"; exit 6
  fi
  cp "$AGENT_DIR/loader.cjs" "$APP_DIR/loader.cjs"
  node -e "const fs=require('fs');const p='$APP_DIR/package.json';const d=JSON.parse(fs.readFileSync(p,'utf8'));d.main='loader.cjs';fs.writeFileSync(p,JSON.stringify(d,null,2)+'\n');"
  echo "[build-secure] FASE 3: entry-point do asar = loader.cjs (main.cjs obfuscado = fallback)"
fi

# --- 5) .py e .exe NUNCA entram no asar (movidos, nao deletados) ----------
[ -f "$PY_APP" ] && mv "$PY_APP" "$PY_STASH"
[ -f "$EXE_APP" ] && mv "$EXE_APP" "$EXE_STASH"

# --- 6) empacota ----------------------------------------------------------
mkdir -p "$(dirname "$OUT")"
(cd "$AGENT_DIR" && $ASAR pack app "$OUT")
echo "[build-secure] asar empacotado"

# --- 6a) VERIFICACAO ANTI-VAZAMENTO: nada de fonte limpa / binarios no asar -
LEAKS=$(cd "$AGENT_DIR" && $ASAR list "$OUT" 2>/dev/null | grep -iE 'main\.original|\.py$|\.exe$|\.bak$' || true)
if [ -n "$LEAKS" ]; then
  echo "[build-secure] ERRO CRITICO: arquivos proibidos dentro do asar:"
  echo "$LEAKS"
  echo "               (fonte limpa / binario). Build ABORTADO."
  rm -f "$OUT"
  exit 4
fi
echo "[build-secure] asar sem vazamentos (sem main.original / .py / .exe / .bak)"

# --- 6b) VERIFICACAO OBRIGATORIA: o asar empacotado TEM que estar ofuscado --
# A ofuscacao ja falhou silenciosamente em teste (asar saiu legivel). O agente
# so faz self-check em runtime; aqui garantimos ANTES de distribuir: extrai o
# main.cjs de dentro do asar e exige a assinatura de ofuscacao. Se o codigo sair
# legivel, ABORTA o build (nao gera pacote inseguro).
VERIFY_DIR="$(mktemp -d)"
(cd "$AGENT_DIR" && $ASAR extract "$OUT" "$VERIFY_DIR") >/dev/null 2>&1
HITS=$(grep -o '_0x[a-f0-9]\{4,\}' "$VERIFY_DIR/main.cjs" 2>/dev/null | wc -l | tr -d ' ')
rm -rf "$VERIFY_DIR"
if [ "${HITS:-0}" -lt 500 ]; then
  echo "[build-secure] ERRO CRITICO: o asar NAO esta ofuscado (marcadores _0x=$HITS)."
  echo "               O build foi ABORTADO para nao gerar um pacote inseguro."
  echo "               Rode de novo; se persistir, verifique o javascript-obfuscator."
  rm -f "$OUT"
  exit 3
fi
echo "[build-secure] ofuscacao confirmada no asar (marcadores _0x=$HITS)"

# --- 7) restaura o fonte (via trap) e 8) imprime hash ---------------------
restore; trap - EXIT

SIZE=$(wc -c < "$OUT" | tr -d ' ')
if have shasum; then HASH=$(shasum -a 256 "$OUT" | awk '{print $1}');
elif have sha256sum; then HASH=$(sha256sum "$OUT" | awk '{print $1}');
else HASH="(sha256 indisponivel)"; fi

echo ""
echo "==========================================================="
echo " app.asar gerado: $OUT"
echo " sha256:          $HASH"
echo " tamanho:         $SIZE bytes"
echo "-----------------------------------------------------------"
echo " REGISTRE este sha256 em agent_releases.file_hash para esta"
echo " versao. O agente BLOQUEIA a operacao se o hash divergir."
echo "==========================================================="

# --- 9) FASE 3 (OPCIONAL): cifra o main.cjs ofuscado com AES-256-GCM -------
# So roda quando RENOV_ENCRYPT_ASAR=1. Gera main.enc = [12B IV][ciphertext][16B TAG]
# a partir do main.cjs OFUSCADO (capturado em 4b) e imprime a CHAVE (base64) que
# deve ir para agent_release_keys.aes_key desta versao. O build normal (sem a env)
# NAO e afetado. So use no BUILD PILOTO enquanto a FASE 3 nao for promovida.
if [ "${RENOV_ENCRYPT_ASAR:-0}" = "1" ]; then
  if [ ! -f "$OBF_TMP" ]; then
    echo "[build-secure] ERRO FASE 3: $OBF_TMP ausente (ofuscado nao capturado)."; exit 5
  fi
  ENC_OUT="$(dirname "$OUT")/main.enc"
  echo ""
  echo "[build-secure] FASE 3: cifrando main.cjs ofuscado (AES-256-GCM) -> $ENC_OUT"
  AES_KEY_B64=$(node -e '
    const fs=require("fs"),crypto=require("crypto");
    const inp=process.argv[1], out=process.argv[2];
    const key=crypto.randomBytes(32), iv=crypto.randomBytes(12);
    const data=fs.readFileSync(inp);
    const c=crypto.createCipheriv("aes-256-gcm",key,iv);
    const ct=Buffer.concat([c.update(data),c.final()]);
    const tag=c.getAuthTag();
    fs.writeFileSync(out,Buffer.concat([iv,ct,tag]));
    process.stdout.write(key.toString("base64"));
  ' "$OBF_TMP" "$ENC_OUT")
  rm -f "$OBF_TMP"
  if have shasum; then ENC_HASH=$(shasum -a 256 "$ENC_OUT" | awk '{print $1}');
  elif have sha256sum; then ENC_HASH=$(sha256sum "$ENC_OUT" | awk '{print $1}');
  else ENC_HASH="(sha256 indisponivel)"; fi
  ENC_SIZE=$(wc -c < "$ENC_OUT" | tr -d ' ')
  echo ""
  echo "==========================================================="
  echo " FASE 3 — main.enc gerado: $ENC_OUT"
  echo " sha256(main.enc): $ENC_HASH"
  echo " tamanho(main.enc):$ENC_SIZE bytes"
  echo " AES key (base64):"
  echo "   $AES_KEY_B64"
  echo "-----------------------------------------------------------"
  echo " REGISTRE a chave acima em agent_release_keys (version='$SRC_VER'):"
  echo "   INSERT INTO agent_release_keys(version,aes_key) VALUES('$SRC_VER','<chave>')"
  echo "   ON CONFLICT (version) DO UPDATE SET aes_key=EXCLUDED.aes_key;"
  echo " ENTRY-POINT ja cortado AUTOMATICAMENTE: o app.asar acima ja tem"
  echo " loader.cjs como main (main.cjs obfuscado fica como fallback)."
  echo " FALTA (manual): 1) SUBIR main.enc no Storage em"
  echo "    agent-releases/$SRC_VER/main.enc  (o loader baixa por OTA via"
  echo "    agent-asar-key; NAO precisa mais empacotar em resources/);"
  echo " 2) registrar a chave em agent_release_keys (version='$SRC_VER');"
  echo " 3) registrar o sha256 do app.asar em agent_releases."
  echo " NUNCA suba a chave AES junto do artefato. O loader cacheia o CODIGO"
  echo " selado (DPAPI/KEK) em %ProgramData%\\Renov\\main.enc.cache p/ offline."
  echo "==========================================================="
fi
