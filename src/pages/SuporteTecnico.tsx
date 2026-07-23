import { useState, useMemo } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { ClipboardList, KeyRound, Stethoscope, Building2, Navigation, Timer, Settings, Users, TrendingUp, ShieldCheck, Cpu, Cable, Radio } from "lucide-react";
import RestrictedAuth from "@/components/RestrictedAuth";
import { Cadastros } from "./Cadastros";
import { CadastroLoginInner } from "./CadastroLogin";
import Diagnostico from "./Diagnostico";
import { useFarmAccessPendingCount } from "@/components/FarmDeviceAccessAdmin";
import FazendaContent from "./Fazenda";
import TimersConfig from "@/components/TimersConfig";
import Usuarios from "./Usuarios";
import SistemaSettings from "@/components/SistemaSettings";
import Produtividade from "./Produtividade";
import DevicesAdmin from "@/components/DevicesAdmin";
import HardwareSecurityPanel from "@/components/HardwareSecurityPanel";
import BridgeConsole from "./BridgeConsole";
import CommunicationReport from "@/components/CommunicationReport";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { useGuidedTour } from "@/hooks/useGuidedTour";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";

const tabs = [
  { value: "equipamentos", label: "Equipamentos", icon: ClipboardList },
  { value: "login", label: "Login", icon: KeyRound },
  { value: "diagnostico", label: "Diagnóstico", icon: Stethoscope },
  { value: "fazenda", label: "Fazenda", icon: Building2 },
  { value: "temporizadores", label: "Temporizadores", icon: Timer },
  { value: "sistema", label: "Sistema", icon: Settings },
  { value: "usuarios", label: "Usuários", icon: Users },
  { value: "produtividade", label: "Produtividade", icon: TrendingUp },
  { value: "dispositivos", label: "Dispositivos", icon: ShieldCheck },
  { value: "hardware", label: "Hardware", icon: Cpu },
  { value: "bridge", label: "Bridge Serial", icon: Cable },
  { value: "comunicacao", label: "Comunicação", icon: Radio },
];

const toIsoDate = (d: Date) => d.toISOString().slice(0, 10);

const SuporteTecnico = () => {
  const [activeTab, setActiveTab] = useState("equipamentos");
  const { startRestrictedTour } = useGuidedTour();
  const farmId = useDefaultFarmId();
  const pendingAccessCount = useFarmAccessPendingCount();

  const defaults = useMemo(() => {
    const today = new Date();
    const from = new Date();
    from.setDate(today.getDate() - 7);
    return { from: toIsoDate(from), to: toIsoDate(today) };
  }, []);
  const [fromDate, setFromDate] = useState(defaults.from);
  const [toDate, setToDate] = useState(defaults.to);

  return (
    <RestrictedAuth title="Suporte Técnico" description="Área restrita para configuração e manutenção do sistema">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Suporte Técnico</h1>
            <p className="text-sm text-muted-foreground mt-1">Área restrita de configuração e manutenção</p>
          </div>
          <Button onClick={startRestrictedTour} variant="outline" className="gap-2 h-9">
            <Navigation className="w-4 h-4" />
            Tour Técnico
          </Button>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList data-tour="suporte-tabs" className="bg-secondary border border-border flex-wrap h-auto">
            {tabs.map((tab) => (
              <TabsTrigger
                key={tab.value}
                value={tab.value}
                data-tour={`tab-${tab.value}`}
                className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground gap-2"
              >
                <tab.icon className="w-4 h-4" /> {tab.label}
                {tab.value === "dispositivos" && pendingAccessCount > 0 && (
                  <Badge variant="destructive" className="ml-1 h-5 px-1.5">{pendingAccessCount}</Badge>
                )}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="equipamentos" className="mt-4"><Cadastros /></TabsContent>
          <TabsContent value="login" className="mt-4"><CadastroLoginInner /></TabsContent>
          <TabsContent value="diagnostico" className="mt-4"><Diagnostico /></TabsContent>
          <TabsContent value="fazenda" className="mt-4"><FazendaContent /></TabsContent>
          <TabsContent value="temporizadores" className="mt-4"><TimersConfig /></TabsContent>
          <TabsContent value="sistema" className="mt-4"><SistemaSettings /></TabsContent>
          <TabsContent value="usuarios" className="mt-4"><Usuarios /></TabsContent>
          <TabsContent value="produtividade" className="mt-4"><Produtividade /></TabsContent>
          <TabsContent value="dispositivos" className="mt-4"><DevicesAdmin /></TabsContent>
          <TabsContent value="hardware" className="mt-4"><HardwareSecurityPanel /></TabsContent>
          <TabsContent value="bridge" className="mt-4"><BridgeConsole /></TabsContent>
          <TabsContent value="comunicacao" className="mt-4 space-y-4">
            <Card className="bg-card border-border">
              <CardContent className="p-3 flex flex-wrap gap-3 items-end">
                <div className="space-y-1">
                  <Label htmlFor="comm-from" className="text-xs text-muted-foreground">De</Label>
                  <Input id="comm-from" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-9 w-40" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="comm-to" className="text-xs text-muted-foreground">Até</Label>
                  <Input id="comm-to" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-9 w-40" />
                </div>
              </CardContent>
            </Card>
            <CommunicationReport farmId={farmId} fromDate={fromDate} toDate={toDate} equipmentFilter="all" />
          </TabsContent>
        </Tabs>
      </div>
    </RestrictedAuth>
  );
};

export default SuporteTecnico;
