// SectorsConfig — versão LEGADA mantida apenas para compatibilidade de tipos.
// A fonte de verdade agora é a página `Cadastros` (cloud + UUIDs nativos).
// Este componente continua usando `localStorage` para PLCs/equipamentos antigos
// até ser definitivamente removido em uma rodada futura.

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  Building2, Layers, Plus, Pencil, Trash2, MapPin, Server, CircuitBoard,
} from "lucide-react";
import { notify } from "@/lib/notify";
import {
  Farm, Sector, PlcGroup,
  loadFarms, loadSectors, loadPlcGroups,
  saveFarms, saveSectors, savePlcGroups,
  loadEquipmentFarmMap, saveEquipmentFarmMap,
  genId,
} from "@/lib/sectors";

interface Equipamento {
  id: string;
  tipo: "poco" | "bombeamento" | "nivel";
  nome: string;
  plcId: string;
  // Quando vindo da nuvem, guardamos o vínculo direto para podermos contar
  // equipamentos vinculados à fazenda mesmo sem estarem em nenhum setor.
  cloudFarmId?: string | null;
  cloudSectorId?: string | null;
}

interface PLC {
  id: string;
  nome: string;
  idHex: string;
}

const EQUIP_KEY = "registered_equipment";
const PLC_KEY = "registered_plcs";

// Normaliza ids vindos do localStorage legado (number → string)
function normalizeId(v: unknown): string {
  if (v == null) return "";
  return String(v);
}

function loadEquip(): Equipamento[] {
  try {
    const raw = localStorage.getItem(EQUIP_KEY);
    const arr = raw ? (JSON.parse(raw) as Array<Record<string, unknown>>) : [];
    return arr.map((e) => ({
      id: normalizeId(e.id),
      tipo: e.tipo as Equipamento["tipo"],
      nome: String(e.nome ?? ""),
      plcId: normalizeId(e.plcId),
    }));
  } catch { return []; }
}

function loadPlcs(): PLC[] {
  try {
    const raw = localStorage.getItem(PLC_KEY);
    const arr = raw ? (JSON.parse(raw) as Array<Record<string, unknown>>) : [];
    return arr.map((p) => ({
      id: normalizeId(p.id),
      nome: String(p.nome ?? ""),
      idHex: String(p.idHex ?? ""),
    }));
  } catch { return []; }
}

export default function SectorsConfig() {
  const [farms, setFarms] = useState<Farm[]>(() => loadFarms());
  const [sectors, setSectors] = useState<Sector[]>(() => loadSectors());
  const [plcGroups, setPlcGroups] = useState<PlcGroup[]>(() => loadPlcGroups());
  const [equipment, setEquipment] = useState<Equipamento[]>(() => loadEquip());
  const [plcs, setPlcs] = useState<PLC[]>(() => loadPlcs());

  useEffect(() => {
    const handler = () => {
      setEquipment(loadEquip());
      setPlcs(loadPlcs());
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  // farmId padrão da nuvem (default_farm_id do usuário) — usado para contagens
  const [cloudFarmId, setCloudFarmId] = useState<string | null>(null);

  // Carrega equipamentos cadastrados na nuvem (fonte de verdade atual)
  // e mescla com os locais legados, deduplicando por id.
  useEffect(() => {
    let cancelled = false;
    const fetchCloud = async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const uid = sess.session?.user.id;
        if (!uid) return;
        const { data: prof } = await supabase
          .from("profiles").select("default_farm_id").eq("id", uid).maybeSingle();
        const farmId = prof?.default_farm_id;
        if (!farmId) return;
        if (!cancelled) setCloudFarmId(farmId);
        const { data: rows } = await supabase
          .from("equipments")
          .select("id,name,type,plc_group_id,farm_id,sector_id")
          .eq("farm_id", farmId)
          .eq("active", true)
          .order("name");
        if (cancelled || !rows) return;
        const cloudEquip: Equipamento[] = rows.map((r) => ({
          id: String(r.id),
          tipo: r.type as Equipamento["tipo"],
          nome: r.name,
          plcId: r.plc_group_id ? String(r.plc_group_id) : "",
          cloudFarmId: r.farm_id ? String(r.farm_id) : null,
          cloudSectorId: r.sector_id ? String(r.sector_id) : null,
        }));
        setEquipment((prev) => {
          const map = new Map<string, Equipamento>();
          for (const e of prev) map.set(e.id, e);
          for (const e of cloudEquip) map.set(e.id, e);
          return Array.from(map.values());
        });
      } catch {
        /* silencioso: mantém apenas locais */
      }
    };
    void fetchCloud();
    return () => { cancelled = true; };
  }, []);


  const [farmDlg, setFarmDlg] = useState(false);
  const [farmEdit, setFarmEdit] = useState<Farm | null>(null);
  const [farmName, setFarmName] = useState("");
  // Vínculo de equipamentos no diálogo da Fazenda:
  // farmEquip[equipId] = sectorId ("__none__" = vinculado à fazenda sem setor)
  // ausência da chave = NÃO vinculado a esta fazenda
  const NONE_SECTOR = "__none__";
  const [farmEquip, setFarmEquip] = useState<Record<string, string>>({});

  const openFarmDlg = (f: Farm | null) => {
    setFarmEdit(f);
    setFarmName(f?.nome ?? "");
    // Pré-popula o mapa: para cada equipamento, se está em um setor desta fazenda, marca-o.
    // Também inclui equipamentos vinculados direto à fazenda (sem setor).
    const initial: Record<string, string> = {};
    if (f) {
      const farmSectors = sectors.filter(s => s.farmId === f.id);
      for (const s of farmSectors) {
        for (const eqId of s.equipmentIds) initial[eqId] = s.id;
      }
      const directMap = loadEquipmentFarmMap();
      for (const [eqId, fId] of Object.entries(directMap)) {
        if (fId === f.id && !(eqId in initial)) initial[eqId] = NONE_SECTOR;
      }
    }
    setFarmEquip(initial);
    setFarmDlg(true);
  };

  const toggleFarmEquip = (eqId: string) => {
    setFarmEquip(prev => {
      const next = { ...prev };
      if (eqId in next) delete next[eqId];
      else next[eqId] = NONE_SECTOR;
      return next;
    });
  };

  const setFarmEquipSector = (eqId: string, sectorId: string) => {
    setFarmEquip(prev => ({ ...prev, [eqId]: sectorId }));
  };

  const saveFarm = async () => {
    const nome = farmName.trim();
    if (!nome) { notify.fail("Setores", "Informe o nome da fazenda."); return; }
    let next: Farm[];
    let farmId: string;
    if (farmEdit) {
      farmId = farmEdit.id;
      next = farms.map(f => f.id === farmEdit.id ? { ...f, nome } : f);
    } else {
      farmId = genId("farm");
      next = [...farms, { id: farmId, nome }];
    }
    setFarms(next); saveFarms(next);

    // Reconcilia vínculos de equipamentos com setores desta fazenda
    const selectedIds = Object.keys(farmEquip);
    const nextSectors: Sector[] = sectors.map(s => {
      if (s.farmId !== farmId) {
        // Em outras fazendas: remove qualquer equip que agora pertence a esta
        return { ...s, equipmentIds: s.equipmentIds.filter(id => !selectedIds.includes(id)) };
      }
      // Setores desta fazenda: monta lista a partir do mapa
      const wanted = selectedIds.filter(eqId => farmEquip[eqId] === s.id);
      return { ...s, equipmentIds: wanted };
    });
    setSectors(nextSectors); saveSectors(nextSectors);

    // Atualiza mapa equip→fazenda (vínculo direto, "Sem setor")
    const directMap = loadEquipmentFarmMap();
    // Remove entradas dos selectedIds (vamos re-decidir abaixo)
    for (const eqId of selectedIds) delete directMap[eqId];
    // Para cada equip desta fazenda marcado como Sem setor → grava
    for (const eqId of selectedIds) {
      if (farmEquip[eqId] === NONE_SECTOR) directMap[eqId] = farmId;
    }
    // Também limpa entradas órfãs apontando para esta fazenda mas não mais selecionadas
    for (const [eqId, fId] of Object.entries(directMap)) {
      if (fId === farmId && !selectedIds.includes(eqId)) delete directMap[eqId];
    }
    saveEquipmentFarmMap(directMap);

    // Atualiza nuvem: bombas marcadas → farm_id desta fazenda; desmarcadas que estavam aqui → mantém farm_id mas sector_id null
    try {
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const cloudIds = selectedIds.filter(id => UUID_RE.test(id));
      if (cloudIds.length > 0) {
        const { data: sess } = await supabase.auth.getSession();
        const uid = sess.session?.user.id;
        if (uid) {
          const { data: prof } = await supabase
            .from("profiles").select("default_farm_id").eq("id", uid).maybeSingle();
          const cloudFarmId = prof?.default_farm_id;
          if (cloudFarmId) {
            await supabase.from("equipments")
              .update({ farm_id: cloudFarmId })
              .in("id", cloudIds);
          }
        }
      }
    } catch { /* silencioso */ }

    setFarmDlg(false);
    notify.ok("Setores", farmEdit ? "Fazenda atualizada." : "Fazenda criada.");
  };

  const deleteFarm = (f: Farm) => {
    if (!confirm(`Excluir a fazenda "${f.nome}"? Os setores associados também serão removidos.`)) return;
    const nextFarms = farms.filter(x => x.id !== f.id);
    const nextSectors = sectors.filter(s => s.farmId !== f.id);
    setFarms(nextFarms); saveFarms(nextFarms);
    setSectors(nextSectors); saveSectors(nextSectors);
    notify.ok("Setores", "Fazenda excluída.");
  };

  const [sectorDlg, setSectorDlg] = useState(false);
  const [sectorEdit, setSectorEdit] = useState<Sector | null>(null);
  const [sectorForm, setSectorForm] = useState<{ nome: string; farmId: string; equipmentIds: string[] }>({
    nome: "", farmId: "", equipmentIds: [],
  });

  const openSectorDlg = (s: Sector | null) => {
    setSectorEdit(s);
    setSectorForm({
      nome: s?.nome ?? "",
      farmId: s?.farmId ?? (farms[0]?.id ?? ""),
      equipmentIds: s?.equipmentIds ?? [],
    });
    setSectorDlg(true);
  };

  const saveSector = async () => {
    const nome = sectorForm.nome.trim();
    if (!sectorForm.farmId) { notify.fail("Setores", "Selecione uma fazenda."); return; }

    // Caso 1: SEM nome → não cria/edita setor.
    // Apenas move as bombas selecionadas para a fazenda escolhida (na nuvem)
    // e remove o vínculo de setor (sector_id = null) caso existam vínculos locais.
    if (!nome) {
      if (sectorForm.equipmentIds.length === 0) {
        notify.fail("Setores", "Informe o nome do setor ou selecione ao menos uma bomba.");
        return;
      }
      try {
        // Filtra apenas IDs em formato UUID (equipamentos cadastrados na nuvem)
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const cloudIds = sectorForm.equipmentIds.filter(id => UUID_RE.test(id));

        if (cloudIds.length > 0) {
          // Resolve o farm_id REAL na nuvem (default_farm_id do usuário logado)
          const { data: sess } = await supabase.auth.getSession();
          const uid = sess.session?.user.id;
          if (!uid) throw new Error("Usuário não autenticado.");
          const { data: prof, error: profErr } = await supabase
            .from("profiles").select("default_farm_id").eq("id", uid).maybeSingle();
          if (profErr) throw profErr;
          const cloudFarmId = prof?.default_farm_id;
          if (!cloudFarmId) throw new Error("Fazenda padrão não configurada na nuvem.");

          const { error } = await supabase
            .from("equipments")
            .update({ farm_id: cloudFarmId, sector_id: null })
            .in("id", cloudIds);
          if (error) throw error;
        }

        // Remove vínculos locais com qualquer setor
        const cleaned: Sector[] = sectors.map(s => ({
          ...s,
          equipmentIds: s.equipmentIds.filter(id => !sectorForm.equipmentIds.includes(id)),
        }));
        setSectors(cleaned); saveSectors(cleaned);
        setSectorDlg(false);
        notify.ok("Setores", `${sectorForm.equipmentIds.length} bomba(s) movida(s) para a fazenda.`);
      } catch (e: unknown) {
        const msg =
          e instanceof Error ? e.message :
          typeof e === "string" ? e :
          (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string")
            ? (e as { message: string }).message
            : JSON.stringify(e);
        notify.fail("Setores", `Falha ao mover bombas: ${msg}`);
      }
      return;
    }

    // Caso 2: COM nome → cria/atualiza setor normalmente
    const cleanedSectors: Sector[] = sectors.map(s => ({
      ...s,
      equipmentIds: s.equipmentIds.filter(id => !sectorForm.equipmentIds.includes(id)),
    }));

    let next: Sector[];
    if (sectorEdit) {
      next = cleanedSectors.map(s =>
        s.id === sectorEdit.id
          ? { ...s, nome, farmId: sectorForm.farmId, equipmentIds: sectorForm.equipmentIds }
          : s
      );
    } else {
      next = [...cleanedSectors, {
        id: genId("sector"),
        farmId: sectorForm.farmId,
        nome,
        equipmentIds: sectorForm.equipmentIds,
      }];
    }
    setSectors(next); saveSectors(next);
    setSectorDlg(false);
    notify.ok("Setores", sectorEdit ? "Setor atualizado." : "Setor criado.");
  };

  const deleteSector = (s: Sector) => {
    if (!confirm(`Excluir o setor "${s.nome}"?`)) return;
    const next = sectors.filter(x => x.id !== s.id);
    setSectors(next); saveSectors(next);
    notify.ok("Setores", "Setor excluído.");
  };

  const toggleEquipInForm = (id: string) => {
    setSectorForm(prev => ({
      ...prev,
      equipmentIds: prev.equipmentIds.includes(id)
        ? prev.equipmentIds.filter(x => x !== id)
        : [...prev.equipmentIds, id],
    }));
  };

  const eligiblePlcs = useMemo(() => {
    const counts = new Map<string, { count: number; equipNames: string[] }>();
    equipment
      .filter(e => e.tipo === "poco" || e.tipo === "bombeamento")
      .forEach(e => {
        const c = counts.get(e.plcId) ?? { count: 0, equipNames: [] };
        c.count += 1;
        c.equipNames.push(e.nome);
        counts.set(e.plcId, c);
      });
    return Array.from(counts.entries())
      .filter(([, v]) => v.count >= 2)
      .map(([plcId, v]) => {
        const plc = plcs.find(p => p.id === plcId);
        return {
          plcId,
          plcNome: plc?.nome ?? `PLC ${plcId}`,
          plcHex: plc?.idHex ?? "",
          count: v.count,
          equipNames: v.equipNames,
        };
      });
  }, [equipment, plcs]);

  const setPlcGroupName = (plcId: string, nome: string) => {
    const trimmed = nome.trim();
    let next: PlcGroup[];
    if (!trimmed) {
      next = plcGroups.filter(g => g.plcId !== plcId);
    } else if (plcGroups.some(g => g.plcId === plcId)) {
      next = plcGroups.map(g => g.plcId === plcId ? { ...g, nome: trimmed } : g);
    } else {
      next = [...plcGroups, { plcId, nome: trimmed }];
    }
    setPlcGroups(next); savePlcGroups(next);
  };

  const sectorsByFarm = (farmId: string) => sectors.filter(s => s.farmId === farmId);
  const equipName = (id: string) => equipment.find(e => e.id === id)?.nome ?? `#${id}`;

  return (
    <div className="space-y-4">
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base text-foreground flex items-center gap-2">
            <Building2 className="w-4 h-4 text-primary" />
            Configurações de Início
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            Organize seus equipamentos em uma hierarquia <span className="text-foreground font-medium">Fazenda → Setor → Equipamento</span>.
            Quando uma PLC controlar várias bombas, defina um nome para o grupo (ex.: <span className="text-foreground font-medium">"Rio 12 Bombas"</span>).
          </p>
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader className="pb-3 flex-row items-center justify-between">
          <CardTitle className="text-sm text-foreground flex items-center gap-2">
            <MapPin className="w-4 h-4 text-info" /> Fazendas
            <Badge variant="secondary" className="ml-1">{farms.length}</Badge>
          </CardTitle>
          <Button size="sm" className="gap-1 h-8" onClick={() => openFarmDlg(null)}>
            <Plus className="w-3.5 h-3.5" /> Nova fazenda
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {farms.length === 0 && (
            <p className="text-xs text-muted-foreground italic">Nenhuma fazenda cadastrada.</p>
          )}
          {farms.map(f => {
            const fSectors = sectorsByFarm(f.id);
            // Conta TODOS os equipamentos vinculados à fazenda — incluindo
            // os que estão "Sem setor" (vinculados direto à fazenda).
            const ids = new Set<string>();
            // 1) Equipamentos em setores desta fazenda
            for (const s of fSectors) for (const id of s.equipmentIds) ids.add(id);
            // 2) Vínculos diretos no mapa local (Sem setor)
            const directMap = loadEquipmentFarmMap();
            for (const [eqId, fId] of Object.entries(directMap)) {
              if (fId === f.id) ids.add(eqId);
            }
            // 3) Equipamentos da nuvem com farm_id == default_farm_id e SEM setor.
            //    Como a nuvem usa um único default_farm_id por usuário, atribuímos
            //    esses equipamentos à única fazenda local quando houver só uma;
            //    havendo várias, só somamos quando o id já estiver listado.
            const onlyOneFarm = farms.length === 1;
            for (const e of equipment) {
              if (
                e.cloudFarmId &&
                cloudFarmId &&
                e.cloudFarmId === cloudFarmId &&
                !e.cloudSectorId &&
                onlyOneFarm
              ) {
                ids.add(e.id);
              }
            }
            const equipCount = ids.size;
            const semSetorCount = equipCount - fSectors.reduce((acc, s) => acc + s.equipmentIds.length, 0);
            return (
              <div key={f.id} className="p-3 bg-secondary/40 rounded-lg border border-border">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground truncate">{f.nome}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {fSectors.length} setor(es) · {equipCount} equipamento(s)
                      {semSetorCount > 0 && (
                        <span className="text-warning"> · {semSetorCount} sem setor</span>
                      )}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openFarmDlg(f)}>
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => deleteFarm(f)}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
                {fSectors.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {fSectors.map(s => (
                      <Badge key={s.id} variant="outline" className="text-[10px] gap-1">
                        <Layers className="w-3 h-3" /> {s.nome}
                        <span className="text-muted-foreground">({s.equipmentIds.length})</span>
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader className="pb-3 flex-row items-center justify-between">
          <CardTitle className="text-sm text-foreground flex items-center gap-2">
            <Layers className="w-4 h-4 text-accent" /> Setores
            <Badge variant="secondary" className="ml-1">{sectors.length}</Badge>
          </CardTitle>
          <Button
            size="sm"
            className="gap-1 h-8"
            disabled={farms.length === 0}
            onClick={() => openSectorDlg(null)}
          >
            <Plus className="w-3.5 h-3.5" /> Novo setor
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {farms.length === 0 && (
            <p className="text-xs text-muted-foreground italic">Cadastre uma fazenda antes de criar setores.</p>
          )}
          {farms.length > 0 && sectors.length === 0 && (
            <p className="text-xs text-muted-foreground italic">Nenhum setor cadastrado.</p>
          )}
          {sectors.map(s => {
            const farm = farms.find(f => f.id === s.farmId);
            return (
              <div key={s.id} className="p-3 bg-secondary/40 rounded-lg border border-border">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground truncate">{s.nome}</p>
                    <p className="text-[10px] text-muted-foreground">
                      <MapPin className="w-2.5 h-2.5 inline mr-0.5" />
                      {farm?.nome ?? "—"} · {s.equipmentIds.length} equipamento(s)
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openSectorDlg(s)}>
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => deleteSector(s)}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
                {s.equipmentIds.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {s.equipmentIds.map(id => (
                      <Badge key={id} variant="outline" className="text-[10px]">
                        {equipName(id)}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm text-foreground flex items-center gap-2">
            <Server className="w-4 h-4 text-warning" /> Grupos por PLC
            <Badge variant="secondary" className="ml-1">{eligiblePlcs.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-[11px] text-muted-foreground">
            PLCs que controlam 2 ou mais bombas são detectadas automaticamente. Defina um nome amigável para o grupo.
          </p>
          {eligiblePlcs.length === 0 && (
            <p className="text-xs text-muted-foreground italic">
              Nenhuma PLC com múltiplas bombas no momento.
            </p>
          )}
          {eligiblePlcs.map(p => {
            const current = plcGroups.find(g => g.plcId === p.plcId)?.nome ?? "";
            return (
              <div key={p.plcId} className="p-3 bg-secondary/40 rounded-lg border border-border space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <CircuitBoard className="w-4 h-4 text-info shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-foreground truncate">
                        {p.plcNome} {p.plcHex && <span className="text-muted-foreground font-normal text-xs">· {p.plcHex}</span>}
                      </p>
                      <p className="text-[10px] text-muted-foreground">{p.count} bombas: {p.equipNames.join(", ")}</p>
                    </div>
                  </div>
                </div>
                <div>
                  <Label className="text-[11px] text-muted-foreground">Nome do grupo</Label>
                  <Input
                    placeholder='Ex.: "Rio 12 Bombas"'
                    defaultValue={current}
                    onBlur={(e) => setPlcGroupName(p.plcId, e.target.value)}
                    className="bg-background border-border h-8 mt-1"
                  />
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Dialog open={farmDlg} onOpenChange={setFarmDlg}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{farmEdit ? "Editar Fazenda" : "Nova Fazenda"}</DialogTitle>
            <DialogDescription>
              Defina o nome e selecione quais equipamentos pertencem a esta fazenda.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Nome da fazenda</Label>
              <Input
                value={farmName}
                onChange={(e) => setFarmName(e.target.value)}
                placeholder="Ex.: Fazenda Santa Maria"
                autoFocus
              />
            </div>
            <div>
              <Label>Equipamentos desta fazenda</Label>
              <p className="text-[10px] text-muted-foreground mb-1.5">
                Marque os equipamentos cadastrados que pertencem a esta fazenda. Opcionalmente, escolha o setor de cada um.
              </p>
              <div className="max-h-64 overflow-auto border border-border rounded-md bg-background/50 p-2 space-y-1">
                {equipment.length === 0 && (
                  <p className="text-xs text-muted-foreground italic px-1">Nenhum equipamento cadastrado.</p>
                )}
                {equipment.map(eq => {
                  const checked = eq.id in farmEquip;
                  // Onde o equipamento está hoje (em outra fazenda)?
                  const ownerSector = sectors.find(s => s.equipmentIds.includes(eq.id));
                  const ownerFarm = ownerSector ? farms.find(f => f.id === ownerSector.farmId) : null;
                  const inOtherFarm = ownerFarm && farmEdit && ownerFarm.id !== farmEdit.id;
                  // Setores da fazenda atual (sendo editada/criada)
                  const farmSectors = farmEdit ? sectors.filter(s => s.farmId === farmEdit.id) : [];
                  return (
                    <div
                      key={eq.id}
                      className="flex items-center gap-2 px-2 py-1 rounded hover:bg-secondary/60"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleFarmEquip(eq.id)}
                        className="accent-primary cursor-pointer"
                        id={`farmeq-${eq.id}`}
                      />
                      <label htmlFor={`farmeq-${eq.id}`} className="text-xs text-foreground flex-1 cursor-pointer truncate">
                        {eq.nome}
                      </label>
                      <Badge variant="outline" className="text-[9px] capitalize">{eq.tipo}</Badge>
                      {checked && farmSectors.length > 0 && (
                        <Select
                          value={farmEquip[eq.id] ?? NONE_SECTOR}
                          onValueChange={(v) => setFarmEquipSector(eq.id, v)}
                        >
                          <SelectTrigger className="h-7 w-32 text-[10px] bg-background">
                            <SelectValue placeholder="Setor" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE_SECTOR}>Sem setor</SelectItem>
                            {farmSectors.map(s => (
                              <SelectItem key={s.id} value={s.id}>{s.nome}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      {inOtherFarm && !checked && (
                        <span className="text-[9px] text-warning">em "{ownerFarm?.nome}"</span>
                      )}
                    </div>
                  );
                })}
              </div>
              {!farmEdit && (
                <p className="text-[10px] text-muted-foreground mt-1.5 italic">
                  Para escolher setores específicos, salve a fazenda primeiro e crie os setores.
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFarmDlg(false)}>Cancelar</Button>
            <Button onClick={saveFarm}>Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={sectorDlg} onOpenChange={setSectorDlg}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{sectorEdit ? "Editar Setor" : "Novo Setor"}</DialogTitle>
            <DialogDescription>Vincule equipamentos a um setor dentro de uma fazenda.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Nome do setor</Label>
              <Input
                value={sectorForm.nome}
                onChange={(e) => setSectorForm(s => ({ ...s, nome: e.target.value }))}
                placeholder="Ex.: Setor Norte"
                autoFocus
              />
            </div>
            <div>
              <Label>Fazenda</Label>
              <Select
                value={sectorForm.farmId}
                onValueChange={(v) => setSectorForm(s => ({ ...s, farmId: v }))}
              >
                <SelectTrigger className="bg-background"><SelectValue placeholder="Selecione" /></SelectTrigger>
                <SelectContent>
                  {farms.map(f => <SelectItem key={f.id} value={f.id}>{f.nome}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Equipamentos</Label>
              <p className="text-[10px] text-muted-foreground mb-1.5">
                Selecione bombas e/ou níveis. Um equipamento pertence a apenas um setor.
              </p>
              <div className="max-h-56 overflow-auto border border-border rounded-md bg-background/50 p-2 space-y-1">
                {equipment.length === 0 && (
                  <p className="text-xs text-muted-foreground italic px-1">Nenhum equipamento cadastrado.</p>
                )}
                {equipment.map(eq => {
                  const checked = sectorForm.equipmentIds.includes(eq.id);
                  const owner = sectors.find(s => s.equipmentIds.includes(eq.id) && s.id !== sectorEdit?.id);
                  return (
                    <label
                      key={eq.id}
                      className="flex items-center gap-2 px-2 py-1 rounded hover:bg-secondary/60 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleEquipInForm(eq.id)}
                        className="accent-primary"
                      />
                      <span className="text-xs text-foreground flex-1">{eq.nome}</span>
                      <Badge variant="outline" className="text-[9px] capitalize">{eq.tipo}</Badge>
                      {owner && (
                        <span className="text-[9px] text-warning">em "{owner.nome}"</span>
                      )}
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSectorDlg(false)}>Cancelar</Button>
            <Button onClick={saveSector}>Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
