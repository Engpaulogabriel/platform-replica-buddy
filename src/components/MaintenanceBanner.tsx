// Banner sticky laranja exibido no topo do app quando a fazenda está em Modo Manutenção.
// Mostra tempo restante (countdown) e o motivo. Aparece para TODOS os usuários da fazenda
// (não só admins). É puramente informativo — encerrar é feito no /platform pelos admins.
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useFarmMaintenance, formatCountdown } from "@/hooks/useFarmMaintenance";
import { Wrench, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { notify } from "@/lib/notify";

export function MaintenanceBanner({ farmId }: { farmId: string | null }) {
  const { active, secondsLeft, reason } = useFarmMaintenance(farmId);
  const { user } = useAuth();
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (!user?.id) { setIsAdmin(false); return; }
    void supabase
      .from("platform_admins")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle()
      .then(({ data }) => setIsAdmin(!!data));
  }, [user?.id]);

  if (!active || !farmId) return null;

  const release = async () => {
    if (!confirm("Encerrar Modo Manutenção agora? O sistema voltará a operar normalmente.")) return;
    const { error } = await supabase.rpc("platform_maintenance_release" as any, { _farm_id: farmId });
    if (error) return notify.fail("Modo Manutenção", error.message);
    notify.ok("Modo Manutenção", "Encerrado. Sistema retomando operações.");
  };

  return (
    <div
      className="shrink-0 border-b border-amber-500/40 text-amber-950 dark:text-amber-100"
      style={{ background: "linear-gradient(90deg, hsl(38 95% 60% / 0.25), hsl(38 95% 50% / 0.35), hsl(38 95% 60% / 0.25))" }}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-3 px-4 py-2 text-sm">
        <Wrench className="w-4 h-4 shrink-0 text-amber-700 dark:text-amber-300 animate-pulse" />
        <div className="flex-1 min-w-0">
          <span className="font-semibold uppercase tracking-wider text-[11px]">Modo Manutenção · </span>
          <span>Bombas e automação pausadas pela equipe Renov.</span>
          {reason && <span className="ml-1 opacity-80">"{reason}"</span>}
        </div>
        <span className="font-mono font-bold tabular-nums px-2 py-0.5 rounded bg-amber-500/30 text-amber-950 dark:text-amber-50">
          {formatCountdown(secondsLeft)}
        </span>
        {isAdmin && (
          <Button size="sm" variant="ghost" className="h-7 px-2 text-amber-950 dark:text-amber-100 hover:bg-amber-500/30" onClick={release}>
            <X className="w-3.5 h-3.5 mr-1" />Encerrar
          </Button>
        )}
      </div>
    </div>
  );
}
