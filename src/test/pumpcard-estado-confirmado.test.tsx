import fs from "node:fs";
import path from "node:path";
// @vitest-environment jsdom
// Card e toggle devem sempre representar o MESMO estado confirmado da bomba.
// Falha de comunicação não pode fazer o card parecer DESLIGADO.
import { describe, it, expect, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { PumpCard } from "@/components/dashboard/PumpCard";
import type { Pump } from "@/components/dashboard/PumpTable";

vi.mock("@/contexts/MaintenanceContext", () => ({ useOpenMaintenance: () => ({ getForEquipment: () => null }) }));
vi.mock("@/contexts/MasterManagerContext", () => ({ usePermission: () => true }));

const base = (o: Partial<Pump> = {}): Pump => ({
  id: "p6", name: "POÇO 06 R1 R4", running: true, online: true,
  communicationStatus: "online", lastCommunication: new Date().toISOString(),
  signalRF: 72, mode: "manual", sector: "", farmId: "f", ...o,
} as unknown as Pump);

function draw(p: Pump) {
  cleanup();
  render(<PumpCard pump={p} expanded refreshing={false} lastFailed={false}
    isGuarded={false} userOnline maintenanceActive={false}
    farms={[]} sectors={[]} guardFarmId={null} virtualize={false}
    onToggle={() => {}} onRefresh={() => {}} onOpenDialog={() => {}} onToggleExpand={() => {}} />);
}
/** classe do container do card = cor operacional */
const cor = () => document.querySelector("div > div")?.className ?? "";
/** o toggle reflete o estado confirmado */
const toggleLigado = () =>
  document.querySelector('[role="switch"]')?.getAttribute("data-state") === "checked";

const verde    = (c: string) => /bg-primary\/25/.test(c);
const vermelho = (c: string) => /bg-destructive\/20/.test(c);
const cinza    = (c: string) => /bg-muted\/60/.test(c);

describe("2. DESLIGAR falha por timeout — o bug relatado", () => {
  it("POÇO 06 R1 R4 ligado, comm_fail → card VERDE e toggle LIGADO", () => {
    draw(base({ running: true, pending: "comm_fail" } as Partial<Pump>));
    expect(verde(cor()), "card deveria seguir o estado confirmado").toBe(true);
    expect(vermelho(cor())).toBe(false);
    expect(toggleLigado()).toBe(true);
  });

  it("card e toggle NUNCA divergem com comm_fail", () => {
    for (const running of [true, false]) {
      draw(base({ running, pending: "comm_fail" } as Partial<Pump>));
      expect(verde(cor()), `running=${running}`).toBe(running);
      expect(toggleLigado(), `running=${running}`).toBe(running);
    }
  });

  it("pending 'error' também não inverte o estado operacional", () => {
    draw(base({ running: true, pending: "error" } as Partial<Pump>));
    expect(vermelho(cor())).toBe(false);
    expect(toggleLigado()).toBe(true);
  });
});

describe("1, 3 e 4. cenários que já funcionavam continuam iguais", () => {
  it("1. desligamento confirmado → card vermelho, toggle desligado", () => {
    draw(base({ running: false }));
    expect(vermelho(cor())).toBe(true);
    expect(toggleLigado()).toBe(false);
  });

  it("3. ligamento confirmado → card verde, toggle ligado", () => {
    draw(base({ running: true }));
    expect(verde(cor())).toBe(true);
    expect(toggleLigado()).toBe(true);
  });

  it("4. LIGAR falha (segue desligado) → card vermelho, toggle desligado", () => {
    draw(base({ running: false, pending: "comm_fail" } as Partial<Pump>));
    expect(vermelho(cor())).toBe(true);
    expect(toggleLigado()).toBe(false);
  });
});

describe("5. estado é idêntico antes e depois do refresh", () => {
  it("comm_fail (antes) e sem pending (depois do reload) dão a mesma cor", () => {
    draw(base({ running: true, pending: "comm_fail" } as Partial<Pump>));
    const antes = cor();
    draw(base({ running: true }));            // o reload perde `pending`
    expect(cor()).toBe(antes);
  });

  it("também para bomba desligada", () => {
    draw(base({ running: false, pending: "comm_fail" } as Partial<Pump>));
    const antes = cor();
    draw(base({ running: false }));
    expect(cor()).toBe(antes);
  });
});

describe("nada foi regredido", () => {
  it("comm_fail NÃO altera a cor física — a garantia que importa", () => {
    // O selo "Falha de Comm" foi retirado do cabeçalho na versão atual do
    // Lovable (o próprio comentário do card registra: o cabeçalho passou a ser
    // ESTADO FÍSICO e só isso). A comunicação é comunicada pelas barras.
    // O requisito de produto que continua valendo — e este teste protege — é
    // que falha técnica jamais pinte o card.
    const CARD = fs.readFileSync(path.resolve(__dirname,
      "../components/dashboard/PumpCard.tsx"), "utf8");
    const i = CARD.indexOf("animate-pump-glow");
    const cores = CARD.slice(Math.max(0, i - 900), i + 200);
    expect(cores).not.toContain("isCommFail");
    expect(cores).not.toContain("commandUnconfirmed");
  });

  it("estados de transição continuam sinalizando", () => {
    draw(base({ running: true, pending: "turning_off" } as Partial<Pump>));
    expect(document.body.textContent).toMatch(/Desligando/i);
  });

  it("OFFLINE continua cinza e tem precedência", () => {
    draw(base({ running: true, online: false, communicationStatus: "offline",
                pending: "comm_fail" } as Partial<Pump>));
    expect(cinza(cor())).toBe(true);
  });

  it("manutenção continua com precedência sobre tudo", () => {
    cleanup();
    render(<PumpCard pump={base({ running: true, pending: "comm_fail" } as Partial<Pump>)}
      expanded refreshing={false} lastFailed={false} isGuarded={false} userOnline
      maintenanceActive={false} inMaintenance farms={[]} sectors={[]} guardFarmId={null}
      virtualize={false} onToggle={() => {}} onRefresh={() => {}}
      onOpenDialog={() => {}} onToggleExpand={() => {}} />);
    expect(/bg-info\/10/.test(cor())).toBe(true);
  });

  it("o selo de comando não confirmado NÃO é mais renderizado", () => {
    // O aviso "Comando não confirmado" foi REMOVIDO do card em produção (ruído técnico para o cliente). O que continua garantido — e é o que importa — é que o timeout NÃO vira Offline e NÃO altera o estado físico exibido.
    draw(base({ running: true, commandUnconfirmedAt: Date.now() } as Partial<Pump>));
    expect(document.body.textContent).not.toMatch(/Comando não confirmado/);
  });
});
