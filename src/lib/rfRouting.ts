// ─────────────────────────────────────────────────────────────────────────────
// rfRouting — preferências de roteamento RS-485 + montagem de frame por comando
// ─────────────────────────────────────────────────────────────────────────────
// Persiste em localStorage qual rádio (R1/R2/R3) o Dashboard usa para enviar
// comandos e se vai através do repetidor (REP:R3:TX:Rx:...) ou direto.
//
// Mapeamento dos comandos lógicos do app para o protocolo Renov:
//   turn_on/turn_off → cmd="1", payload POSICIONAL por saída
//   status_read      → cmd="CFG", payload="STATUS" (mesmo do BombaSection: STATUS)
//
// Os hw_ids do equipment (4 dígitos hex, ex "1107") encaixam direto no TSNN
// do `buildLoRaFrame` — é exatamente o ID que o firmware filtra na resposta.

import { buildLoRaFrame, buildDirectToServer, buildViaRepetidorTx, type Radio } from "@/lib/protocol";
import { supabase } from "@/integrations/supabase/client";

const LS_RADIO = "rf_routing_radio_v1";
const LS_VIA_REP = "rf_routing_via_rep_v1";

export type RfCmdLogical = "turn_on" | "turn_off" | "status_read";

export interface RfRoutingConfig {
  radio: Radio;
  viaRepetidor: boolean;
}

export const DEFAULT_RF_ROUTING: RfRoutingConfig = {
  radio: "R1",
  viaRepetidor: false,
};

export function loadRfRouting(): RfRoutingConfig {
  try {
    const radio = (localStorage.getItem(LS_RADIO) as Radio | null) ?? DEFAULT_RF_ROUTING.radio;
    const viaRep = localStorage.getItem(LS_VIA_REP);
    return {
      radio: ["R1", "R2", "R3"].includes(radio) ? radio : DEFAULT_RF_ROUTING.radio,
      viaRepetidor: viaRep === "1",
    };
  } catch {
    return DEFAULT_RF_ROUTING;
  }
}

export function saveRfRouting(cfg: RfRoutingConfig): void {
  try {
    localStorage.setItem(LS_RADIO, cfg.radio);
    localStorage.setItem(LS_VIA_REP, cfg.viaRepetidor ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/**
 * Carrega o roteamento da nuvem (rf_routing) para a fazenda dada e
 * espelha em localStorage. Se não houver linha, mantém o cache local.
 * Não falha em caso de erro — apenas mantém o estado atual.
 */
export async function pullRfRoutingFromCloud(farmId: string): Promise<void> {
  try {
    const { data, error } = await supabase
      .from("rf_routing")
      .select("radio, via_repetidor")
      .eq("farm_id", farmId)
      .maybeSingle();
    if (error || !data) return;
    const radio = (["R1", "R2", "R3"] as const).includes(data.radio as Radio)
      ? (data.radio as Radio)
      : DEFAULT_RF_ROUTING.radio;
    saveRfRouting({ radio, viaRepetidor: !!data.via_repetidor });
  } catch {
    /* ignore */
  }
}

/**
 * Persiste o roteamento na nuvem (upsert por farm_id) e no localStorage.
 * Use quando o operador alterar a configuração na UI.
 */
export async function saveRfRoutingCloud(farmId: string, cfg: RfRoutingConfig): Promise<void> {
  saveRfRouting(cfg);
  try {
    await supabase.from("rf_routing").upsert(
      { farm_id: farmId, radio: cfg.radio, via_repetidor: cfg.viaRepetidor },
      { onConflict: "farm_id" },
    );
  } catch {
    /* sync silencioso — fica salvo localmente até nova tentativa */
  }
}

export function buildPositionalPayload(saida: number, turnOn: boolean): string {
  const n = Math.max(1, Math.min(6, Math.floor(saida) || 1));
  return "0".repeat(n - 1) + (turnOn ? "1" : "0");
}

/**
 * Monta payload combinado da PLC (multi-saída).
 * - Tamanho = `total` (1-6).
 * - Preserva o estado atual das outras saídas.
 * - Altera apenas o bit da saída alvo.
 *
 * Ex: estado="010001", saida=3, turnOn=true, total=6 → "011001"
 */
export function buildCombinedPayload(
  currentState: string | null | undefined,
  saida: number,
  turnOn: boolean,
  total: number,
): string {
  const n = Math.max(1, Math.min(6, Math.floor(total) || 1));
  const pos = Math.max(1, Math.min(n, Math.floor(saida) || 1));
  let state: string;
  const cur = currentState ?? "";
  if (new RegExp(`^[01]{${n}}$`).test(cur)) {
    state = cur;
  } else if (/^[01]{6}$/.test(cur)) {
    state = cur.substring(0, n);
  } else {
    state = "0".repeat(n);
  }
  const bit = turnOn ? "1" : "0";
  return state.substring(0, pos - 1) + bit + state.substring(pos);
}

/**
 * Converte o comando lógico em (cmd, payload) do firmware.
 *
 * Payload POSICIONAL: número de dígitos = saída; último dígito = ação.
 * Exemplos: saída 1 ON "1", saída 2 ON "01", saída 3 OFF "000".
 */
export function commandToProtocol(
  command: RfCmdLogical,
  saida: number = 1,
  totalSaidas: number = 1,
  currentOutputsState?: string | null,
): { cmd: string; payload: string } {
  if (command === "status_read") {
    return { cmd: "CFG", payload: "STATUS" };
  }

  const total = Math.max(1, Math.min(6, Math.floor(totalSaidas) || 1));
  if (total <= 1) return { cmd: "1", payload: command === "turn_on" ? "1" : "0" };
  return { cmd: "1", payload: buildCombinedPayload(currentOutputsState, saida, command === "turn_on", total) };
}

/**
 * Monta a linha completa que vai para `serialAPI.write(...)`.
 * Retorna `null` se `hwId` estiver vazio/ausente — não dá pra mandar comando
 * sem ID do equipamento (cairia no modo simulado).
 *
 * Suporta override por equipamento:
 *   - `radioOverride`: se informado (R1/R2/R3), usa esse rádio em vez do global da fazenda.
 *   - `viaRepetidorOverride`: se informado (true/false), usa esse roteamento em vez do global.
 *   - Se `null`/`undefined`, herda do `routing` (global da fazenda).
 *
 * IMPORTANTE: o formato do frame e a lógica de encapsulamento (buildLoRaFrame /
 * buildDirectToServer / buildViaRepetidorTx) NÃO mudam — a única diferença é
 * de onde vêm o rádio e o flag de repetidor.
 */
export function buildEquipmentFrame(args: {
  hwId: string | null | undefined;
  command: RfCmdLogical;
  routing?: RfRoutingConfig;
  radioOverride?: Radio | null;
  viaRepetidorOverride?: boolean | null;
  /** Número da saída alvo (1-6). Se omitido, deduz das posições 5-6 do hwId. */
  saida?: number;
  /** Total de saídas do PLC. Se omitido, usa `saida`. */
  totalSaidas?: number;
  /** Estado atual de todas as saídas (last_outputs_state). Default = tudo "0". */
  currentOutputsState?: string | null;
}): string | null {
  const hw = (args.hwId ?? "").trim();
  if (!hw) return null;
  const routing = args.routing ?? loadRfRouting();
  const radio: Radio = args.radioOverride ?? routing.radio;
  const viaRep: boolean = args.viaRepetidorOverride ?? routing.viaRepetidor;

  // TSNN = primeiros 4 chars do hw_id do equipamento (= hw_id do PLC)
  const tsnn = hw.length >= 4 ? hw.substring(0, 4) : hw;

  // Saída alvo: parâmetro explícito ou posições 5-6 do hwId
  let saida = args.saida ?? 0;
  if (!saida && hw.length >= 6) {
    saida = parseInt(hw.substring(4, 6), 10) || 1;
  }
  if (!saida) saida = 1;

  const totalSaidas = args.totalSaidas ?? 1;

  const { cmd, payload } = commandToProtocol(
    args.command,
    saida,
    totalSaidas,
    args.currentOutputsState,
  );
  const frame = buildLoRaFrame(tsnn, cmd, payload);
  return viaRep
    ? buildViaRepetidorTx(radio, frame)
    : buildDirectToServer(radio, frame);
}
