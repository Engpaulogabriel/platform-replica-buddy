// @vitest-environment node
// ─────────────────────────────────────────────────────────────────────────────
// O texto da notificação do Modo Automático
// ─────────────────────────────────────────────────────────────────────────────
// Em 22/09 a Sossego recebeu, às 12:18, "Horário programado: 21:02 · Data:
// Ter, 22/09/2026". O motor estava certo — a janela 21:02→17:50 atravessa a
// meia-noite e ele estava restaurando o estado dentro dela. A mensagem é que
// afirmava um horário do próprio dia.
//
// A decisão vive em `ehReconciliacao`, extraída do arquivo real e executada.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const SRC = "supabase/functions/whatsapp-automation-notify/index.ts";
const src = readFileSync(SRC, "utf8");
const corpo = src.slice(src.indexOf("function ehReconciliacao"));
const ehReconciliacao = new Function(
  corpo.slice(0, corpo.indexOf("\n}") + 2).replace("function ehReconciliacao(rows: any[]): boolean", "function f(rows)")
  + "\nreturn f;")() as (rows: any[]) => boolean;

const linha = (late?: number) => ({ details: late === undefined ? {} : { late_minutes: late } });

describe("reconciliação × disparo pontual", () => {
  it("o caso real da Sossego: 21:02 executado às 12:18 do dia seguinte", () => {
    // 21:02 de ontem até 12:18 de hoje = 916 minutos de atraso
    expect(ehReconciliacao([linha(916)])).toBe(true);
  });

  it("disparo no início da janela não é reconciliação", () => {
    expect(ehReconciliacao([linha(0)])).toBe(false);
    expect(ehReconciliacao([linha(1)])).toBe(false);
    expect(ehReconciliacao([linha(10)])).toBe(false);
  });

  it("atraso operacional pequeno ainda conta como disparo pontual", () => {
    expect(ehReconciliacao([linha(9)])).toBe(false);
  });

  it("sem late_minutes (registro legado) trata como disparo pontual", () => {
    expect(ehReconciliacao([linha()])).toBe(false);
    expect(ehReconciliacao([{}])).toBe(false);
  });

  it("num lote, basta uma linha reconciliada", () => {
    expect(ehReconciliacao([linha(0), linha(600)])).toBe(true);
  });
});

describe("o texto não afirma horário do próprio dia numa reconciliação", () => {
  it("o ramo de reconciliação não imprime 'Horário programado'", () => {
    const i = src.indexOf("const reconcilia = ehReconciliacao(g.rows);");
    const bloco = src.slice(i, i + 700);
    const ramo = bloco.slice(bloco.indexOf("? `♻️"), bloco.indexOf(": `⏰"));
    expect(ramo).toContain("janela automática ativa");
    expect(ramo).toContain("Restaurado em");
    expect(ramo).not.toContain("Horário programado");
  });

  it("o ramo pontual continua mostrando o horário programado", () => {
    const i = src.indexOf("const reconcilia = ehReconciliacao(g.rows);");
    const bloco = src.slice(i, i + 700);
    expect(bloco.slice(bloco.indexOf(": `⏰"))).toContain("Horário programado");
  });
});
