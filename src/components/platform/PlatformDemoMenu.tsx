// PlatformDemoMenu — dropdown no header do /platform que permite ao staff
// Renov entrar nas fazendas demo (Apresentação Lite ou Enterprise Pro).
// Reutiliza o mesmo mecanismo do FarmSwitcher: ajusta profiles.default_farm_id
// + reload, então a nuvem libera o acesso via has_farm_access (que cobre
// platform staff em farms.is_demo = true).
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PlayCircle, Sparkles, Building2, ChevronDown, Loader2 } from "lucide-react";
import { notify } from "@/lib/notify";

interface DemoFarm {
  farm_id: string;
  name: string;
  city: string | null;
  state: string | null;
  plan: string;
  equipments_count: number | null;
  description: string | null;
}

export default function PlatformDemoMenu() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [demos, setDemos] = useState<DemoFarm[]>([]);
  const [entering, setEntering] = useState<string | null>(null);

  useEffect(() => {
    void supabase.rpc("platform_list_demo_farms" as any).then(({ data, error }) => {
      if (error) {
        console.warn("[demo] erro listando demos:", error.message);
        return;
      }
      setDemos((data as any) ?? []);
    });
  }, []);

  const enterDemo = async (farm: DemoFarm) => {
    if (!user?.id) {
      notify.fail("Modo Demonstração", "Sessão expirada — faça login novamente.");
      return;
    }
    setEntering(farm.farm_id);
    try {
      // Salva flag para o Dashboard mostrar o tour/banner correto
      sessionStorage.setItem("demo_mode_active", "1");
      sessionStorage.setItem("demo_farm_id", farm.farm_id);

      // Aponta o profile do staff pra fazenda demo
      const { error } = await supabase
        .from("profiles")
        .update({ default_farm_id: farm.farm_id })
        .eq("id", user.id);
      if (error) throw error;
      localStorage.setItem(`last_farm:${user.id}`, farm.farm_id);

      notify.ok("Modo Demonstração", `Entrando em ${farm.name}…`);
      // Pequeno delay para o toast aparecer; navega + reload para todos os hooks releiam
      setTimeout(() => {
        navigate("/home");
        setTimeout(() => window.location.reload(), 80);
      }, 250);
    } catch (e: any) {
      notify.fail("Modo Demonstração", "Falha ao entrar no modo demo: " + (e?.message ?? e));
      setEntering(null);
    }
  };

  if (!demos.length) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="border-amber-500/50 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 hover:text-amber-700"
        >
          <PlayCircle className="w-4 h-4 mr-2" />
          Modo Demonstração
          <ChevronDown className="w-3 h-3 ml-1.5 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-amber-500" />
          Apresentar para um cliente
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {demos.map((farm) => {
          const isPro = farm.plan === "pro";
          return (
            <DropdownMenuItem
              key={farm.farm_id}
              disabled={entering !== null}
              onSelect={(e) => { e.preventDefault(); void enterDemo(farm); }}
              className="flex items-start gap-3 py-2.5 cursor-pointer"
            >
              <div
                className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                  isPro ? "bg-primary/15 text-primary" : "bg-blue-500/15 text-blue-600"
                }`}
              >
                {entering === farm.farm_id ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Building2 className="w-4 h-4" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold leading-tight">{farm.name}</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {isPro ? "Demo completa · 8 bombas · 3 setores" : "Demo enxuta · 4 bombas · 2 reservatórios"}
                </div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mt-0.5">
                  Plano {farm.plan} · {farm.equipments_count ?? 0} equip.
                </div>
              </div>
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5 text-[10px] text-muted-foreground leading-relaxed">
          As fazendas demo não enviam comandos reais e não aparecem em métricas/relatórios da plataforma.
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
