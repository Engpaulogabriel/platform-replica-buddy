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
import { isFarmMigrated } from "@/lib/migrationRegistry";
import { getSupabaseForFarm } from "@/lib/supabaseRouter";

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

// Bind defensivo: este módulo é importado por libs de baixo nível (automationLog,
// commandWorker) que aparecem em suítes onde o cliente é mockado parcialmente.
// Um `.bind` direto quebrava o CARREGAMENTO desses testes por um detalhe que não
// tem nada a ver com o que eles verificam.
const noChannel = ((topic: string) => {
  throw new Error(`[realtime] cliente sem suporte a channel() — topic "${topic}"`);
}) as unknown as ChannelFn;
const originalChannel: ChannelFn =
  typeof supabase?.channel === "function" ? supabase.channel.bind(supabase) : noChannel;
const originalRemoveChannel: RemoveChannelFn =
  typeof supabase?.removeChannel === "function"
    ? supabase.removeChannel.bind(supabase)
    : (async () => "ok") as unknown as RemoveChannelFn;

// ─────────────────────────────────────────────────────────────────────────────
// DUAL-BACKEND — Realtime NÃO é fonte válida para fazenda migrada
// ─────────────────────────────────────────────────────────────────────────────
// `originalChannel` está amarrado ao singleton do backend ANTIGO. Para uma
// fazenda já promovida ao backend novo isso é duplamente errado:
//
//   1. o canal assina `farm_id=eq.<fazenda>` no projeto ANTIGO, cujas linhas
//      estão congeladas desde o cutover — nenhum evento chegará;
//   2. o subscribe responde SUBSCRIBED assim mesmo, e a tela conclui
//      "Realtime conectado" — o que DESLIGA a rede de segurança e congela os
//      dados. Com a regra de offline comparando contra Date.now(), o card
//      acaba declarando OFFLINE sem o banco sustentar essa conclusão.
//
// O backend novo, por sua vez, não publica tabelas em `supabase_realtime`
// (publication vazia). Então, hoje, a resposta honesta para uma fazenda
// migrada é: Realtime INDISPONÍVEL. Quem atualiza é o polling dedicado.
//
// Fazendas NÃO migradas seguem exatamente o caminho de sempre.
const INERT = Symbol.for("renov.realtime.inert");

/** Há Realtime operacional utilizável para esta fazenda? */
export function isRealtimeAvailableForFarm(farmId: string | null | undefined): boolean {
  return !isFarmMigrated(farmId);
}

/** Canal que nunca conecta e se declara CLOSED — sem WebSocket, sem mentira. */
function makeInertChannel(topic: string) {
  const inert: any = {
    topic,
    state: "closed",
    [INERT]: true,
    on: () => inert,
    subscribe: (cb?: (status: string) => void) => {
      try { cb?.("CLOSED"); } catch { /* ignore */ }
      return inert;
    },
    unsubscribe: async () => "ok",
    send: async () => "ok",
    track: async () => "ok",
    untrack: async () => "ok",
  };
  return inert;
}

/**
 * `farmId` é OPCIONAL de propósito: chamadas globais (sem fazenda) e todos os
 * consumidores existentes mantêm o comportamento atual, byte por byte. Quem
 * assina dados FARM-SCOPED deve informar a fazenda.
 */
export function getRealtimeChannel(
  topic: string,
  opts?: Parameters<ChannelFn>[1],
  farmId?: string | null,
) {
  if (farmId !== undefined && !isRealtimeAvailableForFarm(farmId)) {
    return makeInertChannel(topic);
  }
  return originalChannel(topic, opts as any);
}

/**
 * Canal de BROADCAST da fazenda — no cliente DELA.
 *
 * Diferença essencial para `getRealtimeChannel`: broadcast NÃO depende de
 * `supabase_realtime` publication. É mensagem ponto-a-ponto por WebSocket entre
 * quem publica (o Agent) e quem escuta (esta tela). Portanto, para uma fazenda
 * migrada, o canal correto é o do backend NOVO — que é onde o Agent dela está
 * conectado e publicando. Assinar o antigo aqui seria escutar uma sala vazia.
 *
 * Isto NÃO habilita Realtime no projeto novo: nenhuma publication é criada nem
 * alterada. Só abre a conexão de cliente no projeto certo.
 */
export function getFarmBroadcastChannel(
  topic: string,
  farmId: string | null | undefined,
  opts?: Parameters<ChannelFn>[1],
) {
  const client = getSupabaseForFarm(farmId);
  return client.channel(topic, opts as any);
}

export async function removeFarmBroadcastChannel(
  farmId: string | null | undefined,
  channel: Parameters<RemoveChannelFn>[0],
) {
  if (channel && (channel as any)[INERT]) return "ok";
  return getSupabaseForFarm(farmId).removeChannel(channel as any);
}

export async function removeRealtimeChannel(channel: Parameters<RemoveChannelFn>[0]) {
  // Canal inerte nunca chegou ao cliente real — removê-lo por lá lançaria.
  if (channel && (channel as any)[INERT]) return "ok";
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
