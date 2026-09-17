// @vitest-environment jsdom
// PROVA CONSOLIDADA no nível do card: as três correções convivem sem se anular.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { Pump } from "@/components/dashboard/PumpTable";

vi.mock("@/contexts/MaintenanceContext", () => ({ useOpenMaintenance: () => ({ getForEquipment: () => null }) }));
vi.mock("@/contexts/MasterManagerContext", () => ({ usePermission: () => true }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));

const db = { admin: false, support: false, pref: false };
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (t: string) => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({
      data: (t === "platform_admins" && db.admin) || (t === "platform_support" && db.support)
        ? { user_id: "u1" } : null, error: null }) }) }) }),
    rpc: async (fn: string) => ({
      data: fn === "get_technical_display_pref" ? ((db.admin || db.support) && db.pref) : null,
      error: null }),
  },
}));
vi.mock("@/lib/realtimeKillSwitch", () => ({
  getRealtimeChannel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
  removeRealtimeChannel: async () => {},
}));

const { PumpCard } = await import("@/components/dashboard/PumpCard");
const { TechnicalTelemetryProvider } = await import("@/hooks/useTechnicalTelemetry");

const base = (over: Partial<Pump> = {}): Pump => ({
  id: "p1", name: "POÇO 12 R6", running: false, online: true,
  communicationStatus: "online",
  lastCommunication: new Date(Date.now() - 13 * 60_000).toISOString(),
  signalRF: 72, mode: "manual", sector: "", farmId: "f",
  commandHistory: [{ action: "Desligar automação", time: "14/08 17:03", result: "success",
                     source: "auto", label: "AUTOMAÇÃO", actor: "Desligamento 17h Semear" }],
  statusHistory: [{ status: "Desligado", source: "auto", time: "14/08 17:03",
                    label: "AUTOMAÇÃO", actor: "Desligamento 17h Semear" }],
  ...over,
} as unknown as Pump);

async function draw(p: Pump, extra: Record<string, unknown> = {}) {
  document.body.innerHTML = "";
  const r = render(
    <TechnicalTelemetryProvider>
      <PumpCard pump={p} expanded refreshing={false} lastFailed={false}
        isGuarded={false} userOnline maintenanceActive={false}
        farms={[]} sectors={[]} guardFarmId={null} virtualize={false}
        onToggle={() => {}} onRefresh={() => {}} onOpenDialog={() => {}} onToggleExpand={() => {}}
        {...extra} />
    </TechnicalTelemetryProvider>);
  await act(async () => {});
  return r;
}
// O textContent vem concatenado ("POÇO 12 R6LOCAL"), então \b não serve aqui.
const temSeloLocal = () => (document.body.textContent ?? "").includes("LOCAL");
const icone = () => screen.getByTestId("pump-refresh-button").querySelector("svg")?.getAttribute("class") ?? "";

beforeEach(() => { db.admin = false; db.support = false; db.pref = false; });

describe("1. origem canônica no card", () => {
  it("automação das 17h: SEM selo LOCAL", async () => {
    await draw(base({ actuationOrigin: "auto" } as Partial<Pump>));
    expect(temSeloLocal()).toBe(false);
  });

  it("comando remoto confirmado: SEM selo LOCAL", async () => {
    await draw(base({ actuationOrigin: "remote" } as Partial<Pump>));
    expect(temSeloLocal()).toBe(false);
  });

  it("atuação local real: COM selo LOCAL", async () => {
    await draw(base({ actuationOrigin: "local", running: true } as Partial<Pump>));
    expect(temSeloLocal()).toBe(true);
  });
});

describe("2. mini relatório para o cliente", () => {
  it("data/hora, origem e regra aparecem sem permissão nenhuma", async () => {
    await draw(base());
    fireEvent.click(screen.getByTestId("pump-refresh-button"));
    await waitFor(() => expect(screen.queryByText(/Atualizar status agora/i)).not.toBeNull());
    expect(screen.getAllByTestId("status-time")[0].textContent).toBe("14/08 17:03");
    expect(screen.getAllByTestId("status-origin")[0].textContent).toBe("AUTOMAÇÃO");
    expect(screen.getAllByTestId("status-actor")[0].textContent).toBe("Desligamento 17h Semear");
  });

  it("automação NÃO é convertida em Remoto", async () => {
    await draw(base());
    fireEvent.click(screen.getByTestId("pump-refresh-button"));
    await waitFor(() => expect(screen.queryByText(/Atualizar status agora/i)).not.toBeNull());
    expect(screen.getAllByTestId("status-origin").map((e) => e.textContent)).not.toContain("REMOTO");
  });

  it("o badge Automação não usa azul", async () => {
    await draw(base());
    fireEvent.click(screen.getByTestId("pump-refresh-button"));
    await waitFor(() => expect(screen.queryByText(/Atualizar status agora/i)).not.toBeNull());
    expect(screen.getAllByTestId("status-origin")[0].className).not.toMatch(/text-info|bg-info/);
  });

  it("azul continua aparecendo na manutenção técnica", async () => {
    await draw(base(), { inMaintenance: true });
    expect(document.body.innerHTML).toContain("text-info");
  });
});

describe("3. privacidade: só a idade fica oculta", () => {
  it("cliente não vê Xmin nem 'sem comunicação há X'", async () => {
    await draw(base());
    expect(screen.queryByTestId("technical-comm-age")).toBeNull();
    expect(document.body.textContent).not.toMatch(/\d+min/);
    expect(document.body.textContent).not.toMatch(/sem comunica[çc][ãa]o h[áa]/i);
  });

  it("admin com a chave desligada: histórico sim, idade não", async () => {
    db.admin = true;
    await draw(base());
    fireEvent.click(screen.getByTestId("pump-refresh-button"));
    await waitFor(() => expect(screen.queryByText(/Atualizar status agora/i)).not.toBeNull());
    expect(screen.getAllByTestId("status-time")).toHaveLength(1);
    expect(screen.queryByTestId("technical-comm-age")).toBeNull();
  });

  it("admin com a chave ligada vê os dois", async () => {
    db.admin = true; db.pref = true;
    await draw(base());
    await waitFor(() => expect(screen.queryByTestId("technical-comm-age")).not.toBeNull());
  });
});

describe("4. o ciclo do RefreshCw não foi revertido", () => {
  it("normal → girando → CheckCircle2 → falha", async () => {
    await draw(base());
    expect(icone()).toContain("lucide-refresh-cw");
    expect(icone()).not.toContain("animate-spin");
    await draw(base(), { refreshing: true });
    expect(icone()).toContain("animate-spin");
    await draw(base(), { refreshResult: "success" });
    expect(icone()).toContain("lucide-circle-check");
    await draw(base(), { refreshResult: "fail", lastFailed: true });
    expect(icone()).toContain("lucide-triangle-alert");
  });

  it("instável não pinta o ícone de azul", async () => {
    await draw(base({ communicationStatus: "unstable" } as Partial<Pump>));
    expect(screen.getByTestId("pump-refresh-button").className).toContain("text-primary");
    expect(screen.getByTestId("pump-refresh-button").className).not.toContain("text-info");
  });
});
