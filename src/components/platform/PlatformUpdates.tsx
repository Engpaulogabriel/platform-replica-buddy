import AgentUpdateStatusPanel from "./AgentUpdateStatusPanel";
import { useEffect, useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { notify } from "@/lib/notify";
import {
  Download, Plus, RefreshCw, Trash2, Star, ExternalLink, Rocket, AlertTriangle, CheckCircle2, Pin, PinOff,
  UploadCloud, FileArchive, Loader2, Undo2,
} from "lucide-react";
import { enqueueAgentCommand } from "@/lib/agentCommands";
import { Progress } from "@/components/ui/progress";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { supabase as supabaseClient } from "@/integrations/supabase/client";

interface Release {
  id: string;
  version: string;
  download_url: string | null;
  release_notes: string | null;
  is_latest: boolean;
  mandatory: boolean;
  published_at: string;
  file_hash: string | null;
  file_size_bytes: number | null;
  artifact_type?: "asar" | "exe" | null;
  storage_path?: string | null;
}

interface FarmAgent {
  farm_id: string;
  name: string;
  city: string | null;
  state: string | null;
  agent_version: string | null;
  agent_status: string;
  last_heartbeat: string | null;
  /** null = segue is_latest global; string = pinned na versão informada */
  target_agent_version: string | null;
  agent_previous_version: string | null;
}
const MIN_ASAR_BYTES = 10 * 1024 * 1024; // 10 MB — .asar sem node_modules fica menor que isso

function isAsarTooSmall(r: Pick<Release, "artifact_type" | "file_size_bytes">): boolean {
  return r.artifact_type === "asar" && typeof r.file_size_bytes === "number" && r.file_size_bytes < MIN_ASAR_BYTES;
}


function compareVersions(a: string | null, b: string | null): number {
  if (!a) return -1;
  if (!b) return 1;
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

export default function PlatformUpdates() {
  const [releases, setReleases] = useState<Release[]>([]);
  const [agents, setAgents] = useState<FarmAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [asarFile, setAsarFile] = useState<File | null>(null);
  const [blockedFarms, setBlockedFarms] = useState<Set<string>>(new Set());
  const [form, setForm] = useState({
    version: "",
    download_url: "",
    release_notes: "",
    is_latest: true,
    mandatory: false,
    file_hash: "",
    file_size_bytes: "",
  });

  const latest = useMemo(() => releases.find((r) => r.is_latest) ?? null, [releases]);

  const load = async () => {
    setLoading(true);
    try {
      const [{ data: rel }, { data: farms }] = await Promise.all([
        supabase.from("agent_releases").select("*").order("published_at", { ascending: false }),
        supabase
          .from("farms")
          .select("id, name, city, state, target_agent_version, agent_previous_version, site_health(agent_version, agent_status, last_heartbeat)")
          .order("name"),
      ]);
      setReleases((rel as Release[]) ?? []);
      const mapped: FarmAgent[] = (farms ?? []).map((f: any) => {
        const sh = Array.isArray(f.site_health) ? f.site_health[0] : f.site_health;
        return {
          farm_id: f.id,
          name: f.name,
          city: f.city,
          state: f.state,
          agent_version: sh?.agent_version ?? null,
          agent_status: sh?.agent_status ?? "offline",
          last_heartbeat: sh?.last_heartbeat ?? null,
          target_agent_version: f.target_agent_version ?? null,
          agent_previous_version: f.agent_previous_version ?? null,
        };
      });
      setAgents(mapped);
    } catch (e: any) {
      notify.fail("Atualizações", e.message ?? "Falha ao carregar releases");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const resetForm = () => {
    setForm({ version: "", download_url: "", release_notes: "", is_latest: true, mandatory: false, file_hash: "", file_size_bytes: "" });
    setAsarFile(null);
    setUploadProgress(0);
  };

  // Computa SHA-256 do arquivo no navegador (Web Crypto API)
  const computeSha256 = async (file: File): Promise<string> => {
    const buf = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  };

  const handleAsarPicked = async (file: File | null) => {
    setAsarFile(file);
    if (!file) return;
    if (!/\.(asar|exe)$/i.test(file.name)) {
      notify.warn("Atualizações", "Arquivo precisa ser .asar (leve) ou .exe (instalador completo)");
      setAsarFile(null);
      return;
    }
    const isExe = /\.exe$/i.test(file.name);
    const sizeMB = file.size / 1024 / 1024;
    if (!isExe && file.size < MIN_ASAR_BYTES) {
      notify.fail(
        "Atualizações",
        `⚠️ Arquivo muito pequeno (${sizeMB.toFixed(2)} MB). O .asar válido deve ter pelo menos 10 MB. Verifique se as dependências (node_modules) estão incluídas.`,
      );
      setAsarFile(null);
      return;
    }
    try {
      const hash = await computeSha256(file);
      setForm((f) => ({
        ...f,
        file_hash: hash,
        file_size_bytes: String(file.size),
      }));
      notify.ok(
        "Atualizações",
        `Hash calculado (${sizeMB.toFixed(1)} MB) [${isExe ? "exe" : "asar"}]`,
      );
    } catch (e: any) {
      notify.fail("Atualizações", `Falha ao calcular hash: ${e.message}`);
    }
  };


  const handleCreate = async () => {
    if (!form.version.trim()) {
      notify.fail("Atualizações", "Versão é obrigatória");
      return;
    }
    if (!/^\d+\.\d+\.\d+/.test(form.version.trim())) {
      notify.fail("Atualizações", "Versão deve seguir o padrão semver (ex: 1.5.0)");
      return;
    }
    if (!asarFile && !form.download_url.trim()) {
      notify.fail("Atualizações", "Selecione um arquivo .asar OU informe uma URL externa (legado .exe)");
      return;
    }
    if (asarFile && !/\.exe$/i.test(asarFile.name) && asarFile.size < MIN_ASAR_BYTES) {
      const mb = (asarFile.size / 1024 / 1024).toFixed(2);
      notify.fail(
        "Atualizações",
        `⚠️ Arquivo muito pequeno (${mb} MB). O .asar válido deve ter pelo menos 10 MB. Verifique se as dependências (node_modules) estão incluídas.`,
      );
      return;
    }

    setUploading(true);
    setUploadProgress(0);
    try {
      let storage_path: string | null = null;
      let artifact_type: "asar" | "exe" = "exe";

      if (asarFile) {
        const isExe = /\.exe$/i.test(asarFile.name);
        artifact_type = isExe ? "exe" : "asar";
        const version = form.version.trim();
        const fileName = isExe ? `GestorDeBombasKey-Setup-${version}.exe` : "app.asar";
        storage_path = `releases/${version}/${fileName}`;
        setUploadProgress(10);
        const { error: upErr } = await supabaseClient.storage
          .from("agent-releases")
          .upload(storage_path, asarFile, {
            upsert: true,
            contentType: "application/octet-stream",
          });
        if (upErr) throw new Error(`Upload falhou: ${upErr.message}`);
        setUploadProgress(90);
      }


      const { error } = await supabase.from("agent_releases").insert({
        version: form.version.trim(),
        download_url: form.download_url.trim() || null,
        storage_path,
        artifact_type,
        release_notes: form.release_notes.trim() || null,
        is_latest: form.is_latest,
        mandatory: form.mandatory,
        file_hash: form.file_hash.trim() || null,
        file_size_bytes: form.file_size_bytes ? Number(form.file_size_bytes) : null,
      } as any);
      if (error) {
        // Se o insert falhou, tenta limpar o arquivo do storage
        if (storage_path) {
          await supabaseClient.storage.from("agent-releases").remove([storage_path]).catch(() => {});
        }
        throw new Error(error.message);
      }
      setUploadProgress(100);
      notify.ok("Atualizações", `Release ${form.version} publicada`);
      setDialogOpen(false);
      resetForm();
      load();
    } catch (e: any) {
      notify.fail("Atualizações", e.message ?? "Falha ao publicar release");
    } finally {
      setUploading(false);
    }
  };

  const handleSetLatest = async (id: string) => {
    const target = releases.find((r) => r.id === id);
    if (target && isAsarTooSmall(target)) {
      const mb = ((target.file_size_bytes ?? 0) / 1024 / 1024).toFixed(2);
      notify.fail(
        "Atualizações",
        `⚠️ Arquivo muito pequeno (${mb} MB). O .asar válido deve ter pelo menos 10 MB. Verifique se as dependências (node_modules) estão incluídas.`,
      );
      return;
    }
    const { error } = await supabase.from("agent_releases").update({ is_latest: true }).eq("id", id);
    if (error) return notify.fail("Atualizações", error.message);
    notify.ok("Atualizações", "Release marcada como atual");
    load();
  };

  const handleDelete = async (id: string) => {
    const target = releases.find((r) => r.id === id);
    const { error } = await supabase.from("agent_releases").delete().eq("id", id);
    if (error) return notify.fail("Atualizações", error.message);
    // Limpa o arquivo do storage se existir (best-effort)
    if (target?.storage_path) {
      await supabaseClient.storage.from("agent-releases").remove([target.storage_path]).catch(() => {});
    }
    notify.ok("Atualizações", "Release removida");
    load();
  };

  // Dispara update via RPC com guard de fila pendente.
  // farmId=null aplica para todas as fazendas.
  const dispatchUpdate = async (farmId: string | null, version: string, force = false) => {
    const rel = releases.find((r) => r.version === version);
    if (rel && isAsarTooSmall(rel)) {
      const mb = ((rel.file_size_bytes ?? 0) / 1024 / 1024).toFixed(2);
      notify.fail(
        "Atualizações",
        `⚠️ Arquivo muito pequeno (${mb} MB). O .asar da versão ${version} deve ter pelo menos 10 MB. Verifique se as dependências (node_modules) estão incluídas. Update bloqueado.`,
      );
      return;
    }
    const targets = farmId ? [farmId] : agents.map((a) => a.farm_id);
    let ok = 0, blocked = 0, failed = 0;
    const newlyBlocked: string[] = [];
    const newlyOk: string[] = [];
    for (const fid of targets) {
      const { data, error } = await supabase.rpc("request_agent_update" as any, {
        _farm_id: fid, _version: version, _force: force,
      });
      if (error) { failed++; continue; }
      const res = data as any;
      if (res?.ok) { ok++; newlyOk.push(fid); }
      else if (res?.reason === "pending_commands") { blocked++; newlyBlocked.push(fid); }
      else failed++;
    }
    // Atualiza set de bloqueadas: remove as que foram OK, adiciona as bloqueadas
    setBlockedFarms((prev) => {
      const next = new Set(prev);
      newlyOk.forEach((id) => next.delete(id));
      newlyBlocked.forEach((id) => next.add(id));
      return next;
    });
    if (ok > 0) notify.ok("Atualizações", `Update enviado para ${ok} fazenda(s)`);
    if (blocked > 0) notify.warn("Atualizações", `${blocked} fazenda(s) bloqueada(s) — aguardando fila de comandos esvaziar. Use "Forçar" para ignorar a fila.`);
    if (failed > 0) notify.fail("Atualizações", `${failed} falha(s)`);
  };

  // Rollback 1-clique: insere agent_commands(force_rollback). O agente
  // troca app.asar.bak → app.asar localmente (instantâneo, <5s).
  const dispatchRollback = async (farmId: string, targetVersion: string) => {
    try {
      await enqueueAgentCommand({
        farmId,
        kind: "force_rollback",
        payload: { target_version: targetVersion },
        expiresInSec: 120,
      });
      // Atualiza target_version do agent_update_status pra refletir o alvo do rollback
      await supabase.from("agent_update_status").upsert(
        {
          farm_id: farmId,
          target_version: targetVersion,
          update_status: "pending",
          download_progress: 0,
          error_message: null,
          requested_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        } as any,
        { onConflict: "farm_id" } as any,
      );
      notify.ok("Rollback", `Rollback para ${targetVersion} enviado — agente reverte em até 30s`);
    } catch (e: any) {
      notify.fail("Rollback", e.message ?? "Falha ao enviar rollback");
    }
  };

  const dispatchRollbackAll = async () => {
    const eligible = agents.filter((a) => a.agent_previous_version);
    if (eligible.length === 0) {
      notify.warn("Rollback", "Nenhuma fazenda tem versão anterior registrada");
      return;
    }
    let ok = 0, failed = 0;
    for (const a of eligible) {
      try {
        await enqueueAgentCommand({
          farmId: a.farm_id,
          kind: "force_rollback",
          payload: { target_version: a.agent_previous_version },
          expiresInSec: 120,
        });
        ok++;
      } catch { failed++; }
    }
    if (ok > 0) notify.ok("Rollback", `Rollback enviado para ${ok} fazenda(s)`);
    if (failed > 0) notify.fail("Rollback", `${failed} falha(s)`);
  };

  /**
   * Fixa (pin) a fazenda numa versão específica do agente — usado para rollout
   * gradual: liberar uma versão nova só na fazenda de teste antes das demais.
   * Passa `version=null` para limpar o pin (a fazenda volta a seguir is_latest).
   */
  const handlePinVersion = async (farmId: string, version: string | null) => {
    const { error } = await supabase
      .from("farms")
      .update({ target_agent_version: version })
      .eq("id", farmId);
    if (error) return notify.fail("Atualizações", error.message);
    notify.ok("Atualizações", version
        ? `Fazenda fixada na versão ${version}`
        : "Pin removido — fazenda volta a seguir a versão atual");
    // Atualiza local sem recarregar tudo
    setAgents((prev) =>
      prev.map((a) => (a.farm_id === farmId ? { ...a, target_agent_version: version } : a))
    );
  };

  const outdatedCount = useMemo(() => {
    if (!latest) return 0;
    return agents.filter((a) => a.agent_version && compareVersions(a.agent_version, latest.version) < 0).length;
  }, [agents, latest]);

  return (
    <div className="space-y-6">
      {/* Header KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Versão atual</div>
            <div className="text-2xl font-bold">{latest?.version ?? "—"}</div>
            {latest?.mandatory && <Badge variant="destructive" className="mt-1">Obrigatória</Badge>}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Agentes atualizados</div>
            <div className="text-2xl font-bold text-green-600">
              {latest ? agents.filter((a) => a.agent_version === latest.version).length : 0}
              <span className="text-sm text-muted-foreground"> / {agents.length}</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Desatualizados</div>
            <div className="text-2xl font-bold text-amber-600">{outdatedCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Sem reportar</div>
            <div className="text-2xl font-bold text-muted-foreground">
              {agents.filter((a) => !a.agent_version).length}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Releases */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Rocket className="w-5 h-5 text-primary" />
            Versões publicadas
          </CardTitle>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={load}>
              <RefreshCw className="w-4 h-4 mr-1.5" />Atualizar
            </Button>
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogTrigger asChild>
                <Button size="sm">
                  <Plus className="w-4 h-4 mr-1.5" />Nova release
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>Publicar nova versão do agente</DialogTitle>
                  <DialogDescription>
                    Envie o <code>app.asar</code> (~5 MB, atualização leve) <strong>OU</strong> o instalador <code>.exe</code> completo (~80 MB).
                    <br />
                    <strong className="text-amber-600">⚠ Publicar NÃO atualiza nenhum agente automaticamente.</strong> A versão fica disponível e você decide quando aplicar em cada fazenda (botão "Atualizar agora") ou em todas (botão "Atualizar todas").
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                  <div>
                    <Label>Versão (semver)</Label>
                    <Input
                      placeholder="3.10.6"
                      value={form.version}
                      onChange={(e) => setForm({ ...form, version: e.target.value })}
                      disabled={uploading}
                    />
                  </div>

                  {/* Upload app.asar OU .exe */}
                  <div className="rounded-md border-2 border-dashed border-primary/40 p-4 space-y-2 bg-primary/5">
                    <div className="flex items-center gap-2">
                      <FileArchive className="w-4 h-4 text-primary" />
                      <Label className="text-sm font-semibold">Arquivo app.asar (leve) ou .exe (instalador completo)</Label>
                    </div>
                    <Input
                      type="file"
                      accept=".asar,.exe,application/octet-stream,application/x-msdownload"
                      onChange={(e) => handleAsarPicked(e.target.files?.[0] ?? null)}
                      disabled={uploading}
                    />
                    {asarFile && (
                      <div className="text-xs text-muted-foreground space-y-1">
                        <div className="flex items-center gap-2">
                          <CheckCircle2 className="w-3 h-3 text-green-600" />
                          <span className="font-mono truncate">{asarFile.name}</span>
                          <Badge variant="outline" className="text-[10px]">
                            {/\.exe$/i.test(asarFile.name) ? "exe (completo)" : "asar (leve)"}
                          </Badge>
                          <span>({(asarFile.size / 1024 / 1024).toFixed(2)} MB)</span>
                        </div>
                        {form.file_hash && (
                          <div className="font-mono text-[10px] truncate">SHA-256: {form.file_hash}</div>
                        )}
                      </div>
                    )}
                    <p className="text-[10px] text-muted-foreground">
                      Hash SHA-256 calculado no navegador antes do upload. Use <strong>.asar</strong> para correções de código JS (rápido) e <strong>.exe</strong> quando precisar atualizar Electron/Chromium/Node ou deps nativas (raro).
                    </p>
                  </div>


                  {/* URL externa (legado GitHub) — só aparece se nenhum arquivo foi selecionado */}
                  {!asarFile && (
                    <div className="rounded-md border p-3 space-y-2">
                      <Label className="text-xs text-muted-foreground">OU URL externa pública (legado GitHub Releases)</Label>
                      <Input
                        placeholder="https://github.com/owner/.../GestorDeBombasKey-Setup-1.5.0.exe"
                        value={form.download_url}
                        onChange={(e) => setForm({ ...form, download_url: e.target.value })}
                        disabled={uploading}
                      />
                    </div>
                  )}


                  <div>
                    <Label>Notas da versão</Label>
                    <Textarea
                      placeholder="• Correções de bugs&#10;• Suporte a novos comandos CFG"
                      value={form.release_notes}
                      onChange={(e) => setForm({ ...form, release_notes: e.target.value })}
                      rows={3}
                      disabled={uploading}
                    />
                  </div>
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <div>
                      <div className="text-sm font-medium">Marcar como versão de referência</div>
                      <div className="text-xs text-muted-foreground">Apenas sinaliza esta como a versão recomendada — <strong>não dispara update automático</strong>. Os agentes só atualizam quando você clicar "Atualizar agora".</div>
                    </div>
                    <Switch
                      checked={form.is_latest}
                      onCheckedChange={(v) => setForm({ ...form, is_latest: v })}
                      disabled={uploading}
                    />
                  </div>
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <div>
                      <div className="text-sm font-medium">Atualização obrigatória</div>
                      <div className="text-xs text-muted-foreground">Força reinício imediato no agente quando baixada.</div>
                    </div>
                    <Switch
                      checked={form.mandatory}
                      onCheckedChange={(v) => setForm({ ...form, mandatory: v })}
                      disabled={uploading}
                    />
                  </div>
                  {uploading && (
                    <div className="space-y-1">
                      <Progress value={uploadProgress} className="h-2" />
                      <div className="text-[11px] text-muted-foreground text-right">
                        {uploadProgress < 90 ? "Enviando arquivo…" : "Publicando release…"} {uploadProgress}%
                      </div>
                    </div>
                  )}
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => { setDialogOpen(false); resetForm(); }} disabled={uploading}>
                    Cancelar
                  </Button>
                  <Button onClick={handleCreate} disabled={uploading}>
                    {uploading ? (
                      <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> Publicando…</>
                    ) : (
                      <><UploadCloud className="w-4 h-4 mr-1.5" /> Publicar</>
                    )}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-sm text-muted-foreground py-6 text-center">Carregando…</div>
          ) : releases.length === 0 ? (
            <div className="text-sm text-muted-foreground py-6 text-center">
              Nenhuma release publicada ainda. Crie a primeira após gerar o .exe no GitHub.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Versão</TableHead>
                  <TableHead>Publicada em</TableHead>
                  <TableHead>Tamanho</TableHead>
                  <TableHead>URL</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {releases.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono font-medium">{r.version}</span>
                        {r.is_latest && (
                          <Badge variant="default" className="gap-1">
                            <Star className="w-3 h-3" />Atual
                          </Badge>
                        )}
                        {r.mandatory && <Badge variant="destructive">Obrigatória</Badge>}
                        {r.artifact_type === "asar" ? (
                          <Badge variant="secondary" className="gap-1 text-[10px]">
                            <FileArchive className="w-3 h-3" />asar
                          </Badge>
                        ) : r.artifact_type === "exe" && r.storage_path ? (
                          <Badge variant="secondary" className="gap-1 text-[10px] border-orange-500/40">
                            <FileArchive className="w-3 h-3" />exe (completo)
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px] text-muted-foreground">.exe legado URL</Badge>
                        )}

                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(r.published_at).toLocaleString("pt-BR")}
                    </TableCell>
                    <TableCell className="text-xs">
                      {typeof r.file_size_bytes === "number" ? (
                        isAsarTooSmall(r) ? (
                          <span className="inline-flex items-center gap-1 font-mono font-semibold text-destructive" title="Arquivo suspeito — menor que 10 MB (node_modules pode estar faltando)">
                            <AlertTriangle className="w-3.5 h-3.5" />
                            {(r.file_size_bytes / 1024 / 1024).toFixed(2)} MB
                          </span>
                        ) : (
                          <span className="font-mono text-muted-foreground">
                            {(r.file_size_bytes / 1024 / 1024).toFixed(2)} MB
                          </span>
                        )
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {r.storage_path ? (
                        <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                          <FileArchive className="w-3 h-3" />
                          <code className="text-[10px]">{r.storage_path}</code>
                        </span>
                      ) : r.download_url ? (
                        <a
                          href={r.download_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                        >
                          <ExternalLink className="w-3 h-3" />
                          {r.download_url.length > 50 ? r.download_url.slice(0, 50) + "…" : r.download_url}
                        </a>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        {!r.is_latest && (
                          <Button variant="ghost" size="sm" onClick={() => handleSetLatest(r.id)}>
                            <Star className="w-3.5 h-3.5 mr-1" />Marcar atual
                          </Button>
                        )}
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="ghost" size="sm">
                              <Rocket className="w-3.5 h-3.5 mr-1" />Forçar update em todas
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Forçar atualização em todas as fazendas?</AlertDialogTitle>
                              <AlertDialogDescription>
                                Vai enviar comando <code>update_agent</code> para os {agents.length} agentes ativos.
                                Cada agente vai baixar a versão {r.version} e reiniciar quando estiver online.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancelar</AlertDialogCancel>
                              <AlertDialogAction onClick={() => dispatchUpdate(null, r.version)}>
                                Disparar
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive">
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Remover release {r.version}?</AlertDialogTitle>
                              <AlertDialogDescription>
                                Apenas remove o registro da plataforma. O .exe no GitHub continua intacto.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancelar</AlertDialogCancel>
                              <AlertDialogAction onClick={() => handleDelete(r.id)} className="bg-destructive">
                                Remover
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Agents per farm */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Download className="w-5 h-5 text-primary" />
            Versão instalada por fazenda
          </CardTitle>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={agents.every((a) => !a.agent_previous_version)}
              >
                <Undo2 className="w-4 h-4 mr-1.5" />Rollback todas
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Reverter TODAS as fazendas para a versão anterior?</AlertDialogTitle>
                <AlertDialogDescription>
                  Cada fazenda elegível volta para a versão que rodava antes do último update OTA.
                  Onde existir backup local (<code>app.asar.bak</code>) o rollback é instantâneo (&lt;5s);
                  caso contrário cai pro download da versão anterior.
                  <br /><br />
                  Fazendas elegíveis: <strong>{agents.filter((a) => a.agent_previous_version).length}</strong> de {agents.length}.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancelar</AlertDialogCancel>
                <AlertDialogAction onClick={dispatchRollbackAll} className="bg-destructive">
                  Reverter todas
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardHeader>
        <CardContent>
          {agents.length === 0 ? (
            <div className="text-sm text-muted-foreground py-6 text-center">Nenhuma fazenda encontrada.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fazenda</TableHead>
                  <TableHead>Versão instalada</TableHead>
                  <TableHead>Versão alvo (rollout)</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Último heartbeat</TableHead>
                  <TableHead className="text-right">Ação</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agents.map((a) => {
                  const isOutdated = latest && a.agent_version && compareVersions(a.agent_version, latest.version) < 0;
                  const isUpToDate = latest && a.agent_version === latest.version;
                  // Versão que esta fazenda DEVE rodar: pin se houver, senão a is_latest.
                  const effectiveTarget = a.target_agent_version ?? latest?.version ?? null;
                  const targetRelease = effectiveTarget
                    ? releases.find((r) => r.version === effectiveTarget) ?? null
                    : null;
                  return (
                    <TableRow key={a.farm_id}>
                      <TableCell>
                        <div className="font-medium">{a.name}</div>
                        {(a.city || a.state) && (
                          <div className="text-xs text-muted-foreground">
                            {[a.city, a.state].filter(Boolean).join(" / ")}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        {a.agent_version ? (
                          <div className="flex items-center gap-2">
                            <span className="font-mono">{a.agent_version}</span>
                            {isUpToDate && <CheckCircle2 className="w-3.5 h-3.5 text-green-600" />}
                            {isOutdated && (
                              <Badge variant="outline" className="text-amber-600 border-amber-600">
                                <AlertTriangle className="w-3 h-3 mr-1" />Desatualizado
                              </Badge>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">não reportou</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <Select
                            value={a.target_agent_version ?? "__latest__"}
                            onValueChange={(v) =>
                              handlePinVersion(a.farm_id, v === "__latest__" ? null : v)
                            }
                          >
                            <SelectTrigger className="h-8 w-[180px] text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__latest__">
                                <span className="inline-flex items-center gap-1.5">
                                  <Star className="w-3 h-3" />
                                  Atual ({latest?.version ?? "—"})
                                </span>
                              </SelectItem>
                              {releases.map((r) => (
                                <SelectItem key={r.id} value={r.version}>
                                  <span className="font-mono">{r.version}</span>
                                  {r.is_latest && <span className="ml-1 text-muted-foreground">(atual)</span>}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {a.target_agent_version ? (
                            <Badge variant="outline" className="gap-1 text-xs border-amber-500 text-amber-600">
                              <Pin className="w-3 h-3" />
                              Pinned
                            </Badge>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                              <PinOff className="w-3 h-3" />
                              segue atual
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={a.agent_status === "online" ? "default" : "secondary"}>
                          {a.agent_status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {a.last_heartbeat ? new Date(a.last_heartbeat).toLocaleString("pt-BR") : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1.5">
                          {targetRelease && a.agent_version !== targetRelease.version && (
                            blockedFarms.has(a.farm_id) ? (
                              <>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled
                                  title="Fila de comandos pendentes — aguardando esvaziar"
                                >
                                  <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />Aguardando...
                                </Button>
                                <AlertDialog>
                                  <AlertDialogTrigger asChild>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      className="border-amber-500 text-amber-600 hover:bg-amber-500/10 hover:text-amber-700"
                                      title="Ignorar fila pendente e forçar update agora"
                                    >
                                      <AlertTriangle className="w-3.5 h-3.5 mr-1" />Forçar
                                    </Button>
                                  </AlertDialogTrigger>
                                  <AlertDialogContent>
                                    <AlertDialogHeader>
                                      <AlertDialogTitle>Forçar atualização em {a.name}?</AlertDialogTitle>
                                      <AlertDialogDescription>
                                        A fila de comandos pendentes desta fazenda será ignorada e o
                                        comando <code>update_agent</code> para a versão <code className="font-mono">{targetRelease.version}</code> será enviado imediatamente.
                                        <br /><br />
                                        Use só se tiver certeza — comandos pendentes podem se perder durante o reinício do agente.
                                      </AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <AlertDialogFooter>
                                      <AlertDialogCancel>Cancelar</AlertDialogCancel>
                                      <AlertDialogAction
                                        onClick={() => dispatchUpdate(a.farm_id, targetRelease.version, true)}
                                        className="bg-amber-600 hover:bg-amber-700"
                                      >
                                        Forçar agora
                                      </AlertDialogAction>
                                    </AlertDialogFooter>
                                  </AlertDialogContent>
                                </AlertDialog>
                              </>
                            ) : (
                              <Button
                                variant="default"
                                size="sm"
                                disabled={a.agent_status !== "online"}
                                title={a.agent_status !== "online" ? "Agente offline — só atualiza quando voltar online" : `Atualizar para ${targetRelease.version}`}
                                onClick={() => dispatchUpdate(a.farm_id, targetRelease.version)}
                              >
                                <Rocket className="w-3.5 h-3.5 mr-1" />Atualizar agora
                              </Button>
                            )
                          )}
                          {a.agent_previous_version && a.agent_previous_version !== a.agent_version && (
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                                >
                                  <Undo2 className="w-3.5 h-3.5 mr-1" />Rollback
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Reverter {a.name}?</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    Voltar de <code className="font-mono">{a.agent_version ?? "?"}</code> para{" "}
                                    <code className="font-mono">{a.agent_previous_version}</code>.
                                    O agente será atualizado em até 30s.
                                    Se houver backup local (<code>app.asar.bak</code>), a reversão é instantânea (&lt;5s).
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancelar</AlertDialogCancel>
                                  <AlertDialogAction
                                    onClick={() => dispatchRollback(a.farm_id, a.agent_previous_version!)}
                                    className="bg-destructive"
                                  >
                                    Reverter
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <AgentUpdateStatusPanel />
    </div>
  );
}
