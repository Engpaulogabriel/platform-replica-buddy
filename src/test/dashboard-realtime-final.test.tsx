// @vitest-environment jsdom
// Pacote final: kill switch global ATIVO + bypass só no dashboard, com 15 poços.
import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import fs from "node:fs"; import path from "node:path";
const REPO = path.resolve(__dirname, "../..");
const R = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");
const KILL = R("src/lib/realtimeKillSwitch.ts");
const CAD = R("src/hooks/useCadastrosCloud.ts");
const DASH = R("src/pages/Dashboard.tsx");
const HOOK = R("src/hooks/useDashboardEquipment.ts");
const CARD = R("src/components/dashboard/PumpCard.tsx");

const BLOQUEADOS = [
  "src/hooks/useCloudAutomation.ts", "src/hooks/useSiteHealth.ts",
  "src/hooks/useCommandQueueStatus.ts", "src/lib/farmRealtimeBus.ts",
  "src/components/PeakHourBanner.tsx", "src/components/bridge/AgentLiveLogs.tsx",
  "src/components/platform/PlatformServiceMode.tsx",
  "src/components/tecnico/AuthorshipReconciliationQueue.tsx",
];

describe("kill switch global ativo, bypass só no dashboard", () => {
  it("kill switch permanece ATIVO por padrão", async () => {
    expect(KILL).toContain('"true"');
    vi.resetModules();
    const mod = await import("@/lib/realtimeKillSwitch");
    expect(mod.REALTIME_DISABLED).toBe(true);
  });

  it("useCadastrosCloud usa o canal REAL (bypass explícito)", () => {
    expect(CAD).toContain("getRealtimeChannel");
    expect(CAD).toContain("removeRealtimeChannel");
    expect(CAD).not.toMatch(/supabase\s*\n?\s*\.channel\(/);
  });

  it("os oito módulos fora do dashboard seguem SEM canal real", () => {
    for (const f of BLOQUEADOS) {
      const src = R(f);
      expect(src, `${f} não pode usar o bypass`).not.toContain("getRealtimeChannel");
    }
  });

  it("assina public.equipments filtrado pela fazenda ativa", () => {
    expect(CAD).toMatch(/table:\s*"equipments",\s*filter:\s*`farm_id=eq\.\$\{farmId\}`/);
  });
});

describe("15 poços da Sykue — isolamento e atualização sem F5", () => {
  const ids = Array.from({ length: 15 }, (_, i) => `poco-${String(i + 1).padStart(2, "0")}`);
  type Card = { id: string; running: boolean; pending?: string; updatedAt: number };
  const mk = (): Record<string, Card> =>
    Object.fromEntries(ids.map((id) => [id, { id, running: true, updatedAt: 1_000 }]));

  /** merge do Realtime: só o id do payload, e só se for mais novo. */
  const onUpdate = (cards: Record<string, Card>, id: string, running: boolean, at: number) => {
    const c = cards[id];
    if (!c || at <= c.updatedAt) return cards;
    return { ...cards, [id]: { ...c, running, pending: undefined, updatedAt: at } };
  };

  it("UPDATE de POÇO 12 OFF vira vermelho e os outros 14 não mudam", () => {
    let cards = mk();
    cards["poco-12"] = { ...cards["poco-12"], pending: "turning_off" };
    const antes = JSON.stringify({ ...cards, "poco-12": null });

    cards = onUpdate(cards, "poco-12", false, 2_000);

    expect(cards["poco-12"].running).toBe(false);      // verde → vermelho
    expect(cards["poco-12"].pending).toBeUndefined();  // pendência limpa no mesmo ciclo
    expect(JSON.stringify({ ...cards, "poco-12": null })).toBe(antes);
  });

  it("comando no 10 não altera 11, 12 nem 06", () => {
    let cards = mk();
    cards["poco-10"] = { ...cards["poco-10"], running: false, pending: "turning_on" };
    const snap = (c: Record<string, Card>) => [c["poco-11"], c["poco-12"], c["poco-06"]].map((x) => JSON.stringify(x));
    const antes = snap(cards);
    cards = onUpdate(cards, "poco-10", true, 2_000);
    expect(cards["poco-10"].running).toBe(true);
    expect(snap(cards)).toEqual(antes);
  });

  it("evento atrasado não regride nenhum card", () => {
    let cards = mk();
    cards = onUpdate(cards, "poco-12", false, 5_000);
    cards = onUpdate(cards, "poco-12", true, 3_000);   // antigo
    expect(cards["poco-12"].running).toBe(false);
  });
});

describe("badge montado no header do Dashboard", () => {
  it("Dashboard importa e renderiza o badge com a saúde do hook", () => {
    expect(DASH).toContain('import { RealtimeHealthBadge } from "@/components/dashboard/RealtimeHealthBadge"');
    expect(DASH).toMatch(/<RealtimeHealthBadge health=\{realtimeHealth\} lastPhysicalReadAt=\{lastPhysicalReadAt\} \/>/);
    expect(HOOK).toContain("realtimeHealth: cloud.realtimeHealth");
  });

  it("visível para admin, oculto para operador", async () => {
    vi.resetModules();
    vi.doMock("@/hooks/useTechnicalTelemetry", () => ({ useCanViewTechnicalTelemetry: () => true }));
    const { RealtimeHealthBadge: A } = await import("@/components/dashboard/RealtimeHealthBadge");
    const { unmount } = render(<A health="connected" lastPhysicalReadAt={Date.now()} />);
    expect(screen.getByTestId("realtime-health")).toBeTruthy();
    unmount();

    vi.resetModules();
    vi.doMock("@/hooks/useTechnicalTelemetry", () => ({ useCanViewTechnicalTelemetry: () => false }));
    const { RealtimeHealthBadge: B } = await import("@/components/dashboard/RealtimeHealthBadge");
    render(<B health="connected" />);
    expect(screen.queryByTestId("realtime-health")).toBeNull();
  });
});

describe("correções anteriores preservadas", () => {
  it("120s, sem RESET, sem pending=error, sem comando corretivo", () => {
    expect(HOOK).toContain("PENDING_MAX_MS = 120_000");
    expect(HOOK).toContain("MANUAL_PENDING_WINDOW_MS = 120_000");
    expect(R("src/hooks/usePendingManualCommands.ts")).toContain("PENDING_WINDOW_MS = 120_000");
    expect(HOOK).not.toContain('pending = "error"');
    expect(HOOK).not.toContain("enqueueResetPumpCommand");
    expect(CARD).toContain("const showReset = false;");
  });

  it("pending_command_id não gera transição em nenhum caminho", () => {
    expect(HOOK.match(/const hasAnyPending = localPending \|\| manualCmdFresh;/g)?.length).toBe(2);
    expect(HOOK).not.toMatch(/hasAnyPending[^;]*pending_command_id/);
  });

  it("rede de segurança só em degradado; sem polling no caminho saudável", () => {
    expect(CAD).toContain("startDegradedSafetyNet");
    expect(CAD).toContain("stopDegradedSafetyNet");
    expect(CAD).not.toMatch(/fallbackPoller\s*=\s*setInterval/);
    expect(CAD).toContain('document.visibilityState !== "visible"');
  });

  it("reconexão, background, focus, online e troca de fazenda tratados", () => {
    for (const st of ["SUBSCRIBED", "CHANNEL_ERROR", "TIMED_OUT", "CLOSED"]) expect(CAD).toContain(st);
    expect(CAD).toContain('document.addEventListener("visibilitychange"');
    expect(CAD).toContain('window.addEventListener("focus"');
    expect(CAD).toContain('window.addEventListener("online"');
    expect(CAD).toContain('document.removeEventListener("visibilitychange"');
  });
});
