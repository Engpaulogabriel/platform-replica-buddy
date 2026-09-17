// @vitest-environment jsdom
// PARIDADE DE ORIGEM — o mini relatório é a versão compacta do Relatório de
// Automação. As cinco origens canônicas têm de sobreviver inteiras: é proibido
// reduzir Automação ou WhatsApp para Remoto, ou qualquer origem para Local.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { AutomationLogEntry } from "@/lib/automationLog";
import { buildMiniStatusHistory } from "@/lib/dashboardMiniHistory";
import { buildMiniCommandHistory, miniOrigin } from "@/lib/dashboardMiniHistory";
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
const entrada = (o: Partial<AutomationLogEntry>): AutomationLogEntry => ({
  id: Math.random().toString(36), farmId: "f",
  date: "14/08/2026", time: "17:03", ts: "2026-08-14T20:03:00Z",
  equipmentId: EQ, pump: "POÇO 12 R6",
  action: "Desligada", origin: "Manual", user: null, result: "success", synced: true,
  ...o,
} as AutomationLogEntry);

// ── Os cinco casos exatos do adendo ────────────────────────────────────────
const CASOS: Array<{ nome: string; e: AutomationLogEntry; origem: string; ator: string | null }> = [
  { nome: "Local",
    e: entrada({ origin: "Manual", user: null }),
    origem: "LOCAL", ator: "Acionamento local" },
  { nome: "Remoto pelo painel",
    e: entrada({ origin: "Remoto", user: "Yuri Seibert", action: "Ligada", time: "16:52" }),
    origem: "REMOTO", ator: "Yuri Seibert" },
  { nome: "WhatsApp",
    e: entrada({ origin: "WhatsApp", user: "Paulo Gabriel", action: "Ligada", time: "14:10" }),
    origem: "WHATSAPP", ator: "Paulo Gabriel" },
  { nome: "Automação programada",
    e: entrada({ origin: "Automático", user: "Desligamento 17h Semear", scheduled: true }),
    origem: "AUTOMAÇÃO", ator: "Desligamento 17h Semear" },
  { nome: "Modo automático",
    e: entrada({ origin: "Automático", user: "Regra de irrigação noturna",
                 scheduled: false, action: "Ligada", time: "07:00" }),
    origem: "AUTO", ator: "Regra de irrigação noturna" },
];

describe("classificação canônica preserva as cinco origens", () => {
  for (const c of CASOS) {
    it(`${c.nome} não é reduzido a outra origem`, () => {
      const [st] = buildMiniStatusHistory(EQ, "POÇO 12 R6", [c.e], 1);
      expect(st.label).toBe(c.origem);
      expect(st.actor ?? null).toBe(c.ator);
    });

    it(`${c.nome}: o histórico de comandos usa a mesma origem`, () => {
      const [cmd] = buildMiniCommandHistory(EQ, "POÇO 12 R6", [c.e], 1);
      expect(cmd.label).toBe(c.origem);
      expect(cmd.actor ?? null).toBe(c.ator);
    });
  }

  it("Automação e WhatsApp NUNCA viram Remoto", () => {
    for (const c of CASOS.filter((x) => x.origem !== "REMOTO")) {
      expect(miniOrigin(c.e)).not.toBe("remoto");
      expect(buildMiniStatusHistory(EQ, "POÇO 12 R6", [c.e], 1)[0].label).not.toBe("REMOTO");
    }
  });

  it("nenhuma origem vira Local por engano", () => {
    for (const c of CASOS.filter((x) => x.origem !== "LOCAL")) {
      expect(buildMiniStatusHistory(EQ, "POÇO 12 R6", [c.e], 1)[0].source).not.toBe("local");
    }
  });

  it("Automação programada e Modo automático são distinguidos", () => {
    const prog = entrada({ origin: "Automático", user: "Desligamento 17h Semear", scheduled: true });
    const modo = entrada({ origin: "Automático", user: "Regra noturna", scheduled: false });
    expect(miniOrigin(prog)).toBe("auto");
    expect(miniOrigin(modo)).toBe("automatico");
    expect(buildMiniStatusHistory(EQ, "P", [prog], 1)[0].label).toBe("AUTOMAÇÃO");
    expect(buildMiniStatusHistory(EQ, "P", [modo], 1)[0].label).toBe("AUTO");
  });

  it("Local mostra 'Acionamento local', nunca um nome de pessoa", () => {
    const l = entrada({ origin: "Manual", user: "Alguém" });
    expect(buildMiniStatusHistory(EQ, "P", [l], 1)[0].actor).toBe("Acionamento local");
  });
});

// ── E o card renderiza isso, para qualquer perfil ──────────────────────────
// O card mostra os 3 itens mais recentes (comportamento pré-existente, não
// alterado aqui). A cobertura das cinco origens fica no bloco puro acima.
describe("o card exibe as origens sem colapsar", () => {
  const TRES = CASOS.slice(0, 3);   // Local, Remoto, WhatsApp
  const pump = (): Pump => ({
    id: "p1", name: "POÇO 12 R6", running: false, online: true,
    communicationStatus: "online",
    lastCommunication: new Date(Date.now() - 13 * 60_000).toISOString(),
    signalRF: 72, mode: "manual", sector: "", farmId: "f",
    statusHistory: TRES.map((c) => buildMiniStatusHistory(EQ, "POÇO 12 R6", [c.e], 1)[0]),
    commandHistory: TRES.map((c) => buildMiniCommandHistory(EQ, "POÇO 12 R6", [c.e], 1)[0]),
  } as unknown as Pump);

  async function abrir() {
    document.body.innerHTML = "";
    render(
      <TechnicalTelemetryProvider>
        <PumpCard pump={pump()} expanded refreshing={false} lastFailed={false}
          isGuarded={false} userOnline maintenanceActive={false}
          farms={[]} sectors={[]} guardFarmId={null} virtualize={false}
          onToggle={() => {}} onRefresh={() => {}} onOpenDialog={() => {}} onToggleExpand={() => {}} />
      </TechnicalTelemetryProvider>);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("pump-refresh-button"));
    await waitFor(() => expect(screen.queryByText(/Atualizar status agora/i)).not.toBeNull());
  }

  it("as origens aparecem sem colapsar — WhatsApp não vira Remoto", async () => {
    await abrir();
    expect(screen.queryAllByTestId("status-origin").map((e) => e.textContent))
      .toEqual(["LOCAL", "REMOTO", "WHATSAPP"]);
  });

  it("cada uma vem com seu rótulo à direita", async () => {
    await abrir();
    expect(screen.queryAllByTestId("status-actor").map((e) => e.textContent))
      .toEqual(["Acionamento local", "Yuri Seibert", "Paulo Gabriel"]);
  });

  it("o histórico de comandos mostra as mesmas origens", async () => {
    await abrir();
    expect(screen.queryAllByTestId("cmd-origin").map((e) => e.textContent))
      .toEqual(["LOCAL", "REMOTO", "WHATSAPP"]);
  });

  it("data e hora acompanham cada item, para o cliente", async () => {
    await abrir();
    const horas = screen.queryAllByTestId("status-time").map((e) => e.textContent);
    expect(horas).toHaveLength(3);
    for (const h of horas) expect(h).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
  });

  it("a idade técnica continua oculta mesmo com o histórico visível", async () => {
    await abrir();
    expect(screen.queryByTestId("technical-comm-age")).toBeNull();
    expect(document.body.textContent).not.toMatch(/\d+min/);
  });

  it("cada badge usa a cor da tabela: LOCAL amarelo, REMOTO azul, WHATSAPP verde", async () => {
    // O azul deixou de ser exclusivo da manutenção DENTRO do mini relatório:
    // a tabela de cores manda REMOTO e AUTO em azul. Fora do popover, o azul
    // do card continua reservado a maintenance_mode.
    await abrir();
    const [local, remoto, wa] = screen.queryAllByTestId("status-origin");
    expect(local.className).toMatch(/text-warning/);
    expect(remoto.className).toMatch(/text-info/);
    expect(wa.className).toMatch(/text-primary/);
  });
});
