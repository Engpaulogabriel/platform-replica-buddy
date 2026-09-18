// ─────────────────────────────────────────────────────────────────────────────
// Leituras operacionais — roteamento por fazenda
// ─────────────────────────────────────────────────────────────────────────────
// Uma leitura no backend errado não gera erro: a tela apenas mostra o retrato
// congelado no cutover. Relatório, indicador, horímetro, outorga, automação —
// tudo pareceria funcionar. Por isso a trava principal aqui é uma VARREDURA do
// código-fonte inteiro, não uma lista de arquivos que alguém precise lembrar de
// atualizar.
//
// Sem I/O: varredura estrutural + roteamento puro.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const PEROLA = "1014a8ab-b02a-47c7-90fc-1646d52a991e";
const SOSSEGO = "3e45b5ac-856e-4d29-b3b8-4dd71f86140d";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { __id: "OLD", channel: () => ({ __id: "OLD_CHANNEL" }), removeChannel: async () => "ok" },
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ __id: "NEW" }) }));

import {
  getSupabaseForFarm,
  tryGetSupabaseForFarm,
  assertOperationalClient,
  setNewBackendAuthReady,
} from "@/lib/supabaseRouter";
import { MIGRATED_FARMS } from "@/lib/migrationRegistry";

const idOf = (c: unknown) => (c as { __id: string }).__id;
const src = (p: string) => readFileSync(p, "utf8");

/** Dados que descrevem o estado/operação de UMA fazenda. */
const OPER_TABLES = [
  "equipments", "commands", "agent_commands", "site_health", "plc_groups", "sectors",
  "agent_logs", "automation_log", "automation_execution_log", "automation_schedules",
  "automation_engine", "automation_holiday_configs", "automation_guards", "automations",
  "automation_audit_log", "scheduled_automations", "service_mode_locks", "agent_update_status",
  "agent_config", "agent_hardware", "agent_hardware_history", "device_licenses",
  "peak_hour_config", "farm_productivity_config", "farm_inema_config", "rf_routing",
  "daily_consumption", "level_history", "flow_history", "farm_timing_config",
  "maintenance_orders", "agent_technical_events", "tampering_events",
  "water_permits", "water_permit_wells", "farm_messages",
];
const OPER_RPC = [
  "apply_pump_telemetry", "enqueue_polling_for_due_equipments", "mark_commands_timeout",
  "platform_send_agent_reboot", "platform_clear_pending_commands", "reset_agent_hardware",
  "clear_agent_update", "set_switching_protection", "request_agent_update",
  "enqueue_remote_command", "platform_unbind_device", "farm_backup_create",
  "farm_messages_active", "farm_messages_dismiss", "get_command_result",
  "get_horimetro_daily", "get_horimetro_month_total",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !/\.test\.|\/test\//.test(p)) out.push(p);
  }
  return out;
}

type Leak = { file: string; kind: "READ" | "WRITE"; resource: string };

/**
 * Acessos operacionais farm-scoped ainda feitos pelo singleton ANTIGO.
 *
 * Exceção deliberada: arquivos que montam um INVENTÁRIO GLOBAL da plataforma
 * (todas as fazendas) e, no mesmo lugar, filtram as migradas e as releem no
 * backend delas — o padrão base-global + overlay. Esses precisam mesmo consultar
 * o antigo: é lá que vivem as 9 fazendas não migradas.
 */
function operationalLeaks(): Leak[] {
  const leaks: Leak[] = [];
  for (const file of walk("src")) {
    const code = src(file);
    if (!code.includes('from "@/integrations/supabase/client"')) continue;
    const hasOverlay = code.includes("MIGRATED_FARMS") && code.includes("isFarmMigrated");

    for (const t of OPER_TABLES) {
      const re = new RegExp(`\\bsupabase\\s*\\n?\\s*\\.from\\(\\s*["\`]${t}["\`][^)]*\\)([\\s\\S]{0,500})`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(code))) {
        const isWrite = /\.(insert|update|upsert|delete)\s*\(/.test(m[1]);
        if (!isWrite && hasOverlay) continue; // base global com overlay explícito
        leaks.push({ file, kind: isWrite ? "WRITE" : "READ", resource: t });
      }
    }
    for (const r of OPER_RPC) {
      if (new RegExp(`\\bsupabase\\s*\\n?\\s*\\.rpc\\(\\s*["\`]${r}["\`]`).test(code)) {
        leaks.push({ file, kind: "READ", resource: `rpc:${r}` });
      }
    }
  }
  return leaks;
}

beforeEach(() => setNewBackendAuthReady(true));

// ── 1, 3, 4 — a trava que importa ───────────────────────────────────────────
describe("varredura de src/", () => {
  it("nenhuma LEITURA operacional farm-scoped usa o singleton antigo", () => {
    expect(operationalLeaks().filter((l) => l.kind === "READ")).toEqual([]);
  });

  it("e nenhuma ESCRITA voltou a vazar (invariante do lote anterior)", () => {
    expect(operationalLeaks().filter((l) => l.kind === "WRITE")).toEqual([]);
  });
});

// ── 2 — o roteamento efetivo ────────────────────────────────────────────────
describe("destino por fazenda", () => {
  it("Pérola → NEW; demais → OLD", () => {
    expect(idOf(getSupabaseForFarm(PEROLA))).toBe("NEW");
    expect(idOf(getSupabaseForFarm(SOSSEGO))).toBe("OLD");
    const p = tryGetSupabaseForFarm(PEROLA);
    const s = tryGetSupabaseForFarm(SOSSEGO);
    expect(p.client && idOf(p.client)).toBe("NEW");
    expect(s.client && idOf(s.client)).toBe("OLD");
  });

  it("leitura da Pérola nunca cai silenciosamente no antigo", () => {
    const r = tryGetSupabaseForFarm(PEROLA);
    expect(r.client === null || idOf(r.client) === "NEW").toBe(true);
  });
});

// ── 5 — farmId implícito resolvido com segurança ────────────────────────────
describe("farmId implícito", () => {
  it("telemetria de nível por equipment_id usa a fazenda ativa, não o ID solto", () => {
    for (const f of ["src/hooks/useLevelHistory.ts", "src/hooks/useReservoirDrainEta.ts"]) {
      expect(src(f)).toMatch(/const farmId = useDefaultFarmId\(\);/);
      expect(src(f)).toMatch(/getSupabaseForFarm\(farmId\)\s*\n?\s*\.from\("level_history"\)/);
    }
    const RG = src("src/components/dashboard/ReservoirGauges.tsx");
    expect(RG).toMatch(/const farmId = useDefaultFarmId\(\);/);
    expect(RG).toMatch(/getSupabaseForFarm\(farmId\)\s*\n?\s*\.from\("level_history"\)/);
  });

  it("calibração de nível roteia pela fazenda do próprio equipamento", () => {
    expect(src("src/components/LevelCalibrationCard.tsx"))
      .toMatch(/assertOperationalClient\(equip\.farm_id\)/);
  });

  it("comando de configuração roteia pelo farm_id do próprio row", () => {
    expect(src("src/lib/cfgQueue.ts"))
      .toMatch(/assertOperationalClient\(row\.farm_id as string\)/);
  });
});

// ── 6, 7, 8, 9 — pipelines completos no mesmo backend ───────────────────────
describe("pipelines completos", () => {
  it("comando: SELECT, reserva, timeout e telemetria no mesmo backend da escrita", () => {
    const W = src("src/lib/commandWorker.ts");
    expect(W).toMatch(/async function fetchNextPending\(db: RenovSupabase, farmId: string\)/);
    expect(W).toMatch(/const cmd = await fetchNextPending\(db, activeFarmId\);/);
    expect(W).toMatch(/updateCommandWithRetry\(cmd\.db, cmd\.id/);
    expect(W).toMatch(/assertOperationalClient\(farmId\)\.rpc\("apply_pump_telemetry"/);
  });

  it("automação: leitura e escrita seguem a mesma fazenda", () => {
    const A = src("src/hooks/useCloudAutomation.ts");
    for (const t of ["automation_schedules", "automation_holiday_configs", "automation_engine"]) {
      expect(A).toMatch(new RegExp(`getSupabaseForFarm\\(farmId\\)\\s*\\n?\\s*\\.from\\("${t}"\\)`));
    }
    expect(A).toMatch(/assertOperationalClient\(farmId\)\s*\n?\s*\.from\("automation_engine"\)/);
    expect(src("src/lib/automationLog.ts")).toMatch(/getSupabaseForFarm\(ctx\.farmId\)/);
  });

  it("Agent/OTA: estado operacional da fazenda migrada vem do backend dela", () => {
    const U = src("src/components/platform/AgentUpdateStatusPanel.tsx");
    expect(U).toMatch(/routed\.client\.from\("agent_update_status"\)\.select\("\*"\)\.eq\("farm_id", fid\)/);
    expect(U).toMatch(/assertOperationalClient\(farmId\)\.rpc\("clear_agent_update"/);
    const H = src("src/components/HardwareSecurityPanel.tsx");
    expect(H).toMatch(/routed\.client\.from\("agent_hardware"\)/);
    expect(H).toMatch(/assertOperationalClient\(farmId\)\.rpc\("reset_agent_hardware"/);
  });
});

// ── 10 — farm_messages não pode ficar partido ───────────────────────────────
describe("farm_messages — par completo", () => {
  const F = src("src/components/FarmMessagesBanner.tsx");

  it("READ e DISMISS resolvem o MESMO backend da fazenda", () => {
    expect(F).toMatch(/tryGetSupabaseForFarm\(farmId\)/);
    expect(F).toMatch(/routed\.client\.rpc\("farm_messages_active"/);
    expect(F).toMatch(/assertOperationalClient\(farmId\)\.rpc\("farm_messages_dismiss"/);
  });

  it("nenhum dos dois usa o singleton antigo", () => {
    expect(F).not.toMatch(/supabase\.rpc\("farm_messages_active"/);
    expect(F).not.toMatch(/supabase\.rpc\("farm_messages_dismiss"/);
  });

  it("o canal Realtime foi corrigido junto — era inseparável do par", () => {
    expect(F).toMatch(/isRealtimeAvailableForFarm\(farmId\) \? null : supabase/);
  });

  it("indisponível não vira mensagem velha do antigo", () => {
    expect(F).toMatch(/if \(!routed\.client\) \{ setMsgs\(\[\]\); return; \}/);
  });
});

// ── 11 — o que deve permanecer no antigo ────────────────────────────────────
describe("GLOBAL / CADASTRAL / IDENTIDADE seguem no backend antigo", () => {
  it("catálogo de releases, inventário da plataforma e identidade", () => {
    expect(src("src/components/platform/PlatformUpdates.tsx")).toMatch(/supabase\.from\("agent_releases"\)/);
    expect(src("src/pages/PlatformAdmin.tsx")).toMatch(/supabase\.rpc\("platform_farms_overview"/);
    expect(src("src/hooks/useUserFarms.ts")).toMatch(/supabase\s*\n?\s*\.from\("user_roles"\)/);
    expect(src("src/hooks/usePlatformAccess.ts")).toMatch(/supabase\s*\n?\s*\.from\("profiles" as any\)/);
  });
});

// ── 12 — invariante da migração ─────────────────────────────────────────────
describe("invariantes", () => {
  it("MIGRATED_FARMS continua contendo somente a Pérola", () => {
    expect([...MIGRATED_FARMS]).toEqual([PEROLA]);
  });

  it("escrita e leitura da mesma fazenda coincidem", () => {
    expect(idOf(assertOperationalClient(PEROLA))).toBe(idOf(getSupabaseForFarm(PEROLA)));
    expect(idOf(assertOperationalClient(SOSSEGO))).toBe(idOf(getSupabaseForFarm(SOSSEGO)));
  });
});
