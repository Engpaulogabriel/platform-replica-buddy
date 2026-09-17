// @vitest-environment node
// Só a UI do cabeçalho saiu. Todo o encanamento de Realtime — canal,
// subscription em public.equipments, atualização sem F5 — continua intacto.
import { describe, it, expect } from "vitest";
import fs from "node:fs"; import path from "node:path";
const REPO = path.resolve(__dirname, "../..");
const src = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");

const DASH  = src("src/pages/Dashboard.tsx");
const HOOK  = src("src/hooks/useCadastrosCloud.ts");
const KILL  = src("src/lib/realtimeKillSwitch.ts");
const CARD  = src("src/components/dashboard/PumpCard.tsx");

describe("1. o cabeçalho decorativo não existe mais", () => {
  it("o Dashboard não renderiza mais 'Monitoramento em tempo real'", () => {
    expect(DASH).not.toContain("t.realTimeMonitoring");
    expect(DASH).not.toContain("Monitoramento em tempo real");
  });

  it("não há badge de canal conectado no Dashboard", () => {
    expect(DASH).not.toContain("Tempo real conectado");
    expect(DASH).not.toContain("RealtimeHealthBadge");
    expect(DASH).not.toMatch(/realtimeHealth/i);
  });

  it("a linha do cabeçalho encolheu — o bloco de texto à esquerda saiu", () => {
    // sem o lado esquerdo, os botões seguem à direita e INDICADORES sobe
    expect(DASH).toContain('sm:justify-end');
    expect(DASH).not.toMatch(/<div>\s*<p className="text-xs text-muted-foreground">\{t\.realTimeMonitoring\}/);
  });
});

describe("2. o Realtime continua ligado — nada foi desmontado", () => {
  it("getRealtimeChannel continua exportado e disponível", () => {
    expect(KILL).toContain("export function getRealtimeChannel");
    expect(KILL).toContain("export async function removeRealtimeChannel");
  });

  it("a subscription de public.equipments continua no hook", () => {
    expect(HOOK).toContain("postgres_changes");
    expect(HOOK).toMatch(/table:\s*["']equipments["']/);
  });

  it("o Dashboard continua consumindo o hook que atualiza sem F5", () => {
    expect(DASH).toMatch(/useCadastrosCloud|useDashboardEquipment/);
    // e o hook segue assinando o canal, com o handler que aplica a mudança
    expect(HOOK).toContain("handleEquipmentChange");
    expect(HOOK).toContain(".subscribe(");
  });

  it("nenhuma chamada de unsubscribe/removeChannel foi acrescentada ao Dashboard", () => {
    expect(DASH).not.toContain("removeRealtimeChannel(");
    expect(DASH).not.toMatch(/\.unsubscribe\(\)/);
  });
});

describe("3. o estado visual das bombas não foi tocado", () => {
  it("Ligado, Desligado e Offline continuam decididos no card", () => {
    expect(CARD).toContain('pump.communicationStatus === "offline"');
    expect(CARD).toMatch(/pump\.running \? "Ligado" : "Desligado"/);
  });

  it("o cabeçalho do mini relatório segue mostrando estado físico", () => {
    expect(CARD).toContain('data-testid="header-state"');
    expect(CARD).toMatch(/isOffline \? "Offline" : pump\.running \? "Ligado" : "Desligado"/);
  });

  it("RefreshCw e o ciclo do ícone continuam no lugar", () => {
    expect(CARD).toContain('data-testid="pump-refresh-button"');
    expect(CARD).toContain("<RefreshCw className=\"w-3.5 h-3.5 animate-spin\" />");
    expect(CARD).toContain("<CheckCircle2 className=\"w-3.5 h-3.5\" />");
  });
});

describe("4. o resto da página continua montado", () => {
  const BLOCOS = [
    ["INDICADORES",      /IndicatorsMiniSummary|Indicadores/i],
    ["Centro de Comando", /Centro de Comando|CommandCenter/i],
    ["reservatórios",    /Reservoir/i],
    ["cards/lista",      /PumpTable/],
  ] as const;

  for (const [nome, re] of BLOCOS) {
    it(`${nome} continua sendo renderizado`, () => {
      expect(DASH, `${nome} sumiu do Dashboard`).toMatch(re);
    });
  }

  it("nenhum outro elemento do cabeçalho foi removido junto", () => {
    expect(DASH).toContain("startMainTour");     // botão do tour
    expect(DASH).toContain("Header with view toggle");
  });
});
