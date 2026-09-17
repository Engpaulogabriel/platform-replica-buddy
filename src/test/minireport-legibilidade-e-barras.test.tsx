// @vitest-environment jsdom
// (A) O mini relatório não pode vazar método técnico nem cortar nomes.
// (B) As barras refletem a idade da ÚLTIMA RESPOSTA FÍSICA, não RSSI.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act, cleanup } from "@testing-library/react";
import type { AutomationLogEntry } from "@/lib/automationLog";
import { buildMiniStatusHistory } from "@/lib/dashboardMiniHistory";
import { buildMiniCommandHistory, miniOrigin, miniActor, isTechnicalLabel, commBarsFor } from "@/lib/dashboardMiniHistory";
import type { Pump } from "@/components/dashboard/PumpTable";

vi.mock("@/contexts/MaintenanceContext", () => ({ useOpenMaintenance: () => ({ getForEquipment: () => null }) }));
vi.mock("@/contexts/MasterManagerContext", () => ({ usePermission: () => true }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
const db = { admin: false, pref: false };
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (t: string) => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({
      data: t === "platform_admins" && db.admin ? { user_id: "u1" } : null, error: null }) }) }) }),
    rpc: async (fn: string) => ({
      data: fn === "get_technical_display_pref" ? (db.admin && db.pref) : null, error: null }),
  },
}));
vi.mock("@/lib/realtimeKillSwitch", () => ({
  getRealtimeChannel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
  removeRealtimeChannel: async () => {},
}));

const { PumpCard } = await import("@/components/dashboard/PumpCard");
const { TechnicalTelemetryProvider } = await import("@/hooks/useTechnicalTelemetry");

const EQ = "eq-1";
const MIN = 60_000;
const ent = (o: Partial<AutomationLogEntry>): AutomationLogEntry => ({
  id: Math.random().toString(36), farmId: "f", date: "14/08/2026", time: "17:03",
  ts: "2026-08-14T20:03:00Z", equipmentId: EQ, pump: "POÇO 01 R1",
  action: "Desligada", origin: "Manual", user: null, result: "success", synced: true,
  ...o,
} as AutomationLogEntry);

const pump = (over: Partial<Pump> = {}, es: AutomationLogEntry[] = [ent({})]): Pump => ({
  id: "p1", name: "POÇO 01 R1", running: true, online: true,
  communicationStatus: "online", lastCommunication: new Date(Date.now() - 2 * MIN).toISOString(),
  signalRF: 72, mode: "manual", sector: "", farmId: "f",
  statusHistory: es.map((e) => buildMiniStatusHistory(EQ, "POÇO 01 R1", [e], 1)[0]),
  commandHistory: es.map((e) => buildMiniCommandHistory(EQ, "POÇO 01 R1", [e], 1)[0]),
  ...over,
} as unknown as Pump);

async function draw(p: Pump) {
  cleanup();
  render(
    <TechnicalTelemetryProvider>
      <PumpCard pump={p} expanded refreshing={false} lastFailed={false}
        isGuarded={false} userOnline maintenanceActive={false}
        farms={[]} sectors={[]} guardFarmId={null} virtualize={false}
        onToggle={() => {}} onRefresh={() => {}} onOpenDialog={() => {}} onToggleExpand={() => {}} />
    </TechnicalTelemetryProvider>);
  await act(async () => {});
}
async function abrir(p: Pump) {
  await draw(p);
  fireEvent.click(screen.getByTestId("pump-refresh-button"));
  await waitFor(() => expect(screen.queryByText(/Atualizar status agora/i)).not.toBeNull());
}

// ── 1. nada de método técnico ──────────────────────────────────────────────
describe("1. método técnico nunca ocupa o lugar da pessoa", () => {
  const TECNICOS = ["Telemetria RF", "Acionamento RF", "RF", "Bridge", "Serial",
                    "Sistema", "System", "Agente", "Cloud", "unknown",
                    "3f2b9c11-aaaa-bbbb-cccc-ddddeeee0000"];

  for (const t of TECNICOS) {
    it(`"${t}" não vira autor`, () => {
      expect(isTechnicalLabel(t)).toBe(true);
      expect(miniActor(ent({ origin: "Remoto", user: t }))).toBeNull();
    });
  }

  it("o mini relatório renderizado não contém nenhum desses textos", async () => {
    await abrir(pump({}, [
      ent({ origin: "Remoto", user: "Telemetria RF", action: "Ligada" }),
      ent({ origin: "Remoto", user: "Acionamento RF" }),
      ent({ origin: "Remoto", user: "Bridge" }),
    ]));
    const txt = document.body.textContent ?? "";
    for (const t of ["Telemetria RF", "Acionamento RF", "Bridge", "Serial", "Sistema"])
      expect(txt, `vazou "${t}"`).not.toContain(t);
  });

  it("pessoa de verdade continua aparecendo", () => {
    expect(miniActor(ent({ origin: "Remoto", user: "Yuri Seibert" }))).toBe("Yuri Seibert");
  });

  it("WhatsApp · Fulano vira só o nome — o badge já diz o canal", () => {
    expect(miniActor(ent({ origin: "WhatsApp", user: "WhatsApp · Paulo Gabriel" })))
      .toBe("Paulo Gabriel");
  });
});

// ── 2 a 6. classificação e cores ───────────────────────────────────────────
describe("2 a 6. badge e cor por origem", () => {
  const CASOS = [
    { o: "auto",       ent: ent({ origin: "Automático", user: "Desligamento 17h Semear", scheduled: true }),
      badge: "AUTOMAÇÃO", cor: /text-primary/, ator: "Desligamento 17h Semear" },
    { o: "remoto",     ent: ent({ origin: "Remoto", user: "Yuri Seibert" }),
      badge: "REMOTO", cor: /text-info/, ator: "Yuri Seibert" },
    { o: "local",      ent: ent({ origin: "Manual" }),
      badge: "LOCAL", cor: /text-warning/, ator: "Acionamento local" },
    { o: "automatico", ent: ent({ origin: "Automático", user: "Modo noturno", scheduled: false }),
      badge: "AUTO", cor: /text-info/, ator: "Modo noturno" },
    { o: "whatsapp",   ent: ent({ origin: "WhatsApp", user: "Paulo Gabriel" }),
      badge: "WHATSAPP", cor: /text-primary/, ator: "Paulo Gabriel" },
  ] as const;

  for (const c of CASOS) {
    it(`${c.badge}: badge, cor e nome completo`, async () => {
      await abrir(pump({}, [c.ent]));
      const b = screen.getAllByTestId("status-origin")[0];
      expect(b.textContent).toBe(c.badge);
      expect(b.className).toMatch(c.cor);
      expect(screen.getAllByTestId("status-actor")[0].textContent).toBe(c.ator);
    });
  }

  it("o desligamento das 17h NUNCA é AUTO, REMOTO ou LOCAL", async () => {
    // mesmo sem details.scheduled_shutdown, origin auto assume regra programada
    for (const e of [
      ent({ origin: "Automático", user: "Desligamento 17h Semear", scheduled: true }),
      ent({ origin: "Automático", user: "Desligamento 17h Semear" }),
    ]) {
      expect(miniOrigin(e)).toBe("auto");
      await abrir(pump({}, [e]));
      expect(screen.getAllByTestId("status-origin")[0].textContent).toBe("AUTOMAÇÃO");
    }
  });
});

// ── 7 e 8. layout ──────────────────────────────────────────────────────────
describe("7 e 8. nada é cortado, data/hora continuam", () => {
  const LONGA = "Desligamento programado das 17h da Fazenda Semear — bloco norte";

  it("regra longa não usa truncate/ellipsis e quebra linha", async () => {
    await abrir(pump({}, [ent({ origin: "Automático", user: LONGA, scheduled: true })]));
    const el = screen.getAllByTestId("status-actor")[0];
    expect(el.textContent).toBe(LONGA);           // completo, sem "…"
    expect(el.textContent).not.toContain("…");
    expect(el.textContent).not.toMatch(/\.\.\.$/);
    for (const c of ["truncate", "text-ellipsis", "line-clamp", "overflow-hidden"])
      expect(el.className, `${c} no nome`).not.toContain(c);
    expect(el.className).toContain("break-words");
  });

  it("nome de pessoa longo idem", async () => {
    const NOME = "Paulo Gabriel Oliveira Carneiro de Albuquerque";
    await abrir(pump({}, [ent({ origin: "Remoto", user: NOME })]));
    const el = screen.getAllByTestId("cmd-actor")[0];
    expect(el.textContent).toBe(NOME);
    expect(el.className).not.toContain("truncate");
  });

  it("data/hora seguem visíveis nas duas listas", async () => {
    await abrir(pump({}, [ent({ origin: "Remoto", user: "Yuri Seibert" })]));
    expect(screen.getAllByTestId("status-time")[0].textContent).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
    expect(screen.getAllByTestId("cmd-time")[0].textContent).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
  });
});

// ── ITEM 5: barras de comunicação ──────────────────────────────────────────
describe("barras refletem a idade da última resposta física", () => {
  const barras = () => Number(screen.getByTestId("comm-bars").getAttribute("data-bars"));
  const comIdade = (min: number, over: Partial<Pump> = {}) =>
    pump({ lastCommunication: new Date(Date.now() - min * MIN).toISOString(), ...over });

  const FAIXAS: Array<[number, number]> = [
    [0, 4], [5, 4], [5.02, 3], [8, 3], [8.02, 2], [11, 2], [11.02, 1], [14.98, 1], [15, 0],
  ];

  it("as fronteiras exatas ficam na função pura, sem depender do relógio", () => {
    for (const [min, esperado] of FAIXAS)
      expect(commBarsFor(min * MIN), `${min} min`).toBe(esperado);
  });

  for (const [min, esperado] of FAIXAS.filter(([m]) => ![5, 8, 11].includes(m))) {
    it(`${min} min → ${esperado} barras (render)`, async () => {
      await draw(comIdade(min, min >= 15
        ? { online: false, communicationStatus: "offline" } as Partial<Pump>
        : {}));
      expect(barras()).toBe(esperado);
    });
  }

  it("o cliente não vê minuto, porcentagem nem tooltip técnico", async () => {
    await draw(comIdade(12));
    const el = screen.getByTestId("comm-bars");
    expect(el.getAttribute("title")).toBeNull();
    expect(el.textContent ?? "").toBe("");
    expect(document.body.textContent).not.toMatch(/\d+\s*%/);
    expect(document.body.textContent).not.toMatch(/\d+min/);
  });

  it("admin com a chave ligada tem o horário no title", async () => {
    db.admin = true; db.pref = true;
    await draw(comIdade(12));
    expect(screen.getByTestId("comm-bars").getAttribute("title")).toMatch(/Última resposta física/);
    db.admin = false; db.pref = false;
  });

  it("Ligado com 1 barra e Desligado com 4 barras — informações independentes", async () => {
    // `header-state` vive no popover; aqui olhamos a COR DO CARD, que é o
    // estado físico. Barras e estado são independentes.
    await draw(comIdade(12, { running: true } as Partial<Pump>));
    expect(barras()).toBe(1);
    expect(document.querySelector("div > div")?.className).toMatch(/bg-primary/);

    await draw(comIdade(1, { running: false } as Partial<Pump>));
    expect(barras()).toBe(4);
    expect(document.querySelector("div > div")?.className).not.toMatch(/bg-primary\/25/);
  });

  it("as barras não representam RSSI: signalRF alto com resposta velha dá 1 barra", async () => {
    await draw(comIdade(12, { signalRF: 100 } as Partial<Pump>));
    expect(barras()).toBe(1);
  });

  it("nova leitura por Realtime muda as barras sem F5", async () => {
    await draw(comIdade(12));
    expect(barras()).toBe(1);
    await draw(comIdade(1));      // chega last_communication novo
    expect(barras()).toBe(4);
  });

  it("15 min mantém o Offline cinza existente e 0 barras", async () => {
    await draw(comIdade(20, { online: false, communicationStatus: "offline" } as Partial<Pump>));
    expect(barras()).toBe(0);
    fireEvent.click(screen.getByTestId("pump-refresh-button"));
    await waitFor(() => expect(screen.queryByTestId("header-state")).not.toBeNull());
    expect(screen.getByTestId("header-state").textContent).toBe("Offline");
    expect(screen.getByTestId("header-state").className).toMatch(/muted/);
  });
});
