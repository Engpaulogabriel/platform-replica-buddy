// @vitest-environment node
// Indicador AUTO: estados próprios, sem tocar na cor operacional da bomba.
// Vermelho piscante SÓ para falha real de ligamento após 15 min de TENTATIVA —
// nunca para quem está na fila, nunca para quem está sem comunicação.
import { describe, it, expect } from "vitest";
import fs from "node:fs"; import path from "node:path";
import {
  autoState, AUTO_IS_FAILURE, AUTO_LABEL, AUTO_FAILURE_TOLERANCE_MS,
  validateStaggerConfig, STAGGER_DEFAULTS, STAGGER_LIMITS,
  type AutoInput,
} from "../lib/automaticPumpState.ts";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const base = (o: Partial<AutoInput> = {}): AutoInput => ({
  engineEnabled: true, desired: "on", physicalRunning: false,
  hasPendingCommand: false, attemptSince: null, online: true, now: NOW, ...o,
});
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

describe("13 a 18. estados do indicador AUTO", () => {
  it("AUTO desativado → estado 'off', sem indicador", () => {
    expect(autoState(base({ engineEnabled: false }))).toBe("off");
    expect(AUTO_LABEL.off).toBe("");
  });

  it("13. aguardando a vez na fila → NÃO é falha, NÃO é vermelho", () => {
    const s = autoState(base());          // desired ON, físico OFF, sem tentativa
    expect(s).toBe("waiting_start");
    expect(AUTO_IS_FAILURE[s]).toBe(false);
    expect(AUTO_LABEL[s]).toBe("AUTO · Aguardando partida");
  });

  it("13b. por mais que espere na fila, nunca fica vermelho", () => {
    // 3 horas na fila, sem tentativa real → segue aguardando
    const s = autoState(base({ attemptSince: null }));
    expect(s).toBe("waiting_start");
    expect(AUTO_IS_FAILURE[s]).toBe(false);
  });

  it("comando em processamento → 'Ligando'", () => {
    const s = autoState(base({ hasPendingCommand: true }));
    expect(s).toBe("starting");
    expect(AUTO_IS_FAILURE[s]).toBe(false);
  });

  it("14. sem comunicação → 'Sem comunicação', não falha", () => {
    for (const i of [base({ online: false }), base({ physicalRunning: null })]) {
      const s = autoState(i);
      expect(s).toBe("no_comm");
      expect(AUTO_IS_FAILURE[s]).toBe(false);
      expect(AUTO_LABEL[s]).toBe("AUTO · Sem comunicação");
    }
  });

  it("15. tentativa de 14min59s → ainda NÃO é vermelho", () => {
    const s = autoState(base({ attemptSince: new Date(NOW.getTime() - (15 * 60_000 - 1000)) }));
    expect(s).toBe("starting");
    expect(AUTO_IS_FAILURE[s]).toBe(false);
  });

  it("16. tentativa >= 15 min sem confirmar → AUTO vermelho piscante", () => {
    const s = autoState(base({ attemptSince: minsAgo(15) }));
    expect(s).toBe("failed");
    expect(AUTO_IS_FAILURE[s]).toBe(true);
  });

  it("17. depois de 1h ainda em falha, mas o desired continua ON", () => {
    const i = base({ attemptSince: minsAgo(60) });
    expect(autoState(i)).toBe("failed");
    expect(i.desired).toBe("on");   // responsabilidade não terminou
  });

  it("18. ao confirmar ON, o vermelho some sozinho", () => {
    const s = autoState(base({ physicalRunning: true, attemptSince: minsAgo(60) }));
    expect(s).toBe("idle");
    expect(AUTO_IS_FAILURE[s]).toBe(false);
  });

  it("a tolerância é de 15 minutos", () => {
    expect(AUTO_FAILURE_TOLERANCE_MS).toBe(15 * 60_000);
  });

  it("desired OFF nunca gera falha de ligamento", () => {
    expect(autoState(base({ desired: "off", physicalRunning: true }))).toBe("idle");
    expect(autoState(base({ desired: null }))).toBe("idle");
  });

  it("APENAS 'failed' pinta vermelho", () => {
    const vermelhos = Object.entries(AUTO_IS_FAILURE).filter(([, v]) => v).map(([k]) => k);
    expect(vermelhos).toEqual(["failed"]);
  });
});

describe("configuração de partida escalonada", () => {
  it("defaults conservadores", () => {
    expect(STAGGER_DEFAULTS).toEqual({ enabled: true, batchSize: 1, staggerSeconds: 60 });
  });

  it("22 e 23. validação de limites", () => {
    expect(validateStaggerConfig(1, 60)).toBeNull();
    expect(validateStaggerConfig(3, 90)).toBeNull();
    expect(validateStaggerConfig(0, 60)).toMatch(/Bombas por grupo/);
    expect(validateStaggerConfig(1.5, 60)).toMatch(/inteiro/);
    expect(validateStaggerConfig(1, 5)).toMatch(/Intervalo/);
    expect(validateStaggerConfig(1, 10_000)).toMatch(/Intervalo/);
    expect(validateStaggerConfig(STAGGER_LIMITS.batchMax, STAGGER_LIMITS.staggerMax)).toBeNull();
  });

  it("o mínimo de stagger respeita o ciclo de polling do agente", () => {
    expect(STAGGER_LIMITS.staggerMin).toBe(10);   // POLL_INTERVAL_MS
  });
});

describe("o indicador AUTO não toca na cor operacional da bomba", () => {
  const SRC = fs.readFileSync(
    path.resolve(__dirname, "../lib/automaticPumpState.ts"), "utf8");
  it("o módulo é puro: sem React, sem Supabase, sem DOM", () => {
    expect(SRC).not.toMatch(/from "react"|supabase|document\.|window\./);
  });
  it("não decide cor de bomba — só o próprio indicador", () => {
    expect(SRC).not.toMatch(/bg-destructive|animate-pump-glow|pump.*color/i);
  });
});
