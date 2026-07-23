import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Volume2, VolumeX, Play, AlertTriangle } from "lucide-react";
import { isFailureSoundMuted, setFailureSoundMuted, playFailureSound } from "@/lib/failureSound";
import { notify } from "@/lib/notify";

export default function AudioSettingsCard() {
  const [muted, setMuted] = useState<boolean>(() => isFailureSoundMuted());

  const handleToggle = (checked: boolean) => {
    // checked = som ATIVO → muted = !checked
    const nextMuted = !checked;
    setFailureSoundMuted(nextMuted);
    setMuted(nextMuted);
    notify.ok("Áudio", nextMuted ? "Som de falha desativado" : "Som de falha ativado");
  };

  const handleTest = () => {
    if (muted) {
      // toca mesmo se mutado, é só teste
      setFailureSoundMuted(false);
      playFailureSound();
      setFailureSoundMuted(true);
    } else {
      playFailureSound();
    }
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <CardTitle className="text-base text-foreground flex items-center gap-2">
          <Volume2 className="w-4 h-4" /> Configurações de Áudio
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between p-3 bg-secondary rounded-lg">
          <div className="flex items-start gap-3">
            <div className={`p-2 rounded-md ${muted ? "bg-muted text-muted-foreground" : "bg-destructive/15 text-destructive"}`}>
              {muted ? <VolumeX className="w-5 h-5" /> : <AlertTriangle className="w-5 h-5" />}
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">Som de falha do sistema</p>
              <p className="text-xs text-muted-foreground max-w-md">
                Toca um alerta sonoro toda vez que ocorrer uma falha crítica
                (bomba não ligou/desligou, perda de comunicação, etc.).
              </p>
            </div>
          </div>
          <Switch
            checked={!muted}
            onCheckedChange={handleToggle}
            className="data-[state=checked]:bg-primary"
          />
        </div>

        <div className="flex items-center justify-between gap-3 pt-1">
          <p className="text-xs text-muted-foreground">
            Use o botão ao lado para ouvir como o alerta soa.
          </p>
          <Button
            variant="outline"
            onClick={handleTest}
            className="gap-2"
          >
            <Play className="w-4 h-4" /> Testar som
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
