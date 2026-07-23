import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Timer } from "lucide-react";
import { notify } from "@/lib/notify";
import {
  loadSystemTimers,
  saveSystemTimers,
  type SystemTimers,
} from "@/lib/systemTimers";

const TimersConfig = () => {
  const [timers, setTimers] = useState<SystemTimers>(() => loadSystemTimers());
  const [timersDirty, setTimersDirty] = useState(false);

  useEffect(() => {
    setTimers(loadSystemTimers());
  }, []);

  const updateTimer = (key: keyof SystemTimers, value: string) => {
    setTimers((prev) => ({ ...prev, [key]: value }));
    setTimersDirty(true);
  };

  const handleSaveTimers = () => {
    const saved = saveSystemTimers(timers);
    setTimers(saved);
    setTimersDirty(false);
    notify.ok("Temporizadores", "Temporizadores salvos com sucesso");
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <CardTitle className="text-base text-foreground flex items-center gap-2">
          <Timer className="w-4 h-4" /> Temporizadores
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Label className="text-foreground">Tempo de Comunicação do Sistema</Label>
          <p className="text-xs text-muted-foreground mt-0.5 mb-1.5">Intervalo entre cada envio de comando para os equipamentos</p>
          <Select value={timers.commSystem} onValueChange={(v) => updateTimer("commSystem", v)}>
            <SelectTrigger className="bg-secondary border-border"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="4">4 segundos</SelectItem>
              <SelectItem value="5">5 segundos</SelectItem>
              <SelectItem value="6">6 segundos</SelectItem>
              <SelectItem value="7">7 segundos</SelectItem>
              <SelectItem value="8">8 segundos</SelectItem>
              <SelectItem value="10">10 segundos</SelectItem>
              <SelectItem value="12">12 segundos</SelectItem>
              <SelectItem value="15">15 segundos</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-foreground">Frequência Comunicação dos Níveis</Label>
          <p className="text-xs text-muted-foreground mt-0.5 mb-1.5">Intervalo entre cada leitura dos sensores de nível</p>
          <Select value={timers.commLevels} onValueChange={(v) => updateTimer("commLevels", v)}>
            <SelectTrigger className="bg-secondary border-border"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="1">1 segundo</SelectItem>
              <SelectItem value="2">2 segundos</SelectItem>
              <SelectItem value="3">3 segundos</SelectItem>
              <SelectItem value="5">5 segundos</SelectItem>
              <SelectItem value="10">10 segundos</SelectItem>
              <SelectItem value="15">15 segundos</SelectItem>
              <SelectItem value="30">30 segundos</SelectItem>
              <SelectItem value="60">1 minuto</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-foreground">Tempo Sem Comunicação Automação</Label>
          <p className="text-xs text-muted-foreground mt-0.5 mb-1.5">Tempo máximo sem resposta dos equipamentos de automação antes de considerar offline</p>
          <Select value={timers.offlineAuto} onValueChange={(v) => updateTimer("offlineAuto", v)}>
            <SelectTrigger className="bg-secondary border-border"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="10">10 segundos</SelectItem>
              <SelectItem value="15">15 segundos</SelectItem>
              <SelectItem value="30">30 segundos</SelectItem>
              <SelectItem value="60">1 minuto</SelectItem>
              <SelectItem value="120">2 minutos</SelectItem>
              <SelectItem value="300">5 minutos</SelectItem>
              <SelectItem value="600">10 minutos</SelectItem>
              <SelectItem value="900">15 minutos</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-foreground">Tempo Sem Comunicação Níveis</Label>
          <p className="text-xs text-muted-foreground mt-0.5 mb-1.5">Tempo máximo sem resposta dos sensores de nível antes de considerar offline</p>
          <Select value={timers.offlineLevels} onValueChange={(v) => updateTimer("offlineLevels", v)}>
            <SelectTrigger className="bg-secondary border-border"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="10">10 segundos</SelectItem>
              <SelectItem value="15">15 segundos</SelectItem>
              <SelectItem value="30">30 segundos</SelectItem>
              <SelectItem value="60">1 minuto</SelectItem>
              <SelectItem value="120">2 minutos</SelectItem>
              <SelectItem value="300">5 minutos</SelectItem>
              <SelectItem value="600">10 minutos</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-foreground">Tempo de Reset Automático do Comando</Label>
          <p className="text-xs text-muted-foreground mt-0.5 mb-1.5">Tempo para resetar automaticamente um comando pendente que não obteve resposta</p>
          <Select value={timers.autoReset} onValueChange={(v) => updateTimer("autoReset", v)}>
            <SelectTrigger className="bg-secondary border-border"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="1">1 minuto</SelectItem>
              <SelectItem value="2">2 minutos</SelectItem>
              <SelectItem value="3">3 minutos</SelectItem>
              <SelectItem value="5">5 minutos</SelectItem>
              <SelectItem value="10">10 minutos</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between gap-3 pt-2">
          <p className="text-xs text-muted-foreground">
            {timersDirty ? "Você tem alterações não salvas." : "Todas as alterações estão salvas."}
          </p>
          <Button
            onClick={handleSaveTimers}
            disabled={!timersDirty}
            className="bg-primary text-primary-foreground disabled:opacity-50"
          >
            Salvar
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

export default TimersConfig;
