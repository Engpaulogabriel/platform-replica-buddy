/**
 * protect-restore.cjs — Reverte o pipeline de proteção, restaurando app/main.cjs
 * a partir de app/main.original.cjs e removendo app/main.jsc.
 *
 * Uso: após `npm run build`, ou para desenvolvimento local sem proteção.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const APP_DIR = path.join(ROOT, "app");
const MAIN_SRC = path.join(APP_DIR, "main.cjs");
const MAIN_BACKUP = path.join(APP_DIR, "main.original.cjs");
const MAIN_JSC = path.join(APP_DIR, "main.jsc");

if (fs.existsSync(MAIN_BACKUP)) {
  fs.copyFileSync(MAIN_BACKUP, MAIN_SRC);
  console.log("[PROTECT] app/main.cjs restaurado a partir do backup.");
}
if (fs.existsSync(MAIN_JSC)) {
  fs.unlinkSync(MAIN_JSC);
  console.log("[PROTECT] app/main.jsc removido.");
}
