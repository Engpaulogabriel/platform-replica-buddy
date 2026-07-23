import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Globe, Crown, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { usePlan } from "@/contexts/PlanContext";
import { notify } from "@/lib/notify";
import { useLanguage } from "@/contexts/LanguageContext";
import { Language } from "@/i18n/translations";
import { supabase } from "@/integrations/supabase/client";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";

const langOptions: { value: Language; flag: string; label: string }[] = [
  { value: "pt", flag: "🇧🇷", label: "Português" },
  { value: "en", flag: "🇺🇸", label: "English" },
  { value: "es", flag: "🇪🇸", label: "Español" },
];

export default function SistemaSettings() {
  const { language, setLanguage } = useLanguage();
  const { setPlan, isPro } = usePlan();
  const farmId = useDefaultFarmId();

  // Vazão/Consumo agora é uma flag POR FAZENDA gravada em farms.modules.vazao_consumo
  // (via RPC farm_set_modules). Todos os usuários da fazenda passam a ver os dados
  // quando o dono habilita.
  const [vazaoConsumoEnabled, setVazaoConsumoEnabled] = useState(false);
  const [vazaoLoading, setVazaoLoading] = useState(true);
  const [vazaoBusy, setVazaoBusy] = useState(false);

  const [voltageEnabled, setVoltageEnabled] = useState(() => localStorage.getItem("module_voltage") === "true");
  const [currentEnabled, setCurrentEnabled] = useState(() => localStorage.getItem("module_current") === "true");

  // Carrega estado atual de farms.modules
  useEffect(() => {
    if (!farmId) { setVazaoLoading(false); return; }
    let cancelled = false;
    setVazaoLoading(true);
    void supabase
      .from("farms")
      .select("modules")
      .eq("id", farmId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        const m = ((data?.modules ?? {}) as Record<string, unknown>);
        setVazaoConsumoEnabled(m.vazao_consumo === true);
        setVazaoLoading(false);
      });
    return () => { cancelled = true; };
  }, [farmId]);

  const toggleVazaoConsumo = async (value: boolean) => {
    if (!farmId) { notify.fail("Sistema", "Fazenda não identificada."); return; }
    setVazaoBusy(true);
    // Otimista
    setVazaoConsumoEnabled(value);
    const { data, error } = await supabase.rpc("farm_set_modules" as never, {
      _farm_id: farmId,
      _patch: { vazao_consumo: value },
    } as never);
    setVazaoBusy(false);
    if (error) {
      setVazaoConsumoEnabled(!value); // rollback
      notify.fail("Sistema", error.message || "Falha ao salvar módulo");
      return;
    }
    const mods = (data ?? {}) as Record<string, unknown>;
    setVazaoConsumoEnabled(mods.vazao_consumo === true);
    // Mantém localStorage legado sincronizado para não impactar código antigo
    localStorage.setItem("module_flow", String(value));
    localStorage.setItem("module_consumption", String(value));
    // Sinaliza para hooks que leem farms.modules recarregarem
    window.dispatchEvent(new Event("modules:updated"));
    notify.ok("Sistema", `Módulo de Vazão e Consumo ${value ? "ativado" : "desativado"} para a fazenda`);
  };

  const toggleLocal = (key: string, value: boolean, label: string) => {
    localStorage.setItem(key, String(value));
    window.dispatchEvent(new Event("modules:updated"));
    notify.ok("Sistema", `${label} ${value ? "ativado" : "desativado"}`);
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader><CardTitle className="text-base text-foreground">Módulos do Sistema</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between p-3 bg-secondary rounded-lg">
          <div>
            <p className="text-sm font-medium text-foreground flex items-center gap-2">
              Módulo de Vazão e Consumo
              {(vazaoLoading || vazaoBusy) && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
            </p>
            <p className="text-xs text-muted-foreground">
              Ativa leituras do totalizador (m³) via N2 do PLC. Aplica-se para TODOS os usuários da fazenda —
              exibe consumo diário nos poços e no relatório "Vazão e Consumo".
            </p>
          </div>
          <Switch
            checked={vazaoConsumoEnabled}
            disabled={vazaoLoading || vazaoBusy}
            onCheckedChange={toggleVazaoConsumo}
            className="data-[state=checked]:bg-primary"
          />
        </div>
        <div className="flex items-center justify-between p-3 bg-secondary rounded-lg">
          <div>
            <p className="text-sm font-medium text-foreground">Mostrador de Tensão</p>
            <p className="text-xs text-muted-foreground">Exibir tensão (V) de cada poço — escala 0 V a 380 V</p>
          </div>
          <Switch checked={voltageEnabled} onCheckedChange={(v) => { setVoltageEnabled(v); toggleLocal("module_voltage", v, "Mostrador de Tensão"); }} className="data-[state=checked]:bg-primary" />
        </div>
        <div className="flex items-center justify-between p-3 bg-secondary rounded-lg">
          <div>
            <p className="text-sm font-medium text-foreground">Mostrador de Corrente</p>
            <p className="text-xs text-muted-foreground">Exibir corrente (A) de cada poço — escala 0 A a 1300 A</p>
          </div>
          <Switch checked={currentEnabled} onCheckedChange={(v) => { setCurrentEnabled(v); toggleLocal("module_current", v, "Mostrador de Corrente"); }} className="data-[state=checked]:bg-primary" />
        </div>
        <div className="flex items-center justify-between p-3 bg-secondary rounded-lg">
          <div>
            <p className="text-sm font-medium text-foreground">Modo Offline Banner</p>
            <p className="text-xs text-muted-foreground">Mostrar aviso quando sem conexão</p>
          </div>
          <Switch className="data-[state=checked]:bg-primary" defaultChecked />
        </div>
        <div>
          <Label className="text-foreground">Fuso Horário</Label>
          <Select defaultValue="brt">
            <SelectTrigger className="bg-secondary border-border mt-1"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="brt">Brasília (BRT -03:00)</SelectItem>
              <SelectItem value="amt">Amazônia (AMT -04:00)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-foreground flex items-center gap-2">
            <Globe className="w-4 h-4" /> Idioma / Language / Idioma
          </Label>
          <div className="flex gap-2 mt-2">
            {langOptions.map((opt) => (
              <Button
                key={opt.value}
                variant={language === opt.value ? "default" : "outline"}
                size="sm"
                className={`gap-1.5 ${language === opt.value ? "bg-primary text-primary-foreground" : ""}`}
                onClick={() => { setLanguage(opt.value); notify.ok("Sistema", `${opt.flag} ${opt.label}`); }}
              >
                <span>{opt.flag}</span>
                <span>{opt.label}</span>
              </Button>))}
          </div>
        </div>
        <Button className="bg-primary text-primary-foreground">Salvar</Button>

        <div className="mt-6 border-t border-border pt-4">
          <p className="text-sm font-semibold text-foreground flex items-center gap-2 mb-3">
            <Crown className="w-4 h-4 text-warning" /> Versão do Sistema
          </p>
          <div className="flex gap-2">
            <Button variant={isPro ? "default" : "outline"} size="sm" className={isPro ? "bg-primary text-primary-foreground" : ""} onClick={() => setPlan("pro")}>
              <Crown className="w-3 h-3 mr-1" /> Pro
            </Button>
            <Button variant={!isPro ? "default" : "outline"} size="sm" className={!isPro ? "bg-info text-info-foreground" : ""} onClick={() => setPlan("lite")}>
              Lite
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground mt-2">
            {isPro ? "Todas as funcionalidades desbloqueadas." : "Modo Lite: Automático, Demanda de Energia e Suporte Técnico ficam ocultos. Máximo de 4 bombas."}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
