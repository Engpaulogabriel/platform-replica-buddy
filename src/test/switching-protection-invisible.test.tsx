// @vitest-environment jsdom
// O cliente não pode ver — nem suspeitar — que a proteção de comutação existe.
// Nenhum badge, cadeado, contador, tooltip ou texto no card, para NENHUM perfil.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PumpCard } from "@/components/dashboard/PumpCard";
import type { Pump } from "@/components/dashboard/PumpTable";

vi.mock("@/contexts/MaintenanceContext", () => ({ useOpenMaintenance: () => ({ getForEquipment: () => null }) }));
vi.mock("@/contexts/MasterManagerContext", () => ({ usePermission: () => true }));

const base = (over: Partial<Pump> = {}): Pump => ({
  id: "p1", name: "POÇO 12 R6", running: true, online: true,
  communicationStatus: "online", lastCommunication: new Date().toISOString(),
  signalRF: 72, mode: "manual", sector: "", farmId: "f",
  ...over,
} as unknown as Pump);

const draw = (p: Pump, extra: Record<string, unknown> = {}) => {
  document.body.innerHTML = "";
  return render(
    <PumpCard
      pump={p} expanded refreshing={false} lastFailed={false}
      isGuarded={false} userOnline maintenanceActive={false}
      farms={[]} sectors={[]} guardFarmId={null} virtualize={false}
      onToggle={() => {}} onRefresh={() => {}} onOpenDialog={() => {}} onToggleExpand={() => {}}
      {...extra}
    />);
};

/** texto + todos os atributos que viram tooltip/leitor de tela */
function surface(): string {
  const attrs: string[] = [];
  document.body.querySelectorAll("*").forEach((el) => {
    for (const a of ["title", "aria-label", "alt", "data-tooltip", "data-testid"]) {
      const v = el.getAttribute(a);
      if (v) attrs.push(v);
    }
  });
  return `${document.body.textContent ?? ""}\n${attrs.join("\n")}`;
}

const PROIBIDOS: Array<[string, RegExp]> = [
  ["'Proteção de comutação'", /prote[çc][ãa]o de comuta/i],
  ["'proteção'",             /prote[çc][ãa]o/i],
  ["'aguarde'",              /aguarde/i],
  ["'trava'/'travado'",      /trav(a|ado|ada)/i],
  ["'bloqueado'",            /bloquead/i],
  ["testid do cadeado",      /switching-lock/],
  ["ícone de cadeado",       /lucide-lock/],
  ["contador em segundos",   /\b\d+\s*s\b/i],
];

// O card recebe o estado da trava vindo do Realtime. Mesmo que ele chegue —
// e ele CHEGA para poços habilitados — nada pode aparecer.
const COM_TRAVA = {
  commandLockUntil: Date.now() + 30_000,
  lastConfirmedTransitionAt: Date.now(),
} as Partial<Pump>;

describe("a proteção de comutação é invisível no card", () => {
  for (const cenario of [
    { nome: "sem trava",                p: base() },
    { nome: "COM trava ativa",          p: base(COM_TRAVA) },
    { nome: "COM trava, bomba ligada",  p: base({ ...COM_TRAVA, running: true }) },
    { nome: "COM trava, bomba desligada", p: base({ ...COM_TRAVA, running: false }) },
    { nome: "COM trava e offline",      p: base({ ...COM_TRAVA, online: false, communicationStatus: "offline" }) },
    { nome: "COM trava e instável",     p: base({ ...COM_TRAVA, communicationStatus: "unstable" }) },
  ]) {
    it(`${cenario.nome}: nenhum vestígio da função`, () => {
      draw(cenario.p);
      const s = surface();
      for (const [nome, re] of PROIBIDOS)
        expect(s, `vazou ${nome} (${cenario.nome})`).not.toMatch(re);
    });
  }

  it("o badge de trava não existe mais no DOM", () => {
    draw(base(COM_TRAVA));
    expect(screen.queryByTestId("switching-lock")).toBeNull();
  });

  it("o comando continua LIBERADO no card mesmo com trava recebida", () => {
    // quem recusa é o servidor, e só se o poço estiver habilitado. O card não
    // desabilita o toggle por conta própria — o cliente não percebe diferença.
    const onToggle = vi.fn();
    draw(base({ ...COM_TRAVA, running: false }), { onToggle });
    const sw = document.querySelector('[role="switch"]') as HTMLElement;
    expect(sw.hasAttribute("disabled")).toBe(false);
    sw.click();
    expect(onToggle).toHaveBeenCalledWith("p1");
  });

  it("manutenção continua bloqueando normalmente (não foi afetada)", () => {
    const onToggle = vi.fn();
    draw(base({ running: false }), { inMaintenance: true, onToggle });
    (document.querySelector('[role="switch"]') as HTMLElement)?.click();
    expect(onToggle).not.toHaveBeenCalled();
    expect(document.body.textContent).toMatch(/MANUTENÇÃO/);
  });

  it("o card segue mostrando o essencial: nome e estado", () => {
    draw(base(COM_TRAVA));
    expect(document.body.textContent).toContain("POÇO 12 R6");
    expect(document.querySelector('[role="switch"]')).not.toBeNull();
  });
});
