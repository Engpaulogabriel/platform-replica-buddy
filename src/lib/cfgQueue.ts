// ─────────────────────────────────────────────────────────────────────────────
// cfgQueue — enfileira comandos de configuração remota (CFG / Servidor / Repetidor)
// ─────────────────────────────────────────────────────────────────────────────
// Convenções de prioridade na tabela `commands`:
//   priority=1  → manual (ligar/desligar bomba)         — fura fila
//   priority=2  → cfg (CFG bomba, CFG servidor/repetidor) — acima de polling
//   priority=5  → polling automático
//
// Tipos de comando (enum command_type):
//   - 'config'    → CFG remoto da bomba ([TSNN_CFG_]{...}[TSNN_ETX_]\r)
//   - 'server'    → comando local ESP_A (PING\r, STATUS\r, RESET_B\r, CFG:...)
//   - 'repeater'  → comando do repetidor via R3 (REP:R3:...\r)
//
// Timeouts default:
//   - bomba CFG / repetidor: 10 000 ms
//   - servidor local:         2 000 ms
//
// Toda função retorna { commandId, frame } para o caller acompanhar via
// useCommandTracker.

import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

type CommandInsert = Database["public"]["Tables"]["commands"]["Insert"];
type CommandType = Database["public"]["Enums"]["command_type"];

export interface EnqueueResult {
  commandId: string;
  frame: string;
}

const CR = "\r";

const sourceDevice = (): string | null =>
  typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 80) : null;

async function insertCommand(row: Omit<CommandInsert, "id" | "created_at">): Promise<EnqueueResult> {
  const { data, error } = await supabase
    .from("commands")
    .insert({
      ...row,
      client_event_id: row.client_event_id ?? crypto.randomUUID(),
      source_device: row.source_device ?? sourceDevice(),
    })
    .select("id, frame")
    .single();
  if (error) throw new Error(error.message);
  const r = data as { id: string; frame: string };
  return { commandId: r.id, frame: r.frame };
}

// ──────────────────────────────────────────────────────────────────────────
// 4.1 — CFG remoto da BOMBA
// Frame: [TSNN_CFG_]{COMANDO}[TSNN_ETX_]\r
// ──────────────────────────────────────────────────────────────────────────

export type PumpCfgCommand =
  // Diagnóstico e Sistema
  | "PING"
  | "STATUS"
  | "DUMP"
  | "SAVE"
  | "REBOOT"
  | "FACTORY_RESET"
  // Identificação
  | { kind: "SET_ID"; tddnn: string }            // Ex: "1107"
  | { kind: "SET_TIPO"; value: 1 | 2 | 3 }       // 1=Poço, 2=Bombeamento, 3=Nível
  | { kind: "SET_DIR"; value: 1 | 2 | 3 }        // 1=A, 2=B, 3=C
  | { kind: "SET_NN"; hex: string }              // 00..FF
  | { kind: "SET_NOME"; text: string }           // até 31 chars
  // Automação e Perfil
  | { kind: "SET_PROFILE"; value: 0 | 1 | 2 | 3 } // 0=Direto, 1=Auto, 2=Bombeamento, 3=Pulso M/A
  | { kind: "SET_TSEM"; minutes: number }         // 1..10080 min
  | { kind: "SET_NIVEL"; value: 0 | 1 }           // 0=desligado, 1=ligado
  | { kind: "SET_NIV1_PIN"; gpio: number }
  | { kind: "SET_NIV2_PIN"; gpio: number }
  // Calibração analógica (metros)
  | { kind: "SET_CALIB_N1"; meters: number }
  | { kind: "SET_CALIB_N2"; meters: number }
  // Tempos de rádio (ms)
  | { kind: "SET_TX_GUARD"; ms: number }          // 50..5000
  | { kind: "SET_SLOT_DELAY"; ms: number }        // 0..120000
  | { kind: "SET_WATCH_DELAY"; ms: number }       // 100..30000
  | { kind: "SET_WATCH_WINDOW"; ms: number }      // 1000..300000
  // Escape hatch
  | { kind: "RAW"; payload: string };

function pumpCfgPayload(cmd: PumpCfgCommand): string {
  if (typeof cmd === "string") return cmd;
  switch (cmd.kind) {
    case "SET_ID": return `SET_ID:${cmd.tddnn}`;
    case "SET_TIPO": return `SET_TIPO:${cmd.value}`;
    case "SET_DIR": return `SET_DIR:${cmd.value}`;
    case "SET_NN": return `SET_NN:${cmd.hex.toUpperCase()}`;
    case "SET_NOME": return `SET_NOME:${cmd.text.slice(0, 31)}`;
    case "SET_PROFILE": return `SET_PROFILE:${cmd.value}`;
    case "SET_TSEM": return `SET_TSEM:${Math.max(1, Math.min(10080, Math.floor(cmd.minutes)))}`;
    case "SET_NIVEL": return `SET_NIVEL:${cmd.value}`;
    case "SET_NIV1_PIN": return `SET_NIV1_PIN:${Math.max(0, Math.floor(cmd.gpio))}`;
    case "SET_NIV2_PIN": return `SET_NIV2_PIN:${Math.max(0, Math.floor(cmd.gpio))}`;
    case "SET_CALIB_N1": return `SET_CALIB_N1:${cmd.meters.toFixed(2)}`;
    case "SET_CALIB_N2": return `SET_CALIB_N2:${cmd.meters.toFixed(2)}`;
    case "SET_TX_GUARD": return `SET_TX_GUARD:${Math.max(50, Math.min(5000, Math.floor(cmd.ms)))}`;
    case "SET_SLOT_DELAY": return `SET_SLOT_DELAY:${Math.max(0, Math.min(120000, Math.floor(cmd.ms)))}`;
    case "SET_WATCH_DELAY": return `SET_WATCH_DELAY:${Math.max(100, Math.min(30000, Math.floor(cmd.ms)))}`;
    case "SET_WATCH_WINDOW": return `SET_WATCH_WINDOW:${Math.max(1000, Math.min(300000, Math.floor(cmd.ms)))}`;
    case "RAW": return cmd.payload;
  }
}

export async function enqueuePumpCfg(args: {
  farmId: string;
  equipmentId?: string | null;
  tsnn: string;
  command: PumpCfgCommand;
  userId?: string | null;
  timeoutMs?: number;
}): Promise<EnqueueResult> {
  const payload = pumpCfgPayload(args.command);
  const frame = `[${args.tsnn}_CFG_]{${payload}}[${args.tsnn}_ETX_]${CR}`;
  return insertCommand({
    farm_id: args.farmId,
    equipment_id: args.equipmentId ?? null,
    plc_hw_id: args.tsnn,
    type: "config" as CommandType,
    priority: 2,
    frame,
    timeout_ms: args.timeoutMs ?? 10_000,
    created_by: args.userId ?? null,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// 4.2 — Comandos do SERVIDOR LOCAL (ESP_A)
// Frame: <CMD>\r  (sem prefixo R1/R2/R3, vai direto pela USB)
// ──────────────────────────────────────────────────────────────────────────

// Lista de parâmetros aceitos pelo Servidor (CFG:SET:PARAM=valor)
export type ServerParam =
  | "COALESCE_MS"
  | "DEDUP_WINDOW_MS"
  | "FSM_MAX_STUCK_MS"
  | "I2C_RECOVERY_MAX"
  | "BURST_COOLDOWN_MS"
  | "MODE_SETTLE_MS"
  | "RADIO_TX_MARGIN_MS"
  | "AIR_GUARD_MS"
  | "RX_FRAME_TIMEOUT_MS"
  | "POLL_B_EVERY_MS"
  | "PREP_WAIT_LOCAL_MS"
  | "PREP_WAIT_I2C_MS"
  | "ESP_B_AUTO_RESET_MS"
  | "AUTO_RESET";

export type ServerCommand =
  | "PING"
  | "STATUS"
  | "RESET"
  | "RESET_B"
  | "AUTO_RESET_ON"
  | "AUTO_RESET_OFF"
  | "AUTO_RESET_STATUS"
  | "DEBUG"
  | "DEBUG_OFF"
  | "CFG:DUMP"
  | "CFG:DEFAULT"
  | { kind: "CFG_SET"; param: ServerParam | string; value: string | number }
  | { kind: "CFG_GET"; param: ServerParam | string }
  | { kind: "RAW"; payload: string };

function serverFrame(cmd: ServerCommand): string {
  if (typeof cmd === "string") return cmd + CR;
  switch (cmd.kind) {
    case "CFG_SET": return `CFG:SET:${cmd.param}=${cmd.value}${CR}`;
    case "CFG_GET": return `CFG:GET:${cmd.param}${CR}`;
    case "RAW":     return cmd.payload + CR;
  }
}

export async function enqueueServerCommand(args: {
  farmId: string;
  command: ServerCommand;
  userId?: string | null;
  timeoutMs?: number;
}): Promise<EnqueueResult> {
  const frame = serverFrame(args.command);
  return insertCommand({
    farm_id: args.farmId,
    equipment_id: null,
    plc_hw_id: null,
    type: "server" as CommandType,
    priority: 2,
    frame,
    timeout_ms: args.timeoutMs ?? 2_000,
    created_by: args.userId ?? null,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// 4.3 — Comandos do REPETIDOR (via R3)
// Frame: REP:R3:<CMD>\r
// ──────────────────────────────────────────────────────────────────────────

export type RepeaterRadio = "R1" | "R2" | "R3";

// Parâmetros do Repetidor (CFG:SET_PARAM:NOME=valor)
export type RepeaterParam =
  | "WDT_TIMEOUT_S"
  | "HEAP_MIN_BYTES"
  | "HEAP_CHECK_INTERVAL"
  | "I2C_RECOVERY_MAX"
  | "MODE_SETTLE_MS"
  | "RADIO_TX_MARGIN_MS"
  | "AIR_GUARD_MS"
  | "PREP_WAIT_LOCAL_MS"
  | "PREP_WAIT_I2C_MS"
  | "POLL_B_EVERY_MS"
  | "DEDUP_WINDOW_MS";

export type RepeaterCommand =
  // Diag (sem login)
  | "PING"                                 // CFG:PING
  | "STATUS"                               // STATUS (no firmware vai via RCR)
  | "RESET"                                // RESET ESP A
  | "RESET_B"                              // RESET ESP B
  | "CFG:HELP"                             // lista todos os comandos
  // Auth
  | { kind: "LOGIN"; password: string }    // CFG:LOGIN:<senha>
  | "LOGOUT"                               // CFG:LOGOUT
  // Sessão CFG
  | "CFG:DUMP"
  | "CFG:SAVE"
  | "CFG:LOAD"                             // recarrega NVS
  | "CFG:RESET"                            // factory reset
  | "CFG:REBOOT"
  | "CFG:GET_S"                            // ler região S
  // Região
  | { kind: "CFG_SET_S"; value: number }
  // Tabelas de NN por rádio
  | { kind: "CFG_LIST"; radio: RepeaterRadio }
  | { kind: "CFG_ADD"; radio: RepeaterRadio; nn: string }
  | { kind: "CFG_DEL"; radio: RepeaterRadio; nn: string }
  | { kind: "CFG_CLEAR"; radio: RepeaterRadio }
  | { kind: "CFG_SET_TABLE"; radio: RepeaterRadio; nns: string[] }
  // Timings
  | { kind: "CFG_SET_PARAM"; param: RepeaterParam | string; value: string | number }
  | { kind: "CFG_GET_PARAM"; param: RepeaterParam | string }
  // Escape
  | { kind: "RAW"; payload: string };

function repeaterPayload(cmd: RepeaterCommand): string {
  if (typeof cmd === "string") {
    switch (cmd) {
      case "PING": return "CFG:PING";
      case "STATUS": return "STATUS";
      case "RESET": return "RESET";
      case "RESET_B": return "RESET_B";
      case "LOGOUT": return "CFG:LOGOUT";
      case "CFG:HELP": return "CFG:HELP";
      case "CFG:DUMP": return "CFG:DUMP";
      case "CFG:SAVE": return "CFG:SAVE";
      case "CFG:LOAD": return "CFG:LOAD";
      case "CFG:RESET": return "CFG:RESET";
      case "CFG:REBOOT": return "CFG:REBOOT";
      case "CFG:GET_S": return "CFG:GET_S";
    }
  }
  switch (cmd.kind) {
    case "LOGIN": return `CFG:LOGIN:${cmd.password}`;
    case "CFG_SET_S": return `CFG:SET_S:${cmd.value}`;
    case "CFG_LIST": return `CFG:LIST:${cmd.radio}`;
    case "CFG_ADD": return `CFG:ADD:${cmd.radio}:${cmd.nn.toUpperCase()}`;
    case "CFG_DEL": return `CFG:DEL:${cmd.radio}:${cmd.nn.toUpperCase()}`;
    case "CFG_CLEAR": return `CFG:CLEAR:${cmd.radio}`;
    case "CFG_SET_TABLE": return `CFG:SET:${cmd.radio}:${cmd.nns.map(n => n.toUpperCase()).join(",")}`;
    case "CFG_SET_PARAM": return `CFG:SET_PARAM:${cmd.param}=${cmd.value}`;
    case "CFG_GET_PARAM": return `CFG:GET_PARAM:${cmd.param}`;
    case "RAW": return cmd.payload;
  }
}

function repeaterFrame(cmd: RepeaterCommand): string {
  // Sempre via Servidor → encapsulado como REP:R3:<payload>\r
  return `REP:R3:${repeaterPayload(cmd)}${CR}`;
}

export async function enqueueRepeaterCommand(args: {
  farmId: string;
  equipmentId?: string | null;
  command: RepeaterCommand;
  userId?: string | null;
  timeoutMs?: number;
}): Promise<EnqueueResult> {
  const frame = repeaterFrame(args.command);
  return insertCommand({
    farm_id: args.farmId,
    equipment_id: args.equipmentId ?? null,
    plc_hw_id: null,
    type: "repeater" as CommandType,
    priority: 2,
    frame,
    timeout_ms: args.timeoutMs ?? 15_000,
    created_by: args.userId ?? null,
  });
}
