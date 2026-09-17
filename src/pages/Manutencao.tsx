import { useMemo, useState } from "react";
import { Wrench, Lock, Unlock, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import {
  useEquipmentMaintenance,
  formatMaintenanceDuration,
  formatMaintenanceStartedAt,
  type EquipMaintRow,
} from "@/hooks/useEquipmentMaintenance";
import { usePermission } from "@/contexts/MasterManagerContext";


function computeRunning(eq: EquipMaintRow): "on" | "off" | "offline" {
  const comm = String(eq.communication_status ?? "").toLowerCase();
  if (comm === "offline") return "offline";
  const outs = eq.last_outputs_state ?? "";
  const idx = Math.max(1, Math.min(6, eq.saida ?? 1));
  if (/^[01]{6}$/.test(outs)) return outs.charAt(idx - 1) === "1" ? "on" : "off";
  if (/^[01]$/.test(outs)) return outs === "1" ? "on" : "off";
  return eq.desired_running ? "on" : "off";
}

function statusBadge(eq: EquipMaintRow) {
  if (eq.maintenance_mode) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-warning/15 text-warning border border-warning/30 text-xs font-semibold">
        🔧 Manutenção
      </span>
    );
  }
  const r = computeRunning(eq);
  if (r === "offline") {
    return <Badge variant="outline" className="text-muted-foreground">⚫ Offline</Badge>;
  }
  if (r === "on") {
    return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-primary/15 text-primary border border-primary/30 text-xs font-semibold">🟢 Ligado</span>;
  }
  return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-muted text-muted-foreground border border-border text-xs font-semibold">⚪ Desligado</span>;
}

export default function Manutencao() {
  const { rows, loading, activate, release } = useEquipmentMaintenance();
  const canManageMaintenance = usePermission("can_manage_maintenance");


  const inMaintenance = useMemo(() => rows.filter((r) => r.maintenance_mode), [rows]);

  const [blockTarget, setBlockTarget] = useState<EquipMaintRow | null>(null);
  const [blockReason, setBlockReason] = useState("");
  const [shutdownNow, setShutdownNow] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [releaseTarget, setReleaseTarget] = useState<EquipMaintRow | null>(null);

  const openBlock = (eq: EquipMaintRow) => {
    setBlockTarget(eq);
    setBlockReason("");
    setShutdownNow(true);
  };

  const confirmBlock = async () => {
    if (!blockTarget) return;
    setSubmitting(true);
    try {
      await activate(blockTarget.id, blockReason, shutdownNow);
      toast.success(`🔒 ${blockTarget.name} bloqueado para manutenção.`);
      setBlockTarget(null);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      toast.error(`Falha ao bloquear: ${m}`);
    } finally {
      setSubmitting(false);
    }
  };

  const confirmRelease = async () => {
    if (!releaseTarget) return;
    setSubmitting(true);
    try {
      await release(releaseTarget.id);
      toast.success(`🔓 ${releaseTarget.name} liberado da manutenção.`);
      setReleaseTarget(null);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      toast.error(`Falha ao liberar: ${m}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
          <Wrench className="h-7 w-7 text-warning" />
          Manutenção de Equipamentos
        </h1>
        <p className="text-sm text-muted-foreground">
          Bloqueie equipamentos em manutenção para impedir acionamento acidental.
        </p>
      </header>

      {/* Section 1: in maintenance */}
      <Card>
        <CardContent className="p-4 md:p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold flex items-center gap-2">
              <Lock className="h-4 w-4 text-warning" />
              Equipamentos em Manutenção
            </h2>
            <Badge variant="secondary">{inMaintenance.length}</Badge>
          </div>

          {loading && inMaintenance.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
              <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
            </div>
          ) : inMaintenance.length === 0 ? (
            <p className="text-sm text-success py-4 text-center">
              ✅ Nenhum equipamento em manutenção.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Equipamento</TableHead>
                    <TableHead>Motivo</TableHead>
                    <TableHead>Início</TableHead>
                    <TableHead>Bloqueado por</TableHead>
                    <TableHead>Duração</TableHead>
                    <TableHead className="text-right">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {inMaintenance.map((eq) => (
                    <TableRow key={eq.id}>
                      <TableCell className="font-semibold">{eq.name}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {eq.maintenance_reason || <span className="italic">—</span>}
                      </TableCell>
                      <TableCell>{formatMaintenanceStartedAt(eq.maintenance_started_at)}</TableCell>
                      <TableCell>
                        {eq.maintenance_started_by ?? "—"}
                        {eq.maintenance_started_via && (
                          <span className="ml-1 text-[10px] uppercase text-muted-foreground">
                            ({eq.maintenance_started_via})
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {formatMaintenanceDuration(eq.maintenance_started_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="default"
                          onClick={() => setReleaseTarget(eq)}
                          disabled={!canManageMaintenance}
                          title={!canManageMaintenance ? "Sem permissão" : undefined}
                        >
                          <Unlock className="h-3.5 w-3.5 mr-1" />
                          Liberar
                        </Button>

                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Section 2: all equipment */}
      <Card>
        <CardContent className="p-4 md:p-5 space-y-3">
          <h2 className="text-base font-bold flex items-center gap-2">
            <Wrench className="h-4 w-4 text-primary" />
            Todos os Equipamentos
          </h2>

          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              Nenhum equipamento cadastrado.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Equipamento</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Manutenção</TableHead>
                    <TableHead className="text-right">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((eq) => (
                    <TableRow key={eq.id}>
                      <TableCell className="font-semibold">{eq.name}</TableCell>
                      <TableCell>{statusBadge(eq)}</TableCell>
                      <TableCell className="text-sm">
                        {eq.maintenance_mode ? (
                          <span>
                            {eq.maintenance_reason || <span className="italic text-muted-foreground">sem motivo</span>}
                            <span className="ml-1 text-muted-foreground">
                              ({formatMaintenanceDuration(eq.maintenance_started_at)})
                            </span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {eq.maintenance_mode ? (
                          <Button
                            size="sm"
                            variant="default"
                            onClick={() => setReleaseTarget(eq)}
                            disabled={!canManageMaintenance}
                            title={!canManageMaintenance ? "Sem permissão" : undefined}
                          >
                            <Unlock className="h-3.5 w-3.5 mr-1" />
                            Liberar
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openBlock(eq)}
                            disabled={!canManageMaintenance}
                            title={!canManageMaintenance ? "Sem permissão" : undefined}
                          >
                            <Lock className="h-3.5 w-3.5 mr-1" />
                            Bloquear
                          </Button>
                        )}

                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Block dialog */}
      <Dialog open={!!blockTarget} onOpenChange={(o) => !o && !submitting && setBlockTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>🔒 Bloquear para Manutenção</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm">
              Equipamento: <span className="font-semibold">{blockTarget?.name}</span>
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="maint-reason">Motivo (opcional):</Label>
              <Input
                id="maint-reason"
                value={blockReason}
                onChange={(e) => setBlockReason(e.target.value)}
                placeholder="Ex: Troca de selo"
                maxLength={200}
                disabled={submitting}
              />
            </div>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox
                checked={shutdownNow}
                onCheckedChange={(c) => setShutdownNow(c === true)}
                disabled={submitting}
              />
              Desligar equipamento agora?
            </label>
            <p className="text-xs text-muted-foreground">
              Enquanto bloqueado, comandos remotos (WhatsApp, sistema e automação) não conseguirão ligar este equipamento. O bloqueio não impede acionamento local (chave no painel).
            </p>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={submitting}>Cancelar</Button>
            </DialogClose>
            <Button onClick={confirmBlock} disabled={submitting}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Lock className="h-4 w-4 mr-1" />}
              Confirmar Bloqueio
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Release confirm */}
      <AlertDialog open={!!releaseTarget} onOpenChange={(o) => !o && !submitting && setReleaseTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Liberar manutenção?</AlertDialogTitle>
            <AlertDialogDescription>
              Deseja liberar <span className="font-semibold">{releaseTarget?.name}</span> da manutenção?
              O equipamento voltará à operação normal.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRelease} disabled={submitting}>
              {submitting ? "Liberando…" : "Liberar"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
