// ─────────────────────────────────────────────────────────────────────────────
// farmRealtimeBus — UM único canal Realtime por fazenda, compartilhado por
// todos os hooks/contexts que precisam observar tabelas filtradas por
// `farm_id` ou `user_id`.
// ─────────────────────────────────────────────────────────────────────────────
//
// Por que existe:
//   Cada componente que chamava `supabase.channel(...)` criava sua própria
//   subscription. No iPad/Safari, com Dashboard + Notificações + Guards +
//   Manutenção + AgentActivity + AutomationLog + ..., chegávamos a 10+
//   canais por sessão — todos multiplexados sobre o mesmo WebSocket, mas
//   cada um com seu próprio overhead de heartbeat, presence e callbacks.
//
//   Este módulo abre UM canal por farmId. Quando um listener é adicionado
//   ou removido, o canal é reconstruído (com debounce de 50ms) com todos
//   os `.on("postgres_changes", ...)` registrados no momento. Quando o
//   último listener some, o canal é destruído.
//
// Limitações:
//   • Reconstrução do canal causa uma breve janela (poucos ms) em que
//     mudanças podem ser perdidas. Para os casos de uso atuais (sinos,
//     guards, manutenção, alertas), o consumidor faz `refresh()` no mount
//     e o gap é coberto pelo fallback de polling de cada hook.
//   • Use APENAS para tabelas escopadas por farm/user. Subscriptions
//     globais (sem filtro) continuam usando channels próprios.

import { supabase } from "@/integrations/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";

type PgEvent = "INSERT" | "UPDATE" | "DELETE" | "*";

export interface FarmRealtimeListener {
  table: string;
  event?: PgEvent;
  /** Ex.: `farm_id=eq.${farmId}` ou `user_id=eq.${userId}`. */
  filter?: string;
  onChange: (payload: { new: unknown; old: unknown; eventType: string }) => void;
}

interface BusEntry {
  key: string;                       // farmId
  listeners: Set<FarmRealtimeListener>;
  channel: RealtimeChannel | null;
  rebuildTimer: ReturnType<typeof setTimeout> | null;
}

const buses = new Map<string, BusEntry>();

function rebuildChannel(bus: BusEntry) {
  // Derruba canal anterior — não há API para remover .on() individualmente.
  if (bus.channel) {
    try { void supabase.removeChannel(bus.channel); } catch { /* ignore */ }
    bus.channel = null;
  }
  if (bus.listeners.size === 0) return;

  const channelName = `farm-bus:${bus.key}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 6)}`;
  let ch = supabase.channel(channelName);
  for (const l of bus.listeners) {
    const config: Record<string, string> = {
      event: l.event ?? "*",
      schema: "public",
      table: l.table,
    };
    if (l.filter) config.filter = l.filter;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ch = ch.on("postgres_changes" as any, config as any, (payload) => {
      try {
        l.onChange({
          new: (payload as { new?: unknown }).new ?? null,
          old: (payload as { old?: unknown }).old ?? null,
          eventType: (payload as { eventType?: string }).eventType ?? "*",
        });
      } catch (e) {
        // Um listener nunca pode derrubar os outros.
        if (import.meta.env.DEV) console.warn("[farmRealtimeBus] listener error", e);
      }
    });
  }
  ch.subscribe();
  bus.channel = ch;
}

function scheduleRebuild(bus: BusEntry) {
  if (bus.rebuildTimer != null) return;
  bus.rebuildTimer = setTimeout(() => {
    bus.rebuildTimer = null;
    rebuildChannel(bus);
  }, 50);
}

/**
 * Inscreve um listener no barramento da fazenda. Retorna a função de
 * unsubscribe — chame sempre no cleanup do `useEffect`.
 */
export function subscribeFarmRealtime(
  farmId: string,
  listener: FarmRealtimeListener,
): () => void {
  let bus = buses.get(farmId);
  if (!bus) {
    bus = { key: farmId, listeners: new Set(), channel: null, rebuildTimer: null };
    buses.set(farmId, bus);
  }
  bus.listeners.add(listener);
  scheduleRebuild(bus);

  return () => {
    const entry = buses.get(farmId);
    if (!entry) return;
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0) {
      if (entry.rebuildTimer != null) {
        clearTimeout(entry.rebuildTimer);
        entry.rebuildTimer = null;
      }
      if (entry.channel) {
        try { void supabase.removeChannel(entry.channel); } catch { /* ignore */ }
        entry.channel = null;
      }
      buses.delete(farmId);
    } else {
      scheduleRebuild(entry);
    }
  };
}
