import { useCallback, useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Edit2, Plus, Power, Trash2, Wifi, WifiOff } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { WhatsAppOperatorDialog, type WhatsAppOperator } from "./WhatsAppOperatorDialog";

interface FarmOption { id: string; name: string }

interface WhatsAppConfigRow {
  id?: string;
  farm_id: string;
  bot_number: string | null;
  is_connected: boolean;
  alert_on_failure: boolean;
  alert_on_local_action: boolean;
  alert_on_offline: boolean;
  alert_on_bridge_down: boolean;
  offline_threshold_minutes: number;
  daily_summary: boolean;
  ai_enabled: boolean;
  audio_transcription: boolean;
  tech_group_id: string | null;
  ai_instructions: string | null;
}

const defaultConfig = (farmId: string): WhatsAppConfigRow => ({
  farm_id: farmId,
  bot_number: "+55 77 99808-3951",
  is_connected: false,
  alert_on_failure: true,
  alert_on_local_action: true,
  alert_on_offline: true,
  alert_on_bridge_down: true,
  offline_threshold_minutes: 5,
  daily_summary: false,
  ai_enabled: true,
  audio_transcription: true,
  tech_group_id: null,
  ai_instructions: null,
});

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  farmId: string | null;
  farms: FarmOption[];
  onConnectionChange?: (connected: boolean) => void;
}

const sb = supabase as unknown as {
  from: (t: string) => {
    select: (c: string) => {
      eq: (k: string, v: string) => {
        maybeSingle: () => Promise<{ data: unknown; error: { message: string } | null }>;
        order: (k: string, o?: { ascending: boolean }) => Promise<{ data: unknown[]; error: { message: string } | null }>;
      };
      order: (k: string, o?: { ascending: boolean }) => Promise<{ data: unknown[]; error: { message: string } | null }>;
    };
    insert: (p: unknown) => Promise<{ error: { message: string } | null }>;
    update: (p: unknown) => { eq: (k: string, v: string) => Promise<{ error: { message: string } | null }> };
    upsert: (p: unknown, o?: { onConflict: string }) => Promise<{ error: { message: string } | null }>;
    delete: () => { eq: (k: string, v: string) => Promise<{ error: { message: string } | null }> };
  };
};

export function WhatsAppConfigDialog({ open, onOpenChange, farmId, farms, onConnectionChange }: Props) {
  const [tab, setTab] = useState("connection");
  const [config, setConfig] = useState<WhatsAppConfigRow | null>(null);
  const [operators, setOperators] = useState<WhatsAppOperator[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [opDialogOpen, setOpDialogOpen] = useState(false);
  const [editingOp, setEditingOp] = useState<WhatsAppOperator | null>(null);

  const load = useCallback(async () => {
    if (!farmId) return;
    setLoading(true);
    try {
      const { data: cfg } = await sb.from("whatsapp_config").select("*").eq("farm_id", farmId).maybeSingle();
      setConfig((cfg as WhatsAppConfigRow | null) ?? defaultConfig(farmId));
      const { data: ops } = await sb.from("whatsapp_operators").select("*").eq("farm_id", farmId).order("name");
      setOperators((ops as WhatsAppOperator[]) ?? []);
    } finally {
      setLoading(false);
    }
  }, [farmId]);

  useEffect(() => {
    if (open) {
      setTab("connection");
      void load();
    }
  }, [open, load]);

  const update = <K extends keyof WhatsAppConfigRow>(k: K, v: WhatsAppConfigRow[K]) =>
    setConfig((c) => (c ? { ...c, [k]: v } : c));

  const saveConfig = async () => {
    if (!config) return;
    setSaving(true);
    try {
      const { error } = await sb.from("whatsapp_config").upsert(config, { onConflict: "farm_id" });
      if (error) {
        toast.error("Erro ao salvar: " + error.message);
        return;
      }
      toast.success("Configuração salva");
      onConnectionChange?.(config.is_connected);
    } finally {
      setSaving(false);
    }
  };

  const toggleConnection = async () => {
    if (!config) return;
    const next = !config.is_connected;
    update("is_connected", next);
    setSaving(true);
    try {
      const { error } = await sb.from("whatsapp_config").upsert({ ...config, is_connected: next }, { onConflict: "farm_id" });
      if (error) {
        toast.error("Erro: " + error.message);
        update("is_connected", !next);
        return;
      }
      toast.success(next ? "Conectado (simulado)" : "Desconectado");
      onConnectionChange?.(next);
    } finally {
      setSaving(false);
    }
  };

  const removeOperator = async (id: string) => {
    if (!confirm("Remover este operador?")) return;
    const { error } = await sb.from("whatsapp_operators").delete().eq("id", id);
    if (error) { toast.error(error.message); return; }
    toast.success("Removido");
    void load();
  };

  const toggleOperator = async (op: WhatsAppOperator) => {
    if (!op.id) return;
    const { error } = await sb.from("whatsapp_operators").update({ is_active: !op.is_active }).eq("id", op.id);
    if (error) { toast.error(error.message); return; }
    void load();
  };

  if (!farmId) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Configurar WhatsApp
            {config?.is_connected ? (
              <Badge className="bg-[#25D366]/15 text-[#1ea952] border border-[#25D366]/40"><Wifi className="w-3 h-3 mr-1" />Conectado</Badge>
            ) : (
              <Badge variant="destructive"><WifiOff className="w-3 h-3 mr-1" />Desconectado</Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        {loading || !config ? (
          <div className="py-8 text-center text-muted-foreground">Carregando...</div>
        ) : (
          <Tabs value={tab} onValueChange={setTab} className="mt-2">
            <TabsList className="grid grid-cols-3 w-full">
              <TabsTrigger value="connection">Conexão</TabsTrigger>
              <TabsTrigger value="operators">Operadores</TabsTrigger>
              <TabsTrigger value="alerts">Alertas e IA</TabsTrigger>
            </TabsList>

            {/* Conexão */}
            <TabsContent value="connection" className="space-y-4 pt-4">
              <div className="space-y-2">
                <Label>Número do WhatsApp</Label>
                <Input value={config.bot_number ?? ""} onChange={(e) => update("bot_number", e.target.value)} />
              </div>
              <div className="flex items-center justify-between rounded-lg border border-border p-4">
                <div>
                  <p className="font-medium">Status da conexão</p>
                  <p className="text-xs text-muted-foreground">
                    {config.is_connected ? "Bot ativo e recebendo mensagens" : "Bot desconectado"}
                  </p>
                </div>
                <Button onClick={toggleConnection} disabled={saving} variant={config.is_connected ? "destructive" : "default"}>
                  <Power className="w-4 h-4 mr-2" />
                  {config.is_connected ? "Desconectar" : "Conectar"}
                </Button>
              </div>
              <div className="rounded-lg bg-muted/40 p-4 text-sm text-muted-foreground">
                <p>📱 Quando conectar pela primeira vez, será exibido o QR Code para parear com o WhatsApp Business.</p>
                <p className="mt-1">Último ping: {config.is_connected ? "agora" : "—"}</p>
              </div>
              <div className="flex justify-end">
                <Button onClick={saveConfig} disabled={saving}>Salvar</Button>
              </div>
            </TabsContent>

            {/* Operadores */}
            <TabsContent value="operators" className="space-y-4 pt-4">
              <div className="flex justify-between items-center">
                <p className="text-sm text-muted-foreground">{operators.length} operador(es)</p>
                <Button size="sm" onClick={() => { setEditingOp(null); setOpDialogOpen(true); }}>
                  <Plus className="w-4 h-4 mr-1" /> Adicionar Operador
                </Button>
              </div>
              <div className="rounded-lg border border-border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Nome</TableHead>
                      <TableHead>WhatsApp</TableHead>
                      <TableHead>Fazenda</TableHead>
                      <TableHead>Permissões</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {operators.length === 0 ? (
                      <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-6">Nenhum operador cadastrado</TableCell></TableRow>
                    ) : operators.map((op) => {
                      const farmName = farms.find((f) => f.id === op.farm_id)?.name ?? "—";
                      const perms = [
                        op.can_turn_on && "Ligar",
                        op.can_turn_off && "Desligar",
                        op.can_check_status && "Status",
                        op.receive_alerts && "Alertas",
                      ].filter(Boolean).join(", ");
                      return (
                        <TableRow key={op.id}>
                          <TableCell className="font-medium">
                            <span className="inline-flex items-center gap-1.5">
                              {op.name}
                              {op.ai_enabled && (
                                <span title="IA Ativa" className="text-emerald-500" aria-label="IA Ativa">🤖</span>
                              )}
                            </span>
                          </TableCell>
                          <TableCell className="font-mono text-xs">{op.phone}</TableCell>
                          <TableCell>{farmName}</TableCell>
                          <TableCell className="text-xs">{perms || "—"}</TableCell>
                          <TableCell>
                            {op.is_active
                              ? <Badge className="bg-primary/15 text-primary">Ativo</Badge>
                              : <Badge variant="outline">Inativo</Badge>}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button size="icon" variant="ghost" onClick={() => { setEditingOp(op); setOpDialogOpen(true); }}>
                              <Edit2 className="w-4 h-4" />
                            </Button>
                            <Button size="icon" variant="ghost" onClick={() => toggleOperator(op)} title={op.is_active ? "Desativar" : "Ativar"}>
                              <Power className="w-4 h-4" />
                            </Button>
                            <Button size="icon" variant="ghost" onClick={() => op.id && removeOperator(op.id)}>
                              <Trash2 className="w-4 h-4 text-destructive" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>

            {/* Alertas e IA */}
            <TabsContent value="alerts" className="space-y-6 pt-4">
              <section className="space-y-3">
                <h4 className="font-semibold text-sm">Alertas para Operadores</h4>
                <ToggleRow label="Enviar alertas de falha de equipamento" v={config.alert_on_failure} onChange={(v) => update("alert_on_failure", v)} />
                <ToggleRow label="Enviar alertas de acionamento local" v={config.alert_on_local_action} onChange={(v) => update("alert_on_local_action", v)} />
                <ToggleRow label="Enviar resumo diário (manhã)" v={config.daily_summary} onChange={(v) => update("daily_summary", v)} />
              </section>

              <section className="space-y-3">
                <h4 className="font-semibold text-sm">Alertas para Equipe Técnica (Grupo)</h4>
                <div className="space-y-2">
                  <Label>ID/Número do grupo técnico</Label>
                  <Input value={config.tech_group_id ?? ""} onChange={(e) => update("tech_group_id", e.target.value)} placeholder="ex: 5577999999999-1234567890@g.us" />
                </div>
                <ToggleRow label="Alertar quando equipamento ficar offline" v={config.alert_on_offline} onChange={(v) => update("alert_on_offline", v)} />
                <ToggleRow label="Alertar quando bridge perder comunicação" v={config.alert_on_bridge_down} onChange={(v) => update("alert_on_bridge_down", v)} />
                <div className="space-y-2">
                  <Label>Tempo para considerar offline (minutos)</Label>
                  <Input type="number" min={1} max={120} value={config.offline_threshold_minutes}
                    onChange={(e) => update("offline_threshold_minutes", Math.max(1, Number(e.target.value) || 5))} />
                </div>
              </section>

              <section className="space-y-3">
                <h4 className="font-semibold text-sm">IA Conversacional</h4>
                <ToggleRow label="Ativar atendimento por IA para clientes" v={config.ai_enabled} onChange={(v) => update("ai_enabled", v)} />
                <ToggleRow label="Transcrição de áudio (comandos por voz)" v={config.audio_transcription} onChange={(v) => update("audio_transcription", v)} />
                <div className="space-y-2">
                  <Label>Instruções personalizadas para a IA</Label>
                  <Textarea
                    rows={4}
                    value={config.ai_instructions ?? ""}
                    onChange={(e) => update("ai_instructions", e.target.value)}
                    placeholder="Ex: Responda sempre em português, seja objetivo, confirme antes de executar comandos críticos..."
                  />
                </div>
              </section>

              <div className="flex justify-end">
                <Button onClick={saveConfig} disabled={saving}>{saving ? "Salvando..." : "Salvar"}</Button>
              </div>
            </TabsContent>
          </Tabs>
        )}

        <WhatsAppOperatorDialog
          open={opDialogOpen}
          onOpenChange={setOpDialogOpen}
          initial={editingOp}
          farms={farms}
          defaultFarmId={farmId}
          onSaved={load}
          canEditRole={true}
        />

      </DialogContent>
    </Dialog>
  );
}

function ToggleRow({ label, v, onChange }: { label: string; v: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
      <span className="text-sm">{label}</span>
      <Switch checked={v} onCheckedChange={onChange} />
    </div>
  );
}
