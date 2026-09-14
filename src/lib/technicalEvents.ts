// ─────────────────────────────────────────────────────────────────────────────
// Centro de Evidências Técnicas — helper único de gravação.
// ─────────────────────────────────────────────────────────────────────────────
// FASE 1: só a infraestrutura. Nada chama isto ainda — Agent e Edge Functions
// entram na fase seguinte.
//
// REGRA: toda gravação passa por `recordTechnicalEvent`. Nenhum INSERT direto
// em `technical_events` espalhado pelo código.
//
// AUDITORIA NUNCA DERRUBA A OPERAÇÃO. A função não lança: em qualquer falha
// devolve `null`. Um evento perdido é ruim; um comando de bomba que falha
// porque o log falhou é inaceitável.
import { supabase } from "@/integrations/supabase/client";

export type TechEventCategory =
  | "internet" | "heartbeat" | "cloud" | "bridge" | "serial" | "radio" | "plc"
  | "polling" | "automation" | "command" | "scheduler" | "watchdog"
  | "communication" | "power" | "startup" | "shutdown" | "system";

export type TechEventSeverity = "info" | "warning" | "error" | "critical";

export type TechEventOrigin =
  | "cloud" | "agent" | "plc" | "radio" | "scheduler" | "automation"
  | "manual" | "local" | "unknown";

export interface TechnicalEventInput {
  farmId: string;
  eventType: string;
  category: TechEventCategory;
  severity?: TechEventSeverity;
  origin?: TechEventOrigin;
  equipmentId?: string | null;
  gatewayId?: string | null;
  /** quem emitiu: 'agent', 'automation-tick', 'web'... */
  source?: string | null;
  agentVersion?: string | null;
  platformVersion?: string | null;
  /** agrupa os eventos de UM incidente */
  correlationId?: string | null;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Grava um evento técnico. Devolve o id, ou `null` se não foi possível gravar.
 * NUNCA lança — ver o cabeçalho.
 */
export async function recordTechnicalEvent(input: TechnicalEventInput): Promise<string | null> {
  try {
    // A RPC ainda não está no `types.ts` — ele é gerado do banco vivo e esta
    // migration não foi aplicada. O cast sai sozinho quando os tipos forem
    // regenerados; até lá, tipar como `never` esconderia o nome da função.
    const rpc = supabase.rpc as unknown as (
      fn: string, args: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { message: string } | null }>;
    const { data, error } = await rpc("record_technical_event", {
      _farm_id: input.farmId,
      _event_type: input.eventType,
      _category: input.category,
      _severity: input.severity ?? "info",
      _origin: input.origin ?? "unknown",
      _equipment_id: input.equipmentId ?? null,
      _gateway_id: input.gatewayId ?? null,
      _source: input.source ?? null,
      _agent_version: input.agentVersion ?? null,
      _platform_version: input.platformVersion ?? null,
      _correlation_id: input.correlationId ?? null,
      _payload: input.payload ?? {},
      _metadata: input.metadata ?? {},
    });
    if (error) {
      console.warn("[technicalEvents] falha ao gravar:", error.message);
      return null;
    }
    return (data as string | null) ?? null;
  } catch (e) {
    console.warn("[technicalEvents] exceção ao gravar:", (e as Error)?.message);
    return null;
  }
}

/** Novo id de correlação para agrupar os eventos de um mesmo incidente. */
export function newCorrelationId(): string {
  return crypto.randomUUID();
}

/** Catálogo previsto de `event_type`. Texto livre no banco de propósito: uma
 *  integração futura pode registrar um tipo novo sem migration — perder
 *  evidência por falta de enum seria pior do que um tipo fora do catálogo. */
export const TECH_EVENT_TYPES = {
  internet:  ["internet_online", "internet_offline", "internet_high_latency", "internet_recovered"],
  heartbeat: ["heartbeat_sent", "heartbeat_missed", "heartbeat_recovered"],
  startup:   ["agent_started", "agent_restarted", "agent_updated"],
  shutdown:  ["agent_stopped"],
  bridge:    ["bridge_connected", "bridge_disconnected"],
  serial:    ["serial_port_opened", "serial_port_closed", "serial_failure"],
  plc:       ["plc_online", "plc_offline"],
  polling:   ["polling_ok", "polling_timeout"],
  radio:     ["radio_rssi_critical", "radio_comm_lost", "radio_comm_restored"],
  automation:["automatic_mode_started", "automatic_mode_command_created",
              "scheduled_shutdown_executed", "peak_hour_executed"],
  command:   ["command_created", "command_sent", "command_responded",
              "command_timeout", "command_cancelled", "command_executed"],
  watchdog:  ["safety_off", "protective_off"],
  system:    ["exception", "internal_failure"],
} as const satisfies Partial<Record<TechEventCategory, readonly string[]>>;
