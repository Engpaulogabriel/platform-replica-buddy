// @vitest-environment jsdom
// O ícone de atualização do card é o ORIGINAL e DINÂMICO:
//   normal → RefreshCw
//   atualizando → RefreshCw girando
//   confirmado → CheckCircle2
//   falha → AlertTriangle
// A única mudança autorizada: comunicação instável não pinta o ícone de AZUL.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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

const props = (p: Pump, extra: Record<string, unknown> = {}) => ({
  pump: p, expanded: true, refreshing: false, lastFailed: false,
  isGuarded: false, userOnline: true, maintenanceActive: false,
  farms: [], sectors: [], guardFarmId: null, virtualize: false,
  onToggle: () => {}, onRefresh: () => {}, onOpenDialog: () => {}, onToggleExpand: () => {},
  ...extra,
});

const draw = (p: Pump, extra: Record<string, unknown> = {}) => {
  document.body.innerHTML = "";
  return render(<PumpCard {...(props(p, extra) as never)} />);
};

const botao = () => screen.getByTestId("pump-refresh-button");
const icone = () => botao().querySelector("svg")?.getAttribute("class") ?? "";

const AZUIS = ["text-info", "bg-info", "border-info", "text-sky", "text-blue"];

describe("sequência visual do ícone de atualização", () => {
  it("normal → clique → girando → OK → CheckCircle2 → volta a RefreshCw", () => {
    const onRefresh = vi.fn();
    const { rerender } = draw(base(), { onRefresh });

    // 1) estado normal: RefreshCw parado
    expect(icone()).toContain("lucide-refresh-cw");
    expect(icone()).not.toContain("animate-spin");

    // 2) clique abre o popover original (é de lá que sai o refresh manual)
    fireEvent.click(botao());
    const manual = screen.getByText(/Atualizar status agora/i);
    fireEvent.click(manual);
    expect(onRefresh).toHaveBeenCalledWith("p1");

    // 3) durante a atualização: MESMO RefreshCw, agora girando
    rerender(<PumpCard {...(props(base(), { onRefresh, refreshing: true }) as never)} />);
    expect(icone()).toContain("lucide-refresh-cw");
    expect(icone()).toContain("animate-spin");

    // 4) resposta OK: ícone de sucesso original
    rerender(<PumpCard {...(props(base(), { onRefresh, refreshResult: "success" }) as never)} />);
    expect(icone()).toContain("lucide-circle-check");
    expect(botao().className).toContain("text-primary");

    // 5) passado o efeito, volta ao RefreshCw normal
    rerender(<PumpCard {...(props(base(), { onRefresh }) as never)} />);
    expect(icone()).toContain("lucide-refresh-cw");
    expect(icone()).not.toContain("animate-spin");
  });

  it("falha mantém o ícone de erro original, com a cor de erro", () => {
    draw(base(), { refreshResult: "fail", lastFailed: true });
    expect(icone()).toContain("lucide-triangle-alert");
    expect(botao().className).toContain("text-destructive");
  });

  it("atualizando após falha usa a cor de erro, sem trocar o ícone girando", () => {
    draw(base(), { refreshing: true, lastFailed: true });
    expect(icone()).toContain("lucide-refresh-cw");
    expect(icone()).toContain("animate-spin");
    expect(botao().className).toContain("text-destructive");
  });

  it("offline mantém o botão, em cor neutra", () => {
    draw(base({ online: false, communicationStatus: "offline" } as Partial<Pump>));
    expect(icone()).toContain("lucide-refresh-cw");
    expect(botao().className).toContain("text-muted-foreground");
  });

  it("o botão de atualizar continua existindo em todos os estados", () => {
    for (const p of [
      base(), base({ running: false }),
      base({ communicationStatus: "unstable" }),
      base({ online: false, communicationStatus: "offline" }),
      base({ pending: "turning_on" } as Partial<Pump>),
    ]) {
      draw(p);
      expect(screen.queryByTestId("pump-refresh-button")).not.toBeNull();
    }
  });
});

describe("instável não é azul", () => {
  it("isUnstable mantém o MESMO RefreshCw, na cor operacional, sem azul", () => {
    draw(base({ communicationStatus: "unstable" } as Partial<Pump>));
    expect(icone()).toContain("lucide-refresh-cw");
    expect(botao().className).toContain("text-primary");
    for (const c of AZUIS)
      expect(botao().className, `ícone azul indevido: ${c}`).not.toContain(c);
  });

  it("instável e estável mostram exatamente o mesmo ícone e a mesma cor", () => {
    draw(base({ communicationStatus: "online" } as Partial<Pump>));
    const estavel = { icone: icone(), cor: botao().className };
    draw(base({ communicationStatus: "unstable" } as Partial<Pump>));
    expect({ icone: icone(), cor: botao().className }).toEqual(estavel);
  });

  it("azul continua reservado à manutenção técnica", () => {
    draw(base({ communicationStatus: "unstable" } as Partial<Pump>));
    expect(document.body.innerHTML).not.toContain("text-info");
    draw(base(), { inMaintenance: true });
    expect(document.body.innerHTML).toContain("text-info");   // azul legítimo
  });
});

describe("nada de comando/Realtime foi alterado", () => {
  it("o toggle continua funcionando", () => {
    const onToggle = vi.fn();
    draw(base({ running: false }), { onToggle });
    (document.querySelector('[role="switch"]') as HTMLElement)?.click();
    expect(onToggle).toHaveBeenCalledWith("p1");
  });

  it("clicar no ícone não aciona a bomba", () => {
    const onToggle = vi.fn();
    draw(base(), { onToggle });
    botao().click();
    expect(onToggle).not.toHaveBeenCalled();
  });
});
