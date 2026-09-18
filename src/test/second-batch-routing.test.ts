// ─────────────────────────────────────────────────────────────────────────────
// Segundo lote — eliminação dos leaks operacionais por fazenda
// ─────────────────────────────────────────────────────────────────────────────
// Seis componentes liam (e alguns ESCREVIAM) dados operacionais da fazenda no
// backend antigo. Para a Pérola isso significa relatório congelado no cutover e,
// pior, comando físico enfileirado num servidor que o Agent dela não escuta.
// Sem I/O: garantias estruturais + roteamento puro.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";

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
  BackendRoutingError,
} from "@/lib/supabaseRouter";

const src = (p: string) => readFileSync(p, "utf8");
const PEAK = src("src/components/PeakHourBanner.tsx");
const DEMANDA_PAGE = src("src/pages/DemandaEnergia.tsx");
const DEMANDA_CMP = src("src/components/energy/DemandaEnergia.tsx");
const COMMREPORT = src("src/components/CommunicationReport.tsx");
const AGENT_ACTIVITY = src("src/hooks/useAgentActivity.ts");
const SERVICE_MODE = src("src/components/platform/PlatformServiceMode.tsx");
const UPDATES = src("src/components/platform/PlatformUpdates.tsx");

const idOf = (c: unknown) => (c as { __id: string }).__id;

/** Nenhum `supabase.from(...)` das tabelas operacionais pode restar no arquivo. */
const OPERACIONAIS = [
  "equipments", "commands", "site_health", "plc_groups", "agent_logs",
  "automation_log", "service_mode_locks", "agent_update_status",
];
function leaksOperacionais(code: string): string[] {
  return OPERACIONAIS.filter((t) =>
    new RegExp(`\\bsupabase\\s*\\n?\\s*\\.from\\(\\s*["\`]${t}["\`]`).test(code));
}

beforeEach(() => setNewBackendAuthReady(true));

describe("PeakHourBanner", () => {
  it("equipments da Pérola não vem do singleton antigo", () => {
    expect(leaksOperacionais(PEAK)).toEqual([]);
    expect(PEAK).toMatch(/const routed = tryGetSupabaseForFarm\(farmId\);/);
    expect(PEAK).toMatch(/if \(!routed\.client\) \{ setEquipments\(\[\]\); return; \}/);
  });
  it("não assina Realtime do antigo para fazenda migrada; atualiza por relógio", () => {
    expect(PEAK).toMatch(/if \(!isRealtimeAvailableForFarm\(farmId\)\)/);
    expect(PEAK).toMatch(/const MIGRATED_REFRESH_MS = 30_000;/);
  });
  it("threshold funcional preservado", () => {
    expect(PEAK).toMatch(/const ONLINE_WINDOW_MS = 60_000;/);
  });
});

describe("DemandaEnergia (tela roteada em /demanda-energia)", () => {
  it("equipments da Pérola → backend da fazenda", () => {
    expect(leaksOperacionais(DEMANDA_PAGE)).toEqual([]);
    expect(DEMANDA_PAGE).toMatch(/const routed = tryGetSupabaseForFarm\(farmId\);/);
    expect(DEMANDA_PAGE).toMatch(/db\s*\n?\s*\.from\("equipments"\)/);
  });
  it("corte de carga é escrita operacional FAIL-CLOSED", () => {
    expect(DEMANDA_PAGE).toMatch(/await assertOperationalClient\(farmId\)\.from\("commands"\)\.insert/);
    expect(() => {
      setNewBackendAuthReady(false);
      assertOperationalClient(PEROLA);
    }).toThrow(BackendRoutingError);
    setNewBackendAuthReady(true);
  });
  it("a cópia em components/energy recebeu o mesmo tratamento", () => {
    expect(leaksOperacionais(DEMANDA_CMP)).toEqual([]);
    expect(DEMANDA_CMP).toMatch(/assertOperationalClient\(farmId\)\.from\("commands"\)/);
  });
  it("regra de energia/ponta intocada", () => {
    expect(DEMANDA_PAGE).toMatch(/const ONLINE_WINDOW_MS = 60_000;/);
    expect(DEMANDA_PAGE).toMatch(/ANEEL_TOLERANCE = 1\.10/);
  });
});

describe("CommunicationReport", () => {
  it("automation_log e equipments vêm do MESMO cliente da fazenda", () => {
    expect(leaksOperacionais(COMMREPORT)).toEqual([]);
    expect(COMMREPORT).toMatch(/const routed = tryGetSupabaseForFarm\(farmId\);/);
    expect(COMMREPORT).toMatch(/db\s*\n?\s*\.from\("automation_log"\)/);
    expect(COMMREPORT).toMatch(/db\s*\n?\s*\.from\("equipments"\)/);
  });
  it("não importa mais o singleton", () => {
    expect(COMMREPORT).not.toMatch(/from "@\/integrations\/supabase\/client"/);
  });
});

describe("useAgentActivity", () => {
  it("agent_logs e commands seguem a fazenda", () => {
    expect(leaksOperacionais(AGENT_ACTIVITY)).toEqual([]);
    expect(AGENT_ACTIVITY).toMatch(/const routed = tryGetSupabaseForFarm\(farmId\);/);
    expect(AGENT_ACTIVITY).toMatch(/db\s*\n?\s*\.from\("agent_logs"\)/);
    expect((AGENT_ACTIVITY.match(/db\s*\n?\s*\.from\("commands"\)/g) ?? []).length).toBe(2);
  });
  it("não assina canal do antigo para fazenda migrada", () => {
    expect(AGENT_ACTIVITY).toMatch(/const canSubscribe = isRealtimeAvailableForFarm\(farmId\);/);
    expect(AGENT_ACTIVITY).toMatch(/!canSubscribe \? null : supabase/);
  });
  it("thresholds preservados", () => {
    expect(AGENT_ACTIVITY).toMatch(/const ACTIVITY_WINDOW_MS = 120_000;/);
    expect(AGENT_ACTIVITY).toMatch(/const TICK_MS = 30_000;/);
  });
});

describe("PlatformServiceMode", () => {
  it("equipments da fazenda selecionada vêm do backend dela", () => {
    expect(leaksOperacionais(SERVICE_MODE)).toEqual([]);
    expect(SERVICE_MODE).toMatch(/routed\.client\.from\("equipments"\)/);
  });
  it("frame serial e lock são escritas FAIL-CLOSED", () => {
    expect(SERVICE_MODE).toMatch(/const db = assertOperationalClient\(farmId\);\s*\n\s*const \{ data, error \} = await db\.from\("commands"\)\.insert/);
    expect(SERVICE_MODE).toMatch(/assertOperationalClient\(farmId\)\.from\("service_mode_locks"\)\.upsert/);
    expect(SERVICE_MODE).toMatch(/assertOperationalClient\(farmId\)\.from\("service_mode_locks"\)\.delete/);
  });
  it("o acompanhamento lê no MESMO backend em que o comando foi criado", () => {
    expect(SERVICE_MODE).toMatch(/equipName: eq\.name, farmId \}/);
    expect(SERVICE_MODE).toMatch(/tryGetSupabaseForFarm\(activeTest\.farmId\)/);
    expect(SERVICE_MODE).toMatch(/trackDb\.rpc\("get_command_result"/);
  });
  it("a lista GLOBAL de fazendas continua no antigo", () => {
    expect(SERVICE_MODE).toMatch(/supabase\.from\("farms"\)/);
  });
});

describe("PlatformUpdates", () => {
  it("catálogo global de releases continua no antigo", () => {
    expect(UPDATES).toMatch(/supabase\.from\("agent_releases"\)/);
    expect(UPDATES).toMatch(/\.from\(\s*\n?\s*"farms"\s*\n?\s*\)|from\("farms"\)/);
  });
  it("site_health da fazenda migrada vem do backend dela, sem fallback", () => {
    expect(UPDATES).toMatch(/\.filter\(\(f\) => isFarmMigrated\(f\.id\)\)/);
    expect(UPDATES).toMatch(/routed\.client\s*\n?\s*\.from\("site_health"\)/);
    expect(UPDATES).toMatch(/shByFarm\.has\(f\.id\) \? shByFarm\.get\(f\.id\) : shOld/);
  });
  it("ordens de OTA são operacionais e fail-closed por fazenda", () => {
    expect(UPDATES).toMatch(/assertOperationalClient\(fid\)\.rpc\("request_agent_update"/);
    expect(UPDATES).toMatch(/assertOperationalClient\(farmId\)\.from\("agent_update_status"\)/);
    expect(UPDATES).toMatch(/assertOperationalClient\(farmId\)\s*\n?\s*\.from\("farms"\)\s*\n?\s*\.update\(\{ target_agent_version/);
  });
});

// ── trava transversal ───────────────────────────────────────────────────────
describe("trava transversal dos arquivos corrigidos", () => {
  const CORRIGIDOS: Array<[string, string]> = [
    ["PeakHourBanner", PEAK],
    ["pages/DemandaEnergia", DEMANDA_PAGE],
    ["components/energy/DemandaEnergia", DEMANDA_CMP],
    ["CommunicationReport", COMMREPORT],
    ["useAgentActivity", AGENT_ACTIVITY],
    ["PlatformServiceMode", SERVICE_MODE],
    ["PlatformUpdates", UPDATES],
  ];

  it("nenhum deles volta a ler tabela operacional pelo singleton", () => {
    for (const [nome, code] of CORRIGIDOS) {
      expect(`${nome}: ${leaksOperacionais(code).join(",")}`).toBe(`${nome}: `);
    }
  });

  it("e o roteamento efetivo continua Pérola→NEW, demais→OLD", () => {
    expect(idOf(getSupabaseForFarm(PEROLA))).toBe("NEW");
    expect(idOf(getSupabaseForFarm(SOSSEGO))).toBe("OLD");
    expect(idOf(assertOperationalClient(PEROLA))).toBe("NEW");
    expect(idOf(assertOperationalClient(SOSSEGO))).toBe("OLD");
    const r = tryGetSupabaseForFarm(PEROLA);
    expect(r.client && idOf(r.client)).toBe("NEW");
  });
});
