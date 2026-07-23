// PlatformFarmSwitcher — dropdown no header do /platform que lista TODAS as
// fazendas reais (não-demo) e permite ao staff Renov entrar em qualquer uma
// como se fosse o cliente (impersonate em 2 cliques). Reutiliza
// platform_farms_overview e exclui is_demo. Diferencia-se do PlatformDemoMenu
// pela cor azul (real) vs. amarela (demo).
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
import { Input } from "@/components/ui/input";
import { Building2, ChevronDown, Loader2, Search, UserCog } from "lucide-react";
import { notify } from "@/lib/notify";

interface FarmRow {
  farm_id: string;
  name: string;
  city: string | null;
  state: string | null;
  plan: string;
  is_demo?: boolean | null;
  last_heartbeat: string | null;
  com_connected: boolean | null;
  equipments_count: number | null;
  license_key: string | null;
}

export default function PlatformFarmSwitcher() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [farms, setFarms] = useState<FarmRow[]>([]);
  const [entering, setEntering] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void supabase.rpc("platform_farms_overview" as any).then(({ data, error }) => {
      if (error) {
        console.warn("[impersonate] erro listando fazendas:", error.message);
        return;
      }
      // Excluir demos — elas têm dropdown próprio
      const real = ((data as any[]) ?? []).filter((f) => !f.is_demo);
      setFarms(real);
    });
  }, []);

  const enterFarm = async (farm: FarmRow) => {
    if (!user?.id) {
      notify.fail("Acessar Fazenda", "Sessão expirada — faça login novamente.");
      return;
    }
    setEntering(farm.farm_id);
    try {
      // Sinaliza ao DemoModeBanner que estamos em modo impersonate (não-demo)
      sessionStorage.setItem("impersonate_active", "1");
      sessionStorage.setItem("impersonate_farm_id", farm.farm_id);
      sessionStorage.removeItem("demo_mode_active");
      sessionStorage.removeItem("demo_farm_id");

      const { error } = await supabase
        .from("profiles")
        .update({ default_farm_id: farm.farm_id })
        .eq("id", user.id);
      if (error) throw error;
      localStorage.setItem(`last_farm:${user.id}`, farm.farm_id);

      notify.ok("Acessar Fazenda", `Acessando ${farm.name}…`);
      setTimeout(() => {
        navigate("/home");
        setTimeout(() => window.location.reload(), 80);
      }, 250);
    } catch (e: any) {
      notify.fail("Acessar Fazenda", "Falha ao acessar fazenda: " + (e?.message ?? e));
      setEntering(null);
    }
  };

  const filtered = farms.filter((f) => {
    const q = filter.trim().toLowerCase();
    if (!q) return true;
    return (
      f.name.toLowerCase().includes(q) ||
      (f.city ?? "").toLowerCase().includes(q) ||
      (f.state ?? "").toLowerCase().includes(q)
    );
  });

  if (!farms.length) return null;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="border-blue-500/50 bg-blue-500/10 text-blue-600 hover:bg-blue-500/20 hover:text-blue-700"
        >
          <UserCog className="w-4 h-4 mr-2" />
          Acessar Fazenda
          <ChevronDown className="w-3 h-3 ml-1.5 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 max-h-[70vh] overflow-hidden flex flex-col">
        <DropdownMenuLabel className="flex items-center gap-2 shrink-0">
          <UserCog className="w-4 h-4 text-blue-500" />
          Entrar como cliente
        </DropdownMenuLabel>
        <div className="px-2 pb-2 shrink-0">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Buscar fazenda…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              className="pl-8 h-8 text-xs"
            />
          </div>
        </div>
        <DropdownMenuSeparator className="shrink-0" />
        <div className="overflow-y-auto flex-1 min-h-0">
          {filtered.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              Nenhuma fazenda encontrada.
            </div>
          )}
          {filtered.map((farm) => {
            const online =
              farm.last_heartbeat &&
              Date.now() - new Date(farm.last_heartbeat).getTime() < 5 * 60_000;
            const suspended = !farm.license_key;
            return (
              <DropdownMenuItem
                key={farm.farm_id}
                disabled={entering !== null}
                onSelect={(e) => {
                  e.preventDefault();
                  void enterFarm(farm);
                }}
                className="flex items-start gap-3 py-2.5 cursor-pointer"
              >
                <div className="w-9 h-9 rounded-lg bg-blue-500/15 text-blue-600 flex items-center justify-center shrink-0">
                  {entering === farm.farm_id ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Building2 className="w-4 h-4" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold leading-tight truncate flex items-center gap-1.5">
                    {farm.name}
                    {suspended && (
                      <span className="text-[9px] uppercase font-bold text-destructive">susp.</span>
                    )}
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5 truncate">
                    {farm.city ? `${farm.city}${farm.state ? "/" + farm.state : ""}` : "—"}
                    {" · "}
                    {farm.equipments_count ?? 0} equip.
                    {" · "}
                    {farm.plan?.toUpperCase()}
                  </div>
                  <div className="flex items-center gap-1.5 mt-1">
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        online ? "bg-green-500 animate-pulse" : "bg-muted-foreground/40"
                      }`}
                    />
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      {online ? "Online" : "Offline"}
                    </span>
                  </div>
                </div>
              </DropdownMenuItem>
            );
          })}
        </div>
        <DropdownMenuSeparator className="shrink-0" />
        <div className="px-2 py-1.5 text-[10px] text-muted-foreground leading-relaxed shrink-0">
          Ao entrar, você verá os dados reais do cliente. Comandos manuais
          enviarão para o hardware real.
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
