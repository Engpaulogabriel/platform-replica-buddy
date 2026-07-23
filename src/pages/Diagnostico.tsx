import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Activity, Radio, Droplets, Power, AlertTriangle, Server, Settings2, Waves } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { notify } from "@/lib/notify";
import DiagnosticoAuth from "@/components/diagnostico/DiagnosticoAuth";
import StatusSistemaSection from "@/components/diagnostico/StatusSistemaSection";
import RepetidorSection from "@/components/diagnostico/RepetidorSection";
import BombaSection from "@/components/diagnostico/BombaSection";
import NivelSection from "@/components/diagnostico/NivelSection";
import ServerCfgDialog from "@/components/diagnostico/ServerCfgDialog";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";

const tabItems = [
  { value: "status", label: "Status", icon: Activity },
  { value: "servidor", label: "Servidor", icon: Server },
  { value: "repetidor", label: "Repetidor", icon: Radio },
  { value: "bomba", label: "Bomba", icon: Droplets },
  { value: "nivel", label: "Nível", icon: Waves },
];

const Diagnostico = () => {
  const [activeTab, setActiveTab] = useState("status");
  const [diagnosticoAtivo, setDiagnosticoAtivo] = useState(false);
  const [serverCfgOpen, setServerCfgOpen] = useState(false);
  const farmId = useDefaultFarmId();

  const handleToggleDiagnostico = (checked: boolean) => {
    setDiagnosticoAtivo(checked);
    if (checked) {
      notify.warn("Diagnóstico", "Modo diagnóstico ATIVADO — comunicação normal pausada. Apenas comandos de diagnóstico serão processados.");
    } else {
      notify.ok("Diagnóstico", "Modo diagnóstico DESATIVADO — comunicação normal retomada.");
    }
  };

  return (
    <DiagnosticoAuth>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Diagnóstico</h1>
            <p className="text-sm text-muted-foreground mt-1">Configuração e diagnóstico de hardware via RS-485</p>
          </div>
          <div className="flex items-center gap-3">
            <Badge
              variant={diagnosticoAtivo ? "destructive" : "secondary"}
              className="gap-1.5 px-3 py-1.5 text-xs font-medium"
            >
              <Power className="w-3 h-3" />
              {diagnosticoAtivo ? "Diagnóstico Ativo" : "Diagnóstico Inativo"}
            </Badge>
            <Switch
              checked={diagnosticoAtivo}
              onCheckedChange={handleToggleDiagnostico}
            />
          </div>
        </div>

        {diagnosticoAtivo && (
          <div className="flex items-center gap-3 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3">
            <AlertTriangle className="h-5 w-5 text-destructive shrink-0" />
            <div>
              <p className="text-sm font-medium text-destructive">Comunicação normal pausada</p>
              <p className="text-xs text-muted-foreground">
                O sistema de comunicação automático está em pausa. Apenas comandos enviados manualmente nesta aba serão processados.
                Desative o modo diagnóstico para retomar a operação normal.
              </p>
            </div>
          </div>
        )}

        {!diagnosticoAtivo && (
          <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/50 px-4 py-3">
            <Power className="h-5 w-5 text-muted-foreground shrink-0" />
            <p className="text-sm text-muted-foreground">
              Ative o modo diagnóstico para pausar a comunicação normal e enviar comandos manuais.
            </p>
          </div>
        )}

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="bg-secondary border border-border">
            {tabItems.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value} className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground gap-2">
                <tab.icon className="w-4 h-4" />
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="status" className="mt-4">
            <StatusSistemaSection />
          </TabsContent>
          <TabsContent value="servidor" className="mt-4">
            <div className="rounded-xl border border-border bg-card p-6 space-y-4">
              <div className="flex items-start gap-3">
                <Server className="h-6 w-6 text-primary mt-0.5" />
                <div className="flex-1">
                  <h3 className="text-base font-semibold text-foreground">Servidor (ESP_A)</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Configurações avançadas do servidor RS-485 — timings de rádio, deduplicação, recovery I2C, auto-reset do ESP_B e modo debug.
                  </p>
                </div>
              </div>
              <Button
                onClick={() => setServerCfgOpen(true)}
                disabled={!farmId}
                className="gap-2"
              >
                <Settings2 className="h-4 w-4" /> Abrir configurações avançadas
              </Button>
              <p className="text-xs text-muted-foreground">
                Os comandos são enviados em texto puro pelo RS-485 (terminados em <span className="font-mono">\r</span>). O Servidor faz auto-save após cada alteração.
              </p>
            </div>
          </TabsContent>
          <TabsContent value="repetidor" className="mt-4">
            <RepetidorSection diagnosticoAtivo={diagnosticoAtivo} />
          </TabsContent>
          <TabsContent value="bomba" className="mt-4">
            <BombaSection diagnosticoAtivo={diagnosticoAtivo} />
          </TabsContent>
          <TabsContent value="nivel" className="mt-4">
            <NivelSection />
          </TabsContent>
        </Tabs>
      </div>
      {farmId && (
        <ServerCfgDialog open={serverCfgOpen} onOpenChange={setServerCfgOpen} farmId={farmId} />
      )}
    </DiagnosticoAuth>
  );
};

export default Diagnostico;
