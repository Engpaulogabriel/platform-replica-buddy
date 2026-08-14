// @vitest-environment jsdom
// O card operacional não pode exibir ícone de carregamento/refresh/polling,
// e AZUL é exclusivo de manutenção técnica (maintenance_mode).
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PumpCard } from "@/components/dashboard/PumpCard";
import type { Pump } from "@/components/dashboard/PumpTable";

vi.mock("@/contexts/MaintenanceContext", () => ({ useOpenMaintenance: () => ({ getForEquipment: () => null }) }));
vi.mock("@/contexts/MasterManagerContext", () => ({ usePermission: () => true }));

const base = (over: Partial<Pump> = {}): Pump => ({
  id: "p1", name: "POÇO 12 R6", running: true, online: true,
  communicationStatus: "online",
  lastCommunication: new Date().toISOString(),
  signalRF: 72, voltage: 220, current: 3, mode: "manual", sector: "", farmId: "f",
  ...over,
} as unknown as Pump);

function draw(p: Pump, extra: Record<string, unknown> = {}) {
  document.body.innerHTML = "";
  return render(
    <PumpCard
      pump={p} expanded refreshing={false} lastFailed={false}
      isGuarded={false} userOnline maintenanceActive={false}
      farms={[]} sectors={[]} guardFarmId={null} virtualize={false}
      onToggle={() => {}} onRefresh={() => {}} onOpenDialog={() => {}} onToggleExpand={() => {}}
      {...extra}
    />);
}
const html = () => document.body.innerHTML;

// lucide gera class="lucide lucide-<nome>"
const ICONES_CARREGAMENTO = [
  "lucide-refresh-cw", "lucide-refresh-ccw", "lucide-rotate-cw", "lucide-rotate-ccw",
  "lucide-loader", "lucide-loader-2", "lucide-loader-circle",
];
const CLASSES_AZUIS = [
  "text-info", "bg-info", "border-info",
  "text-sky", "bg-sky", "border-sky",
  "text-blue", "bg-blue", "border-blue",
];

describe("card sem ícone de carregamento", () => {

  for (const estado of [
    { nome: "online ligado",   p: base() },
    { nome: "online desligado", p: base({ running: false }) },
    { nome: "instável (latência — era o caso da Sykue)", p: base({ communicationStatus: "unstable" }) },
    { nome: "offline",         p: base({ online: false, communicationStatus: "offline" }) },
    { nome: "em transição",    p: base({ pending: "turning_on", pendingStartedAt: Date.now() } as Partial<Pump>) },
  ]) {
    it(`${estado.nome}: nenhum ícone de refresh/loader no card`, () => {
      draw(estado.p);
      for (const c of ICONES_CARREGAMENTO)
        expect(html(), `ícone de carregamento presente: ${c}`).not.toContain(c);
    });

    it(`${estado.nome}: nenhuma animação de spinner`, () => {
      draw(estado.p);
      expect(html()).not.toContain("animate-spin");
    });
  }

  it("mesmo com refreshing=true o card não mostra spinner", () => {
    draw(base(), { refreshing: true });
    expect(html()).not.toContain("animate-spin");
    for (const c of ICONES_CARREGAMENTO) expect(html()).not.toContain(c);
  });

  it("refreshResult success/fail não vira ícone de estado no card", () => {
    draw(base(), { refreshResult: "success" });
    expect(html()).not.toContain("lucide-check-circle");
    draw(base(), { refreshResult: "fail", lastFailed: true });
    expect(html()).not.toContain("lucide-alert-triangle");
  });

  it("o acesso aos detalhes continua existindo, em cor neutra", () => {
    draw(base());
    const t = screen.getByTestId("pump-details-trigger");
    expect(t.className).toContain("text-muted-foreground");
    for (const c of CLASSES_AZUIS) expect(t.className).not.toContain(c);
  });
});

describe("azul é exclusivo de manutenção técnica", () => {

  it("sem manutenção: NENHUMA classe azul no card", () => {
    for (const p of [
      base(),
      base({ running: false }),
      base({ communicationStatus: "unstable" }),
      base({ online: false, communicationStatus: "offline" }),
      base({ mode: "auto" } as Partial<Pump>),
      base({ actuationOrigin: "tech_terminal" } as Partial<Pump>),
      base({ actuationOrigin: "local" } as Partial<Pump>),
    ]) {
      draw(p);
      for (const c of CLASSES_AZUIS)
        expect(html(), `azul indevido (${c}) no card sem manutenção`).not.toContain(c);
    }
  });

  it("o badge AUTO existe mas NÃO é azul", () => {
    draw(base({ mode: "auto" } as Partial<Pump>));
    expect(html()).toContain("AUTO");
    for (const c of CLASSES_AZUIS) expect(html()).not.toContain(c);
  });

  it("o badge TÉCNICO existe mas NÃO é azul", () => {
    draw(base({ actuationOrigin: "tech_terminal" } as Partial<Pump>));
    expect(html()).toContain("TÉCNICO");
    for (const c of CLASSES_AZUIS) expect(html()).not.toContain(c);
  });

  it("COM maintenance_mode: o azul aparece — e só aí", () => {
    draw(base(), { inMaintenance: true });
    expect(html()).toContain("MANUTENÇÃO");
    expect(html()).toContain("text-info");   // azul legítimo
  });
});

describe("cores operacionais preservadas", () => {
  const cor = (p: Pump, extra: Record<string, unknown> = {}) => {
    draw(p, extra);
    return document.querySelector("div > div")?.className ?? "";
  };

  it("verde quando ligada", () => {
    expect(cor(base({ running: true }))).toMatch(/bg-primary/);
  });

  it("vermelho/neutro quando desligada, sem verde", () => {
    expect(cor(base({ running: false }))).not.toMatch(/bg-primary\/25/);
  });

  it("cinza quando offline", () => {
    expect(cor(base({ online: false, communicationStatus: "offline" } as Partial<Pump>)))
      .toMatch(/muted|border-border/);
  });

  it("amarelo continua sendo manutenção da fazenda, não azul", () => {
    // (a ordem de manutenção vem do contexto; aqui garante que o amarelo do
    //  projeto não foi trocado por azul em lugar nenhum do card)
    draw(base());
    expect(html()).not.toContain("bg-info");
  });
});

describe("nada de comando/Realtime foi alterado", () => {
  it("o toggle continua presente e habilitado", () => {
    draw(base());
    const sw = document.querySelector('[role="switch"]');
    expect(sw).not.toBeNull();
    expect(sw?.getAttribute("data-state")).toBe("checked");
  });

  it("onToggle continua sendo chamado ao acionar", async () => {
    const onToggle = vi.fn();
    draw(base({ running: false }), { onToggle });
    (document.querySelector('[role="switch"]') as HTMLElement)?.click();
    expect(onToggle).toHaveBeenCalledWith("p1");
  });

  it("em manutenção o comando continua bloqueado", () => {
    const onToggle = vi.fn();
    draw(base({ running: false }), { inMaintenance: true, onToggle });
    const sw = document.querySelector('[role="switch"]') as HTMLElement | null;
    // bloqueio pode ser switch desabilitado OU cadeado no lugar do switch;
    // o que importa é que acionar não dispara comando.
    sw?.click();
    expect(onToggle).not.toHaveBeenCalled();
  });
});
