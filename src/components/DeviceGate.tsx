// DeviceGate: bloqueia acesso de dispositivos não autorizados e exibe
// o código da máquina para aprovação manual na plataforma.
// Também aplica restrição por IP quando ativada para a fazenda do usuário.
import type { ReactNode } from "react";
import { Loader2, Shield, LogOut, Phone, Mail, Copy, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { useDeviceAuthorization } from "@/hooks/useDeviceAuthorization";
import { useIpRestriction } from "@/hooks/useIpRestriction";
import { notify } from "@/lib/notify";

export function DeviceGate({ children }: { children: ReactNode }) {
  const { status, deviceInfo } = useDeviceAuthorization();
  const ipCheck = useIpRestriction();
  const { logout } = useAuth();

  if (status === "checking" || ipCheck.status === "checking") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (status === "blocked") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="max-w-md w-full bg-card border border-border rounded-2xl p-8 space-y-6 shadow-xl">
          <div className="flex flex-col items-center text-center space-y-2">
            <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center">
              <Shield className="w-8 h-8 text-destructive" />
            </div>
            <h1 className="text-xl font-bold text-foreground">🔒 Dispositivo não autorizado</h1>
            <p className="text-sm text-muted-foreground">
              Este dispositivo não está registrado para acessar o sistema. Informe o código abaixo para liberação.
            </p>
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2 text-foreground"><Phone className="w-4 h-4 text-primary" /> (75) 99999-9999</div>
            <div className="flex items-center gap-2 text-foreground"><Mail className="w-4 h-4 text-primary" /> suporte@renovtecnologia.com.br</div>
          </div>
          {deviceInfo && (
            <div className="bg-muted rounded-lg p-3 space-y-1">
              <p className="text-xs text-muted-foreground">Código do dispositivo</p>
              <div className="flex items-center justify-between">
                <code className="font-mono text-base font-bold text-foreground tracking-wider">{deviceInfo.short}</code>
                <Button size="icon" variant="ghost" onClick={() => { navigator.clipboard.writeText(deviceInfo.short); notify.ok("Dispositivo", "Código copiado"); }}>
                  <Copy className="w-4 h-4" />
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground">{deviceInfo.os} • {deviceInfo.browser}</p>
            </div>
          )}
          <Button variant="outline" className="w-full gap-2" onClick={logout}>
            <LogOut className="w-4 h-4" /> Sair
          </Button>
        </div>
      </div>
    );
  }

  if (ipCheck.status === "blocked") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="max-w-md w-full bg-card border border-border rounded-2xl p-8 space-y-6 shadow-xl">
          <div className="flex flex-col items-center text-center space-y-2">
            <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center">
              <Globe className="w-8 h-8 text-destructive" />
            </div>
            <h1 className="text-xl font-bold text-foreground">🚫 Dispositivo não autorizado</h1>
            <p className="text-sm text-muted-foreground">
              Seu dispositivo ainda não foi autorizado para acessar a fazenda <b>{ipCheck.farmName ?? "—"}</b>.
              O administrador foi notificado e irá aprovar seu acesso.
            </p>
          </div>
          <div className="bg-muted rounded-lg p-3 space-y-1">
            <p className="text-xs text-muted-foreground">Seu IP atual</p>
            <div className="flex items-center justify-between">
              <code className="font-mono text-base font-bold text-foreground tracking-wider">{ipCheck.ip ?? "desconhecido"}</code>
              {ipCheck.ip && (
                <Button size="icon" variant="ghost" onClick={() => { navigator.clipboard.writeText(ipCheck.ip!); notify.ok("IP", "IP copiado"); }}>
                  <Copy className="w-4 h-4" />
                </Button>
              )}
            </div>
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2 text-foreground"><Phone className="w-4 h-4 text-primary" /> (75) 99999-9999</div>
            <div className="flex items-center gap-2 text-foreground"><Mail className="w-4 h-4 text-primary" /> suporte@renovtecnologia.com.br</div>
          </div>
          <Button variant="outline" className="w-full gap-2" onClick={logout}>
            <LogOut className="w-4 h-4" /> Sair
          </Button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
