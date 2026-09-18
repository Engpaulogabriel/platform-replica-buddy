// ─────────────────────────────────────────────────────────────────────────────
// Finalização de comando de bomba — uma confirmação, um toast
// ─────────────────────────────────────────────────────────────────────────────
// Regressão do bug visto na Pérola em 18/09/2026: o toast "POÇO 19 desligou com
// sucesso" aparecia com o card ainda em "DESLIGANDO…", e segundos depois vinha um
// segundo toast ("desligamento confirmado") junto com a mudança do card. Dois
// caminhos de confirmação para o mesmo evento, com critérios diferentes.
//
// Nenhum comando físico é enviado: os toasts são dublês e o módulo é puro.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";

const toasts = vi.hoisted(() => ({ on: [] as string[], off: [] as string[],
                                   erro: [] as string[], naoConfirmado: [] as string[] }));
vi.mock("@/lib/notify", () => ({
  notifyCommand: {
    turnedOn: (n: string) => { toasts.on.push(n); },
    turnedOff: (n: string) => { toasts.off.push(n); },
    error: (n: string) => { toasts.erro.push(n); },
    notConfirmed: (n: string) => { toasts.naoConfirmado.push(n); },
    sent: () => {}, blocked: () => {}, safetyExpired: () => {},
  },
  notify: { ok: () => {}, warn: () => {}, fail: () => {} },
}));

import {
  beginPumpCommand,
  failPumpCommand,
  finalizePumpCommandIfConfirmed,
  hasInFlightPumpCommand,
  isPumpCommandFinalized,
  __resetPumpCommandFinalizationForTests,
} from "@/lib/pumpCommandFinalization";

const POCO19 = "eq-19";
const POCO20 = "eq-20";
const src = (p: string) => readFileSync(p, "utf8");

beforeEach(() => {
  __resetPumpCommandFinalizationForTests();
  toasts.on.length = 0; toasts.off.length = 0;
  toasts.erro.length = 0; toasts.naoConfirmado.length = 0;
});

const total = () => toasts.on.length + toasts.off.length;

// ── 1 e 2 — OFF e ON normais ────────────────────────────────────────────────
describe("comando normal", () => {
  it("OFF: confirmação física encerra a transição com UM toast", () => {
    beginPumpCommand(POCO19, "cmd-1", false, "POÇO 19");
    expect(hasInFlightPumpCommand(POCO19)).toBe(true);
    expect(total()).toBe(0);                       // ACK não notifica

    expect(finalizePumpCommandIfConfirmed(POCO19, false)).toBe(true);
    expect(toasts.off).toEqual(["POÇO 19"]);
    expect(total()).toBe(1);
    expect(hasInFlightPumpCommand(POCO19)).toBe(false);
  });

  it("ON: idem, com o toast de ligar", () => {
    beginPumpCommand(POCO20, "cmd-2", true, "POÇO 20");
    expect(finalizePumpCommandIfConfirmed(POCO20, true)).toBe(true);
    expect(toasts.on).toEqual(["POÇO 20"]);
    expect(total()).toBe(1);
  });

  it("o estado ANTIGO chegando não encerra nada — segue verificando", () => {
    beginPumpCommand(POCO19, "cmd-3", false, "POÇO 19");
    // RX com a bomba ainda ligada: não é a confirmação esperada
    expect(finalizePumpCommandIfConfirmed(POCO19, true)).toBe(false);
    expect(total()).toBe(0);
    expect(hasInFlightPumpCommand(POCO19)).toBe(true);
    // agora sim
    expect(finalizePumpCommandIfConfirmed(POCO19, false)).toBe(true);
    expect(total()).toBe(1);
  });
});

// ── 3 — desligamento forçado ────────────────────────────────────────────────
describe("desligamento forçado", () => {
  it("passa pelo MESMO caminho: um toast, sem infraestrutura paralela", () => {
    beginPumpCommand(POCO19, "cmd-forced", false, "POÇO 19");
    // a sequência {1}→{0} termina com last_outputs_state=0 → pending limpa
    expect(finalizePumpCommandIfConfirmed(POCO19, false)).toBe(true);
    expect(toasts.off).toEqual(["POÇO 19"]);
    expect(total()).toBe(1);
  });
});

// ── 4 e 5 — idempotência ────────────────────────────────────────────────────
describe("confirmações duplicadas", () => {
  it("a mesma confirmação por dois caminhos gera UM toast", () => {
    beginPumpCommand(POCO19, "cmd-4", false, "POÇO 19");
    finalizePumpCommandIfConfirmed(POCO19, false);
    finalizePumpCommandIfConfirmed(POCO19, false);   // Realtime + polling
    finalizePumpCommandIfConfirmed(POCO19, false);
    expect(total()).toBe(1);
    expect(isPumpCommandFinalized("cmd-4")).toBe(true);
  });

  it("evento posterior de equipamento não recria toast nem transição", () => {
    beginPumpCommand(POCO19, "cmd-5", false, "POÇO 19");
    finalizePumpCommandIfConfirmed(POCO19, false);
    toasts.off.length = 0;
    // polling seguinte republica o mesmo estado
    expect(finalizePumpCommandIfConfirmed(POCO19, false)).toBe(false);
    expect(hasInFlightPumpCommand(POCO19)).toBe(false);
    expect(total()).toBe(0);
  });
});

// ── 6 e 7 — falhas nunca viram sucesso ──────────────────────────────────────
describe("timeout, erro e equipamento mudo", () => {
  it("timeout encerra sem toast de sucesso e blinda confirmação atrasada", () => {
    beginPumpCommand(POCO19, "cmd-6", false, "POÇO 19");
    failPumpCommand(POCO19);
    expect(total()).toBe(0);
    expect(isPumpCommandFinalized("cmd-6")).toBe(true);
    // confirmação que chega DEPOIS do timeout não pode virar sucesso
    expect(finalizePumpCommandIfConfirmed(POCO19, false)).toBe(false);
    expect(total()).toBe(0);
  });

  it("equipamento sem comando em voo nunca gera confirmação inventada", () => {
    expect(finalizePumpCommandIfConfirmed("eq-18", false)).toBe(false);
    expect(total()).toBe(0);
  });
});

// ── 8 — isolamento entre equipamentos ───────────────────────────────────────
describe("isolamento", () => {
  it("confirmação de outro equipamento não finaliza a transição errada", () => {
    beginPumpCommand(POCO19, "cmd-7", false, "POÇO 19");
    beginPumpCommand(POCO20, "cmd-8", true, "POÇO 20");

    finalizePumpCommandIfConfirmed(POCO20, true);
    expect(toasts.on).toEqual(["POÇO 20"]);
    expect(toasts.off).toEqual([]);
    expect(hasInFlightPumpCommand(POCO19)).toBe(true);   // o 19 continua em voo

    finalizePumpCommandIfConfirmed(POCO19, false);
    expect(toasts.off).toEqual(["POÇO 19"]);
    expect(total()).toBe(2);
  });
});

// ── estrutural — os dois caminhos antigos não existem mais ──────────────────
describe("os dois caminhos antigos foram eliminados", () => {
  it("o ACK do comando não emite mais toast de sucesso", () => {
    const D = src("src/pages/Dashboard.tsx");
    expect(D).not.toMatch(/if \(willTurnOn\) notifyCommand\.turnedOn\(target\.name\);/);
    expect(D).toMatch(/beginPumpCommand\(target\.id, enq\.commandId, willTurnOn, target\.name\)/);
    expect(D).toMatch(/failPumpCommand\(target\.id\)/);
  });

  it("PumpTable não emite mais o toast de confirmação", () => {
    const T = src("src/components/dashboard/PumpTable.tsx");
    expect(T).not.toMatch(/desligamento confirmado/);
  });

  it("a finalização vive num único ponto, ligado à saída da transição", () => {
    const H = src("src/hooks/useDashboardEquipment.ts");
    expect(H).toMatch(/finalizePumpCommandIfConfirmed\(p\.id, p\.running\)/);
    expect(H).toMatch(/antes !== "error" && antes !== "comm_fail" && !p\.pending/);
  });
});
