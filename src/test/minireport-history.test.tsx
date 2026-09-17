// @vitest-environment jsdom
// O mini relatório do card é HISTÓRICO OPERACIONAL: data/hora, origem real e
// nome da regra valem para TODO perfil, inclusive cliente.
// A chave "Exibir tempos técnicos" governa APENAS a idade da telemetria.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { Pump } from "@/components/dashboard/PumpTable";

vi.mock("@/contexts/MaintenanceContext", () => ({ useOpenMaintenance: () => ({ getForEquipment: () => null }) }));
vi.mock("@/contexts/MasterManagerContext", () => ({ usePermission: () => true }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));

const db = { admin: false, support: false, pref: false };
let realtimeCb: ((p: { new?: { show_technical_times?: boolean } }) => void) | null = null;

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
  getRealtimeChannel: () => ({
    on: (_e: string, _f: unknown, cb: (p: { new?: { show_technical_times?: boolean } }) => void) => {
      realtimeCb = cb; return { subscribe: () => ({}) };
    },
  }),
  removeRealtimeChannel: async () => {},
}));

const { PumpCard } = await import("@/components/dashboard/PumpCard");
const { TechnicalTelemetryProvider } = await import("@/hooks/useTechnicalTelemetry");

/** Exatamente o exemplo pedido: automação com regra, remoto com pessoa, local. */
const pump = (): Pump => ({
  id: "p1", name: "POÇO 12 R6", running: false, online: true,
  communicationStatus: "online",
  lastCommunication: new Date(Date.now() - 13 * 60_000).toISOString(),
  lastReading: "14/08/2026 17:03:11",
  signalRF: 72, mode: "manual", sector: "", farmId: "f",
  commandHistory: [
    { action: "Desligar automação", time: "14/08 17:03", result: "success",
      source: "auto", label: "AUTOMAÇÃO", actor: "Desligamento 17h Semear" },
    { action: "Ligar remoto", time: "14/08 16:52", result: "success",
      source: "remoto", label: "REMOTO", actor: "Yuri Seibert" },
    { action: "Desligar local", time: "14/08 15:40", result: "success",
      source: "local", label: "LOCAL", actor: "Acionamento local" },
  ],
  statusHistory: [
    { status: "Desligado", source: "auto",   time: "14/08 17:03", label: "AUTOMAÇÃO", actor: "Desligamento 17h Semear" },
    { status: "Ligado",    source: "remoto", time: "14/08 16:52", label: "REMOTO", actor: "Yuri Seibert" },
    { status: "Desligado", source: "local",  time: "14/08 15:40", label: "LOCAL", actor: "Acionamento local" },
  ],
} as unknown as Pump);

async function abrirMiniRelatorio() {
  document.body.innerHTML = "";
  render(
    <TechnicalTelemetryProvider>
      <PumpCard
        pump={pump()} expanded refreshing={false} lastFailed={false}
        isGuarded={false} userOnline maintenanceActive={false}
        farms={[]} sectors={[]} guardFarmId={null} virtualize={false}
        onToggle={() => {}} onRefresh={() => {}} onOpenDialog={() => {}} onToggleExpand={() => {}}
      />
    </TechnicalTelemetryProvider>);
  await act(async () => {});
  fireEvent.click(screen.getByTestId("pump-refresh-button"));
  await waitFor(() => expect(screen.queryByText(/Atualizar status agora/i)).not.toBeNull());
}

const textos = (testid: string) =>
  screen.queryAllByTestId(testid).map((e) => e.textContent?.trim() ?? "");

function surface(): string {
  const attrs: string[] = [];
  document.body.querySelectorAll("*").forEach((el) => {
    for (const a of ["title", "aria-label"]) {
      const v = el.getAttribute(a); if (v) attrs.push(v);
    }
  });
  return `${document.body.textContent ?? ""}\n${attrs.join("\n")}`;
}

beforeEach(() => { db.admin = false; db.support = false; db.pref = false; realtimeCb = null; });

describe("1 e 2. o cliente vê o histórico completo", () => {
  it("data/hora de cada comando aparece", async () => {
    await abrirMiniRelatorio();
    expect(textos("cmd-time")).toEqual(["14/08 17:03", "14/08 16:52", "14/08 15:40"]);
  });

  it("data/hora de cada leitura de status aparece", async () => {
    await abrirMiniRelatorio();
    expect(textos("status-time")).toEqual(["14/08 17:03", "14/08 16:52", "14/08 15:40"]);
  });

  it("origem real de cada item: Automação, Remoto e Local", async () => {
    await abrirMiniRelatorio();
    expect(textos("status-origin")).toEqual(["AUTOMAÇÃO", "REMOTO", "LOCAL"]);
    expect(textos("cmd-origin")).toEqual(["AUTOMAÇÃO", "REMOTO", "LOCAL"]);
  });

  it("nome da regra na automação e nome da pessoa no remoto", async () => {
    await abrirMiniRelatorio();
    expect(textos("status-actor")).toEqual(
      ["Desligamento 17h Semear", "Yuri Seibert", "Acionamento local"]);
    expect(textos("cmd-actor")).toEqual(
      ["Desligamento 17h Semear", "Yuri Seibert", "Acionamento local"]);
  });

  it("a linha completa do exemplo aparece no mini relatório", async () => {
    await abrirMiniRelatorio();
    const t = document.body.textContent ?? "";
    for (const p of ["14/08 17:03", "Desligado", "AUTOMAÇÃO", "Desligamento 17h Semear"])
      expect(t, `faltou "${p}"`).toContain(p);
  });
});

describe("3. o cliente NÃO vê idade técnica de comunicação", () => {
  it("sem badge de minutos, sem 'sem comunicação há X'", async () => {
    await abrirMiniRelatorio();
    expect(screen.queryByTestId("technical-comm-age")).toBeNull();
    const s = surface();
    expect(s).not.toMatch(/\b\d+\s*min\b/i);
    expect(s).not.toMatch(/sem comunica[çc][ãa]o h[áa]/i);
    expect(s).not.toMatch(/\bh[áa]\s+\d+/i);
  });

  it("os horários do histórico NÃO são confundidos com idade", async () => {
    await abrirMiniRelatorio();
    // DD/MM HH:MM é histórico e pode aparecer; "Xmin" é idade e não pode
    expect(document.body.textContent).toContain("14/08 17:03");
    expect(document.body.textContent).not.toMatch(/\d+min/);
  });
});

describe("4 e 5. a chave governa só a idade técnica", () => {
  it("4. admin com a chave DESLIGADA vê o histórico, mas não a idade", async () => {
    db.admin = true; db.pref = false;
    await abrirMiniRelatorio();
    expect(textos("status-time")).toHaveLength(3);
    expect(textos("cmd-time")).toHaveLength(3);
    expect(screen.queryByTestId("technical-comm-age")).toBeNull();
  });

  it("5. admin com a chave LIGADA vê os dois", async () => {
    db.admin = true; db.pref = true;
    await abrirMiniRelatorio();
    await waitFor(() => expect(screen.queryByTestId("technical-comm-age")).not.toBeNull());
    expect(textos("status-time")).toHaveLength(3);
    expect(screen.getByTestId("technical-comm-age").textContent).toMatch(/\d+min/);
  });

  it("técnico de platform_support idem", async () => {
    db.support = true; db.pref = true;
    await abrirMiniRelatorio();
    await waitFor(() => expect(screen.queryByTestId("technical-comm-age")).not.toBeNull());
    expect(textos("cmd-time")).toHaveLength(3);
  });

  it("usuário não técnico com a chave ligada indevidamente: histórico sim, idade não", async () => {
    db.pref = true;
    await abrirMiniRelatorio();
    expect(textos("status-time")).toHaveLength(3);
    expect(screen.queryByTestId("technical-comm-age")).toBeNull();
  });
});

describe("6. os horários não dependem de F5", () => {
  it("ligar e desligar a chave pelo Realtime não mexe no histórico", async () => {
    db.admin = true;
    await abrirMiniRelatorio();
    const antes = textos("status-time");
    expect(antes).toHaveLength(3);

    await act(async () => { realtimeCb?.({ new: { show_technical_times: true } }); });
    await waitFor(() => expect(screen.queryByTestId("technical-comm-age")).not.toBeNull());
    expect(textos("status-time")).toEqual(antes);      // histórico intacto

    await act(async () => { realtimeCb?.({ new: { show_technical_times: false } }); });
    await waitFor(() => expect(screen.queryByTestId("technical-comm-age")).toBeNull());
    expect(textos("status-time")).toEqual(antes);      // continua intacto
  });
});

describe("nada operacional mudou", () => {
  it("nome do poço, estado e controle continuam", async () => {
    await abrirMiniRelatorio();
    expect(document.body.textContent).toContain("POÇO 12 R6");
    expect(document.querySelector('[role="switch"]')).not.toBeNull();
  });

  it("o ícone de atualização continua sendo o RefreshCw original", async () => {
    await abrirMiniRelatorio();
    const svg = screen.getByTestId("pump-refresh-button").querySelector("svg");
    expect(svg?.getAttribute("class")).toContain("lucide-refresh-cw");
  });

  it("Automação usa VERDE (regra da tabela de cores), nunca o azul", async () => {
    await abrirMiniRelatorio();
    const auto = screen.queryAllByTestId("status-origin").find((b) => b.textContent === "AUTOMAÇÃO");
    expect(auto?.className).toContain("text-primary");
    expect(auto?.className).not.toContain("text-info");
  });
});
