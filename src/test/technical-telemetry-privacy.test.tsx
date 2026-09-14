// @vitest-environment jsdom
// PRIVACIDADE — tempo e diagnóstico de comunicação só para platform_admin e
// técnico (platform_support). Owner, admin de fazenda, supervisor, gestor,
// operador e viewer não podem ver NADA disso: nem texto, nem title, nem
// aria-label, nem elemento no DOM.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { Pump } from "@/components/dashboard/PumpTable";

vi.mock("@/contexts/MaintenanceContext", () => ({ useOpenMaintenance: () => ({ getForEquipment: () => null }) }));
vi.mock("@/contexts/MasterManagerContext", () => ({ usePermission: () => true }));

// ── Banco falso: controla APENAS quem está em platform_admins/platform_support.
const membership = { admin: false, support: false };
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
vi.mock("@/lib/realtimeKillSwitch", () => ({
  getRealtimeChannel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
  removeRealtimeChannel: async () => {},
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    // Este arquivo isola a dimensão PERMISSÃO. A chave "Exibir tempos técnicos"
    // fica LIGADA aqui de propósito, para provar que, mesmo ligada, quem não é
    // staff técnico continua sem ver nada. O padrão desligado é coberto em
    // technical-times-key.test.tsx.
    rpc: async () => ({ data: true, error: null }),
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data:
              (table === "platform_admins" && membership.admin) ||
              (table === "platform_support" && membership.support)
                ? { user_id: "u1" }
                : null,
            error: null,
          }),
        }),
      }),
    }),
  },
}));

const { PumpCard } = await import("@/components/dashboard/PumpCard");
const { TechnicalTelemetryProvider } = await import("@/hooks/useTechnicalTelemetry");

const base = (over: Partial<Pump> = {}): Pump => ({
  id: "poco-12", name: "POÇO 12 R6", running: true, online: true,
  communicationStatus: "online",
  lastCommunication: new Date(Date.now() - 7 * 60_000).toISOString(),
  lastReading: "14/08/2026 07:19:33",
  signalRF: 72, voltage: 0, current: 0, horimetroMes: "123.4h",
  mode: "manual", sector: "", farmId: "f",
  ...over,
} as unknown as Pump);

async function draw(p: Pump) {
  document.body.innerHTML = "";
  const r = render(
    <TechnicalTelemetryProvider>
      <PumpCard
        pump={p} expanded refreshing={false} lastFailed={false}
        isGuarded={false} userOnline maintenanceActive={false}
        farms={[]} sectors={[]} guardFarmId={null} virtualize={false}
        onToggle={() => {}} onRefresh={() => {}} onOpenDialog={() => {}} onToggleExpand={() => {}}
      />
    </TechnicalTelemetryProvider>);
  // O provider começa FECHADO e só depois decide. Espera a decisão chegar:
  // para quem tem acesso, algum elemento técnico precisa aparecer (o badge de
  // idade some em offline, então o sinal RF serve de âncora nesse caso).
  if (membership.admin || membership.support) {
    await waitFor(() => {
      const algum = screen.queryByTestId("technical-comm-age")
                 ?? screen.queryByTestId("technical-signal-rf");
      expect(algum).not.toBeNull();
    });
  } else {
    // para perfil comum não há o que esperar aparecer; garante que o efeito
    // do provider já rodou e mesmo assim nada técnico foi criado.
    await waitFor(() => expect(screen.queryByTestId("technical-comm-age")).toBeNull());
  }
  return r;
}

/** Todo texto visível + todos os atributos que viram tooltip/leitor de tela. */
function surface(): string {
  const attrs: string[] = [];
  document.body.querySelectorAll("*").forEach((el) => {
    for (const a of ["title", "aria-label", "alt", "data-tooltip"]) {
      const v = el.getAttribute(a);
      if (v) attrs.push(v);
    }
  });
  return `${document.body.textContent ?? ""}\n${attrs.join("\n")}`;
}

const PROIBIDOS: Array<[string, RegExp]> = [
  ["minutos relativos",     /\b\d+\s*min\b/i],
  ["segundos relativos",    /\b\d+\s*(s|seg|segundos)\b/i],
  ["relógio HH:MM",         /\b\d{1,2}:\d{2}\b/],
  ["data",                  /\b\d{2}\/\d{2}\/\d{4}\b/],
  ["'última comunicação'",  /última comunica/i],
  ["'última leitura'",      /última leitura/i],
  ["'há ... min'",          /\bhá\s+\d+/i],
  ["latência",              /lat[êe]ncia/i],
  ["sinal RF",              /sinal rf/i],
  ["RX/TX",                 /\b(rx|tx)\b/i],
  ["lastCommunication",     /lastCommunication/i],
  ["lastSeen",              /lastSeen/i],
];

beforeEach(() => { membership.admin = false; membership.support = false; });

describe("privacidade da telemetria técnica", () => {

  // ── QUEM PODE ────────────────────────────────────────────────────────────
  it("platform_admin VÊ o badge de idade da leitura", async () => {
    membership.admin = true;
    await draw(base());
    const badge = screen.getByTestId("technical-comm-age");
    expect(badge.textContent).toMatch(/\d+min/);
  });

  it("técnico cadastrado em platform_support VÊ o badge", async () => {
    membership.support = true;
    await draw(base());
    expect(screen.getByTestId("technical-comm-age").textContent).toMatch(/\d+min/);
  });

  it("as barras de comunicação existem para TODOS, sem número nem tooltip técnico", async () => {
    // A versão atual substituiu o elemento `technical-signal-rf` (exclusivo de
    // admin) pelas barras OPERACIONAIS `comm-bars`, visíveis a todos os
    // perfis. A privacidade não regrediu, e é isso que se verifica aqui: o
    // cliente vê só a QUANTIDADE de barras — sem número, sem porcentagem, sem
    // minutos, sem tooltip. O tempo no `title` continua atrás de `showTimes`.
    await draw(base());
    const barras = screen.queryByTestId("comm-bars");
    expect(barras).not.toBeNull();
    expect(barras?.getAttribute("title")).toBeNull();      // sem tooltip técnico
    expect(barras?.textContent ?? "").not.toMatch(/\d/);   // sem número/percentual
  });

  it("com a chave ligada, admin ganha o tempo no tooltip das barras", async () => {
    membership.admin = true;
    await draw(base());
    const barras = screen.queryByTestId("comm-bars");
    expect(barras?.getAttribute("title") ?? "").toMatch(/Última resposta física/);
  });

  // ── QUEM NÃO PODE ────────────────────────────────────────────────────────
  const COMUNS = ["owner", "admin de fazenda", "supervisor", "gestor", "operador", "viewer"];
  for (const perfil of COMUNS) {
    it(`${perfil}: nenhum elemento técnico existe no DOM`, async () => {
      await draw(base());
      expect(screen.queryByTestId("technical-comm-age")).toBeNull();
      expect(screen.queryByTestId("technical-signal-rf")).toBeNull();
    });
  }

  it("perfil comum: nenhum padrão de tempo/técnico em texto, title ou aria-label", async () => {
    await draw(base());
    const s = surface();
    for (const [nome, re] of PROIBIDOS) {
      expect(s, `vazou ${nome}: ${re}`).not.toMatch(re);
    }
  });

  it("perfil comum: nem no card OFFLINE aparece tempo", async () => {
    await draw(base({ online: false, communicationStatus: "offline" } as Partial<Pump>));
    const s = surface();
    expect(s).toMatch(/Offline/i);                    // o ESTADO continua visível
    expect(s).toMatch(/Sem comunicação com o equipamento/); // frase sem minutos
    for (const [nome, re] of PROIBIDOS) {
      expect(s, `vazou ${nome} no offline: ${re}`).not.toMatch(re);
    }
  });

  it("admin no card OFFLINE recebe o tempo no title", async () => {
    membership.admin = true;
    await draw(base({ online: false, communicationStatus: "offline" } as Partial<Pump>));
    expect(surface()).toMatch(/Sem comunicação há \d+ min/);
  });

  // ── O QUE NÃO PODE MUDAR PARA NINGUÉM ────────────────────────────────────
  it("o card do perfil comum é o do admin MENOS os elementos técnicos", async () => {
    // perfil comum
    await draw(base());
    const comum = document.body.innerHTML;
    expect(comum).toContain("POÇO 12 R6");          // identidade operacional intacta
    expect(comum).not.toContain("technical-comm-age");
    // `technical-signal-rf` deixou de existir: as barras viraram operacionais
    // (`comm-bars`) e aparecem para todos, sem número nem tooltip.
    expect(comum).toContain("comm-bars");

    // admin: mesmo card, agora COM os técnicos
    membership.admin = true;
    await draw(base());
    const admin = document.body.innerHTML;
    expect(admin).toContain("POÇO 12 R6");
    expect(admin).toContain("technical-comm-age");
    expect(admin).toContain("comm-bars");

    // Removendo do DOM só os nós marcados como técnicos, sobra exatamente o
    // card do perfil comum: o gate não mexeu em cor, controle nem rótulo.
    document.querySelectorAll('[data-testid^="technical-"]').forEach((el) => el.remove());
    // O gate técnico deixou de ser SÓ nó: nas barras operacionais ele é um
    // ATRIBUTO (`title` com o tempo), presente para admin e ausente para o
    // perfil comum. Tirar o title junto é o equivalente a "remover o técnico".
    document.querySelectorAll('[data-testid="comm-bars"]').forEach((el) => el.removeAttribute("title"));
    // os ids do Radix são gerados por render; normaliza para comparar estrutura
    const norm = (h: string) => h.replace(/radix-:[^:]*:/g, "radix-id").replace(/\s+/g, "");
    expect(norm(document.body.innerHTML)).toBe(norm(comum));
  });

  it("a cor Offline continua valendo para perfil comum (regra dos 15 min intacta)", async () => {
    await draw(base({ online: false, communicationStatus: "offline" } as Partial<Pump>));
    // o badge de estado existe; o que sumiu foi o número, não a cor
    expect(document.body.textContent).toMatch(/Offline/i);
    expect(screen.queryByTestId("technical-comm-age")).toBeNull();
  });

  it("o controle da bomba continua presente para perfil comum", async () => {
    await draw(base());
    expect(document.querySelector('[role="switch"], input[type="checkbox"], button')).not.toBeNull();
  });

  // ── FALHA FECHADA ────────────────────────────────────────────────────────
  it("sem Provider (falha fechada) nada técnico é renderizado", async () => {
    document.body.innerHTML = "";
    render(
      <PumpCard
        pump={base()} expanded refreshing={false} lastFailed={false}
        isGuarded={false} userOnline maintenanceActive={false}
        farms={[]} sectors={[]} guardFarmId={null} virtualize={false}
        onToggle={() => {}} onRefresh={() => {}} onOpenDialog={() => {}} onToggleExpand={() => {}}
      />);
    expect(screen.queryByTestId("technical-comm-age")).toBeNull();
    expect(screen.queryByTestId("technical-signal-rf")).toBeNull();
  });
});
