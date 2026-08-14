// @vitest-environment jsdom
// O card operacional do poço NÃO pode exibir tempo técnico em lugar nenhum:
// nem texto, nem tooltip, nem title, nem aria-label.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PumpCard } from "@/components/dashboard/PumpCard";
import type { Pump } from "@/components/dashboard/PumpTable";

vi.mock("@/contexts/MaintenanceContext", () => ({ useOpenMaintenance: () => ({ getForEquipment: () => null }) }));
vi.mock("@/contexts/MasterManagerContext", () => ({ usePermission: () => true }));

const base = (over: Partial<Pump> = {}): Pump => ({
  id: "poco-12", name: "POÇO 12 R6", running: true, online: true,
  communicationStatus: "online",
  // valores propositalmente "gritantes": se vazarem, o teste vê
  lastCommunication: new Date(Date.now() - 7 * 60_000).toISOString(),
  lastReading: "14/08/2026 07:19:33",
  signalRF: 72, voltage: 0, current: 0, horimetroMes: "123.4h",
  mode: "manual", sector: "", farmId: "f",
  ...over,
} as unknown as Pump);

const draw = (p: Pump) => render(
  <PumpCard
    pump={p} expanded refreshing={false} lastFailed={false}
    isGuarded={false} userOnline maintenanceActive={false}
    farms={[]} sectors={[]} guardFarmId={null} virtualize={false}
    onToggle={() => {}} onRefresh={() => {}} onOpenDialog={() => {}} onToggleExpand={() => {}}
  />);

/** Junta TODO texto visível + todos os atributos que viram tooltip/leitor de tela. */
function surface(): string {
  const root = document.body;
  const attrs: string[] = [];
  root.querySelectorAll("*").forEach((el) => {
    for (const a of ["title", "aria-label", "alt", "data-tooltip"]) {
      const v = el.getAttribute(a);
      if (v) attrs.push(v);
    }
  });
  return `${root.textContent ?? ""}\n${attrs.join("\n")}`;
}

// padrões de tempo técnico proibidos no card operacional
const PROIBIDOS: Array<[string, RegExp]> = [
  ["minutos relativos",      /\b\d+\s*min\b/i],
  ["segundos relativos",     /\b\d+\s*(s|seg|segundos)\b/i],
  ["horas relativas",        /\b\d+\s*h\b(?!\w)/i],
  ["relógio HH:MM",          /\b\d{1,2}:\d{2}\b/],
  ["data",                   /\b\d{2}\/\d{2}\/\d{4}\b/],
  ["'última comunicação'",   /última comunica/i],
  ["'última leitura'",       /última leitura/i],
  ["'há ... min'",           /\bhá\s+\d+/i],
  ["latência",               /lat[êe]ncia/i],
];

describe("PumpCard não expõe tempo técnico", () => {
  for (const estado of [
    { nome: "ligado",   p: base() },
    { nome: "desligado", p: base({ running: false }) },
    { nome: "offline",  p: base({ online: false, communicationStatus: "offline" }) },
    { nome: "instável", p: base({ communicationStatus: "unstable" }) },
    { nome: "em transição", p: base({ pending: "turning_off", pendingStartedAt: Date.now() } as Partial<Pump>) },
    { nome: "comando não confirmado", p: base({ commandUnconfirmedAt: Date.now() } as Partial<Pump>) },
    { nome: "com proteção de comutação", p: base({ commandLockUntil: Date.now() + 30_000,
        lastConfirmedTransitionAt: Date.now() } as Partial<Pump>) },
  ]) {
    it(`estado ${estado.nome}: nenhum padrão de tempo aparece`, () => {
      document.body.innerHTML = "";
      draw(estado.p);
      const txt = surface();
      for (const [rotulo, re] of PROIBIDOS) {
        expect(re.test(txt), `${rotulo} vazou no card (${estado.nome}): ${txt.match(re)?.[0]}`).toBe(false);
      }
    });
  }

  it("o selo '7min' que aparecia em produção não existe mais", () => {
    document.body.innerHTML = "";
    draw(base({ communicationStatus: "unstable" }));
    expect(surface()).not.toMatch(/⏱/);
    expect(surface()).not.toMatch(/\d+min/);
  });


  it("o card continua mostrando o que é operacional", () => {
    document.body.innerHTML = "";
    draw(base());
    expect(surface()).toMatch(/POÇO 12 R6/);
  });
});
