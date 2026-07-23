import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Database, RefreshCw, DownloadCloud, Undo2, HardDrive, Calendar, Loader2 } from "lucide-react";
import { notify } from "@/lib/notify";

interface Farm { farm_id: string; name: string; }
interface BackupRow {
  id: string;
  farm_id: string;
  created_at: string;
  created_by: string | null;
  trigger_kind: string;
  label: string | null;
  size_bytes: number | null;
  meta: any;
}

function fmtBytes(b: number | null) {
  if (!b) return "—";
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  return (b / 1024 / 1024).toFixed(2) + " MB";
}
function fmtDate(s: string) {
  return new Date(s).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

export default function PlatformBackups({ isAdmin }: { isAdmin: boolean }) {
  const [farms, setFarms] = useState<Farm[]>([]);
  const [farmId, setFarmId] = useState<string>("");
  const [backups, setBackups] = useState<BackupRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<BackupRow | null>(null);

  useEffect(() => {
    void supabase.rpc("platform_farms_overview" as any).then(({ data, error }) => {
      if (error) return notify.fail("Backups", error.message);
      const list = (data as any[] ?? []).map(f => ({ farm_id: f.farm_id, name: f.name }));
      setFarms(list);
      if (list.length && !farmId) setFarmId(list[0].farm_id);
    });
  }, []);

  const loadBackups = async (fid: string) => {
    if (!fid) return;
    setLoading(true);
    const { data, error } = await supabase.rpc("farm_backup_list" as any, { _farm_id: fid });
    setLoading(false);
    if (error) return notify.fail("Backups", error.message);
    setBackups((data as any) ?? []);
  };

  useEffect(() => { if (farmId) void loadBackups(farmId); }, [farmId]);

  const createBackup = async () => {
    if (!farmId) return;
    setCreating(true);
    const { data, error } = await supabase.rpc("farm_backup_create" as any, {
      _farm_id: farmId, _trigger_kind: "manual", _label: "Backup manual via painel",
    });
    setCreating(false);
    if (error) return notify.fail("Backups", error.message);
    notify.ok("Backups", "Backup criado: " + String(data).slice(0, 8) + "…");
    void loadBackups(farmId);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Database className="w-4 h-4 text-primary" />
                Backups por fazenda
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                Snapshot diário automático às 03:00 UTC · Retenção 30 dias · Restauração seletiva
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Select value={farmId} onValueChange={setFarmId}>
                <SelectTrigger className="w-64"><SelectValue placeholder="Selecione a fazenda" /></SelectTrigger>
                <SelectContent>
                  {farms.map(f => <SelectItem key={f.farm_id} value={f.farm_id}>{f.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" onClick={() => loadBackups(farmId)} disabled={loading}>
                <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
              </Button>
              {isAdmin && (
                <Button size="sm" onClick={createBackup} disabled={!farmId || creating}>
                  {creating ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <DownloadCloud className="w-4 h-4 mr-1.5" />}
                  Backup agora
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead>Origem</TableHead>
                  <TableHead>Conteúdo</TableHead>
                  <TableHead className="text-right">Tamanho</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {backups.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                      {loading ? "Carregando…" : "Nenhum backup ainda. Clique em 'Backup agora' para criar o primeiro."}
                    </TableCell>
                  </TableRow>
                )}
                {backups.map(b => {
                  const c = b.meta?.counts ?? {};
                  return (
                    <TableRow key={b.id}>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <Calendar className="w-3.5 h-3.5 text-muted-foreground" />
                          <span className="text-sm">{fmtDate(b.created_at)}</span>
                        </div>
                        {b.label && <div className="text-[10px] text-muted-foreground mt-0.5">{b.label}</div>}
                      </TableCell>
                      <TableCell>
                        <Badge variant={b.trigger_kind === "scheduled" ? "secondary" : b.trigger_kind === "pre-restore" ? "destructive" : "default"}>
                          {b.trigger_kind === "scheduled" ? "Diário" : b.trigger_kind === "pre-restore" ? "Pré-restauração" : "Manual"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {c.equipments ?? 0} equip · {c.schedules ?? 0} horários · {c.user_roles ?? 0} usuários · {c.commands ?? 0} cmds
                      </TableCell>
                      <TableCell className="text-right text-sm font-mono">
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                          <HardDrive className="w-3 h-3" />
                          {fmtBytes(b.size_bytes)}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        {isAdmin && (
                          <Button variant="ghost" size="sm" onClick={() => setRestoreTarget(b)}>
                            <Undo2 className="w-4 h-4 mr-1" />
                            Restaurar
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <RestoreDialog
        backup={restoreTarget}
        farmName={farms.find(f => f.farm_id === restoreTarget?.farm_id)?.name ?? ""}
        onClose={() => setRestoreTarget(null)}
        onDone={() => { setRestoreTarget(null); void loadBackups(farmId); }}
      />
    </div>
  );
}

function RestoreDialog({ backup, farmName, onClose, onDone }: any) {
  const [cad, setCad] = useState(true);
  const [aut, setAut] = useState(true);
  const [usr, setUsr] = useState(false);
  const [hist, setHist] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!backup) return null;

  const submit = async () => {
    if (!cad && !aut && !usr && !hist) {
      return notify.fail("Backups", "Selecione ao menos uma categoria.");
    }
    if (!confirm(
      `ATENÇÃO: vai sobrescrever dados da fazenda "${farmName}".\n` +
      `Um backup de segurança será criado automaticamente antes.\n\nContinuar?`
    )) return;
    setBusy(true);
    const { data, error } = await supabase.rpc("farm_backup_restore" as any, {
      _backup_id: backup.id,
      _restore_cadastros: cad,
      _restore_automacao: aut,
      _restore_usuarios: usr,
      _restore_historico: hist,
    });
    setBusy(false);
    if (error) return notify.fail("Backups", error.message);
    notify.ok("Backups", "Restauração concluída.");
    onDone();
  };

  return (
    <Dialog open={!!backup} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restaurar backup</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md border p-3 bg-muted/30 text-sm">
            <div><strong>Fazenda:</strong> {farmName}</div>
            <div><strong>Data:</strong> {fmtDate(backup.created_at)}</div>
            <div className="text-xs text-muted-foreground mt-1">
              Esta operação afeta APENAS esta fazenda. Outras fazendas não serão tocadas.
            </div>
          </div>

          <Label className="text-xs uppercase tracking-wider">O que restaurar?</Label>
          <div className="space-y-2">
            <label className="flex items-start gap-2 cursor-pointer">
              <Checkbox checked={cad} onCheckedChange={v => setCad(!!v)} />
              <div>
                <div className="text-sm font-medium">Cadastros</div>
                <div className="text-xs text-muted-foreground">PLCs, setores, equipamentos, rotas RF</div>
              </div>
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <Checkbox checked={aut} onCheckedChange={v => setAut(!!v)} />
              <div>
                <div className="text-sm font-medium">Automação</div>
                <div className="text-xs text-muted-foreground">Horários, feriados, motor, guards</div>
              </div>
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <Checkbox checked={usr} onCheckedChange={v => setUsr(!!v)} />
              <div>
                <div className="text-sm font-medium">Usuários e permissões</div>
                <div className="text-xs text-muted-foreground">Roles dos usuários nesta fazenda</div>
              </div>
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <Checkbox checked={hist} onCheckedChange={v => setHist(!!v)} />
              <div>
                <div className="text-sm font-medium">Histórico operacional (mesclado)</div>
                <div className="text-xs text-muted-foreground">Pump runtime — preserva existente, traz registros antigos</div>
              </div>
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Undo2 className="w-4 h-4 mr-1.5" />}
            Restaurar selecionados
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
