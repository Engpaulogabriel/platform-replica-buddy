// DemoModeBanner — barra superior persistente exibida quando o staff Renov
// está dentro de uma fazenda via /platform.
//
// Dois modos:
//  • DEMO (amarelo)        → fazenda fictícia (farms.is_demo = true)
//  • IMPERSONATE (azul)    → fazenda real do cliente, acessada pelo dropdown
//                            "Acessar Fazenda" do /platform
//
// Em ambos os casos o botão "Voltar para a Plataforma" zera default_farm_id
// e devolve o staff para /platform.
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useIsDemoFarm } from "@/hooks/useIsDemoFarm";
import { usePlatformAccess } from "@/hooks/usePlatformAccess";
import { Button } from "@/components/ui/button";
import { Sparkles, ArrowLeft, UserCog } from "lucide-react";
import { notify } from "@/lib/notify";
import { useState } from "react";

export default function DemoModeBanner() {
  const { isDemo, farmName } = useIsDemoFarm();
  const { user } = useAuth();
  const { role } = usePlatformAccess();
  const navigate = useNavigate();
  const [exiting, setExiting] = useState(false);

  // Modo impersonate: staff Renov entrou numa fazenda REAL via dropdown do /platform
  const impersonateActive =
    typeof window !== "undefined" &&
    sessionStorage.getItem("impersonate_active") === "1" &&
    !isDemo &&
    Boolean(role); // só mostra se realmente for staff (defensivo)

  if (!isDemo && !impersonateActive) return null;

  const exit = async () => {
    if (!user?.id) return;
    setExiting(true);
    try {
      await supabase
        .from("profiles")
        .update({ default_farm_id: null })
        .eq("id", user.id);
      sessionStorage.removeItem("demo_mode_active");
      sessionStorage.removeItem("demo_farm_id");
      sessionStorage.removeItem("impersonate_active");
      sessionStorage.removeItem("impersonate_farm_id");
      notify.ok("Modo Demonstração", "Voltando para a Plataforma…");
      setTimeout(() => {
        navigate("/platform");
        setTimeout(() => window.location.reload(), 80);
      }, 200);
    } catch (e: any) {
      notify.fail("Modo Demonstração", "Falha ao sair: " + (e?.message ?? e));
      setExiting(false);
    }
  };

  // Configuração visual por modo
  const cfg = isDemo
    ? {
        wrapper:
          "border-amber-500/40 bg-gradient-to-r from-amber-500/15 via-amber-400/20 to-amber-500/15",
        iconBg: "bg-amber-500/30",
        iconColor: "text-amber-700 dark:text-amber-400",
        titleColor: "text-amber-700 dark:text-amber-300",
        subColor: "text-amber-700/80 dark:text-amber-300/80",
        btnClass:
          "border-amber-500/50 bg-background/60 text-amber-700 hover:bg-amber-500/15 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200",
        Icon: Sparkles,
        label: "Modo Demonstração",
        sub: `${farmName ?? "Fazenda fictícia"} · comandos não chegam em hardware real`,
        ariaLabel: "Modo demonstração ativo",
      }
    : {
        wrapper:
          "border-blue-500/40 bg-gradient-to-r from-blue-500/15 via-blue-400/20 to-blue-500/15",
        iconBg: "bg-blue-500/30",
        iconColor: "text-blue-700 dark:text-blue-400",
        titleColor: "text-blue-700 dark:text-blue-300",
        subColor: "text-blue-700/80 dark:text-blue-300/80",
        btnClass:
          "border-blue-500/50 bg-background/60 text-blue-700 hover:bg-blue-500/15 hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-200",
        Icon: UserCog,
        label: "Acessando como Cliente",
        sub: `${farmName ?? "Fazenda do cliente"} · você está vendo dados reais — comandos vão para o hardware`,
        ariaLabel: "Modo impersonate ativo",
      };

  const Icon = cfg.Icon;

  return (
    <div
      className={`sticky top-0 z-40 w-full border-b backdrop-blur-sm ${cfg.wrapper}`}
      role="status"
      aria-label={cfg.ariaLabel}
    >
      <div className="max-w-screen-2xl mx-auto px-4 py-2 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 animate-pulse ${cfg.iconBg}`}>
            <Icon className={`w-3.5 h-3.5 ${cfg.iconColor}`} />
          </div>
          <div className="min-w-0">
            <div className={`text-xs font-bold uppercase tracking-wider leading-tight ${cfg.titleColor}`}>
              {cfg.label}
            </div>
            <div className={`text-[11px] leading-tight truncate ${cfg.subColor}`}>
              {cfg.sub}
            </div>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={exit}
          disabled={exiting}
          className={`h-8 ${cfg.btnClass}`}
        >
          <ArrowLeft className="w-3.5 h-3.5 mr-1.5" />
          {exiting ? "Saindo…" : "Voltar para a Plataforma"}
        </Button>
      </div>
    </div>
  );
}
