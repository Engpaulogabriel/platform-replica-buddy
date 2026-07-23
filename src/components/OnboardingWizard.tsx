import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Droplets, CheckCircle } from "lucide-react";
import { notify } from "@/lib/notify";

interface OnboardingWizardProps {
  open: boolean;
  onClose: () => void;
}

export function OnboardingWizard({ open, onClose }: OnboardingWizardProps) {
  const finish = () => {
    localStorage.setItem("onboarding_done", "true");
    notify.ok("Onboarding", "Bem-vindo!");
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-foreground">
            <Droplets className="w-5 h-5 text-primary" />
            Bem-vindo ao Gestor de Bombas
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <p className="text-sm text-muted-foreground">
            Tudo pronto para começar. Use o menu lateral para acessar o Dashboard, Automação e Configurações.
          </p>
          <div className="grid grid-cols-3 gap-3">
            {[
              { icon: "🔵", label: "Controle remoto de bombas" },
              { icon: "📊", label: "Monitoramento em tempo real" },
              { icon: "⏰", label: "Automação por horário" },
            ].map((f) => (
              <div key={f.label} className="flex flex-col items-center gap-2 p-3 bg-secondary/50 rounded-lg border border-border text-center">
                <span className="text-2xl">{f.icon}</span>
                <span className="text-xs font-medium text-foreground">{f.label}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex justify-end pt-2">
          <Button size="sm" onClick={finish} className="gap-1 bg-primary text-primary-foreground">
            <CheckCircle className="w-3 h-3" /> Começar
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
