// FarmSwitcher — seletor de fazenda no header, com criação de novas
import { useEffect, useState } from "react";
import { Building2, Check, ChevronsUpDown, Plus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { usePlatformAdmin } from "@/hooks/usePlatformAdmin";
import { useMasterManager } from "@/contexts/MasterManagerContext";


interface Farm {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  role: string;
}

export function FarmSwitcher({ compact }: { compact?: boolean }) {
  const { user } = useAuth();
  const { isPlatformAdmin } = usePlatformAdmin();
  const { isMasterManager } = useMasterManager();

  const [open, setOpen] = useState(false);
  const [farms, setFarms] = useState<Farm[]>([]);
  const [currentFarmId, setCurrentFarmId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", city: "", state: "" });

  const loadFarms = async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      const { data: profile } = await supabase
        .from("profiles").select("default_farm_id").eq("id", user.id).maybeSingle();
      const activeId = sessionStorage.getItem("impersonate_farm_id")
        ?? sessionStorage.getItem("demo_farm_id")
        ?? profile?.default_farm_id
        ?? localStorage.getItem(`last_farm:${user.id}`)
        ?? null;
      setCurrentFarmId(activeId);
      if (activeId) localStorage.setItem(`last_farm:${user.id}`, activeId);

      // Gestor Master? Se sim, listar SÓ as fazendas vinculadas ao grupo.
      const { data: mm } = await supabase
        .from("master_managers" as any)
        .select("id")
        .eq("user_id", user.id)
        .eq("status", "active")
        .maybeSingle();

      const list: Farm[] = [];
      const seen = new Set<string>();

      if (mm && (mm as any).id) {
        const { data: mmFarms } = await supabase
          .from("master_manager_farms" as any)
          .select("farms(id, name, city, state)")
          .eq("manager_id", (mm as any).id);
        for (const link of (mmFarms ?? []) as any[]) {
          const f = link.farms;
          if (f && !seen.has(f.id)) { list.push({ ...f, role: "gestor_master" }); seen.add(f.id); }
        }
      } else {
        const { data: roles, error } = await supabase
          .from("user_roles")
          .select("role, farm_id, farms(id, name, city, state)")
          .eq("user_id", user.id);
        if (error) throw error;
        for (const r of (roles ?? []) as any[]) {
          const f = r.farms;
          if (f && !seen.has(f.id)) { list.push({ ...f, role: r.role }); seen.add(f.id); }
        }
        if (isPlatformAdmin) {
          const { data: allFarms } = await supabase
            .from("farms")
            .select("id, name, city, state")
            .order("name", { ascending: true });
          for (const farm of allFarms ?? []) {
            if (!seen.has(farm.id)) list.push({ ...farm, role: "platform_admin" });
          }
        }
      }
      setFarms(list);
    } catch (e) {
      console.error(e);
      notify.fail("Trocar Fazenda", "Erro ao carregar fazendas");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadFarms(); }, [user?.id, isPlatformAdmin]);


  const switchFarm = async (farmId: string) => {
    if (!user?.id || farmId === currentFarmId) { setOpen(false); return; }
    setSwitching(farmId);
    try {
      const { error } = await supabase
        .from("profiles").update({ default_farm_id: farmId }).eq("id", user.id);
      if (error) throw error;
      localStorage.setItem(`last_farm:${user.id}`, farmId);
      notify.ok("Trocar Fazenda", "Fazenda ativa alterada");
      setOpen(false);
      // recarrega para os hooks pegarem o novo farmId
      setTimeout(() => window.location.reload(), 300);
    } catch (e) {
      console.error(e);
      notify.fail("Trocar Fazenda", "Erro ao trocar de fazenda");
    } finally {
      setSwitching(null);
    }
  };

  const createFarm = async () => {
    if (!form.name.trim()) { notify.fail("Trocar Fazenda", "Nome é obrigatório"); return; }
    setCreating(true);
    try {
      const { data, error } = await supabase.rpc("create_farm_with_owner", {
        _name: form.name.trim(),
        _city: form.city.trim() || undefined,
        _state: form.state.trim() || undefined,
      });
      if (error) throw error;
      const newFarmId = data as string;
      notify.ok("Trocar Fazenda", `Fazenda "${form.name}" criada!`);

      // Define a nova fazenda como ativa
      if (user?.id && newFarmId) {
        await supabase.from("profiles").update({ default_farm_id: newFarmId }).eq("id", user.id);
      }

      setCreateOpen(false);
      setForm({ name: "", city: "", state: "" });
      setTimeout(() => window.location.reload(), 400);
    } catch (e) {
      console.error(e);
      notify.fail("Trocar Fazenda", `Erro ao criar fazenda: ${(e as Error).message}`);
    } finally {
      setCreating(false);
    }
  };

  const current = farms.find((f) => f.id === currentFarmId);

  // Gestor Master com apenas 1 fazenda: ocultar seletor
  if (isMasterManager && farms.length <= 1) return null;

  return (

    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={compact ? "h-8 w-8 p-0" : "h-8 gap-1.5 text-xs"}
            title="Trocar de fazenda"
          >
            <Building2 className="w-3.5 h-3.5 text-primary" />
            {!compact && (
              <span className="max-w-[120px] truncate">
                {current?.name ?? "Selecionar fazenda"}
              </span>
            )}
            {!compact && <ChevronsUpDown className="w-3 h-3 opacity-50" />}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 p-0">
          <div className="p-2 border-b border-border">
            <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground px-2 py-1">
              Suas Fazendas ({farms.length})
            </p>
          </div>
          <div className="max-h-[300px] overflow-y-auto py-1">
            {loading ? (
              <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin inline mr-1" /> Carregando...
              </div>
            ) : farms.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                Nenhuma fazenda cadastrada
              </div>
            ) : (
              farms.map((farm) => {
                const isActive = farm.id === currentFarmId;
                const isSwitchingThis = switching === farm.id;
                return (
                  <button
                    key={farm.id}
                    onClick={() => switchFarm(farm.id)}
                    disabled={!!switching}
                    className={cn(
                      "w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-muted/60 transition-colors",
                      isActive && "bg-primary/5",
                    )}
                  >
                    <div className={cn(
                      "w-7 h-7 rounded-md flex items-center justify-center shrink-0 mt-0.5",
                      isActive ? "bg-primary/15" : "bg-muted",
                    )}>
                      <Building2 className={cn("w-3.5 h-3.5", isActive ? "text-primary" : "text-muted-foreground")} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-foreground truncate">{farm.name}</p>
                      <p className="text-[10px] text-muted-foreground truncate">
                        {[farm.city, farm.state].filter(Boolean).join(" - ") || "Sem localização"}
                        {" · "}
                        <span className="uppercase font-medium">{farm.role}</span>
                      </p>
                    </div>
                    {isSwitchingThis ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-primary shrink-0 mt-1" />
                    ) : isActive ? (
                      <Check className="w-3.5 h-3.5 text-primary shrink-0 mt-1" />
                    ) : null}
                  </button>
                );
              })
            )}
          </div>
          {isPlatformAdmin && (
            <div className="p-2 border-t border-border">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start text-xs gap-2 h-8"
                onClick={() => { setOpen(false); setCreateOpen(true); }}
              >
                <Plus className="w-3.5 h-3.5 text-primary" />
                Criar nova fazenda
              </Button>
            </div>
          )}
          {!isPlatformAdmin && (
            <div className="p-2 border-t border-border">
              <p className="text-[10px] text-muted-foreground text-center px-2 py-1">
                🔒 Apenas o super-admin pode criar novas fazendas
              </p>
            </div>
          )}
        </PopoverContent>
      </Popover>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Building2 className="w-4 h-4 text-primary" />
              Nova Fazenda
            </DialogTitle>
            <DialogDescription>
              Você será o proprietário (owner) da nova fazenda. Cada fazenda tem seus próprios equipamentos, membros e licença.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label htmlFor="farm-name">Nome da Fazenda *</Label>
              <Input
                id="farm-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Ex: Fazenda São José"
                className="mt-1"
                autoFocus
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="farm-city">Cidade</Label>
                <Input
                  id="farm-city"
                  value={form.city}
                  onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
                  placeholder="Uberaba"
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="farm-state">Estado</Label>
                <Input
                  id="farm-state"
                  value={form.state}
                  onChange={(e) => setForm((f) => ({ ...f, state: e.target.value }))}
                  placeholder="MG"
                  maxLength={2}
                  className="mt-1"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancelar
            </Button>
            <Button onClick={createFarm} disabled={creating || !form.name.trim()}>
              {creating ? (
                <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Criando...</>
              ) : (
                <><Plus className="w-4 h-4 mr-1" /> Criar Fazenda</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
