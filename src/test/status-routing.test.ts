// ─────────────────────────────────────────────────────────────────────────────
// Status online/offline — roteamento e atualização por backend da fazenda
// ─────────────────────────────────────────────────────────────────────────────
// Trava os dois bugs provados na auditoria:
//   BUG 1 — canal Realtime do backend ANTIGO se declarava conectado para a
//           fazenda migrada, congelando os dados até o card virar OFFLINE.
//   BUG 2 — status do agente de fazenda migrada lido só do backend ANTIGO.
//
// Sem I/O: comportamento puro (router, kill switch) + garantias estruturais.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";

const PEROLA = "1014a8ab-b02a-47c7-90fc-1646d52a991e";
const SOSSEGO = "3e45b5ac-856e-4d29-b3b8-4dd71f86140d";
const SEMEAR = "0b1d53df-6d5c-4674-8517-9299aac3ec18";

const realChannel = { __id: "OLD_CHANNEL", state: "joined", subscribe: (cb?: (s: string) => void) => { cb?.("SUBSCRIBED"); return realChannel; } };
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    __id: "OLD",
    channel: () => realChannel,
    removeChannel: async () => "ok",
  },
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ __id: "NEW" }) }));

import {
  getRealtimeChannel,
  removeRealtimeChannel,
  isRealtimeAvailableForFarm,
} from "@/lib/realtimeKillSwitch";
import {
  getSupabaseForFarm,
  tryGetSupabaseForFarm,
  setNewBackendAuthReady,
} from "@/lib/supabaseRouter";
import { MIGRATED_FARMS } from "@/lib/migrationRegistry";

const src = (p: string) => readFileSync(p, "utf8");
const CADASTROS = src("src/hooks/useCadastrosCloud.ts");
const PLATFORM = src("src/pages/PlatformAdmin.tsx");
const MINHAS = src("src/pages/MinhasFazendas.tsx");
const DASHBOARD_HOOK = src("src/hooks/useDashboardEquipment.ts");
const idOf = (c: unknown) => (c as { __id: string }).__id;

beforeEach(() => setNewBackendAuthReady(true));

// ── 1, 2 e 12 — Realtime do ANTIGO não vale para fazenda migrada ─────────────
describe("Realtime por fazenda", () => {
  it("fazenda migrada não tem Realtime utilizável; fazenda antiga tem", () => {
    expect(isRealtimeAvailableForFarm(PEROLA)).toBe(false);
    expect(isRealtimeAvailableForFarm(SOSSEGO)).toBe(true);
    expect(isRealtimeAvailableForFarm(SEMEAR)).toBe(true);
  });

  it("canal da Pérola é inerte e se declara CLOSED — nunca SUBSCRIBED", () => {
    const ch = getRealtimeChannel("cadastros-perola", undefined, PEROLA);
    expect(idOf(ch)).not.toBe("OLD_CHANNEL");
    const status: string[] = [];
    ch.subscribe((s: string) => status.push(s));
    expect(status).toEqual(["CLOSED"]);
    expect(ch.state).toBe("closed");
  });

  it("fazenda não migrada continua recebendo o canal real do backend antigo", () => {
    const ch = getRealtimeChannel("cadastros-sossego", undefined, SOSSEGO);
    expect(idOf(ch)).toBe("OLD_CHANNEL");
  });

  it("chamada sem farmId preserva o comportamento histórico", () => {
    expect(idOf(getRealtimeChannel("global"))).toBe("OLD_CHANNEL");
  });

  it("remover canal inerte não explode", async () => {
    const ch = getRealtimeChannel("x", undefined, PEROLA);
    await expect(removeRealtimeChannel(ch)).resolves.toBe("ok");
  });

  it("o hook de dados marca Realtime degradado para fazenda migrada (sem mentir 'conectado')", () => {
    expect(CADASTROS).toMatch(/if \(!isRealtimeAvailableForFarm\(farmId\)\)/);
    expect(CADASTROS).toMatch(/realtimeConnected: false, realtimeHealth: "degraded"/);
    // e informa a fazenda ao pedir canal — nos DOIS canais (postgres_changes e broadcast)
    expect((CADASTROS.match(/undefined, farmId\)/g) ?? []).length).toBe(2);
    expect(CADASTROS).toMatch(/getRealtimeChannel\(`cadastros-/);
    expect(CADASTROS).toMatch(/getRealtimeChannel\(`farm-\$\{farmId\}`, undefined, farmId\)/);
  });
});

// ── 3, 4 e 5 — polling periódico, lifecycle-safe ─────────────────────────────
describe("polling da fazenda migrada", () => {
  it("é periódico (setInterval), não one-shot", () => {
    expect(CADASTROS).toMatch(/setInterval\([\s\S]{0,200}MIGRATED_POLL_MS\)/);
    // o one-shot antigo (setTimeout de 3s + startMigratedPoll) não existe mais
    expect(CADASTROS).not.toMatch(/startMigratedPoll/);
    expect(CADASTROS).not.toMatch(/setTimeout\(r, 3000\)/);
  });

  it("nasce de um efeito ancorado em state.farmId — funciona mesmo se era null no mount", () => {
    expect(CADASTROS).toMatch(/const fid = state\.farmId;\s*\n\s*if \(!fid \|\| !isFarmMigrated\(fid\)\) return;/);
    expect(CADASTROS).toMatch(/\}, \[state\.farmId, refresh\]\);/);
  });

  it("limpa o timer na troca de fazenda e na desmontagem", () => {
    expect(CADASTROS).toMatch(/return \(\) => clearInterval\(id\);/);
  });

  it("mantém 15 s e não altera o threshold de offline", () => {
    expect(CADASTROS).toMatch(/const MIGRATED_POLL_MS = 15_000;/);
    // regra oficial do dashboard intocada
    expect(DASHBOARD_HOOK).toMatch(/const OFFLINE_MIN_SINGLE = 15;/);
    expect(DASHBOARD_HOOK).toMatch(/const OFFLINE_MIN_MULTI = 20;/);
    expect(DASHBOARD_HOOK).toMatch(/diff >= offlineWindowMs\(outputsInPlc\)\) return "offline"/);
  });

  it("os dados do polling vêm do backend da fazenda", () => {
    expect(CADASTROS).toMatch(/const client = getSupabaseForFarm\(farmId\);/);
    expect(idOf(getSupabaseForFarm(PEROLA))).toBe("NEW");
    expect(idOf(getSupabaseForFarm(SOSSEGO))).toBe("OLD");
  });
});

// ── 6, 7 e 8 — recursos operacionais por fazenda ─────────────────────────────
describe("equipments e site_health seguem a fazenda", () => {
  it("Pérola → NEW; outra fazenda → OLD", () => {
    for (const _res of ["equipments", "site_health"]) {
      expect(idOf(getSupabaseForFarm(PEROLA))).toBe("NEW");
      expect(idOf(getSupabaseForFarm(SOSSEGO))).toBe("OLD");
      expect(idOf(getSupabaseForFarm(SEMEAR))).toBe("OLD");
    }
  });
});

// ── 9 e 10 — Plataforma: global no OLD, operacional no backend da fazenda ────
describe("PlatformAdmin", () => {
  it("lista/cadastro global continua no backend antigo", () => {
    expect(PLATFORM).toMatch(/supabase\.rpc\("platform_farms_overview"/);
    expect(PLATFORM).toMatch(/supabase\.rpc\("platform_overview_stats"/);
  });

  it("status operacional da fazenda migrada é sobreposto pelo backend dela", () => {
    expect(PLATFORM).toMatch(/async function overlayMigratedAgentStatus/);
    expect(PLATFORM).toMatch(/rows\.filter\(\(r\) => isFarmMigrated\(r\.farm_id\)\)/);
    expect(PLATFORM).toMatch(/routed\.client\s*\n?\s*\.from\("site_health"\)/);
    expect(PLATFORM).toMatch(/setFarms\(await overlayMigratedAgentStatus\(/);
  });

  it("o detalhe da fazenda migrada lê os TRÊS blocos operacionais do backend dela", () => {
    expect(PLATFORM).toMatch(/if \(!isFarmMigrated\(farmId\)\) \{ setDetail\(data\); return; \}/);
    expect(PLATFORM).toMatch(/routed\.client\.from\("site_health"\)\.select\("\*"\)/);
    expect(PLATFORM).toMatch(/routed\.client\.from\("equipments"\)\.select\("\*"\)/);
    expect(PLATFORM).toMatch(/routed\.client\.from\("agent_logs"\)\.select\("\*"\)/);
  });

  it("sem fallback silencioso: indisponível é indisponível, não OFFLINE", () => {
    expect(PLATFORM).toMatch(/operational_unavailable: true, last_heartbeat: null/);
    expect(PLATFORM).toMatch(/const online = !statusUnavailable && f\.last_heartbeat/);
    expect(PLATFORM).toMatch(/Indisponível/);
    expect(PLATFORM).toMatch(/site_health_unavailable/);
  });

  it("threshold do agente permanece 5 min", () => {
    expect(PLATFORM).toMatch(/< 5 \* 60_000/);
  });
});

// ── 11 e 12 — Minhas Fazendas ───────────────────────────────────────────────
describe("MinhasFazendas", () => {
  it("não usa mais o singleton para dados operacionais", () => {
    expect(MINHAS).not.toMatch(/from "@\/integrations\/supabase\/client"/);
    expect(MINHAS).not.toMatch(/\bsupabase\s*\n?\s*\.from\(/);
  });

  it("agrupa por backend resolvido a partir do farm_id", () => {
    expect(MINHAS).toMatch(/const routed = tryGetSupabaseForFarm\(id\);/);
    expect(MINHAS).toMatch(/client\.from\("equipments"\)/);
    expect(MINHAS).toMatch(/client\.from\("site_health"\)/);
  });

  it("fazenda migrada sem backend disponível fica indisponível, não offline", () => {
    expect(MINHAS).toMatch(/if \(!routed\.client\) \{ map\[id\]\.unavailable = true; continue; \}/);
    expect(MINHAS).toMatch(/Agente indisponível/);
    const r = tryGetSupabaseForFarm(PEROLA);
    expect(r.client === null || idOf(r.client) === "NEW").toBe(true);
  });

  it("threshold de 90 s preservado", () => {
    expect(MINHAS).toMatch(/const AGENT_FRESH_MS = 90_000;/);
  });
});

// ── 13 e 14 — invariantes da migração ───────────────────────────────────────
describe("invariantes", () => {
  it("MIGRATED_FARMS continua contendo somente a Pérola", () => {
    expect([...MIGRATED_FARMS]).toEqual([PEROLA]);
  });

  it("nenhum threshold foi inflado para esconder o problema", () => {
    // Dashboard: 15/20 min e janela de instabilidade de 2 min
    expect(DASHBOARD_HOOK).toMatch(/const UNSTABLE_MIN = 2;/);
    // Plataforma: 5 min · Minhas Fazendas: 90 s
    expect(PLATFORM).toMatch(/< 5 \* 60_000/);
    expect(MINHAS).toMatch(/90_000/);
  });
});
