// Observa o automation_log (store reativo, alimentado por Realtime do Supabase)
// e, sempre que uma NOVA falha chega ("Bomba não ligou" / "Bomba não desligou"),
// dispara uma notificação no sino + um toast visual.
//
// Garante que falhas registradas pelo motor da nuvem (automation-tick) apareçam
// como notificação mesmo quando o usuário não estava com a aba aberta no momento
// da falha — o Realtime entrega assim que ele reconectar.
import { useEffect, useRef } from "react";
import { notify } from "@/lib/notify";
import { useAutomationLog, type AutomationLogEntry } from "@/lib/automationLog";
import { useNotifications } from "@/contexts/NotificationContext";


const STORAGE_KEY = "pump_failure_notifs_seen_v1";
const MAX_SEEN = 500;

function loadSeen(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(arr);
  } catch {
    return new Set();
  }
}

function saveSeen(seen: Set<string>) {
  try {
    // mantém só os mais recentes para não inflar
    const arr = Array.from(seen).slice(-MAX_SEEN);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
  } catch {
    // ignore
  }
}

function originLabel(o: AutomationLogEntry["origin"]): string {
  return o === "Manual" ? "Local" : o === "Automático" ? "Automático" : "Remoto";
}

// ⚠️ TEMPORARIAMENTE DESATIVADO (a pedido do usuário, abril/2026):
// enquanto a comunicação RF está sendo estabilizada, alertas "Bomba não ligou"
// / "Bomba não desligou" no sino estavam aparecendo indevidamente. Reativar
// quando o protocolo estiver 100% confirmado em campo.
const PUMP_FAILURE_NOTIFS_ENABLED = false;

export function usePumpFailureNotifications() {
  const entries = useAutomationLog((s) => s.entries);
  const { addNotification } = useNotifications();
  const seenRef = useRef<Set<string> | null>(null);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (!PUMP_FAILURE_NOTIFS_ENABLED) return;
    if (!seenRef.current) seenRef.current = loadSeen();
    const seen = seenRef.current;

    // No primeiro ciclo: marca tudo já existente como visto SEM notificar
    // (evita avalanche de toasts ao abrir o app pela primeira vez).
    if (!initializedRef.current) {
      initializedRef.current = true;
      for (const e of entries) seen.add(e.id);
      saveSeen(seen);
      return;
    }

    const fresh: AutomationLogEntry[] = [];
    for (const e of entries) {
      // Só dispara notificação de falha para comandos reais de liga/desliga.
      // Eventos de sistema (Sem resposta, Reinício do agente, OTA, Leitura OK)
      // não geram alerta no sino — têm seu próprio tratamento.
      if (e.action !== "Ligada" && e.action !== "Desligada") continue;
      if (e.result !== "fail") continue;
      if (seen.has(e.id)) continue;

      // Ignora falhas muito antigas (> 30 min) — provavelmente já vistas em
      // outra sessão, mas o seen-set foi resetado.
      const ageMs = Date.now() - new Date(e.ts).getTime();
      if (ageMs > 30 * 60_000) {
        seen.add(e.id);
        continue;
      }

      fresh.push(e);
      seen.add(e.id);
    }

    if (fresh.length === 0) return;
    saveSeen(seen);

    for (const e of fresh) {
      const title = e.action === "Ligada" ? "Bomba não ligou" : "Bomba não desligou";
      const message = `${e.pump} — falha no comando ${originLabel(e.origin).toLowerCase()}`;
      // source/sourceRef garantem que a mesma falha (mesmo automation_log id)
      // gere apenas UM registro compartilhado por fazenda — o unique index
      // (farm_id, source, source_ref) faz a deduplicação cross-usuário.
      addNotification({
        title,
        message,
        severity: "critical",
        source: "pump_failure",
        sourceRef: e.id,
      });
      // Toast removido a pedido — alertas de falha continuam no sino de notificações.
    }
  }, [entries, addNotification]);
}
