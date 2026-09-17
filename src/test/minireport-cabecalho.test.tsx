// @vitest-environment jsdom
// O cabeçalho do mini relatório mostra ESTADO FÍSICO — nunca origem.
// As origens continuam nas linhas de histórico, onde significam algo.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act, cleanup } from "@testing-library/react";
import type { AutomationLogEntry } from "@/lib/automationLog";
import { buildMiniStatusHistory } from "@/lib/dashboardMiniHistory";
import { buildMiniCommandHistory } from "@/lib/dashboardMiniHistory";
import type { Pump } from "@/components/dashboard/PumpTable";

vi.mock("@/contexts/MaintenanceContext", () => ({ useOpenMaintenance: () => ({ getForEquipment: () => null }) }));
vi.mock("@/contexts/MasterManagerContext", () => ({ usePermission: () => true }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
    rpc: async () => ({ data: false, error: null }),
  },
}));
vi.mock("@/lib/realtimeKillSwitch", () => ({
  getRealtimeChannel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
  removeRealtimeChannel: async () => {},
}));

const { PumpCard } = await import("@/components/dashboard/PumpCard");
const { TechnicalTelemetryProvider } = await import("@/hooks/useTechnicalTelemetry");

const EQ = "eq-1";
const ent = (o: Partial<AutomationLogEntry>): AutomationLogEntry => ({
  id: Math.random().toString(36), farmId: "f",
  date: "14/08/2026", time: "17:03", ts: "2026-08-14T20:03:00Z",
  equipmentId: EQ, pump: "POÇO 01 R1",
  action: "Desligada", origin: "Manual", user: null, result: "success", synced: true,
  ...o,
} as AutomationLogEntry);

const hist = (e: AutomationLogEntry) => ({
  statusHistory: buildMiniStatusHistory(EQ, "POÇO 01 R1", [e], 1),
  commandHistory: buildMiniCommandHistory(EQ, "POÇO 01 R1", [e], 1),
});

const pump = (over: Partial<Pump>, e: AutomationLogEntry): Pump => ({
  id: "p1", name: "POÇO 01 R1", running: true, online: true,
  communicationStatus: "online",
  lastCommunication: new Date(Date.now() - 2 * 60_000).toISOString(),
  signalRF: 72, mode: "manual", sector: "", farmId: "f",
  ...hist(e), ...over,
} as unknown as Pump);

async function abrir(p: Pump, extra: Record<string, unknown> = {}) {
  // `cleanup()` desmonta pelo React; zerar innerHTML na mão quebraria o
  // afterEach do Testing Library e contaminaria os testes seguintes.
  cleanup();
  render(
    <TechnicalTelemetryProvider>
      <PumpCard pump={p} expanded refreshing={false} lastFailed={false}
        isGuarded={false} userOnline maintenanceActive={false}
        farms={[]} sectors={[]} guardFarmId={null} virtualize={false}
        onToggle={() => {}} onRefresh={() => {}} onOpenDialog={() => {}} onToggleExpand={() => {}}
        {...extra} />
    </TechnicalTelemetryProvider>);
  await act(async () => {});
  fireEvent.click(screen.getByTestId("pump-refresh-button"));
  await waitFor(() => expect(screen.queryByText(/Atualizar status agora/i)).not.toBeNull());
}

const cabecalho = () => screen.getByTestId("header-state").textContent?.trim();
const PROIBIDOS = ["Local", "Remoto", "WhatsApp", "Automação", "Automático",
                   "Falha de Comm", "Acionamento local", "Yuri Seibert",
                   "Desligamento 17h Semear"];

describe("o cabeçalho mostra estado físico, nunca origem", () => {
  it("1. ligado + histórico Local → LIGADO, nunca LOCAL", async () => {
    await abrir(pump({ running: true, actuationOrigin: "local" } as Partial<Pump>,
                     ent({ origin: "Manual" })));
    expect(cabecalho()).toBe("Ligado");
    for (const t of PROIBIDOS) expect(cabecalho()).not.toContain(t);
  });

  it("2. desligado + histórico Automação → DESLIGADO, nunca AUTOMAÇÃO", async () => {
    await abrir(pump({ running: false } as Partial<Pump>,
                     ent({ origin: "Automático", user: "Desligamento 17h Semear", scheduled: true })));
    expect(cabecalho()).toBe("Desligado");
  });

  it("3. ligado + histórico Remoto → LIGADO", async () => {
    await abrir(pump({ running: true } as Partial<Pump>,
                     ent({ origin: "Remoto", user: "Yuri Seibert", action: "Ligada" })));
    expect(cabecalho()).toBe("Ligado");
  });

  it("3b. ligado + histórico WhatsApp → LIGADO", async () => {
    await abrir(pump({ running: true } as Partial<Pump>,
                     ent({ origin: "WhatsApp", user: "Paulo Gabriel", action: "Ligada" })));
    expect(cabecalho()).toBe("Ligado");
  });

  it("4. offline → OFFLINE, em cinza", async () => {
    await abrir(pump({ running: true, online: false, communicationStatus: "offline",
                       actuationOrigin: "local" } as Partial<Pump>, ent({ origin: "Manual" })));
    expect(cabecalho()).toBe("Offline");
    const cls = screen.getByTestId("header-state").className;
    expect(cls).toMatch(/muted/);
    expect(cls).not.toMatch(/text-primary/);
  });

  it("falha de comunicação não sequestra o cabeçalho", async () => {
    await abrir(pump({ running: true, commandUnconfirmedAt: Date.now() } as Partial<Pump>,
                     ent({ origin: "Manual" })));
    expect(cabecalho()).not.toContain("Falha");
    expect(["Ligado", "Desligado"]).toContain(cabecalho());
  });

  it("instável mostra o último estado conhecido, não Offline", async () => {
    await abrir(pump({ running: true, communicationStatus: "unstable" } as Partial<Pump>,
                     ent({ origin: "Manual" })));
    expect(cabecalho()).toBe("Ligado");
  });

  it("verde quando ligado, vermelho quando desligado", async () => {
    await abrir(pump({ running: true } as Partial<Pump>, ent({ origin: "Manual" })));
    expect(screen.getByTestId("header-state").className).toMatch(/text-primary/);
    await abrir(pump({ running: false } as Partial<Pump>, ent({ origin: "Manual" })));
    expect(screen.getByTestId("header-state").className).toMatch(/text-destructive/);
  });
});

describe("5. origem, regra e autor continuam nas linhas históricas", () => {
  it("Automação com a regra aparece no histórico, não no cabeçalho", async () => {
    await abrir(pump({ running: false } as Partial<Pump>,
                     ent({ origin: "Automático", user: "Desligamento 17h Semear", scheduled: true })));
    expect(cabecalho()).toBe("Desligado");
    expect(screen.getAllByTestId("status-origin")[0].textContent).toBe("AUTOMAÇÃO");
    expect(screen.getAllByTestId("status-actor")[0].textContent).toBe("Desligamento 17h Semear");
    expect(screen.getAllByTestId("cmd-origin")[0].textContent).toBe("AUTOMAÇÃO");
  });

  it("Local mostra 'Acionamento local' na linha, e o cabeçalho segue o estado", async () => {
    await abrir(pump({ running: true, actuationOrigin: "local" } as Partial<Pump>,
                     ent({ origin: "Manual" })));
    expect(cabecalho()).toBe("Ligado");
    expect(screen.getAllByTestId("status-origin")[0].textContent).toBe("LOCAL");
    expect(screen.getAllByTestId("status-actor")[0].textContent).toBe("Acionamento local");
  });

  it("data/hora continuam em cada linha", async () => {
    await abrir(pump({}, ent({ origin: "Remoto", user: "Yuri Seibert" })));
    expect(screen.getAllByTestId("status-time")[0].textContent).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
    expect(screen.getAllByTestId("cmd-time")[0].textContent).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
  });
});

describe("6. nada anterior foi revertido", () => {
  it("a idade técnica continua oculta por padrão", async () => {
    await abrir(pump({ lastCommunication: new Date(Date.now() - 13 * 60_000).toISOString() } as Partial<Pump>,
                     ent({ origin: "Manual" })));
    expect(screen.queryByTestId("technical-comm-age")).toBeNull();
    expect(document.body.textContent).not.toMatch(/\d+min/);
  });

  it("o RefreshCw original segue no lugar", async () => {
    await abrir(pump({}, ent({ origin: "Manual" })));
    expect(screen.getByTestId("pump-refresh-button").querySelector("svg")?.getAttribute("class"))
      .toContain("lucide-refresh-cw");
  });

  it("o selo LOCAL do CARD (fora do popover) continua existindo", async () => {
    // a regra vale para o cabeçalho do popover; o card mantém seu selo próprio
    await abrir(pump({ running: true, actuationOrigin: "local" } as Partial<Pump>,
                     ent({ origin: "Manual" })));
    expect(document.body.textContent).toContain("LOCAL");
  });
});
