// ─────────────────────────────────────────────────────────────────────────────
// KILL SWITCH GLOBAL DO REALTIME — EMERGÊNCIA
//
// Enquanto REALTIME_DISABLED = true, TODO `supabase.channel()` do app inteiro
// devolve um stub inerte por padrão. Nenhum WebSocket é aberto.
//
// EXCEÇÃO: hooks críticos que precisam de Realtime (ex.: useCommandTracker
// para receber a resposta do Electron via UPDATE em `commands`) podem usar
// `getRealtimeChannel()` / `removeRealtimeChannel()` para acessar as APIs
// originais do Supabase — bypass explícito do kill switch, sem polling.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from "@/integrations/supabase/client";

// ATIVO POR PADRÃO — decisão deliberada. O kill switch derrubava TODO o Realtime
// do app (o stub responde `CLOSED` no subscribe), o que era a causa global do
// dashboard atrasado: nenhum evento de `equipments` chegava e os cards só mudavam
// com F5 (POÇO 12 R6 confirmado OFF no banco às 14:29:51 com o card ainda verde).
//
// Em vez de reativar os NOVE módulos de uma vez — risco de reproduzir o incidente
// que motivou o kill switch — apenas o DASHBOARD DE BOMBAS usa o bypass explícito
// getRealtimeChannel()/removeRealtimeChannel(). Os demais seguem bloqueados até
// auditoria separada: useCloudAutomation, useSiteHealth, useCommandQueueStatus,
// farmRealtimeBus, PeakHourBanner, AgentLiveLogs, PlatformServiceMode e
// AuthorshipReconciliationQueue.
//
// VITE_REALTIME_DISABLED=false libera tudo, se um dia a auditoria concluir isso.
export const REALTIME_DISABLED =
  String(import.meta.env.VITE_REALTIME_DISABLED ?? "true").toLowerCase() !== "false";

// Guardamos as implementações originais ANTES de instalar o stub, para que
// componentes específicos possam optar por Realtime real quando necessário.
type ChannelFn = typeof supabase.channel;
type RemoveChannelFn = typeof supabase.removeChannel;

const originalChannel: ChannelFn = supabase.channel.bind(supabase);
const originalRemoveChannel: RemoveChannelFn = supabase.removeChannel.bind(supabase);

export function getRealtimeChannel(topic: string, opts?: Parameters<ChannelFn>[1]) {
  return originalChannel(topic, opts as any);
}

export async function removeRealtimeChannel(channel: Parameters<RemoveChannelFn>[0]) {
  return originalRemoveChannel(channel);
}

export function installRealtimeKillSwitch(): void {
  if (!REALTIME_DISABLED) return;

  const makeStub = (topic: string) => {
    const stub: any = {
      topic,
      state: "closed",
      on: () => stub,
      subscribe: (cb?: (status: string) => void) => {
        try { cb?.("CLOSED"); } catch { /* ignore */ }
        return stub;
      },
      unsubscribe: async () => "ok",
      send: async () => "ok",
      track: async () => "ok",
      untrack: async () => "ok",
    };
    return stub;
  };

  (supabase as any).channel = (topic?: string) => makeStub(topic ?? "killswitch");
  (supabase as any).removeChannel = async () => "ok";
  (supabase as any).removeAllChannels = async () => [];
  try { (supabase as any).realtime?.disconnect?.(); } catch { /* ignore */ }

  console.warn(
    "[realtime] KILL SWITCH ATIVO — Realtime desabilitado globalmente (exceções via getRealtimeChannel).",
  );
}
