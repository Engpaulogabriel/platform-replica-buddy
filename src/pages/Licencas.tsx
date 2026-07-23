import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { KeyRound, Copy, Shield, AlertTriangle, ShieldCheck, Loader2 } from "lucide-react";
import { notify } from "@/lib/notify";

const SUPABASE_URL = "https://feqyexitblmhyzykttgu.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZlcXlleGl0YmxtaHl6eWt0dGd1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE5MzU0MDQsImV4cCI6MjA4NzUxMTQwNH0.zy3VEqRg_wicaHH9annVoDxq1YLEsN327Z9ksppSnkc";

const LicenseManager = () => {
  const [targetMachineId, setTargetMachineId] = useState("");
  const [generatedKey, setGeneratedKey] = useState("");
  const [challenge, setChallenge] = useState("");
  const [codeResult, setCodeResult] = useState<string | null>(null);
  const [requestedBy, setRequestedBy] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<Array<{ machineId: string; key: string; date: string }>>(() => {
    try {
      return JSON.parse(localStorage.getItem("license-history") || "[]");
    } catch {
      return [];
    }
  });

  const isElectron = !!window.licenseAPI;
  const currentMachineId = window.licenseAPI?.getMachineId?.() || "Disponível apenas no Electron";
  const currentLicense = window.licenseAPI?.checkLicense?.();

  /* ── Gerar licença via Electron (local) ── */
  const handleGenerateLocal = () => {
    const id = targetMachineId.trim().toUpperCase();
    if (id.length < 8) {
      notify.fail("Licenças", "ID da máquina inválido (mínimo 8 caracteres)");
      return;
    }

    let key: string;
    if (window.licenseAPI) {
      key = window.licenseAPI.generateKey(id);
    } else {
      notify.warn("Licenças", "Geração de chaves real só funciona no Electron");
      key = "DEMO-DEMO-DEMO-DEMO-DEMO-DEMO";
    }

    setGeneratedKey(key);
    saveToHistory(id, key);
    notify.ok("Licenças", "Chave gerada com sucesso!");
  };

  /* ── Gerador de códigos (Code Companion) ── */
  const handleGenerateCode = async () => {
    setError("");
    setCodeResult(null);

    if (!/^[A-Za-z0-9]{6}$/.test(challenge)) {
      setError("Insira exatamente 6 caracteres (letras ou números).");
      return;
    }

    if (!requestedBy.trim()) {
      setError("Informe quem está solicitando.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/validate-2fa`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_ANON_KEY,
          "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          action: "get-response",
          challenge: challenge.toUpperCase(),
        }),
      });

      const data = await res.json();
      const normalizedResponse =
        typeof data?.response === "string"
          ? data.response.trim().toUpperCase().replace(/[^A-Z0-9]/g, "")
          : "";

      if (!res.ok) {
        setError("Falha ao consultar o servidor.");
      } else if (normalizedResponse.length === 6) {
        setCodeResult(normalizedResponse);
        notify.ok("Licenças", "Código gerado!");
      } else {
        setError("Resposta inválida recebida do servidor.");
      }
    } catch {
      setError("Erro de conexão. Verifique sua internet.");
    } finally {
      setLoading(false);
    }
  };

  const saveToHistory = (machineId: string, key: string) => {
    const entry = { machineId, key, date: new Date().toLocaleString("pt-BR") };
    const updated = [entry, ...history].slice(0, 50);
    setHistory(updated);
    localStorage.setItem("license-history", JSON.stringify(updated));
  };

  const copyKey = (text: string) => {
    navigator.clipboard.writeText(text);
    notify.ok("Licenças", "Copiado!");
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
          <Shield className="w-6 h-6 text-primary" />
          Gerenciador de Licenças
        </h1>
        <p className="text-sm text-muted-foreground mt-1">Gere chaves de ativação anti-clone e códigos de acesso</p>
      </div>

      {/* Current Machine Info */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm text-foreground">Esta Máquina</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">ID da Máquina</p>
              <p className="font-mono text-sm text-foreground tracking-wider">{currentMachineId}</p>
            </div>
            {isElectron && (
              <Button variant="outline" size="sm" onClick={() => copyKey(currentMachineId)}>
                <Copy className="w-3 h-3 mr-1" /> Copiar
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={currentLicense?.activated ? "default" : "secondary"}>
              {currentLicense?.activated ? "✓ Ativado" : "Não ativado"}
            </Badge>
            {currentLicense?.activatedAt && (
              <span className="text-xs text-muted-foreground">
                desde {new Date(currentLicense.activatedAt).toLocaleString("pt-BR")}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* License Key Generator */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm text-foreground flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-primary" />
              Gerar Licença (Anti-Clone)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-sm">ID da Máquina do Cliente</Label>
              <Input
                placeholder="Cole aqui o ID da máquina"
                value={targetMachineId}
                onChange={(e) => setTargetMachineId(e.target.value.toUpperCase())}
                className="font-mono bg-secondary border-border text-foreground placeholder:text-muted-foreground tracking-wider"
              />
            </div>

            <Button onClick={handleGenerateLocal} className="w-full gap-2">
              <KeyRound className="w-4 h-4" /> Gerar Chave de Licença
            </Button>

            {generatedKey && (
              <div className="bg-secondary rounded-lg p-4 space-y-2">
                <p className="text-xs text-muted-foreground">Chave Gerada:</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 font-mono text-sm text-primary font-bold tracking-wider">
                    {generatedKey}
                  </code>
                  <Button variant="outline" size="sm" onClick={() => copyKey(generatedKey)}>
                    <Copy className="w-3 h-3" />
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Code Generator (from Code Companion) */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm text-foreground flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-accent" />
              Gerador de Códigos (2FA)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-sm">Solicitante *</Label>
              <Input
                placeholder="Seu nome"
                value={requestedBy}
                onChange={(e) => setRequestedBy(e.target.value)}
                className="bg-secondary border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-sm">Código de Desafio</Label>
              <Input
                maxLength={6}
                placeholder="ABC123"
                value={challenge}
                onChange={(e) => setChallenge(e.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase())}
                className="font-mono text-center text-xl tracking-[0.4em] bg-secondary border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button onClick={handleGenerateCode} disabled={loading} className="w-full gap-2">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
              {loading ? "Gerando..." : "Gerar Código de Resposta"}
            </Button>

            {codeResult && (
              <div className="bg-accent/10 border border-accent/30 rounded-lg p-4 space-y-2">
                <p className="text-xs text-accent font-medium flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5" /> Código de Resposta
                </p>
                <div className="flex items-center justify-between">
                  <span className="font-mono text-2xl font-bold tracking-[0.3em] text-foreground">
                    {codeResult}
                  </span>
                  <Button variant="outline" size="sm" onClick={() => copyKey(codeResult)}>
                    <Copy className="w-3 h-3" />
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Warning for browser mode */}
      {!isElectron && (
        <div className="flex items-start gap-3 p-4 rounded-lg border border-warning/30 bg-warning/5">
          <AlertTriangle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-foreground">Modo Navegador</p>
            <p className="text-xs text-muted-foreground">
              A geração de chaves de licença e ID da máquina só funcionam no Electron (.exe).
              O gerador de códigos 2FA funciona normalmente via internet.
            </p>
          </div>
        </div>
      )}

      {/* History */}
      {history.length > 0 && (
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm text-foreground">Histórico de Licenças Geradas</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {history.map((entry, i) => (
                <div key={i} className="flex items-center justify-between p-3 bg-secondary rounded-lg">
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-xs text-muted-foreground truncate">
                      Máquina: {entry.machineId}
                    </p>
                    <p className="font-mono text-xs text-primary font-bold truncate">
                      Chave: {entry.key}
                    </p>
                    <p className="text-xs text-muted-foreground">{entry.date}</p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => copyKey(entry.key)}>
                    <Copy className="w-3 h-3" />
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

export default LicenseManager;
