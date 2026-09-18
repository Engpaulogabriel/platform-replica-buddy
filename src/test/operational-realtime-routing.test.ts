// ─────────────────────────────────────────────────────────────────────────────
// Realtime operacional — nenhum canal do backend antigo fala pela Pérola
// ─────────────────────────────────────────────────────────────────────────────
// Dois modos de falha distintos, ambos silenciosos:
//   · postgres_changes — o backend novo não tem publication, então a resposta
//     honesta é "indisponível" + polling. Assinar o antigo entrega uma sala
//     vazia que ainda por cima se declara conectada.
//   · broadcast — NÃO depende de publication. O Agent da Pérola publica no
//     projeto novo, logo o canal correto é o do cliente DELA.
//
// Sem I/O: varredura estrutural + roteamento puro.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const PEROLA = "1014a8ab-b02a-47c7-90fc-1646d52a991e";
const SOSSEGO = "3e45b5ac-856e-4d29-b3b8-4dd71f86140d";

const oldChannel = { __id: "OLD_CHANNEL", state: "joined" };
const newChannel = { __id: "NEW_CHANNEL", state: "joined" };
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { __id: "OLD", channel: () => oldChannel, removeChannel: async () => "ok" },
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ __id: "NEW", channel: () => newChannel, removeChannel: async () => "ok" }),
}));

import {
  getRealtimeChannel,
  getFarmBroadcastChannel,
  removeFarmBroadcastChannel,
  isRealtimeAvailableForFarm,
} from "@/lib/realtimeKillSwitch";
import { getSupabaseForFarm, setNewBackendAuthReady } from "@/lib/supabaseRouter";
import { MIGRATED_FARMS } from "@/lib/migrationRegistry";

const idOf = (c: unknown) => (c as { __id: string }).__id;
const src = (p: string) => readFileSync(p, "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !/\.test\.|\/test\//.test(p)) out.push(p);
  }
  return out;
}

/** Canais sem filtro de fazenda que apenas DISPARAM um refresh já roteado. */
const GLOBAL_TRIGGERS = ["platform-tampering", "platform-alerts", "agent_update_status_live"];
/** Preferência de UI / identidade — não são operacionais. */
const NAO_OPERACIONAIS = ["dashboard_layouts", "tdp"];

/** Canais farm-scoped que ainda assinam o singleton antigo sem proteção. */
function realtimeLeaks(): string[] {
  const leaks: string[] = [];
  for (const file of walk("src")) {
    const code = src(file);
    if (!code.includes('from "@/integrations/supabase/client"')) continue;
    const protegido =
      code.includes("isRealtimeAvailableForFarm") || code.includes("getFarmBroadcastChannel");
    const re = /\bsupabase\s*\n?\s*\.channel\(\s*[`"']([^`"']*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      const topic = m[1];
      const base = topic.split("$")[0].split(":")[0].trim();
      if (GLOBAL_TRIGGERS.includes(base) || NAO_OPERACIONAIS.includes(base)) continue;
      const ctx = code.slice(Math.max(0, m.index - 800), m.index + 900);
      if (!/farm_id|farmId/.test(ctx)) continue;
      if (!protegido) leaks.push(`${file}: channel(${topic})`);
    }
  }
  return leaks;
}

beforeEach(() => setNewBackendAuthReady(true));

// ── 1 e 2 — a trava principal ───────────────────────────────────────────────
describe("varredura de src/", () => {
  it("nenhum canal farm-scoped operacional assina o antigo sem proteção", () => {
    expect(realtimeLeaks()).toEqual([]);
  });
});

// ── 3 e 6 — sem mentira, sem fallback ───────────────────────────────────────
describe("postgres_changes", () => {
  it("Pérola não tem Realtime utilizável; demais têm", () => {
    expect(isRealtimeAvailableForFarm(PEROLA)).toBe(false);
    expect(isRealtimeAvailableForFarm(SOSSEGO)).toBe(true);
  });

  it("canal da Pérola é inerte e responde CLOSED — nunca SUBSCRIBED", () => {
    const ch = getRealtimeChannel("qualquer", undefined, PEROLA);
    const status: string[] = [];
    ch.subscribe((s: string) => status.push(s));
    expect(status).toEqual(["CLOSED"]);
    expect(ch.state).toBe("closed");
    expect(idOf(ch)).not.toBe("OLD_CHANNEL");
  });

  it("fazenda não migrada continua no canal real do antigo", () => {
    expect(idOf(getRealtimeChannel("qualquer", undefined, SOSSEGO))).toBe("OLD_CHANNEL");
  });
});

// ── 4 — broadcast vai ao cliente da própria fazenda ─────────────────────────
describe("broadcast", () => {
  it("Pérola → canal do backend NOVO; demais → antigo", () => {
    expect(idOf(getFarmBroadcastChannel("agent-logs-x", PEROLA))).toBe("NEW_CHANNEL");
    expect(idOf(getFarmBroadcastChannel("agent-logs-x", SOSSEGO))).toBe("OLD_CHANNEL");
    expect(idOf(getSupabaseForFarm(PEROLA))).toBe("NEW");
  });

  it("a remoção também vai ao cliente certo", async () => {
    await expect(removeFarmBroadcastChannel(PEROLA, newChannel as never)).resolves.toBe("ok");
    await expect(removeFarmBroadcastChannel(SOSSEGO, oldChannel as never)).resolves.toBe("ok");
  });
});

// ── 5, 7, 8, 9, 10 — canais corrigidos, um a um ─────────────────────────────
describe("canais corrigidos", () => {
  it("AgentLiveLogs escuta o broadcast no backend da fazenda", () => {
    const A = src("src/components/bridge/AgentLiveLogs.tsx");
    expect(A).toMatch(/getFarmBroadcastChannel\(`agent-logs-\$\{farmId\}`, farmId/);
    expect(A).toMatch(/removeFarmBroadcastChannel\(farmId, channel\)/);
    expect(A).not.toMatch(/supabase\.channel\(`agent-logs/);
  });

  it("AuthorshipReconciliationQueue: leitura roteada e canal protegido", () => {
    const Q = src("src/components/tecnico/AuthorshipReconciliationQueue.tsx");
    expect(Q).toMatch(/getSupabaseForFarm\(farmId\)\.from\("remote_reconciliation_queue"/);
    expect(Q).toMatch(/if \(!isRealtimeAvailableForFarm\(farmId\)\)/);
    expect(Q).toMatch(/const RECONCILE_POLL_MS = 30_000;/);
  });

  it("automationLog não assina o antigo para fazenda migrada", () => {
    const L = src("src/lib/automationLog.ts");
    expect(L).toMatch(/if \(!isRealtimeAvailableForFarm\(ctx\.farmId\)\) return;/);
  });

  it("AgentUpdateStatusPanel ignora evento do antigo sobre fazenda migrada", () => {
    const U = src("src/components/platform/AgentUpdateStatusPanel.tsx");
    expect(U).toMatch(/if \(isFarmMigrated\(row\.farm_id\)\) return prev;/);
    expect(U).toMatch(/const OTA_POLL_MS = 20_000;/);
  });

  it("PlatformDevices: o canal é só gatilho e o refresh já é roteado", () => {
    const D = src("src/components/platform/PlatformDevices.tsx");
    expect(D).toMatch(/const DEVICES_POLL_MS = 60_000;/);
    expect(D).toMatch(/routed\.client\.from\("tampering_events"\)/);
  });

  it("PlatformAlerts inclui a fazenda migrada no feed", () => {
    const P = src("src/components/platform/PlatformAlerts.tsx");
    expect(P).toMatch(/routed\.client\.rpc\("platform_alerts_feed"/);
    expect(P).toMatch(/\.filter\(\(r\) => !isFarmMigrated\(r\.farm_id\)\)/);
    expect(P).toMatch(/const ALERTS_POLL_MS = 60_000;/);
  });
});

// ── 5 — timers sempre limpos ────────────────────────────────────────────────
describe("ciclo de vida dos polls", () => {
  const COM_POLL: Array<[string, string]> = [
    ["AuthorshipReconciliationQueue", "src/components/tecnico/AuthorshipReconciliationQueue.tsx"],
    ["AgentUpdateStatusPanel", "src/components/platform/AgentUpdateStatusPanel.tsx"],
    ["PlatformDevices", "src/components/platform/PlatformDevices.tsx"],
    ["PlatformAlerts", "src/components/platform/PlatformAlerts.tsx"],
  ];

  it.each(COM_POLL)("%s limpa o timer e pausa em segundo plano", (_nome, file) => {
    const code = src(file);
    expect(code).toMatch(/clearInterval\(/);
    expect(code).toMatch(/document\.visibilityState !== "visible"/);
  });
});

// ── 11, 12, 13 — nada regrediu ──────────────────────────────────────────────
describe("sem regressão nos lotes anteriores", () => {
  it("farm_messages continua com READ, DISMISS e canal coerentes", () => {
    const F = src("src/components/FarmMessagesBanner.tsx");
    expect(F).toMatch(/routed\.client\.rpc\("farm_messages_active"/);
    expect(F).toMatch(/assertOperationalClient\(farmId\)\.rpc\("farm_messages_dismiss"/);
    expect(F).toMatch(/isRealtimeAvailableForFarm\(farmId\) \? null : supabase/);
  });

  it("commandWorker não assina o canal de commands do antigo para migrada", () => {
    const W = src("src/lib/commandWorker.ts");
    expect(W).toMatch(/!isRealtimeAvailableForFarm\(farmId\) \? null : supabase/);
    expect(W).toMatch(/activeDb = assertOperationalClient\(farmId\);/);
  });

  it("dashboard_layouts permanece no antigo — é preferência de UI, não operação", () => {
    const D = src("src/pages/Dashboard.tsx");
    expect(D).toMatch(/PREFERÊNCIA DE UI/);
    expect(D).toMatch(/supabase\s*\n?\s*\.channel\(`dashboard_layouts:\$\{farmId\}`\)/);
  });
});

// ── 14 ──────────────────────────────────────────────────────────────────────
describe("invariantes", () => {
  it("MIGRATED_FARMS continua contendo somente a Pérola", () => {
    expect([...MIGRATED_FARMS]).toEqual([PEROLA]);
  });
});
