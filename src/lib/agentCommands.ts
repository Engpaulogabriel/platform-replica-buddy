// ─────────────────────────────────────────────────────────────────────────────
// agentCommands — fila de comandos remotos para o Agent Electron da fazenda
// ─────────────────────────────────────────────────────────────────────────────
// O Agent (electron-agent/main.cjs) escuta a tabela `agent_commands` via
// Realtime e executa ações como abrir/fechar a porta serial, listar portas,
// pausar polling, etc. Aqui criamos os helpers de TX + espera de resposta.

import { supabase } from "@/integrations/supabase/client";

export type AgentCmdKind =
  | "open_port"
  | "close_port"
  | "change_port"
  | "hard_reset_bridge"
  | "set_log_level"
  | "send_manual_frame"
  | "pause_polling"
  | "resume_polling"
  | "list_ports"
  | "agent_restart"
  | "update_agent"
  | "force_reboot"
  | "force_rollback"
  | "start_log_stream"
  | "renew_log_stream"
  | "stop_log_stream";


export type AgentCmdStatus = "pending" | "ack" | "executing" | "done" | "error" | "expired";

export interface AgentCmdResult {
  status: AgentCmdStatus;
  result?: { response?: string; latency_ms?: number; data?: unknown } | null;
  error_message?: string | null;
  duration_ms?: number | null;
}

interface EnqueueArgs {
  farmId: string;
  kind: AgentCmdKind;
  payload?: Record<string, unknown>;
  expiresInSec?: number; // default 60
}

export async function enqueueAgentCommand({
  farmId,
  kind,
  payload = {},
  expiresInSec = 60,
}: EnqueueArgs): Promise<string> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id ?? null;

  const expiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();

  const { data, error } = await supabase
    .from("agent_commands")
    .insert([
      {
        farm_id: farmId,
        kind,
        payload: payload as never,
        created_by: userId,
        expires_at: expiresAt,
      },
    ])
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? "Falha ao enfileirar comando");
  }
  return data.id as string;
}

/** Aguarda até o agent finalizar o comando (status final) ou expirar timeout. */
export async function waitForAgentCommand(
  commandId: string,
  timeoutMs = 15_000,
): Promise<AgentCmdResult> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  while (Date.now() < deadline) {
    const { data, error } = await supabase
      .from("agent_commands")
      .select("status, result, error_message, duration_ms")
      .eq("id", commandId)
      .maybeSingle();

    if (error) {
      // tenta de novo — pode ser RLS transitório
    } else if (data) {
      const status = data.status as AgentCmdStatus;
      if (status === "done" || status === "error" || status === "expired") {
        return {
          status,
          result: (data.result as AgentCmdResult["result"]) ?? null,
          error_message: data.error_message,
          duration_ms: data.duration_ms,
        };
      }
    }
    await new Promise((r) => setTimeout(r, 600));
  }

  return {
    status: "expired",
    error_message: `Sem resposta do Agent em ${(timeoutMs / 1000).toFixed(0)}s`,
  };
}

/** Helper combinado: enfileira + espera. */
export async function runAgentCommand(
  args: EnqueueArgs & { timeoutMs?: number },
): Promise<{ commandId: string; result: AgentCmdResult }> {
  const commandId = await enqueueAgentCommand(args);
  const result = await waitForAgentCommand(commandId, args.timeoutMs ?? 15_000);
  return { commandId, result };
}
