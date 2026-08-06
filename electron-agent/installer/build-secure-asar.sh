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
