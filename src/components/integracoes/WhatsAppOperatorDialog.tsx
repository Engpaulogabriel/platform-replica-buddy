import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { notifyWhatsAppImmediate } from "@/lib/whatsappNotify";

export type WhatsAppRole = "operator" | "approver" | "manager" | "super_admin";

export type NotificationPref = "default" | "private" | "mute";

export interface WhatsAppOperator {
  id?: string;
  farm_id: string | null;
  name: string;
  full_name?: string | null;
  cpf?: string | null;
  phone: string;
  can_turn_on: boolean;
  can_turn_off: boolean;
  can_check_status: boolean;
  receive_alerts: boolean;
  is_active: boolean;
  ai_enabled: boolean;
  audio_enabled: boolean;
  role: WhatsAppRole;
  notification_preference: NotificationPref;
}


interface FarmOption { id: string; name: string }

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initial?: WhatsAppOperator | null;
  farms: FarmOption[];
  defaultFarmId: string | null;
  onSaved: () => void;
  canEditRole?: boolean;
}

function maskBR(v: string) {
  const d = v.replace(/\D/g, "").slice(0, 13);
  if (!d) return "";
  let r = "+";
  r += d.slice(0, 2);
  if (d.length > 2) r += " " + d.slice(2, 4);
  if (d.length > 4) r += " " + d.slice(4, 9);
  if (d.length > 9) r += "-" + d.slice(9, 13);
  return r;
}

const empty = (farmId: string | null): WhatsAppOperator => ({
  farm_id: farmId,
  name: "",
  full_name: "",
  cpf: "",
  phone: "+55 ",
  can_turn_on: true,
  can_turn_off: true,
  can_check_status: true,
  receive_alerts: true,
  is_active: true,
  ai_enabled: false,
  audio_enabled: false,
  role: "operator",
  notification_preference: "default",
});

function maskCPF(v: string) {
  const d = (v || "").replace(/\D/g, "").slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`;
  if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9, 11)}`;
}

function isValidCPF(input: string): boolean {
  const cpf = (input || "").replace(/\D/g, "");
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(cpf.charAt(i), 10) * (10 - i);
  let check = 11 - (sum % 11);
  if (check >= 10) check = 0;
  if (check !== parseInt(cpf.charAt(9), 10)) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(cpf.charAt(i), 10) * (11 - i);
  check = 11 - (sum % 11);
  if (check >= 10) check = 0;
  if (check !== parseInt(cpf.charAt(10), 10)) return false;
  return true;
}


const ROLE_LABELS: Record<WhatsAppRole, string> = {
  operator: "Operador",
  approver: "Aprovador",
  manager: "Gestor",
  super_admin: "Super Admin",
};

const NOTIF_LABELS: Record<NotificationPref, string> = {
  default: "Padrão",
  private: "Sempre privado",
  mute: "Silenciado",
};


export function WhatsAppOperatorDialog({ open, onOpenChange, initial, farms, defaultFarmId, onSaved, canEditRole = false }: Props) {
  const [form, setForm] = useState<WhatsAppOperator>(empty(defaultFarmId));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setForm(initial ? { ...initial } : empty(defaultFarmId));
  }, [open, initial, defaultFarmId]);

  const update = <K extends keyof WhatsAppOperator>(k: K, v: WhatsAppOperator[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const requiresCpf = form.role === "manager" || form.role === "super_admin";
  const cpfDigits = (form.cpf ?? "").replace(/\D/g, "");
  const cpfOk = !requiresCpf || (cpfDigits.length === 11 && isValidCPF(cpfDigits));
  const fullNameOk = !requiresCpf || (form.full_name ?? "").trim().length >= 3;
  const valid =
    form.name.trim().length >= 2 &&
    /^\+55 \d{2} \d{5}-\d{4}$/.test(form.phone) &&
    cpfOk &&
    fullNameOk;

  const save = async () => {
    if (!valid) {
      if (requiresCpf && !cpfOk) toast.error("CPF inválido. Use o formato XXX.XXX.XXX-XX.");
      else if (requiresCpf && !fullNameOk) toast.error("Informe o nome completo do gestor.");
      else toast.error("Preencha nome e número (+55 XX XXXXX-XXXX)");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        farm_id: form.farm_id,
        name: form.name.trim(),
        phone: form.phone,
        can_turn_on: form.can_turn_on,
        can_turn_off: form.can_turn_off,
        can_check_status: form.can_check_status,
        receive_alerts: form.receive_alerts,
        is_active: form.is_active,
        ai_enabled: form.ai_enabled,
        audio_enabled: form.audio_enabled,
        notification_preference: form.notification_preference,
        full_name: requiresCpf ? (form.full_name ?? "").trim() : (form.full_name ?? null),
        cpf: requiresCpf ? maskCPF(cpfDigits) : (form.cpf ?? null),
        ...(canEditRole ? { role: form.role, is_approver: form.role !== "operator" } : {}),
      };

      const client = supabase as unknown as {
        from: (t: string) => {
          insert: (p: unknown) => Promise<{ error: { message: string } | null }>;
          update: (p: unknown) => { eq: (k: string, v: string) => Promise<{ error: { message: string } | null }> };
        };
      };
      const res = initial?.id
        ? await client.from("whatsapp_operators").update(payload).eq("id", initial.id)
        : await client.from("whatsapp_operators").insert(payload);
      if (res.error) {
        if (res.error.message.includes("duplicate")) toast.error("Já existe operador com esse número");
        else toast.error("Erro ao salvar: " + res.error.message);
        return;
      }
      toast.success(initial?.id ? "Operador atualizado" : "Operador adicionado");
      // Notificação WhatsApp imediata quando permissões mudam em operador existente
      if (initial?.id) {
        const changes: string[] = [];
        if (initial.can_turn_on !== form.can_turn_on) changes.push(form.can_turn_on ? "ligar permitido" : "ligar bloqueado");
        if (initial.can_turn_off !== form.can_turn_off) changes.push(form.can_turn_off ? "desligar permitido" : "desligar bloqueado");
        if (initial.can_check_status !== form.can_check_status) changes.push(form.can_check_status ? "consulta permitida" : "consulta bloqueada");
        if (initial.is_active !== form.is_active) changes.push(form.is_active ? "ativo" : "inativo");
        if (changes.length) {
          notifyWhatsAppImmediate("operator_permissions_changed", {
            target_phone: form.phone,
            target_name: form.name,
            farm_id: form.farm_id,
            summary: `Suas permissões foram atualizadas: ${changes.join(", ")}.`,
          }, { fireAndForget: true });
        }
      }
      onSaved();
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{initial?.id ? "Editar operador" : "Adicionar operador"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Nome completo</Label>
            <Input value={form.name} onChange={(e) => update("name", e.target.value)} placeholder="João da Silva" />
          </div>
          <div className="space-y-2">
            <Label>Número WhatsApp</Label>
            <Input
              value={form.phone}
              onChange={(e) => update("phone", maskBR(e.target.value))}
              placeholder="+55 77 99999-9999"
            />
          </div>
          <div className="space-y-2">
            <Label>Fazenda vinculada</Label>
            <Select value={form.farm_id ?? ""} onValueChange={(v) => update("farm_id", v)}>
              <SelectTrigger><SelectValue placeholder="Selecione a fazenda" /></SelectTrigger>
              <SelectContent>
                {farms.map((f) => <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Nível de Acesso</Label>
            <Select
              value={form.role}
              onValueChange={(v) => update("role", v as WhatsAppRole)}
              disabled={!canEditRole}
            >
              <SelectTrigger>
                <SelectValue>{ROLE_LABELS[form.role]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(["operator", "approver", "manager", "super_admin"] as WhatsAppRole[]).map((r) => (
                  <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!canEditRole && (
              <p className="text-[11px] text-muted-foreground">Apenas Super Admin pode alterar nível de acesso.</p>
            )}
          </div>

          {requiresCpf && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-3">
              <p className="text-[11px] font-medium uppercase tracking-wider text-amber-500">
                Dados obrigatórios para Gestor / Super Admin
              </p>
              <div className="space-y-2">
                <Label>Nome completo (oficial)</Label>
                <Input
                  value={form.full_name ?? ""}
                  onChange={(e) => update("full_name", e.target.value)}
                  placeholder="João da Silva"
                />
              </div>
              <div className="space-y-2">
                <Label>CPF</Label>
                <Input
                  value={form.cpf ?? ""}
                  onChange={(e) => update("cpf", maskCPF(e.target.value))}
                  placeholder="000.000.000-00"
                  inputMode="numeric"
                  maxLength={14}
                />
                {!cpfOk && (form.cpf ?? "").length > 0 && (
                  <p className="text-[11px] text-destructive">CPF inválido — verifique os dígitos.</p>
                )}
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label>Permissões</Label>
            <div className="grid grid-cols-2 gap-2">
              {[
                { k: "can_turn_on" as const, l: "Ligar bombas" },
                { k: "can_turn_off" as const, l: "Desligar bombas" },
                { k: "can_check_status" as const, l: "Consultar status" },
                { k: "receive_alerts" as const, l: "Receber alertas" },
              ].map((p) => (
                <label key={p.k} className="flex items-center gap-2 text-sm cursor-pointer">
                  <Checkbox checked={form[p.k]} onCheckedChange={(v) => update(p.k, Boolean(v))} />
                  {p.l}
                </label>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <div>
              <Label>Status</Label>
              <p className="text-xs text-muted-foreground">{form.is_active ? "Ativo" : "Inativo"}</p>
            </div>
            <Switch checked={form.is_active} onCheckedChange={(v) => update("is_active", v)} />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <div className="space-y-1 pr-3">
              <div className="flex items-center gap-2">
                <Label>Inteligência Artificial</Label>
                {form.ai_enabled ? (
                  <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 text-emerald-500 px-2 py-0.5 text-[11px] font-medium">
                    🤖 IA Ativa
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-md bg-muted text-muted-foreground px-2 py-0.5 text-[11px] font-medium">
                    Bot Padrão
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">Quando ativo, o sistema usa IA para interpretar comandos em linguagem natural. Desativado, aceita apenas comandos exatos e respostas "sim"/"não".</p>
            </div>
            <Switch
              checked={form.ai_enabled}
              onCheckedChange={(v) => {
                update("ai_enabled", v);
                if (!v) update("audio_enabled", false);
              }}
            />
          </div>
          <div className={`flex items-center justify-between rounded-lg border border-border p-3 ${!form.ai_enabled ? "opacity-60" : ""}`}>
            <div className="space-y-1 pr-3">
              <div className="flex items-center gap-2">
                <Label>Reconhecimento de Áudio</Label>
                {form.audio_enabled ? (
                  <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 text-emerald-500 px-2 py-0.5 text-[11px] font-medium">
                    🎤 Ativo
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-md bg-muted text-muted-foreground px-2 py-0.5 text-[11px] font-medium">
                    Desativado
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">Quando ativo, o sistema transcreve e processa áudios. Requer IA ativa.</p>
            </div>
            <Switch
              checked={form.audio_enabled && form.ai_enabled}
              disabled={!form.ai_enabled}
              onCheckedChange={(v) => update("audio_enabled", v)}
            />
          </div>
          <div className="space-y-2">
            <Label>Preferência de Notificação</Label>
            <Select
              value={form.notification_preference}
              onValueChange={(v) => update("notification_preference", v as NotificationPref)}
            >
              <SelectTrigger><SelectValue>{NOTIF_LABELS[form.notification_preference]}</SelectValue></SelectTrigger>
              <SelectContent>
                {(["default", "private", "mute"] as NotificationPref[]).map((p) => (
                  <SelectItem key={p} value={p}>{NOTIF_LABELS[p]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              Sobrescreve a configuração da fazenda. "Silenciado" desativa alertas mas mantém o envio de comandos.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={save} disabled={saving || !valid}>{saving ? "Salvando..." : "Salvar"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
