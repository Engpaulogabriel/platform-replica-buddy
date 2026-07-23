// ─────────────────────────────────────────────────────────────────────────────
// Cadastros na nuvem — sincronização bidirecional + migração automática
// ─────────────────────────────────────────────────────────────────────────────
// Esta lib NÃO substitui a tela `Cadastros.tsx` ainda. Foi desenhada para:
//   1) Migrar automaticamente PLCs / Setores / Equipamentos do localStorage
//      para as tabelas plc_groups / sectors / equipments na primeira vez que
//      um owner/admin loga e a fazenda está vazia na nuvem.
//   2) Manter um `cloud_id_map_v1` em localStorage para o Dashboard
//      continuar usando IDs numéricos curtos no estado React, traduzindo
//      para UUIDs ao falar com a nuvem.
//   3) Backup das chaves locais em `*_backup_v1` por 30 dias.
//   4) Rollback total em caso de falha (deleta o que entrou na nuvem,
//      restaura backup local).
//
// Regras de hw_id:
//   - hw_id de equipamento = `<plcHex><saida 2 dígitos>`. Ex: PLC "2101"
//     saída 3 → "210103". Único por (farm_id, hw_id) no banco.
//
// Próxima fase: refatorar `Cadastros.tsx` para ler/escrever direto na nuvem.

import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

// ───────── Tipos locais (formato no localStorage hoje) ─────────
interface LocalPlc {
  plcId: number;     // numérico curto, usado pelo dashboard
  nome: string;
  idHex?: string;    // alguns registros têm idHex separado, outros usam o nome
}

interface LocalSector {
  id: string;        // ex: "sec_abc123"
  farmId: string;    // farm local, NÃO migra (tudo vai para o farm padrão da nuvem)
  nome: string;
  equipmentIds: number[];
}

type EquipTipo = "poco" | "bombeamento" | "nivel";

interface LocalEquipamento {
  id: number;
  tipo: EquipTipo;
  nome: string;
  plcId: number;
  saida: number;        // 1-6
  latitude?: string;
  longitude?: string;
  horasPico?: string;
  maxHorasDia?: string;
  demandaKw?: string;
  alturaMax?: string;
  alarmeBaixo?: string;
  alarmeAlto?: string;
  fonteTipo?: "rio" | "canal" | "piscina" | "poco" | "reservatorio";
  alimentaId?: number;
}

// ───────── Tipos da nuvem ─────────
type EquipType = Database["public"]["Enums"]["equipment_type"];

// ───────── Chaves localStorage ─────────
const KEY_PLCS    = "plc_groups_v1";
const KEY_SECTORS = "sectors_v1";
const KEY_EQUIPS  = "registered_equipment";
const KEY_BACKUP_META = "cadastros_backup_meta";
const KEY_ID_MAP  = "cloud_id_map_v1";
const KEY_MIGRATING = "cadastros_migrating";

// ───────── Helpers ─────────
const readJSON = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

/** hw_id de equipamento: `<plcHex><saidaDoisDigitos>`. Ex: 2101 + 3 → "210103". Para nível (saida=null) → "210100". */
export const buildEquipHwId = (plcHex: string, saida: number | null): string =>
  `${plcHex}${String(saida ?? 0).padStart(2, "0")}`;

/** hw_id do PLC: usa idHex se presente, senão deriva do nome (PLC-001 → "0001"). */
const plcHwIdFromLocal = (p: LocalPlc): string => {
  if (p.idHex && /^[0-9A-Fa-f]+$/.test(p.idHex)) return p.idHex.toUpperCase();
  // fallback: extrai dígitos do nome e zera-pad para 4 chars
  const digits = (p.nome.match(/\d+/)?.[0] ?? String(p.plcId));
  return digits.padStart(4, "0").toUpperCase();
};

const tipoToEnum = (t: EquipTipo): EquipType => {
  if (t === "poco") return "poco";
  if (t === "nivel") return "nivel";
  return "bombeamento";
};

const num = (s?: string): number | null => {
  if (!s) return null;
  const v = parseFloat(s.replace(",", "."));
  return Number.isFinite(v) ? v : null;
};

// ───────── ID Map persistido ─────────
export interface CloudIdMap {
  plcs: Record<number, string>;     // plcId local → uuid plc_groups
  sectors: Record<string, string>;  // sector.id local → uuid sectors
  equips: Record<number, string>;   // equip.id local → uuid equipments
  farmId: string;                   // farm padrão usada na migração
  migratedAt: string;               // ISO
}

export const loadCloudIdMap = (): CloudIdMap | null =>
  readJSON<CloudIdMap | null>(KEY_ID_MAP, null);

const saveCloudIdMap = (m: CloudIdMap) => {
  localStorage.setItem(KEY_ID_MAP, JSON.stringify(m));
};

// ───────── Backup local com TTL 30 dias ─────────
interface BackupMeta {
  createdAt: string;   // ISO
  ttlDays: number;
  keys: string[];      // chaves de origem que viraram *_backup_v1
}

const backupLocal = () => {
  const moved: string[] = [];
  for (const k of [KEY_PLCS, KEY_SECTORS, KEY_EQUIPS]) {
    const v = localStorage.getItem(k);
    if (v != null) {
      localStorage.setItem(`${k}_backup_v1`, v);
      localStorage.removeItem(k);
      moved.push(k);
    }
  }
  if (moved.length) {
    const meta: BackupMeta = { createdAt: new Date().toISOString(), ttlDays: 30, keys: moved };
    localStorage.setItem(KEY_BACKUP_META, JSON.stringify(meta));
  }
};

const restoreFromBackup = () => {
  for (const k of [KEY_PLCS, KEY_SECTORS, KEY_EQUIPS]) {
    const v = localStorage.getItem(`${k}_backup_v1`);
    if (v != null) {
      localStorage.setItem(k, v);
      localStorage.removeItem(`${k}_backup_v1`);
    }
  }
  localStorage.removeItem(KEY_BACKUP_META);
};

/** Limpa backups expirados (>30 dias). Chame no boot. */
export const purgeExpiredBackups = () => {
  const meta = readJSON<BackupMeta | null>(KEY_BACKUP_META, null);
  if (!meta) return;
  const age = (Date.now() - new Date(meta.createdAt).getTime()) / 86_400_000;
  if (age >= meta.ttlDays) {
    for (const k of meta.keys) localStorage.removeItem(`${k}_backup_v1`);
    localStorage.removeItem(KEY_BACKUP_META);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Migração automática
// ─────────────────────────────────────────────────────────────────────────────
export type MigrationResult =
  | { status: "skipped"; reason: string }
  | { status: "migrated"; counts: { plcs: number; sectors: number; equips: number } }
  | { status: "rolled_back"; error: string };

export async function migrateLocalCadastrosToCloud(): Promise<MigrationResult> {
  // 1) Anti-concorrência (mesma aba ou recarregamento durante migração)
  if (sessionStorage.getItem(KEY_MIGRATING) === "1") {
    return { status: "skipped", reason: "already_running" };
  }
  // 2) Já migrou?
  if (loadCloudIdMap()) {
    return { status: "skipped", reason: "already_migrated" };
  }

  // 3) Sessão / contexto
  const { data: sessionData } = await supabase.auth.getSession();
  const user = sessionData.session?.user;
  if (!user) return { status: "skipped", reason: "not_authenticated" };

  const { data: profile } = await supabase
    .from("profiles")
    .select("default_farm_id")
    .eq("id", user.id)
    .maybeSingle();
  const farmId = profile?.default_farm_id;
  if (!farmId) return { status: "skipped", reason: "no_default_farm" };

  // 4) Permissão: owner ou admin
  const { data: roleRow } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .eq("farm_id", farmId)
    .maybeSingle();
  if (!roleRow || (roleRow.role !== "owner" && roleRow.role !== "admin")) {
    return { status: "skipped", reason: "not_admin" };
  }

  // 5) Nuvem precisa estar vazia
  const [eqHead, plcHead, secHead] = await Promise.all([
    supabase.from("equipments").select("id", { count: "exact", head: true }).eq("farm_id", farmId),
    supabase.from("plc_groups").select("id", { count: "exact", head: true }).eq("farm_id", farmId),
    supabase.from("sectors").select("id", { count: "exact", head: true }).eq("farm_id", farmId),
  ]);
  const cloudEmpty = (eqHead.count ?? 0) === 0 && (plcHead.count ?? 0) === 0 && (secHead.count ?? 0) === 0;
  if (!cloudEmpty) return { status: "skipped", reason: "cloud_not_empty" };

  // 6) Local precisa ter dados
  const localPlcs    = readJSON<LocalPlc[]>(KEY_PLCS, []);
  const localSectors = readJSON<LocalSector[]>(KEY_SECTORS, []);
  const localEquips  = readJSON<LocalEquipamento[]>(KEY_EQUIPS, []);
  if (!localPlcs.length && !localSectors.length && !localEquips.length) {
    return { status: "skipped", reason: "local_empty" };
  }

  sessionStorage.setItem(KEY_MIGRATING, "1");
  const insertedPlcIds: string[] = [];
  const insertedSectorIds: string[] = [];
  const insertedEquipIds: string[] = [];

  try {
    // ───── 1) PLCs ─────
    const plcMap: Record<number, string> = {};
    for (const p of localPlcs) {
      const hw = plcHwIdFromLocal(p);
      const { data, error } = await supabase
        .from("plc_groups")
        .insert({ farm_id: farmId, name: p.nome, hw_id: hw })
        .select("id")
        .single();
      if (error) throw new Error(`plc "${p.nome}": ${error.message}`);
      plcMap[p.plcId] = data.id;
      insertedPlcIds.push(data.id);
    }

    // ───── 2) Setores ─────
    const sectorMap: Record<string, string> = {};
    for (const s of localSectors) {
      const { data, error } = await supabase
        .from("sectors")
        .insert({ farm_id: farmId, name: s.nome })
        .select("id")
        .single();
      if (error) throw new Error(`sector "${s.nome}": ${error.message}`);
      sectorMap[s.id] = data.id;
      insertedSectorIds.push(data.id);
    }

    // índice equipId local → sectorId local (para resolver sector_id)
    const equipToSector = new Map<number, string>();
    for (const s of localSectors) for (const eId of s.equipmentIds) equipToSector.set(eId, s.id);

    // ───── 3) Equipamentos ─────
    const equipMap: Record<number, string> = {};
    for (const e of localEquips) {
      const plcUuid = plcMap[e.plcId] ?? null;
      const plcHex = localPlcs.find((p) => p.plcId === e.plcId)
        ? plcHwIdFromLocal(localPlcs.find((p) => p.plcId === e.plcId)!)
        : String(e.plcId).padStart(4, "0").toUpperCase();
      const hw = buildEquipHwId(plcHex, e.saida);
      const sectorLocal = equipToSector.get(e.id);
      const sectorUuid = sectorLocal ? sectorMap[sectorLocal] ?? null : null;

      const { data, error } = await supabase
        .from("equipments")
        .insert({
          farm_id: farmId,
          name: e.nome,
          type: tipoToEnum(e.tipo),
          hw_id: hw,
          saida: e.saida,
          latitude: num(e.latitude),
          longitude: num(e.longitude),
          horas_pico: e.horasPico ?? null,
          max_horas_dia: num(e.maxHorasDia),
          demanda_kw: num(e.demandaKw),
          max_height: num(e.alturaMax),
          alarm_low: num(e.alarmeBaixo),
          alarm_high: num(e.alarmeAlto),
          fonte_tipo: e.fonteTipo ?? null,
          plc_group_id: plcUuid,
          sector_id: sectorUuid,
          active: true,
        })
        .select("id")
        .single();
      if (error) throw new Error(`equip "${e.nome}": ${error.message}`);
      equipMap[e.id] = data.id;
      insertedEquipIds.push(data.id);
    }

    // ───── 4) 2ª passada: alimenta_id ─────
    for (const e of localEquips) {
      if (!e.alimentaId) continue;
      const target = equipMap[e.alimentaId];
      if (!target) continue;
      const { error } = await supabase
        .from("equipments")
        .update({ alimenta_id: target })
        .eq("id", equipMap[e.id]);
      if (error) throw new Error(`alimenta "${e.nome}": ${error.message}`);
    }

    // ───── 5) Persistir idMap + backup local ─────
    const idMap: CloudIdMap = {
      plcs: plcMap,
      sectors: sectorMap,
      equips: equipMap,
      farmId,
      migratedAt: new Date().toISOString(),
    };
    saveCloudIdMap(idMap);
    backupLocal();

    sessionStorage.removeItem(KEY_MIGRATING);
    return {
      status: "migrated",
      counts: {
        plcs: insertedPlcIds.length,
        sectors: insertedSectorIds.length,
        equips: insertedEquipIds.length,
      },
    };
  } catch (err) {
    // ───── ROLLBACK ─────
    const errMsg = err instanceof Error ? err.message : String(err);
    try {
      // Ordem reversa por causa das FKs
      if (insertedEquipIds.length) {
        await supabase.from("equipments").delete().in("id", insertedEquipIds);
      }
      if (insertedSectorIds.length) {
        await supabase.from("sectors").delete().in("id", insertedSectorIds);
      }
      if (insertedPlcIds.length) {
        await supabase.from("plc_groups").delete().in("id", insertedPlcIds);
      }
    } catch {
      // best-effort: se rollback falhar, ainda assim sinalizamos erro
    }
    // restaura backup local se chegou a fazer
    restoreFromBackup();
    sessionStorage.removeItem(KEY_MIGRATING);
    return { status: "rolled_back", error: errMsg };
  }
}
