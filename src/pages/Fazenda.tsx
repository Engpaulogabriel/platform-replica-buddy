import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Building2, Copy, KeyRound, Check, FileText, RotateCw, Loader2 } from "lucide-react";
import { notify } from "@/lib/notify";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";
import { usePlatformAdmin } from "@/hooks/usePlatformAdmin";
import { supabase } from "@/integrations/supabase/client";
import { runAgentCommand } from "@/lib/agentCommands";
import { confirmAction } from "@/lib/confirmDialog";
import SedeCoordsCard from "@/components/SedeCoordsCard";

export const FAZENDA_STORAGE_KEY = "fazenda_data";

export interface FazendaData {
  nome: string;
  proprietario: string;
  cidadeEstado: string;
  telefone: string;
}

export function loadFazendaData(): FazendaData {
  try {
    const saved = localStorage.getItem(FAZENDA_STORAGE_KEY);
    if (saved) return JSON.parse(saved);
  } catch {}
  return { nome: "Fazenda Santa Maria", proprietario: "João Silva", cidadeEstado: "Uberaba - MG", telefone: "(34) 99999-0000" };
}

function InemaToggleCard({ farmId }: { farmId: string | null }) {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!farmId) return;
    setLoading(true);
    (async () => {
      const { data, error } = await supabase
        .from("farms")
        .select("inema_enabled" as any)
        .eq("id", farmId)
        .maybeSingle();
      if (!alive) return;
      if (!error && data) setEnabled(Boolean((data as any).inema_enabled));
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [farmId]);

  const toggle = async (next: boolean) => {
    if (!farmId || saving) return;
    setSaving(true);
    const prev = enabled;
    setEnabled(next);
    const { error } = await supabase
      .from("farms")
      .update({ inema_enabled: next } as any)
      .eq("id", farmId);
    setSaving(false);
    if (error) {
      setEnabled(prev);
      notify.fail("INEMA", "Não foi possível salvar o módulo INEMA.");
    } else {
      notify.ok("INEMA", `Módulo INEMA ${next ? "ativado" : "desativado"} para esta fazenda.`);
    }
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <CardTitle className="text-base text-foreground flex items-center gap-2">
          <FileText className="w-4 h-4 text-primary" /> Módulo INEMA
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-foreground font-medium">
              Conformidade Hídrica INEMA
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Quando ativo, a aba "Conformidade INEMA" aparece em Produtividade e o
              agente monitora as outorgas desta fazenda.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-muted-foreground w-12 text-right">
              {loading ? "..." : enabled ? "Ativo" : "Inativo"}
            </span>
            <Switch
              checked={enabled}
              onCheckedChange={toggle}
              disabled={loading || saving || !farmId}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// Reiniciar Agente — SÓ super-admin (platform_admin). Enfileira agent_restart em
// agent_commands; o agente Electron executa app.relaunch()+app.exit(0) e volta em
// segundos. Elimina AnyDesk para reiniciar o .exe da fazenda remotamente.
function AgentRestartCard({ farmId }: { farmId: string | null }) {
  const { isPlatformAdmin, loading } = usePlatformAdmin();
  const [busy, setBusy] = useState(false);

  if (loading || !isPlatformAdmin) return null;

  const restart = async () => {
    if (!farmId || busy) return;
    const ok = await confirmAction({
      title: "Reiniciar o Agente desta fazenda?",
      description:
        "O Renov Agent (.exe) no PC da fazenda vai reiniciar. A comunicação com as " +
        "bombas fica indisponível por alguns segundos enquanto o processo sobe de novo.",
      confirmLabel: "Reiniciar Agente",
      variant: "destructive",
    });
    if (!ok) return;
    setBusy(true);
    try {
      // expira em 5min: se o agente estiver offline agora, executa ao voltar (dentro da janela).
      const { result } = await runAgentCommand({
        farmId, kind: "agent_restart", payload: {}, expiresInSec: 300, timeoutMs: 20_000,
      });
      if (result.status === "done") {
        notify.ok("Agente", "Reinício confirmado — o agente está subindo novamente.");
      } else if (result.status === "expired") {
        notify.warn("Agente",
          "Comando enfileirado, mas o agente não respondeu (offline ou travado). " +
          "Se estiver travado, o watchdog do PC reinicia automaticamente.");
      } else {
        notify.fail("Agente", `Falha ao reiniciar: ${result.error_message ?? "erro desconhecido"}`);
      }
    } catch (e: any) {
      notify.fail("Agente", e?.message ?? "Falha ao enviar o comando de reinício.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <CardTitle className="text-base text-foreground flex items-center gap-2">
          <RotateCw className="w-4 h-4 text-primary" /> Reiniciar Agente
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Reinicia o Renov Agent instalado no PC da fazenda remotamente, sem AnyDesk.
          Útil para destravar o agente ou aplicar mudanças de configuração.
        </p>
        <Button variant="destructive" onClick={restart} disabled={busy || !farmId}>
          {busy ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <RotateCw className="w-4 h-4 mr-1.5" />}
          {busy ? "Enviando…" : "Reiniciar Agente"}
        </Button>
      </CardContent>
    </Card>
  );
}

const FazendaContent = () => {
  const [form, setForm] = useState<FazendaData>(loadFazendaData);
  const farmId = useDefaultFarmId();
  const [copied, setCopied] = useState(false);

  const save = () => {
    localStorage.setItem(FAZENDA_STORAGE_KEY, JSON.stringify(form));
    window.dispatchEvent(new Event("fazenda-updated"));
    notify.ok("Fazenda", "Dados da fazenda salvos com sucesso!");
  };

  const copyFarmId = async () => {
    if (!farmId) return;
    await navigator.clipboard.writeText(farmId);
    setCopied(true);
    notify.ok("Fazenda", "Farm ID copiado!");
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-4">
      <SedeCoordsCard />
      <AgentRestartCard farmId={farmId} />
      <InemaToggleCard farmId={farmId} />
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base text-foreground flex items-center gap-2">
            <Building2 className="w-4 h-4 text-primary" /> Perfil da Fazenda
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label className="text-foreground">Nome da Fazenda</Label>
              <Input className="bg-secondary border-border mt-1" value={form.nome} onChange={e => setForm(f => ({ ...f, nome: e.target.value }))} />
            </div>
            <div>
              <Label className="text-foreground">Proprietário</Label>
              <Input className="bg-secondary border-border mt-1" value={form.proprietario} onChange={e => setForm(f => ({ ...f, proprietario: e.target.value }))} />
            </div>
            <div>
              <Label className="text-foreground">Cidade / Estado</Label>
              <Input className="bg-secondary border-border mt-1" value={form.cidadeEstado} onChange={e => setForm(f => ({ ...f, cidadeEstado: e.target.value }))} />
            </div>
            <div>
              <Label className="text-foreground">Telefone</Label>
              <Input className="bg-secondary border-border mt-1" value={form.telefone} onChange={e => setForm(f => ({ ...f, telefone: e.target.value }))} />
            </div>
          </div>
          <Button className="bg-primary text-primary-foreground" onClick={save}>
            Salvar Alterações
          </Button>
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base text-foreground flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-primary" /> Identificação Técnica
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label className="text-foreground">Farm ID (UUID)</Label>
            <p className="text-xs text-muted-foreground mb-2">
              Use este código no setup do Renov Agent (.exe) instalado no PC da fazenda.
            </p>
            <div className="flex gap-2">
              <Input
                className="bg-secondary border-border font-mono text-xs"
                value={farmId ?? "Carregando..."}
                readOnly
              />
              <Button
                variant="outline"
                size="icon"
                onClick={copyFarmId}
                disabled={!farmId}
                className="shrink-0"
              >
                {copied ? <Check className="w-4 h-4 text-primary" /> : <Copy className="w-4 h-4" />}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default FazendaContent;
