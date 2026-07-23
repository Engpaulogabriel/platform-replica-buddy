// Sector / Farm data model — hierarchy: Fazenda → Setor → Equipamento
// IDs SÃO UUIDs nativos da nuvem. Os helpers `loadFarms` / `loadSectors` /
// `loadPlcGroups` continuam exportados para compatibilidade com
// `SectorsConfig` (legado) — mas agora retornam listas vazias se não houver
// localStorage. A fonte de verdade real do Dashboard é `useCadastrosCloud`.

export interface Farm {
  id: string;
  nome: string;
}

export interface Sector {
  id: string;
  farmId: string;
  nome: string;
  equipmentIds: string[]; // UUIDs de equipments
}

export interface PlcGroup {
  plcId: string; // UUID
  nome: string;
}

const FARMS_BASE = "farms_v1";
const SECTORS_BASE = "sectors_v1";
const PLC_GROUPS_BASE = "plc_groups_v1";
const EQUIP_FARM_BASE = "equipment_farm_v1"; // Record<equipId, farmId> para equipamentos vinculados direto à fazenda (sem setor)
const ACTIVE_SCOPE_KEY = "sectors_active_farm"; // farm_id da fazenda ativa para escopar dados de Configurações de Início

// Cada fazenda tem seu próprio conjunto de dados locais (Configurações de Início).
// As chaves são sufixadas por farmId; sem escopo, retornamos chaves vazias para
// não vazar dados entre fazendas.
function scope(): string | null {
  try { return localStorage.getItem(ACTIVE_SCOPE_KEY); } catch { return null; }
}
function k(base: string): string | null {
  const s = scope();
  return s ? `${base}:${s}` : null;
}

export function setSectorsScope(farmId: string | null) {
  try {
    if (farmId) {
      const prev = localStorage.getItem(ACTIVE_SCOPE_KEY);
      localStorage.setItem(ACTIVE_SCOPE_KEY, farmId);
      // Migração one-shot: na primeira vez que esta fazenda é escopada, se ela
      // ainda não tem dados próprios mas existem dados legados (globais), copia-os
      // para esta fazenda. Marca a migração para não copiar de novo (e não
      // contaminar outras fazendas).
      const migFlag = `sectors_migrated:${farmId}`;
      if (!localStorage.getItem(migFlag)) {
        for (const base of [FARMS_BASE, SECTORS_BASE, PLC_GROUPS_BASE, EQUIP_FARM_BASE]) {
          const legacy = localStorage.getItem(base);
          const target = `${base}:${farmId}`;
          if (legacy && !localStorage.getItem(target)) {
            localStorage.setItem(target, legacy);
          }
        }
        localStorage.setItem(migFlag, "1");
        // Remove dados legados globais para não vazarem em outras fazendas
        for (const base of [FARMS_BASE, SECTORS_BASE, PLC_GROUPS_BASE, EQUIP_FARM_BASE]) {
          localStorage.removeItem(base);
        }
      }
      if (prev !== farmId) window.dispatchEvent(new CustomEvent("sectors:updated", { detail: { scope: farmId } }));
    } else {
      localStorage.removeItem(ACTIVE_SCOPE_KEY);
      window.dispatchEvent(new CustomEvent("sectors:updated", { detail: { scope: null } }));
    }
  } catch { /* ignore */ }
}

export const UNASSIGNED_FARM_ID = "__unassigned__";
export const UNASSIGNED_SECTOR_ID = "__unassigned__";
export const NO_SECTOR_ID = "__no_sector__"; // Setor virtual "Sem setor" dentro de uma fazenda

function readJSON<T>(base: string, fallback: T): T {
  try {
    const key = k(base);
    if (!key) return fallback; // sem fazenda ativa → sem dados (não polui nem mistura fazendas)
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJSON<T>(base: string, value: T) {
  const key = k(base);
  if (!key) return; // sem fazenda ativa → não grava
  localStorage.setItem(key, JSON.stringify(value));
  window.dispatchEvent(new CustomEvent("sectors:updated", { detail: { key } }));
}

export const loadFarms = (): Farm[] => readJSON<Farm[]>(FARMS_BASE, []);
export const loadSectors = (): Sector[] => readJSON<Sector[]>(SECTORS_BASE, []);
export const loadPlcGroups = (): PlcGroup[] => readJSON<PlcGroup[]>(PLC_GROUPS_BASE, []);
export const loadEquipmentFarmMap = (): Record<string, string> =>
  readJSON<Record<string, string>>(EQUIP_FARM_BASE, {});

export const saveFarms = (v: Farm[]) => writeJSON(FARMS_BASE, v);
export const saveSectors = (v: Sector[]) => writeJSON(SECTORS_BASE, v);
export const savePlcGroups = (v: PlcGroup[]) => writeJSON(PLC_GROUPS_BASE, v);
export const saveEquipmentFarmMap = (v: Record<string, string>) => writeJSON(EQUIP_FARM_BASE, v);

export function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// Find sector containing a given equipment id (UUID)
export function findSectorForEquipment(equipId: string, sectors: Sector[]): Sector | undefined {
  return sectors.find((s) => s.equipmentIds.includes(equipId));
}

export interface FarmGroup {
  farm: Farm | { id: string; nome: string };
  sectors: { sector: Sector | { id: string; nome: string; farmId: string; equipmentIds: string[] }; equipmentIds: string[] }[];
}

export function groupEquipmentByFarm(
  equipmentIds: string[],
  farms: Farm[],
  sectors: Sector[],
  fallbackFarm?: { id: string; nome: string },
  equipmentFarmMap?: Record<string, string>
): FarmGroup[] {
  const buckets = new Map<string, FarmGroup>();
  const directMap = equipmentFarmMap ?? loadEquipmentFarmMap();

  const fallbackId = fallbackFarm?.id ?? UNASSIGNED_FARM_ID;
  const fallbackNome = fallbackFarm?.nome ?? "Sem fazenda";

  const ensureFarm = (farmId: string, nome: string): FarmGroup => {
    let b = buckets.get(farmId);
    if (!b) {
      b = { farm: { id: farmId, nome }, sectors: [] };
      buckets.set(farmId, b);
    }
    return b;
  };

  const ensureSector = (
    farmBucket: FarmGroup,
    sectorId: string,
    sectorNome: string,
    farmId: string
  ) => {
    let s = farmBucket.sectors.find((x) => x.sector.id === sectorId);
    if (!s) {
      s = {
        sector: { id: sectorId, nome: sectorNome, farmId, equipmentIds: [] },
        equipmentIds: [],
      };
      farmBucket.sectors.push(s);
    }
    return s;
  };

  for (const eqId of equipmentIds) {
    const sector = findSectorForEquipment(eqId, sectors);
    if (sector) {
      const farm = farms.find((f) => f.id === sector.farmId);
      const farmBucket = ensureFarm(
        farm?.id ?? fallbackId,
        farm?.nome ?? fallbackNome
      );
      const sectorBucket = ensureSector(farmBucket, sector.id, sector.nome, farmBucket.farm.id);
      sectorBucket.equipmentIds.push(eqId);
      continue;
    }
    // Sem setor, mas pode estar vinculado direto a uma fazenda
    const directFarmId = directMap[eqId];
    const directFarm = directFarmId ? farms.find((f) => f.id === directFarmId) : undefined;
    if (directFarm) {
      const farmBucket = ensureFarm(directFarm.id, directFarm.nome);
      const sectorBucket = ensureSector(farmBucket, NO_SECTOR_ID, "Sem setor", directFarm.id);
      sectorBucket.equipmentIds.push(eqId);
    } else {
      const farmBucket = ensureFarm(fallbackId, fallbackNome);
      const sectorBucket = ensureSector(
        farmBucket,
        UNASSIGNED_SECTOR_ID,
        "Sem setor",
        fallbackId
      );
      sectorBucket.equipmentIds.push(eqId);
    }
  }

  return Array.from(buckets.values());
}
