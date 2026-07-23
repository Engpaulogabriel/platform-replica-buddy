export type Radio = "R1" | "R2" | "R3";

/**
 * REGRA CRÍTICA: Todo frame Serial DEVE terminar com \r (CR 0x0D).
 * Sem \r, o firmware ESP32 ignora o frame.
 */
const CR = "\r";

/**
 * Frame do protocolo:
 *   [TSNN_CMD_]{PAYLOAD}[TSNN_ETX_]\r
 */
export function buildLoRaFrame(tsnn: string, cmd: string, payload: string) {
  return `[${tsnn}_${cmd}_]{${payload}}[${tsnn}_ETX_]${CR}`;
}

/**
 * Direto (Servidor / bomba conectada sem repetidor):
 *   FRAME  (sem prefixo de rádio)
 *
 * O parâmetro `radio` é ignorado por compatibilidade com chamadas antigas.
 * Prefixos como `R1:`/`R2:`/`R3:` NÃO devem existir em envio direto.
 */
export function buildDirectToServer(_radio: Radio, frame: string) {
  return frame;
}

/**
 * Via repetidor:
 *   REP:R3:TX:Rx:FRAME  (frame já inclui \r)
 */
export function buildViaRepetidorTx(radioTx: Radio, frame: string) {
  return `REP:R3:TX:${radioTx}:${frame}`;
}

/**
 * CFG no repetidor remoto:
 *   REP:R3:CFG:...\r
 */
export function buildRepetidorCfg(cfgCmd: string) {
  return `REP:R3:${cfgCmd}${CR}`;
}

/**
 * Comando local para o Servidor ESP_A:
 *   Ex: PING\r, STATUS\r, RESET_B\r, CFG:DUMP\r
 */
export function buildServerCmd(cmd: string) {
  return `${cmd}${CR}`;
}

/**
 * Garante que um frame termina com \r.
 * Usado pelo Electron antes de enviar — safety net.
 */
export function ensureCR(frame: string): string {
  return frame.endsWith(CR) ? frame : frame + CR;
}

export function isBombaResponseLine(line: string) {
  return line.startsWith("_[") || line.includes("_[");
}

export function isRepResponseLine(line: string) {
  return line.includes("~RCR_RESP~") || line.startsWith("REP_RESP:") || line.startsWith("RCR_RESP:");
}

export function isServerResponseLine(line: string) {
  return line.startsWith("OK:") || line.startsWith("ERR:");
}

export function isCfgResponseLine(line: string) {
  return line.includes("_CFG_]") || line.includes("_CFG_");
}
