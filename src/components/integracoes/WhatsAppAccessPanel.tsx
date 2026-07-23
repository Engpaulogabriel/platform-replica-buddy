import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  CheckCircle2,
  XCircle,
  MapPin,
  ShieldCheck,
  KeyRound,
  History,
  Users,
  Plus,
  Ban,
  Sparkles,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { notifyWhatsAppImmediate } from "@/lib/whatsappNotify";

const sb = supabase as unknown as { from: (t: string) => any };

type Farm = { id: string; name: string };

type RegRequest = {
  id: string;
  phone: string;
  name: string | null;
  farm_id: string | null;
  role_provided: string | null;
  invite_code_used: string | null;
  status: string;
  step: number;
  registration_lat: number | null;
  registration_lng: number | null;
  registration_location_text: string | null;
  location_skipped: boolean;
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  farms?: { name: string } | null;
};

type Operator = {
  id: string;
  name: string;
  phone: string;
  farm_id: string | null;
  role: string;
  is_active: boolean;
  ai_enabled?: boolean;
  audio_enabled?: boolean;
  approved_by_phone: string | null;
  approved_at: string | null;
  registration_lat: number | null;
  registration_lng: number | null;
  registration_location_text: string | null;
  full_name?: string | null;
  cpf?: string | null;
  location?: string | null;
  registered_via_code?: string | null;
  registered_at?: string | null;
  farms?: { name: string } | null;
};

type InviteCode = {
  id: string;
  farm_id: string;
  code: string;
  expires_at: string | null;
  max_uses: number;
  current_uses: number;
  is_active: boolean;
  created_at: string;
  created_by: string | null;
  farms?: { name: string } | null;
};

type AuditEntry = {
  id: string;
  event_type: string;
  actor_phone: string | null;
  actor_name: string | null;
  target_phone: string | null;
  target_name: string | null;
  farm_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
  farms?: { name: string } | null;
};

const EVENT_LABEL: Record<string, { label: string; cls: string }> = {
  registration_started: { label: "Início de cadastro", cls: "bg-blue-500/15 text-blue-500" },
  registration_completed: { label: "Cadastro finalizado", cls: "bg-amber-500/15 text-amber-500" },
  registration_approved: { label: "Acesso aprovado", cls: "bg-emerald-500/15 text-emerald-500" },
  registration_rejected: { label: "Acesso negado", cls: "bg-rose-500/15 text-rose-500" },
  access_revoked: { label: "Acesso revogado", cls: "bg-rose-500/15 text-rose-500" },
  invite_code_created: { label: "Código gerado", cls: "bg-indigo-500/15 text-indigo-500" },
  failed_code_attempt: { label: "Código inválido", cls: "bg-orange-500/15 text-orange-500" },
};

function fmtDate(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "2-digit",
    hour: "2-digit", minute: "2-digit", timeZone: "America/Bahia",
  }).replace(",", "");
}

function fmtPhone(p?: string | null) {
  if (!p) return "—";
  const digits = p.replace(/\D/g, "");
  if (digits.length < 10) return p;
  return `+${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4, -4)}-${digits.slice(-4)}`;
}

export function WhatsAppAccessPanel({ farmId, farms }: { farmId: string | null; farms: Farm[] }) {
  const [tab, setTab] = useState("pending");
  const [pending, setPending] = useState<RegRequest[]>([]);
  const [history, setHistory] = useState<RegRequest[]>([]);
  const [approvedOps, setApprovedOps] = useState<Operator[]>([]);
  const [codes, setCodes] = useState<InviteCode[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);

  // Audit filters
  const [auditEvent, setAuditEvent] = useState<string>("all");
  const [auditFarm, setAuditFarm] = useState<string>("all");

  // New code form
  const [newCodeValue, setNewCodeValue] = useState("");
  const [newCodeExpires, setNewCodeExpires] = useState<string>("");
  const [newCodeMaxUses, setNewCodeMaxUses] = useState<number>(50);
  const [newCodePhone, setNewCodePhone] = useState<string>("");

  const farmMap = useMemo(() => Object.fromEntries(farms.map((f) => [f.id, f.name])), [farms]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [reqRes, opRes, codeRes, auditRes] = await Promise.all([
        sb.from("whatsapp_registration_requests")
          .select("*, farms:farm_id(name)")
          .order("created_at", { ascending: false })
          .limit(200),
        sb.from("whatsapp_operators")
          .select("*, farms:farm_id(name)")
          .order("approved_at", { ascending: false, nullsFirst: false })
          .limit(200),
        sb.from("whatsapp_invite_codes")
          .select("*, farms:farm_id(name)")
          .order("created_at", { ascending: false })
          .limit(100),
        sb.from("whatsapp_audit_log")
          .select("*, farms:farm_id(name)")
          .order("created_at", { ascending: false })
          .limit(300),
      ]);
      const reqs = (reqRes.data ?? []) as RegRequest[];
      setPending(reqs.filter((r) => r.status === "pending_approval"));
      setHistory(reqs.filter((r) => r.status !== "pending_approval"));
      setApprovedOps((opRes.data ?? []) as Operator[]);
      setCodes((codeRes.data ?? []) as InviteCode[]);
      setAudit((auditRes.data ?? []) as AuditEntry[]);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const approveRequest = async (r: RegRequest) => {
    if (!r.farm_id) {
      toast.error("Solicitação sem fazenda definida.");
      return;
    }
    const cleanPhone = r.phone.startsWith("+") ? r.phone : `+${r.phone.replace(/\D/g, "")}`;
    const { error: insErr } = await sb.from("whatsapp_operators").insert({
      phone: cleanPhone,
      name: r.name ?? `Operador ${cleanPhone.slice(-4)}`,
      farm_id: r.farm_id,
      role: "operator",
      is_active: true,
      can_turn_on: true,
      can_turn_off: true,
      can_check_status: true,
      receive_alerts: true,
      approved_by_phone: "web-ui",
      approved_at: new Date().toISOString(),
      registration_lat: r.registration_lat,
      registration_lng: r.registration_lng,
      registration_location_text: r.registration_location_text,
    });
    if (insErr) {
      toast.error("Falha ao aprovar: " + insErr.message);
      return;
    }
    await sb.from("whatsapp_registration_requests").update({
      status: "approved",
      reviewed_by: "web-ui",
      reviewed_at: new Date().toISOString(),
    }).eq("id", r.id);
    await sb.from("whatsapp_audit_log").insert({
      event_type: "registration_approved",
      actor_phone: "web-ui",
      target_phone: r.phone,
      target_name: r.name,
      farm_id: r.farm_id,
      details: { via: "web", role_provided: r.role_provided },
    });
    // Notificação WhatsApp imediata ao operador aprovado
    notifyWhatsAppImmediate("operator_approved", {
      target_phone: cleanPhone,
      target_name: r.name,
      farm_id: r.farm_id,
    }, { fireAndForget: true });
    toast.success(`Acesso liberado para ${r.name ?? r.phone}`);
    void load();
  };

  const rejectRequest = async (r: RegRequest) => {
    await sb.from("whatsapp_registration_requests").update({
      status: "rejected",
      reviewed_by: "web-ui",
      reviewed_at: new Date().toISOString(),
    }).eq("id", r.id);
    await sb.from("whatsapp_audit_log").insert({
      event_type: "registration_rejected",
      actor_phone: "web-ui",
      target_phone: r.phone,
      target_name: r.name,
      farm_id: r.farm_id,
      details: { via: "web" },
    });
    notifyWhatsAppImmediate("operator_rejected", {
      target_phone: r.phone,
      target_name: r.name,
      farm_id: r.farm_id,
    }, { fireAndForget: true });
    toast.success("Solicitação rejeitada.");
    void load();
  };

  const revokeOperator = async (op: Operator) => {
    if (!confirm(`Revogar acesso de ${op.name}?`)) return;
    await sb.from("whatsapp_operators").update({
      is_active: false,
      deactivated_at: new Date().toISOString(),
      deactivated_by: "web-ui",
    }).eq("id", op.id);
    await sb.from("whatsapp_audit_log").insert({
      event_type: "access_revoked",
      actor_phone: "web-ui",
      target_phone: op.phone,
      target_name: op.name,
      farm_id: op.farm_id,
      details: { via: "web" },
    });
    toast.success("Acesso revogado.");
    void load();
  };

  const toggleAi = async (op: Operator, value: boolean) => {
    // optimistic — turning AI off also forces audio off (audio requires AI).
    const audioPatch = value ? {} : { audio_enabled: false };
    setApprovedOps((prev) => prev.map((o) => (o.id === op.id ? { ...o, ai_enabled: value, ...audioPatch } : o)));
    const { error } = await sb
      .from("whatsapp_operators")
      .update({ ai_enabled: value, ...audioPatch })
      .eq("id", op.id);
    if (error) {
      toast.error("Falha ao atualizar IA: " + error.message);
      setApprovedOps((prev) => prev.map((o) => (o.id === op.id ? { ...o, ai_enabled: !value, audio_enabled: op.audio_enabled } : o)));
      return;
    }
    toast.success(`IA ${value ? "ativada" : "desativada"} para ${op.name}.`);
  };

  const toggleAudio = async (op: Operator, value: boolean) => {
    if (value && !op.ai_enabled) {
      toast.error("Ative a IA antes de habilitar o áudio.");
      return;
    }
    setApprovedOps((prev) => prev.map((o) => (o.id === op.id ? { ...o, audio_enabled: value } : o)));
    const { error } = await sb.from("whatsapp_operators").update({ audio_enabled: value }).eq("id", op.id);
    if (error) {
      toast.error("Falha ao atualizar Áudio: " + error.message);
      setApprovedOps((prev) => prev.map((o) => (o.id === op.id ? { ...o, audio_enabled: !value } : o)));
      return;
    }
    toast.success(`Reconhecimento de áudio ${value ? "ativado" : "desativado"} para ${op.name}.`);
  };

  const createCode = async () => {
    if (!farmId) {
      toast.error("Selecione uma fazenda padrão primeiro.");
      return;
    }
    let code = newCodeValue.trim().toUpperCase().replace(/\s+/g, "");
    if (!code) {
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const buf = new Uint8Array(8);
      crypto.getRandomValues(buf);
      code = Array.from(buf).map((b) => alphabet[b % alphabet.length]).join("");
    }
    const expiresIso = newCodeExpires
      ? new Date(newCodeExpires).toISOString()
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const { error } = await sb.from("whatsapp_invite_codes").insert({
      farm_id: farmId,
      code,
      created_by: "web-ui",
      expires_at: expiresIso,
      max_uses: Math.max(1, newCodeMaxUses),
      current_uses: 0,
      is_active: true,
    });
    if (error) {
      toast.error("Falha ao criar código: " + error.message);
      return;
    }
    await sb.from("whatsapp_audit_log").insert({
      event_type: "invite_code_created",
      actor_phone: "web-ui",
      farm_id: farmId,
      details: { code, expires_at: expiresIso, max_uses: newCodeMaxUses, target_phone: newCodePhone || null },
    });
    // Entrega imediata via WhatsApp se telefone informado
    const targetPhone = newCodePhone.replace(/\D/g, "");
    if (targetPhone) {
      notifyWhatsAppImmediate("invite_code_created", {
        target_phone: targetPhone.startsWith("55") ? `+${targetPhone}` : `+55${targetPhone}`,
        code,
        farm_id: farmId,
        expires_at: expiresIso,
      }, { fireAndForget: true });
      toast.success(`Código ${code} criado e enviado para ${targetPhone}.`);
    } else {
      toast.success(`Código ${code} criado.`);
    }
    setNewCodeValue("");
    setNewCodeExpires("");
    setNewCodePhone("");
    void load();
  };

  const deactivateCode = async (c: InviteCode) => {
    if (!confirm(`Desativar o código ${c.code}?`)) return;
    await sb.from("whatsapp_invite_codes").update({ is_active: false }).eq("id", c.id);
    await sb.from("whatsapp_audit_log").insert({
      event_type: "invite_code_expired",
      actor_phone: "web-ui",
      farm_id: c.farm_id,
      details: { code: c.code, reason: "manual_deactivation" },
    });
    toast.success("Código desativado.");
    void load();
  };

  const filteredAudit = useMemo(() => {
    return audit.filter((a) => {
      if (auditEvent !== "all" && a.event_type !== auditEvent) return false;
      if (auditFarm !== "all" && a.farm_id !== auditFarm) return false;
      return true;
    });
  }, [audit, auditEvent, auditFarm]);

  const eventTypes = useMemo(
    () => Array.from(new Set(audit.map((a) => a.event_type))).sort(),
    [audit],
  );

  return (
    <Card className="border-2">
      <CardHeader>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-primary/10 p-3 border border-primary/30">
              <ShieldCheck className="w-8 h-8 text-primary" />
            </div>
            <div>
              <CardTitle className="flex items-center gap-2 flex-wrap">
                Solicitações de Acesso
                {pending.length > 0 && (
                  <Badge className="bg-amber-500/15 text-amber-500 border border-amber-500/40">
                    {pending.length} pendente{pending.length > 1 ? "s" : ""}
                  </Badge>
                )}
              </CardTitle>
              <CardDescription className="mt-1">
                Aprove novos operadores, gerencie códigos de convite e audite todas as ações.
              </CardDescription>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? "Atualizando..." : "Atualizar"}
          </Button>
        </div>
      </CardHeader>

      <CardContent>
        <Tabs value={tab} onValueChange={setTab} className="w-full">
          <TabsList className="grid grid-cols-4 w-full">
            <TabsTrigger value="pending">
              <Users className="w-4 h-4 mr-1.5" /> Pendentes
              {pending.length > 0 && (
                <span className="ml-1.5 rounded-full bg-amber-500/20 text-amber-500 text-[10px] px-1.5">
                  {pending.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="approved">
              <CheckCircle2 className="w-4 h-4 mr-1.5" /> Aprovados
            </TabsTrigger>
            <TabsTrigger value="codes">
              <KeyRound className="w-4 h-4 mr-1.5" /> Códigos
            </TabsTrigger>
            <TabsTrigger value="audit">
              <History className="w-4 h-4 mr-1.5" /> Auditoria
            </TabsTrigger>
          </TabsList>

          {/* PENDING */}
          <TabsContent value="pending" className="mt-4">
            {pending.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                Nenhuma solicitação pendente. ✨
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Nome</TableHead>
                      <TableHead>Telefone</TableHead>
                      <TableHead>Fazenda</TableHead>
                      <TableHead>Função</TableHead>
                      <TableHead>Local</TableHead>
                      <TableHead>Data</TableHead>
                      <TableHead className="text-right">Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pending.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="font-medium">{r.name ?? "—"}</TableCell>
                        <TableCell>{fmtPhone(r.phone)}</TableCell>
                        <TableCell>{r.farms?.name ?? farmMap[r.farm_id ?? ""] ?? "—"}</TableCell>
                        <TableCell>{r.role_provided ?? "—"}</TableCell>
                        <TableCell>
                          {r.registration_lat != null && r.registration_lng != null ? (
                            <a
                              href={`https://www.google.com/maps?q=${r.registration_lat},${r.registration_lng}`}
                              target="_blank" rel="noreferrer"
                              className="inline-flex items-center gap-1 text-primary hover:underline"
                            >
                              <MapPin className="w-3.5 h-3.5" /> Ver
                            </a>
                          ) : (
                            <span className="text-muted-foreground text-xs">
                              {r.location_skipped ? "Pulado" : "—"}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs">{fmtDate(r.created_at)}</TableCell>
                        <TableCell className="text-right space-x-1">
                          <Button size="sm" onClick={() => void approveRequest(r)}>
                            <CheckCircle2 className="w-4 h-4 mr-1" /> Aprovar
                          </Button>
                          <Button size="sm" variant="destructive" onClick={() => void rejectRequest(r)}>
                            <XCircle className="w-4 h-4 mr-1" /> Rejeitar
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {history.length > 0 && (
              <div className="mt-6">
                <h4 className="text-sm font-semibold mb-2 text-muted-foreground">Histórico recente</h4>
                <div className="overflow-x-auto rounded-lg border border-border/50">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Nome</TableHead>
                        <TableHead>Telefone</TableHead>
                        <TableHead>Fazenda</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Revisado em</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {history.slice(0, 20).map((r) => (
                        <TableRow key={r.id}>
                          <TableCell>{r.name ?? "—"}</TableCell>
                          <TableCell>{fmtPhone(r.phone)}</TableCell>
                          <TableCell>{r.farms?.name ?? "—"}</TableCell>
                          <TableCell>
                            <Badge variant={r.status === "approved" ? "default" : "destructive"}>
                              {r.status === "approved" ? "Aprovado" : r.status === "rejected" ? "Rejeitado" : r.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs">{fmtDate(r.reviewed_at)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </TabsContent>

          {/* APPROVED OPERATORS */}
          <TabsContent value="approved" className="mt-4">
            <div className="overflow-x-auto rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nome</TableHead>
                    <TableHead>Telefone</TableHead>
                    <TableHead>Fazenda</TableHead>
                    <TableHead>Nível</TableHead>
                    <TableHead>CPF</TableHead>
                    <TableHead>Localização</TableHead>
                    <TableHead>Cadastro</TableHead>
                    <TableHead>Código</TableHead>
                    <TableHead className="text-center">
                      <span className="inline-flex items-center gap-1">
                        <Sparkles className="w-3.5 h-3.5" /> IA
                      </span>
                    </TableHead>
                    <TableHead className="text-center">
                      <span className="inline-flex items-center gap-1" title="Reconhecimento de Áudio">
                        🎤 Áudio
                      </span>
                    </TableHead>
                    <TableHead className="text-right">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {approvedOps.length === 0 ? (
                    <TableRow><TableCell colSpan={11} className="text-center text-muted-foreground py-6">Nenhum operador.</TableCell></TableRow>
                  ) : approvedOps.map((op) => {
                    const cpfDigits = (op.cpf ?? "").replace(/\D/g, "");
                    const cpfMasked = cpfDigits.length === 11
                      ? `***.***.${cpfDigits.slice(6, 9)}-${cpfDigits.slice(9)}`
                      : "—";
                    const locText = op.location ?? op.registration_location_text ?? null;
                    return (
                    <TableRow key={op.id} className={op.is_active ? "" : "opacity-50"}>
                      <TableCell className="font-medium">
                        <div>{op.full_name ?? op.name}</div>
                        {op.full_name && op.full_name !== op.name ? (
                          <div className="text-[11px] text-muted-foreground">{op.name}</div>
                        ) : null}
                      </TableCell>
                      <TableCell>{fmtPhone(op.phone)}</TableCell>
                      <TableCell>{op.farms?.name ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="capitalize">{op.role}</Badge>
                      </TableCell>
                      <TableCell className="text-xs font-mono">{cpfMasked}</TableCell>
                      <TableCell className="text-xs">
                        {locText ? (
                          <span className="inline-flex items-center gap-1">
                            {op.registration_lat != null && op.registration_lng != null ? (
                              <a
                                href={`https://www.google.com/maps?q=${op.registration_lat},${op.registration_lng}`}
                                target="_blank" rel="noreferrer"
                                className="text-primary hover:underline"
                                title="Abrir no mapa"
                              >
                                <MapPin className="w-3 h-3" />
                              </a>
                            ) : null}
                            {locText}
                          </span>
                        ) : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="text-xs">{fmtDate(op.registered_at ?? op.approved_at)}</TableCell>
                      <TableCell className="text-xs font-mono">{op.registered_via_code ?? "—"}</TableCell>
                      <TableCell className="text-center">
                        <Switch
                          checked={!!op.ai_enabled}
                          disabled={!op.is_active}
                          onCheckedChange={(v) => void toggleAi(op, v)}
                        />
                      </TableCell>
                      <TableCell className="text-center">
                        <Switch
                          checked={!!op.audio_enabled && !!op.ai_enabled}
                          disabled={!op.is_active || !op.ai_enabled}
                          onCheckedChange={(v) => void toggleAudio(op, v)}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        {op.is_active ? (
                          <Button size="sm" variant="ghost" onClick={() => void revokeOperator(op)}>
                            <Ban className="w-4 h-4 mr-1" /> Revogar
                          </Button>
                        ) : (
                          <Badge variant="secondary">Inativo</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </TabsContent>

          {/* INVITE CODES */}
          <TabsContent value="codes" className="mt-4 space-y-4">
            <div className="rounded-lg border border-border p-4 space-y-3 bg-muted/30">
              <div className="text-sm font-semibold flex items-center gap-2">
                <Plus className="w-4 h-4" /> Novo código de convite
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Código (deixe vazio para gerar)</Label>
                  <Input
                    placeholder="Ex: FAZENDA2026"
                    value={newCodeValue}
                    onChange={(e) => setNewCodeValue(e.target.value.toUpperCase())}
                    maxLength={32}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Expira em</Label>
                  <Input
                    type="date"
                    value={newCodeExpires}
                    onChange={(e) => setNewCodeExpires(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Máx. usos</Label>
                  <Input
                    type="number"
                    min={1}
                    value={newCodeMaxUses}
                    onChange={(e) => setNewCodeMaxUses(Number(e.target.value) || 1)}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">WhatsApp do destinatário (opcional)</Label>
                  <Input
                    placeholder="(75) 99999-9999"
                    value={newCodePhone}
                    onChange={(e) => setNewCodePhone(e.target.value)}
                  />
                </div>
              </div>
              <Button onClick={() => void createCode()} disabled={!farmId}>
                <Plus className="w-4 h-4 mr-1" /> Criar código
              </Button>
            </div>

            <div className="overflow-x-auto rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Código</TableHead>
                    <TableHead>Fazenda</TableHead>
                    <TableHead>Usos</TableHead>
                    <TableHead>Expira</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {codes.length === 0 ? (
                    <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-6">Nenhum código.</TableCell></TableRow>
                  ) : codes.map((c) => {
                    const expired = c.expires_at && new Date(c.expires_at).getTime() < Date.now();
                    const exhausted = c.current_uses >= c.max_uses;
                    return (
                      <TableRow key={c.id} className={c.is_active && !expired && !exhausted ? "" : "opacity-60"}>
                        <TableCell className="font-mono font-semibold">{c.code}</TableCell>
                        <TableCell>{c.farms?.name ?? "—"}</TableCell>
                        <TableCell>{c.current_uses}/{c.max_uses}</TableCell>
                        <TableCell className="text-xs">{fmtDate(c.expires_at)}</TableCell>
                        <TableCell>
                          {!c.is_active ? <Badge variant="secondary">Desativado</Badge>
                            : expired ? <Badge variant="destructive">Expirado</Badge>
                            : exhausted ? <Badge variant="destructive">Esgotado</Badge>
                            : <Badge className="bg-emerald-500/15 text-emerald-500 border border-emerald-500/40">Ativo</Badge>}
                        </TableCell>
                        <TableCell className="text-right">
                          {c.is_active && (
                            <Button size="sm" variant="ghost" onClick={() => void deactivateCode(c)}>
                              <Ban className="w-4 h-4 mr-1" /> Desativar
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </TabsContent>

          {/* AUDIT */}
          <TabsContent value="audit" className="mt-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Filtrar por evento</Label>
                <Select value={auditEvent} onValueChange={setAuditEvent}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos</SelectItem>
                    {eventTypes.map((e) => (
                      <SelectItem key={e} value={e}>{EVENT_LABEL[e]?.label ?? e}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Filtrar por fazenda</Label>
                <Select value={auditFarm} onValueChange={setAuditFarm}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todas</SelectItem>
                    {farms.map((f) => <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="overflow-x-auto rounded-lg border border-border max-h-[500px] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Quando</TableHead>
                    <TableHead>Evento</TableHead>
                    <TableHead>Ator</TableHead>
                    <TableHead>Alvo</TableHead>
                    <TableHead>Fazenda</TableHead>
                    <TableHead>Detalhes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredAudit.length === 0 ? (
                    <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-6">Nada registrado.</TableCell></TableRow>
                  ) : filteredAudit.map((a) => {
                    const meta = EVENT_LABEL[a.event_type];
                    return (
                      <TableRow key={a.id}>
                        <TableCell className="text-xs whitespace-nowrap">{fmtDate(a.created_at)}</TableCell>
                        <TableCell>
                          <Badge className={`${meta?.cls ?? "bg-muted text-muted-foreground"} border-0`}>
                            {meta?.label ?? a.event_type}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs">
                          {a.actor_name ?? "—"}
                          {a.actor_phone && <div className="text-muted-foreground">{fmtPhone(a.actor_phone)}</div>}
                        </TableCell>
                        <TableCell className="text-xs">
                          {a.target_name ?? "—"}
                          {a.target_phone && <div className="text-muted-foreground">{fmtPhone(a.target_phone)}</div>}
                        </TableCell>
                        <TableCell className="text-xs">{a.farms?.name ?? "—"}</TableCell>
                        <TableCell className="text-xs max-w-xs">
                          {a.details ? (
                            <code className="text-[11px] text-muted-foreground line-clamp-2">
                              {JSON.stringify(a.details)}
                            </code>
                          ) : "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
