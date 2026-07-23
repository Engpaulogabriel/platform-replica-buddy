// Notificações universais por fazenda.
//
// • Compartilhado: todos os usuários da mesma fazenda veem o mesmo alerta
//   (tabela `farm_notifications`, sincronizada via Realtime).
// • Lido individual: cada usuário marca como lido por si
//   (tabela `farm_notification_reads`).
// • Ligar/desligar global: `farms.bell_alerts_enabled` (toggle por fazenda).
//
// Cada notificação tem `kind` ("failure" | "system") usado pelas abas do sino.
import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";
import { playFailureSound } from "@/lib/failureSound";
// (revertido: voltou a usar canal próprio após bug de freeze no barramento)

export type NotifSeverity = "critical" | "warning" | "info" | "success";
export type NotifKind = "failure" | "system";

export interface Notification {
  id: string;
  title: string;
  message: string;
  severity: NotifSeverity;
  kind: NotifKind;
  timestamp: Date;
  read: boolean;
  resolvedAt?: Date;
  equipmentId?: string;
  source?: string;
  sourceRef?: string;
}

interface NotificationContextType {
  notifications: Notification[];
  unreadCount: number;
  enabled: boolean;
  addNotification: (n: Omit<Notification, "id" | "timestamp" | "read" | "kind"> & { kind?: NotifKind }) => void;
  markAsRead: (id: string) => void;
  markAllAsRead: () => void;
  clearAll: () => void;
}

const NotificationContext = createContext<NotificationContextType>({
  notifications: [],
  unreadCount: 0,
  enabled: false,
  addNotification: () => {},
  markAsRead: () => {},
  markAllAsRead: () => {},
  clearAll: () => {},
});

interface RawNotificationRow {
  id: string;
  farm_id: string;
  severity: string;
  kind: string | null;
  title: string;
  message: string;
  source: string | null;
  source_ref: string | null;
  equipment_id: string | null;
  resolved_at: string | null;
  created_at: string;
}

function normalizeSeverity(s: string): NotifSeverity {
  if (s === "critical" || s === "warning" || s === "info" || s === "success") return s;
  return "info";
}
function normalizeKind(k: string | null, source?: string | null): NotifKind {
  if (k === "system") return "system";
  // Acionamento local detectado pelo agente entra na aba Sistema.
  if (source === "acionamento_local") return "system";
  return "failure";
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const farmId = useDefaultFarmId();

  // Sino sempre ativo em todas as fazendas — sem toggle.
  const enabled = true;
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  const soundedIdsRef = useRef<Set<string>>(new Set());

  // ─── Carga inicial + Realtime ───────────────────────────────────────────────
  useEffect(() => {
    if (!user?.id || !farmId) {
      setNotifications([]); setReadIds(new Set());
      return;
    }
    let cancelled = false;
    let firstLoad = true;


    const load = async () => {
      const cutoffIso = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
      const [notifRes, readRes] = await Promise.all([
        supabase
          .from("farm_notifications")
          .select("id, farm_id, severity, kind, title, message, source, source_ref, equipment_id, resolved_at, created_at")
          .eq("farm_id", farmId)
          .gte("created_at", cutoffIso)
          .order("created_at", { ascending: false })
          .limit(200),
        supabase
          .from("farm_notification_reads")
          .select("notification_id")
          .eq("user_id", user.id),
      ]);


      if (cancelled) return;

      const reads = new Set<string>(
        (readRes.data ?? []).map((r) => (r as { notification_id: string }).notification_id),
      );
      setReadIds(reads);

      const rows = (notifRes.data ?? []) as RawNotificationRow[];
      const mapped: Notification[] = rows.map((r) => ({
        id: r.id,
        title: r.title,
        message: r.message,
        severity: normalizeSeverity(r.severity),
        kind: normalizeKind(r.kind, r.source),
        timestamp: new Date(r.created_at),
        read: reads.has(r.id),
        resolvedAt: r.resolved_at ? new Date(r.resolved_at) : undefined,
        equipmentId: r.equipment_id ?? undefined,
        source: r.source ?? undefined,
        sourceRef: r.source_ref ?? undefined,
      }));
      // Som de alerta crítico: só para notificações NOVAS detectadas pelo polling
      // (nunca na primeira carga, para não tocar som de histórico antigo).
      if (!firstLoad) {
        const fresh = mapped.find((n) => n.severity === "critical" && !soundedIdsRef.current.has(n.id));
        if (fresh) playFailureSound();
      }
      firstLoad = false;
      for (const n of mapped) soundedIdsRef.current.add(n.id);
      setNotifications(mapped);
    };

    load();

    // EMERGÊNCIA: Realtime desabilitado globalmente (src/lib/realtimeKillSwitch.ts).
    // Polling HTTP simples a cada 15s para manter o sino atualizado.
    const poll = setInterval(() => { void load(); }, 15_000);

    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [user?.id, farmId]);

  const cutoffMs = Date.now() - 72 * 60 * 60 * 1000;
  const merged = notifications
    .filter((n) => n.timestamp.getTime() >= cutoffMs)
    .map((n) => ({ ...n, read: readIds.has(n.id) }));
  const unreadCount = merged.filter((n) => !n.read).length;


  const addNotification = useCallback(
    async (n: Omit<Notification, "id" | "timestamp" | "read" | "kind"> & { kind?: NotifKind }) => {
      if (!farmId) return;
      const { error } = await supabase.from("farm_notifications").insert({
        farm_id: farmId,
        severity: n.severity,
        kind: n.kind ?? "failure",
        title: n.title, message: n.message,
        source: n.source ?? null, source_ref: n.sourceRef ?? null,
        equipment_id: n.equipmentId ?? null,
      });
      if (error && error.code !== "23505") {
        console.warn("[notifications] insert failed", error);
      }
    },
    [farmId],
  );

  const markAsRead = useCallback(async (id: string) => {
    if (!user?.id) return;
    setReadIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev); next.add(id); return next;
    });
    await supabase.from("farm_notification_reads").upsert(
      { notification_id: id, user_id: user.id },
      { onConflict: "notification_id,user_id", ignoreDuplicates: true },
    );
  }, [user?.id]);

  const markAllAsRead = useCallback(async () => {
    if (!user?.id) return;
    const unread = merged.filter((n) => !n.read).map((n) => n.id);
    if (unread.length === 0) return;
    setReadIds((prev) => {
      const next = new Set(prev);
      unread.forEach((id) => next.add(id));
      return next;
    });
    await supabase.from("farm_notification_reads").upsert(
      unread.map((nid) => ({ notification_id: nid, user_id: user.id })),
      { onConflict: "notification_id,user_id", ignoreDuplicates: true },
    );
  }, [user?.id, merged]);

  const clearAll = useCallback(async () => { await markAllAsRead(); }, [markAllAsRead]);

  return (
    <NotificationContext.Provider
      value={{ notifications: merged, unreadCount, enabled, addNotification, markAsRead, markAllAsRead, clearAll }}
    >
      {children}
    </NotificationContext.Provider>
  );
}

export const useNotifications = () => useContext(NotificationContext);
