import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import RestrictedAuth from "@/components/RestrictedAuth";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Settings, Bell, Globe, Crown, Home, Volume2, Zap } from "lucide-react";
import SerialConfigSection from "@/components/SerialConfigSection";
import AudioSettingsCard from "@/components/AudioSettingsCard";
import SectorsConfig from "@/components/SectorsConfig";
import PeakHourConfigCard from "@/components/PeakHourConfigCard";
import { useState, useEffect } from "react";
import { usePlan } from "@/contexts/PlanContext";
import { notifyConfig } from "@/lib/notify";
import { useLanguage } from "@/contexts/LanguageContext";
import { Language } from "@/i18n/translations";

const langOptions: { value: Language; flag: string; label: string }[] = [
  { value: "pt", flag: "🇧🇷", label: "Português" },
  { value: "en", flag: "🇺🇸", label: "English" },
  { value: "es", flag: "🇪🇸", label: "Español" },
];

const Configuracoes = () => {
  const { language, setLanguage } = useLanguage();
  const { plan, setPlan, isPro } = usePlan();
  const [flowEnabled, setFlowEnabled] = useState(() => {
    const saved = localStorage.getItem("module_flow");
    return saved !== null ? saved === "true" : false;
  });
  const [consumptionEnabled, setConsumptionEnabled] = useState(() => {
    const saved = localStorage.getItem("module_consumption");
    return saved !== null ? saved === "true" : false;
  });
  const [voltageEnabled, setVoltageEnabled] = useState(() => {
    const saved = localStorage.getItem("module_voltage");
    return saved !== null ? saved === "true" : false;
  });
  const [currentEnabled, setCurrentEnabled] = useState(() => {
    const saved = localStorage.getItem("module_current");
    return saved !== null ? saved === "true" : false;
  });

  const handleFlowToggle = (checked: boolean) => {
    setFlowEnabled(checked);
    localStorage.setItem("module_flow", String(checked));
    notifyConfig.toggled("Módulo de Vazão", checked);
  };

  const handleConsumptionToggle = (checked: boolean) => {
    setConsumptionEnabled(checked);
    localStorage.setItem("module_consumption", String(checked));
    notifyConfig.toggled("Módulo de Consumo", checked);
  };

  const handleVoltageToggle = (checked: boolean) => {
    setVoltageEnabled(checked);
    localStorage.setItem("module_voltage", String(checked));
    window.dispatchEvent(new Event("modules:updated"));
    notifyConfig.toggled("Mostrador de Tensão", checked);
  };

  const handleCurrentToggle = (checked: boolean) => {
    setCurrentEnabled(checked);
    localStorage.setItem("module_current", String(checked));
    window.dispatchEvent(new Event("modules:updated"));
    notifyConfig.toggled("Mostrador de Corrente", checked);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Configurações</h1>
        <p className="text-sm text-muted-foreground mt-1">Preferências do sistema e perfil da fazenda</p>
      </div>
      <Tabs defaultValue="inicio">
        <TabsList className="bg-secondary border border-border flex-wrap h-auto">
          <TabsTrigger value="inicio" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground gap-2">
            <Home className="w-4 h-4" /> Configurações de Início
          </TabsTrigger>
          <TabsTrigger value="audio" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground gap-2">
            <Volume2 className="w-4 h-4" /> Áudio
          </TabsTrigger>
          <TabsTrigger value="notificacoes" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground gap-2">
            <Bell className="w-4 h-4" /> Notificações
          </TabsTrigger>
          <TabsTrigger value="ponta" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground gap-2">
            <Zap className="w-4 h-4" /> Horário de Ponta
          </TabsTrigger>
        </TabsList>

        <TabsContent value="audio" className="mt-4">
          <AudioSettingsCard />
        </TabsContent>
        <TabsContent value="inicio" className="mt-4">
          <SectorsConfig />
        </TabsContent>



        <TabsContent value="notificacoes" className="mt-4">
          <Card className="bg-card border-border">
            <CardHeader><CardTitle className="text-base text-foreground">Notificações Push</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between p-3 bg-secondary rounded-lg">
                <div>
                  <p className="text-sm font-medium text-foreground">Alarme de Nível Baixo</p>
                  <p className="text-xs text-muted-foreground">Receber push quando nível cair abaixo do mínimo</p>
                </div>
                <Switch className="data-[state=checked]:bg-primary" defaultChecked />
              </div>
              <div className="flex items-center justify-between p-3 bg-secondary rounded-lg">
                <div>
                  <p className="text-sm font-medium text-foreground">Alarme de Nível Alto</p>
                  <p className="text-xs text-muted-foreground">Receber push quando nível subir acima do máximo</p>
                </div>
                <Switch className="data-[state=checked]:bg-primary" defaultChecked />
              </div>
              <div className="flex items-center justify-between p-3 bg-secondary rounded-lg">
                <div>
                  <p className="text-sm font-medium text-foreground">Equipamento Offline</p>
                  <p className="text-xs text-muted-foreground">Receber push quando bomba ficar offline</p>
                </div>
                <Switch className="data-[state=checked]:bg-primary" defaultChecked />
              </div>
              <Button className="bg-primary text-primary-foreground">Salvar</Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="ponta" className="mt-4">
          <PeakHourConfigCard />
        </TabsContent>


      </Tabs>
    </div>
  );
};

export default Configuracoes;
