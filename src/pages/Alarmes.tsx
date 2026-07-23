import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Bell, BellRing, ArrowDown, ArrowUp, TestTube, Droplet } from "lucide-react";
import BellHistoryPanel from "@/components/BellHistoryPanel";

const reservoirs = [
  { id: 1, name: "Reservatório R1", level: 75, alarmLow: 20, alarmHigh: 90, lowActive: true, highActive: true },
  { id: 2, name: "Reservatório R2", level: 22, alarmLow: 25, alarmHigh: 95, lowActive: true, highActive: true },
  { id: 3, name: "Reservatório R3", level: 55, alarmLow: 20, alarmHigh: 90, lowActive: true, highActive: false },
  { id: 4, name: "Reservatório R4", level: 88, alarmLow: 15, alarmHigh: 85, lowActive: true, highActive: true },
];

function getLevelColor(percent: number) {
  if (percent >= 60) return "text-primary";
  if (percent >= 30) return "text-warning";
  return "text-destructive";
}

const Alarmes = () => {
  const [data] = useState(reservoirs);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Alarmes e Notificações</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configure alertas de reservatório e revise o histórico do sino.
        </p>
      </div>

      <Tabs defaultValue="reservoirs">
        <TabsList>
          <TabsTrigger value="reservoirs" className="gap-2"><Droplet className="w-4 h-4" />Reservatórios</TabsTrigger>
          <TabsTrigger value="bell" className="gap-2"><Bell className="w-4 h-4" />Histórico do Sino</TabsTrigger>
        </TabsList>

        <TabsContent value="reservoirs" className="space-y-4 mt-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {data.map((res) => {
              const isLowAlert = res.lowActive && res.level <= res.alarmLow;
              const isHighAlert = res.highActive && res.level >= res.alarmHigh;
              return (
                <Card key={res.id} className={`bg-card border-border ${(isLowAlert || isHighAlert) ? "border-destructive/50" : ""}`}>
                  <CardContent className="p-4 space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {(isLowAlert || isHighAlert)
                          ? <BellRing className="w-5 h-5 text-warning animate-pulse-alert" />
                          : <Bell className="w-5 h-5 text-muted-foreground" />}
                        <h3 className="font-bold text-foreground">{res.name}</h3>
                      </div>
                      <span className={`text-lg font-bold ${getLevelColor(res.level)}`}>{res.level}%</span>
                    </div>
                    <div className="flex items-center gap-3 p-3 rounded-lg bg-secondary">
                      <ArrowDown className="w-4 h-4 text-warning shrink-0" />
                      <div className="flex-1">
                        <p className="text-xs text-muted-foreground">Alarme Nível Baixo</p>
                        <div className="flex items-center gap-2 mt-1">
                          <Input type="number" value={res.alarmLow} className="w-20 h-8 bg-card border-border text-foreground text-sm" onChange={() => {}} />
                          <span className="text-sm text-muted-foreground">%</span>
                        </div>
                      </div>
                      <Switch checked={res.lowActive} className="data-[state=checked]:bg-primary" />
                    </div>
                    <div className="flex items-center gap-3 p-3 rounded-lg bg-secondary">
                      <ArrowUp className="w-4 h-4 text-destructive shrink-0" />
                      <div className="flex-1">
                        <p className="text-xs text-muted-foreground">Alarme Nível Alto</p>
                        <div className="flex items-center gap-2 mt-1">
                          <Input type="number" value={res.alarmHigh} className="w-20 h-8 bg-card border-border text-foreground text-sm" onChange={() => {}} />
                          <span className="text-sm text-muted-foreground">%</span>
                        </div>
                      </div>
                      <Switch checked={res.highActive} className="data-[state=checked]:bg-primary" />
                    </div>
                    <Button variant="outline" size="sm" className="w-full border-border text-muted-foreground hover:text-foreground gap-2">
                      <TestTube className="w-4 h-4" /> Testar Alarme
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </TabsContent>

        <TabsContent value="bell" className="mt-4">
          <BellHistoryPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default Alarmes;
