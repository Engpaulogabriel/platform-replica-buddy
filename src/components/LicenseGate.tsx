import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Shield, Copy, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { notify } from "@/lib/notify";
import renovLogo from "@/assets/renov-logo.png";

interface LicenseGateProps {
  children: React.ReactNode;
}

const LicenseGate = ({ children }: LicenseGateProps) => {
  const [checking, setChecking] = useState(true);
  const [activated, setActivated] = useState(false);
  const [machineId, setMachineId] = useState("");
  const [licenseKey, setLicenseKey] = useState("");
  const [error, setError] = useState("");
  const [activating, setActivating] = useState(false);

  useEffect(() => {
    // If not running in Electron, skip license check (dev mode)
    if (!window.licenseAPI) {
      setChecking(false);
      setActivated(true);
      return;
    }

    const result = window.licenseAPI.checkLicense();
    setMachineId(result.machineId);
    setActivated(result.activated);
    setChecking(false);
  }, []);

  const handleActivate = async () => {
    if (!licenseKey.trim()) {
      setError("Insira a chave de licença");
      return;
    }

    setActivating(true);
    setError("");

    // Small delay for UX
    await new Promise((r) => setTimeout(r, 500));

    const result = window.licenseAPI!.activate(licenseKey.trim());
    if (result.success) {
      setActivated(true);
      notify.ok("Licença", "Sistema ativado com sucesso!");
    } else {
      setError("Chave de licença inválida para esta máquina");
    }
    setActivating(false);
  };

  const copyMachineId = () => {
    navigator.clipboard.writeText(machineId);
    notify.ok("Licença", "ID da máquina copiado!");
  };

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (activated) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[hsl(210,55%,18%)]">
      <div className="fixed inset-0 bg-[radial-gradient(ellipse_at_center,hsl(145_55%_38%/0.1),transparent_70%)]" />

      <div className="w-full max-w-md mx-4 relative z-10">
        <div className="bg-white border border-border rounded-2xl p-8 space-y-6 shadow-xl">
          {/* Logo */}
          <div className="flex flex-col items-center space-y-3">
            <img src={renovLogo} alt="Renov" className="h-14 w-auto" />
            <div className="flex items-center gap-2 text-primary">
              <Shield className="w-5 h-5" />
              <h1 className="text-lg font-bold">Ativação do Sistema</h1>
            </div>
            <p className="text-xs text-muted-foreground text-center">
              Este sistema requer ativação vinculada ao hardware desta máquina.
            </p>
          </div>

          {/* Machine ID */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">ID da Máquina</label>
            <div className="flex gap-2">
              <Input
                readOnly
                value={machineId}
                className="font-mono text-xs bg-secondary border-border text-foreground tracking-wider"
              />
              <Button variant="outline" size="icon" onClick={copyMachineId} title="Copiar ID">
                <Copy className="w-4 h-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Envie este ID ao administrador para receber sua chave de licença.
            </p>
          </div>

          {/* License Key Input */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Chave de Licença</label>
            <Input
              placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
              value={licenseKey}
              onChange={(e) => setLicenseKey(e.target.value.toUpperCase())}
              className="font-mono bg-secondary border-border text-foreground placeholder:text-muted-foreground tracking-wider"
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 text-destructive text-sm">
              <XCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <Button
            onClick={handleActivate}
            disabled={activating}
            className="w-full h-12 text-base font-bold bg-primary text-primary-foreground"
          >
            {activating ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <>
                <CheckCircle2 className="w-5 h-5 mr-2" />
                Ativar Sistema
              </>
            )}
          </Button>

          <p className="text-xs text-center text-muted-foreground">
            Renov Tecnologia Agrícola — Sistema protegido contra cópia
          </p>
        </div>
      </div>
    </div>
  );
};

export default LicenseGate;
