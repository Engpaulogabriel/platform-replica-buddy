import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Megaphone, Send, Clock, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { isFarmMigrated, MIGRATED_FARMS } from "@/lib/migrationRegistry";
import { notify } from "@/lib/notify";

type BroadcastRow = {
  id: string;
  message: string;
  target: string;
  farm_id: string | null;
  sent_by: string | null;
  sent_count: number;
  status: string;
  scheduled_at: string | null;
  sent_at: string | null;
  created_at: string;
};

interface Props {
  farmId: string | null;
  farms: { id: string; name: string }[];
}

export function WhatsAppBroadcastCard({ farmId, farms }: Props) {
  const [message, setMessage] = useState("");
  const [target, setTarget] = useState<string>("all");
  const [scheduled, setScheduled] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<BroadcastRow[]>([]);

  const loadHistory = async () => {
    const { data } = await (supabase as any)
      .from("whatsapp_broadcasts")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(20);
    setHistory((data ?? []) as BroadcastRow[]);
  };

  useEffect(() => { void loadHistory(); }, []);

  const send = async (mode: "send" | "test") => {
    const msg = message.trim();
    if (!msg) return notify.fail("Broadcast", "Digite uma mensagem.");
    if (msg.length > 4000) return notify.fail("Broadcast", "Máximo de 4000 caracteres.");

    // ── BLOQUEIO EXPLÍCITO ────────────────────────────────────────────────
    // `whatsapp-broadcast` ainda NÃO existe no backend novo. As duas saídas
    // erradas seriam: enviar pelo backend antigo (lista de operadores congelada
    // no cutover — mensagem chegando a quem talvez já não opere a fazenda) ou
    // chamar o novo e colher um 404 silencioso. Recusamos antes de sair daqui,
    // com o motivo na tela. Some quando a função for publicada no novo.
    if (target === "farm" && isFarmMigrated(farmId)) {
      return notify.fail(
        "Broadcast indisponível",
        "Esta fazenda já opera no novo servidor, onde o envio em massa ainda não está publicado. Use a notificação individual até a liberação.",
      );
    }

    setBusy(true);

    const body: Record<string, unknown> = {
      message: msg,
      target: target === "farm" ? (farmId ? `farm:${farmId}` : "all") : target,
      farm_id: target === "farm" ? farmId : null,
    };
    if (mode === "test") body.test_only_phone = null; // server side handled by 'broadcast teste' chat path; here just preview to no one
    if (scheduled && mode === "send") body.scheduled_at = new Date(scheduled).toISOString();

    const { data, error } = await supabase.functions.invoke("whatsapp-broadcast", { body });
    setBusy(false);
    if (error) return notify.fail("Broadcast", error.message);
    const d = data as any;
    if (d?.status === "scheduled") notify.ok("Broadcast", "Agendado com sucesso.");
    else if (d?.status === "ok") notify.ok("Broadcast", `Enviado para ${d.sent_count}/${d.target_count} operadores.`);
    else notify.fail("Broadcast", d?.error || "Falha no envio.");
    setMessage("");
    setScheduled("");
    void loadHistory();
  };

  /** Fazendas migradas ficam fora do alcance real deste envio. */
  const migratedOutOfReach = target !== "farm" && MIGRATED_FARMS.size > 0;

  const statusBadge = (s: string) => {
    if (s === "sent") return <Badge className="bg-emerald-500/20 text-emerald-600 border-emerald-500/40"><CheckCircle2 className="w-3 h-3 mr-1" />Enviado</Badge>;
    if (s === "sending") return <Badge variant="secondary"><Loader2 className="w-3 h-3 mr-1 animate-spin" />Enviando</Badge>;
    if (s === "pending") return <Badge variant="outline"><Clock className="w-3 h-3 mr-1" />Agendado</Badge>;
    return <Badge variant="destructive"><XCircle className="w-3 h-3 mr-1" />Falhou</Badge>;
  };

  const farmName = (id: string | null) => id ? (farms.find((f) => f.id === id)?.name ?? "—") : "Todas";

  return (
    <Card className="border-2 border-amber-500/30 bg-gradient-to-br from-amber-500/5 to-transparent">
      <CardHeader className="flex flex-row items-start gap-4">
        <div className="rounded-2xl bg-amber-500/15 p-3 border border-amber-500/30">
          <Megaphone className="w-7 h-7 text-amber-600" />
        </div>
        <div className="flex-1">
          <CardTitle>Broadcast — Mensagens em Massa</CardTitle>
          <CardDescription className="mt-1">
            Envie comunicados para operadores via WhatsApp. Disponível apenas para administradores.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {migratedOutOfReach && (
          <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning-foreground">
            O envio em massa ainda roda no servidor anterior. Fazendas já migradas
            para o novo servidor <strong>não são alcançadas</strong> por este disparo —
            notifique os operadores delas individualmente até a liberação.
          </div>
        )}
        <div className="space-y-2">
          <Label>Destinatários</Label>
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos operadores (todas fazendas)</SelectItem>
              <SelectItem value="farm">Apenas operadores desta fazenda</SelectItem>
              <SelectItem value="role:manager">Apenas gestores</SelectItem>
              <SelectItem value="role:operator">Apenas operadores</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Mensagem</Label>
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Ex: ⚠️ Manutenção programada amanhã das 08:00 às 10:00."
            rows={4}
            maxLength={4000}
          />
          <div className="text-xs text-muted-foreground text-right">{message.length}/4000</div>
        </div>

        <div className="space-y-2">
          <Label>Agendar envio (opcional)</Label>
          <Input
            type="datetime-local"
            value={scheduled}
            onChange={(e) => setScheduled(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">Deixe vazio para enviar agora.</p>
        </div>

        <div className="flex flex-wrap gap-2 justify-end">
          <Button variant="outline" onClick={() => void send("test")} disabled={busy}>
            Pré-visualizar (registrar)
          </Button>
          <Button onClick={() => void send("send")} disabled={busy}>
            {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Send className="w-4 h-4 mr-2" />}
            {scheduled ? "Agendar" : "Enviar agora"}
          </Button>
        </div>

        <div className="rounded-xl bg-muted/40 p-3 text-xs text-muted-foreground">
          ⚠️ Devido à regra das 24h da Meta, mensagens só chegam a operadores que interagiram com o bot nas últimas 24h. Fora dessa janela, é necessário usar templates aprovados.
        </div>

        <div className="border-t pt-4">
          <h4 className="font-semibold mb-2 text-sm">Histórico de envios</h4>
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum broadcast enviado ainda.</p>
          ) : (
            <div className="space-y-2 max-h-72 overflow-y-auto">
              {history.map((b) => (
                <div key={b.id} className="rounded-lg border bg-card p-3 text-sm space-y-1">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="text-xs text-muted-foreground">
                      {new Date(b.created_at).toLocaleString("pt-BR")} · {farmName(b.farm_id)}
                    </div>
                    <div className="flex items-center gap-2">
                      {statusBadge(b.status)}
                      <Badge variant="outline">{b.sent_count} enviadas</Badge>
                    </div>
                  </div>
                  <div className="text-foreground line-clamp-2">{b.message}</div>
                  {b.scheduled_at && (
                    <div className="text-xs text-amber-600">Agendado p/ {new Date(b.scheduled_at).toLocaleString("pt-BR")}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
