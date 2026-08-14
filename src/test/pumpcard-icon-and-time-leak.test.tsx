// @vitest-environment jsdom
// 1) O ícone de atualização é o ORIGINAL, com o ciclo completo.
// 2) Com a chave desligada, NENHUM tempo técnico vaza — nem no card, nem no
//    tooltip, nem no popover operacional.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
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
      // o servidor já devolve false para quem não é staff
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
  id: "p1", name: "POÇO 12 R6", running: true, online: true,
  communicationStatus: "online",
  // 13 minutos: se vazar, aparece como "13min"
  lastCommunication: new Date(Date.now() - 13 * 60_000).toISOString(),
  lastReading: "14/08/2026 07:19:33",
  signalRF: 72, mode: "manual", sector: "", farmId: "f",
  commandHistory: [{ time: "07:19:33", action: "Ligar", ok: true }],
  statusHistory: [{ time: "07:20:01", running: true, origin: "remote" }],
  ...over,
} as unknown as Pump);

const props = (p: Pump, extra: Record<string, unknown> = {}) => ({
  pump: p, expanded: true, refreshing: false, lastFailed: false,
  isGuarded: false, userOnline: true, maintenanceActive: false,
  farms: [], sectors: [], guardFarmId: null, virtualize: false,
  onToggle: () => {}, onRefresh: () => {}, onOpenDialog: () => {}, onToggleExpand: () => {},
  ...extra,
});

async function draw(p: Pump, extra: Record<string, unknown> = {}) {
  document.body.innerHTML = "";
  const r = render(
    <TechnicalTelemetryProvider><PumpCard {...(props(p, extra) as never)} /></TechnicalTelemetryProvider>);
  await act(async () => {});          // deixa o provider decidir
  return r;
}

const botao = () => screen.getByTestId("pump-refresh-button");
const icone = () => botao().querySelector("svg")?.getAttribute("class") ?? "";

/** Texto visível + TODOS os atributos que o usuário consegue ler. */
function surface(): string {
  const attrs: string[] = [];
  document.body.querySelectorAll("*").forEach((el) => {
    for (const a of ["title", "aria-label", "alt", "data-tooltip", "placeholder"]) {
      const v = el.getAttribute(a); if (v) attrs.push(v);
    }
  });
  return `${document.body.textContent ?? ""}\n${attrs.join("\n")}`;
}

beforeEach(() => { db.admin = false; db.support = false; db.pref = false; });

// ── 1 a 5: o ícone ─────────────────────────────────────────────────────────
describe("ícone de atualização original", () => {
  it("1. estado normal: RefreshCw parado", async () => {
    await draw(base());
    expect(icone()).toContain("lucide-refresh-cw");
    expect(icone()).not.toContain("animate-spin");
    expect(document.body.innerHTML).not.toContain("lucide-ellipsis");
    expect(document.body.innerHTML).not.toContain("lucide-more-horizontal");
  });

  it("2. durante o refresh: o MESMO RefreshCw girando", async () => {
    await draw(base(), { refreshing: true });
    expect(icone()).toContain("lucide-refresh-cw");
    expect(icone()).toContain("animate-spin");
  });

  it("3. após confirmação: CheckCircle2, e depois volta ao RefreshCw", async () => {
    const { rerender } = await draw(base(), { refreshResult: "success" });
    expect(icone()).toContain("lucide-circle-check");
    rerender(<TechnicalTelemetryProvider><PumpCard {...(props(base()) as never)} /></TechnicalTelemetryProvider>);
    expect(icone()).toContain("lucide-refresh-cw");
  });

  it("4. falha preserva o ícone e a cor originais", async () => {
    await draw(base(), { refreshResult: "fail", lastFailed: true });
    expect(icone()).toContain("lucide-triangle-alert");
    expect(botao().className).toContain("text-destructive");
  });

  it("5. isUnstable NÃO pinta o ícone de azul", async () => {
    await draw(base({ communicationStatus: "unstable" } as Partial<Pump>));
    expect(icone()).toContain("lucide-refresh-cw");
    expect(botao().className).toContain("text-primary");
    for (const c of ["text-info","bg-info","text-sky","text-blue"])
      expect(botao().className).not.toContain(c);
  });

  it("o clique continua abrindo o popover e o refresh manual funciona", async () => {
    const onRefresh = vi.fn();
    await draw(base(), { onRefresh });
    fireEvent.click(botao());
    fireEvent.click(screen.getByText(/Atualizar status agora/i));
    expect(onRefresh).toHaveBeenCalledWith("p1");
  });
});

// ── 6: nenhum vazamento com a chave desligada ──────────────────────────────
const VAZAMENTOS: Array<[string, RegExp]> = [
  ["idade em minutos",   /\b\d+\s*min\b/i],
  ["idade em segundos",  /\b\d+\s*(s|seg|segundos)\b/i],
  ["'há N'",             /\bhá\s+\d+/i],
  ["'comunicação'",      /comunica[çc][ãa]o/i],
  ["relógio HH:MM",      /\b\d{1,2}:\d{2}\b/],
  ["data",               /\b\d{2}\/\d{2}\/\d{4}\b/],
  ["lastCommunication",  /lastCommunication/i],
  ["lastSeen",           /lastSeen/i],
  ["'última leitura'",   /última leitura/i],
];

describe("6. chave DESLIGADA: zero tempo técnico no card", () => {
  for (const quem of [
    { nome: "usuário comum",   set: () => {} },
    { nome: "platform_admin",  set: () => { db.admin = true; } },
    { nome: "platform_support",set: () => { db.support = true; } },
  ]) {
    it(`${quem.nome}: nenhum padrão de tempo em texto, tooltip ou aria-label`, async () => {
      quem.set();
      await draw(base());
      const s = surface();
      for (const [n, re] of VAZAMENTOS)
        expect(s, `vazou ${n} para ${quem.nome}`).not.toMatch(re);
      expect(screen.queryByTestId("technical-comm-age")).toBeNull();
    });
  }

  it("o popover operacional também não mostra horário", async () => {
    db.admin = true;
    await draw(base());
    fireEvent.click(botao());
    await waitFor(() => expect(screen.queryByText(/Atualizar status agora/i)).not.toBeNull());
    expect(screen.queryByTestId("technical-cmd-time")).toBeNull();
    expect(screen.queryByTestId("technical-status-time")).toBeNull();
    expect(surface()).not.toMatch(/\b\d{1,2}:\d{2}\b/);
  });

  it("card offline: o ESTADO aparece, o tempo não", async () => {
    db.admin = true;
    await draw(base({ online: false, communicationStatus: "offline" } as Partial<Pump>));
    expect(surface()).toMatch(/Offline/i);
    expect(surface()).not.toMatch(/\bhá\s+\d+/i);
    expect(surface()).not.toMatch(/\b\d+\s*min\b/i);
  });

  it("card instável (era quando o selo aparecia): nada de tempo", async () => {
    db.admin = true;
    await draw(base({ communicationStatus: "unstable" } as Partial<Pump>));
    expect(surface()).not.toMatch(/\b\d+\s*min\b/i);
    expect(screen.queryByTestId("technical-comm-age")).toBeNull();
  });
});

// ── 7 e 8: com a chave ligada ──────────────────────────────────────────────
describe("7 e 8. chave LIGADA", () => {
  it("7. platform_admin vê o tempo", async () => {
    db.admin = true; db.pref = true;
    await draw(base());
    await waitFor(() => expect(screen.queryByTestId("technical-comm-age")).not.toBeNull());
    expect(screen.getByTestId("technical-comm-age").textContent).toMatch(/13min/);
  });

  it("7. platform_support vê o tempo", async () => {
    db.support = true; db.pref = true;
    await draw(base());
    await waitFor(() => expect(screen.queryByTestId("technical-comm-age")).not.toBeNull());
  });

  it("8. usuário NÃO técnico não vê, mesmo com a preferência ligada", async () => {
    db.pref = true;                       // preferência ligada indevidamente
    await draw(base());
    expect(screen.queryByTestId("technical-comm-age")).toBeNull();
    for (const [n, re] of VAZAMENTOS)
      expect(surface(), `vazou ${n} para não técnico`).not.toMatch(re);
  });
});

// ── 9: nada operacional mudou ──────────────────────────────────────────────
describe("9. cores, comando, Realtime e manutenção intactos", () => {
  it("verde quando ligada, com e sem a chave", async () => {
    for (const pref of [false, true]) {
      db.admin = true; db.pref = pref;
      await draw(base({ running: true }));
      expect(document.querySelector("div > div")?.className).toMatch(/bg-primary/);
    }
  });

  it("o toggle continua acionando a bomba", async () => {
    const onToggle = vi.fn();
    await draw(base({ running: false }), { onToggle });
    (document.querySelector('[role="switch"]') as HTMLElement)?.click();
    expect(onToggle).toHaveBeenCalledWith("p1");
  });

  it("manutenção continua bloqueando", async () => {
    const onToggle = vi.fn();
    await draw(base({ running: false }), { inMaintenance: true, onToggle });
    (document.querySelector('[role="switch"]') as HTMLElement)?.click();
    expect(onToggle).not.toHaveBeenCalled();
    expect(document.body.textContent).toMatch(/MANUTENÇÃO/);
  });

  it("nome e estado do poço continuam visíveis", async () => {
    await draw(base());
    expect(document.body.textContent).toContain("POÇO 12 R6");
    expect(document.querySelector('[role="switch"]')).not.toBeNull();
  });
});
