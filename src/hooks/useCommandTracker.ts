// ─────────────────────────────────────────────────────────────────────────────
// useCommandTracker — observa um único comando com 3 checagens pontuais
// ─────────────────────────────────────────────────────────────────────────────
// Estratégia: sem Realtime, sem polling contínuo, sem kill switch.
// Faz no máximo 3 SELECTs em commands, agendados por setTimeout: 1s, +2s, +3s.

import { supabase } from "@/integrations/supabase/client";

export type CommandFinalStatus = "executed" | "timeout" | "error" | "cancelled";

export interface CommandResult {
  commandId: string;
  status: CommandFinalStatus | "unknown";
  response: string | null;
  errorMessage: string | null;
  elapsedMs: number;
}

const FINAL_STATUSES: ReadonlyArray<string> = ["executed", "timeout", "error", "cancelled"];
// Intervalo entre SELECTs. O tracker segue verificando até o timeoutMs total
// passado pelo caller (ex: DUMP=12s, SET=8s, PING=5s). Antes ele parava aos 6s
// e mostrava "sem resposta" mesmo quando o Electron UPDATE chegava depois.
const POLL_INTERVAL_MS = 1_500;
const INITIAL_DELAY_MS = 800;

interface CommandTrackerOptions {
  cfgFallback?: {
    farmId: string;
    tsnn: string;
    acceptedTsnn?: string[];
  };
}

export function waitForCommand(commandId: string, timeoutMs: number = 12_000, _options: CommandTrackerOptions = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    let resolved = false;
    let activeTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (activeTimer) clearTimeout(activeTimer);
      activeTimer = null;
    };

    const finish = (result: Omit<CommandResult, "elapsedMs" | "commandId">) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve({ commandId, elapsedMs: Date.now() - start, ...result });
    };

    const finishIfFinal = (row: { status?: string; response?: string | null; error_message?: string | null } | null | undefined) => {
      if (!row?.status) return false;
      if (!FINAL_STATUSES.includes(row.status)) return false;
      const status = row.status as CommandFinalStatus;
      finish({ status, response: row.response ?? null, errorMessage: row.error_message ?? null });
      return true;
    };

    const querySnapshot = async () => {
      // Usa RPC SECURITY DEFINER para bypassar RLS: após o Electron (service_role)
      // fazer UPDATE em commands, a policy pode ocultar a linha do usuário
      // autenticado. A função get_command_result garante visibilidade.
      const { data } = await supabase
        .rpc("get_command_result", { p_command_id: commandId })
        .maybeSingle();
      return data as { status?: string; response?: string | null; error_message?: string | null } | null;
    };

    const deadline = start + Math.max(timeoutMs, 3_000);

    const runCheck = async () => {
      if (resolved) return;
      const row = await querySnapshot();
      if (finishIfFinal(row)) return;

      if (Date.now() >= deadline) {
        finish({ status: "unknown", response: null, errorMessage: "Sem resposta do worker dentro do timeout" });
        return;
      }

      activeTimer = setTimeout(() => { void runCheck(); }, POLL_INTERVAL_MS);
    };

    activeTimer = setTimeout(() => { void runCheck(); }, INITIAL_DELAY_MS);
  });
}
