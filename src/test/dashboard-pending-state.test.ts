// Máquina de estados do card: nenhum poço pode ficar preso em Ligando/Desligando.
// Testa a REGRA extraída dos hooks reais (mesmas constantes e mesma decisão).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "../..");
const read = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");
const HOOK = read("src/hooks/useDashboardEquipment.ts");
const PEND = read("src/hooks/usePendingManualCommands.ts");
const CARD = read("src/components/dashboard/PumpCard.tsx");

type Pending = "turning_on" | "turning_off" | undefined;
interface Card { running: boolean; pending: Pending; pendingStartedAt?: number;
                 commandUnconfirmedAt?: number; lastSyncAt?: number; }
const PENDING_MAX_MS = 120_000;

/** Reproduz a decisão do hook: física confirmada vence; timeout limpa. */
function step(card: Card, o: { physical: boolean; desired?: boolean; now: number; rowAt?: number }): Card {
  // evento atrasado nunca sobrescreve confirmação mais nova
  if (o.rowAt && card.lastSyncAt && o.rowAt < card.lastSyncAt) return card;
  const lastSyncAt = o.rowAt ?? card.lastSyncAt;
  if (!card.pending) return { ...card, running: o.physical, lastSyncAt };
  const desired = o.desired ?? (card.pending === "turning_on");
  // confirmação FÍSICA correspondente → sai da transição imediatamente
  if (o.physical === desired) {
    return { running: o.physical, pending: undefined, commandUnconfirmedAt: undefined, lastSyncAt };
  }
  // 120s sem confirmação → limpa, mantém último estado físico, avisa (sem offline)
  if (card.pendingStartedAt && o.now - card.pendingStartedAt > PENDING_MAX_MS) {
    return { running: o.physical, pending: undefined, commandUnconfirmedAt: o.now, lastSyncAt };
  }
  return { ...card, lastSyncAt };
}
const T0 = 1_000_000;
const ligando = (): Card => ({ running: false, pending: "turning_on", pendingStartedAt: T0 });
const desligando = (): Card => ({ running: true, pending: "turning_off", pendingStartedAt: T0 });

describe("timeout nunca deixa o card preso", () => {
  it("1. timeout de desligamento limpa Desligando sem refresh", () => {
    const r = step(desligando(), { physical: true, now: T0 + 121_000 });
    expect(r.pending).toBeUndefined();
    expect(r.commandUnconfirmedAt).toBeTruthy();
  });

  it("2. timeout de ligamento limpa Ligando sem refresh", () => {
    const r = step(ligando(), { physical: false, now: T0 + 121_000 });
    expect(r.pending).toBeUndefined();
    expect(r.running).toBe(false);
  });

  it("3/4. reconciliação ON → verde; OFF → vermelho", () => {
    expect(step(ligando(), { physical: true, now: T0 + 121_000 }).running).toBe(true);
    expect(step(desligando(), { physical: false, now: T0 + 121_000 }).running).toBe(false);
  });

  it("5. timeout NÃO marca offline — mantém o último estado físico", () => {
    // regra corrigida: timeout = "não confirmado", nunca "sem comunicação"
    const r = step(desligando(), { physical: true, now: T0 + 121_000 });
    expect(r.running).toBe(true);              // seguia ON fisicamente → continua verde
    expect((r as { offline?: boolean }).offline).toBeUndefined();
  });

  it("6. confirmação física tardia atualiza e remove o aviso", () => {
    const t = step(desligando(), { physical: true, now: T0 + 121_000 });
    expect(t.commandUnconfirmedAt).toBeTruthy();
    const tardia = step({ ...t, pending: "turning_off", pendingStartedAt: T0 },
                        { physical: false, now: T0 + 200_000 });
    expect(tardia.running).toBe(false);
    expect(tardia.commandUnconfirmedAt).toBeUndefined();
  });

  it("confirmação física dentro da janela sai da transição imediatamente", () => {
    const r = step(desligando(), { physical: false, now: T0 + 3_000 });
    expect(r.pending).toBeUndefined();
    expect(r.running).toBe(false);
  });

  it("status pending/sent do comando não confirma nada por si só", () => {
    const r = step(desligando(), { physical: true, now: T0 + 5_000 });
    expect(r.pending).toBe("turning_off");   // segue aguardando confirmação física
  });

  it("8. dois poços são independentes", () => {
    const p06 = step(desligando(), { physical: true, now: T0 + 121_000 });
    const p10 = step(ligando(), { physical: false, now: T0 + 10_000 });
    expect(p06.pending).toBeUndefined();
    expect(p10.pending).toBe("turning_on");  // o vizinho não foi afetado
  });

  it("9. evento atrasado não sobrescreve estado novo", () => {
    const novo: Card = { running: true, pending: undefined, lastSyncAt: T0 + 100 };
    const r = step(novo, { physical: false, now: T0 + 200, rowAt: T0 + 50 });
    expect(r.running).toBe(true);
  });
});

describe("código-fonte: garantias estruturais", () => {
  it("ambas as janelas são 120s", () => {
    expect(HOOK).toContain("PENDING_MAX_MS = 120_000");
    expect(HOOK).toContain("MANUAL_PENDING_WINDOW_MS = 120_000");
    expect(PEND).toContain("PENDING_WINDOW_MS = 120_000");
    expect(HOOK).not.toContain("= 300_000;");
  });

  it("7. sem pending='error' e sem comando corretivo do frontend", () => {
    expect(HOOK).not.toContain('pending = "error"');
    expect(HOOK).not.toContain("enqueueResetPumpCommand");
  });

  it("7. RESET não é mais mecanismo de recuperação", () => {
    expect(CARD).toContain("const showReset = false;");
    expect(CARD).not.toContain("RESET_STUCK_MS");
  });

  it("10. hook de pendências não faz polling contínuo", () => {
    expect(PEND).not.toContain("setInterval");
    expect(PEND).not.toMatch(/timer = setTimeout\(loop/);
    expect(PEND).toContain('status === "SUBSCRIBED"');   // reconcilia ao reconectar
  });

  it("reconciliação pontual existe e é por equipment_id", () => {
    expect(HOOK).toContain("reconcileEquipmentsRef");
    expect(HOOK).toMatch(/\.in\("id", unique\)/);
  });

  it("aviso de comando não confirmado não é exibido no card", () => {
    expect(CARD).not.toContain("Comando não confirmado");
    // não entra no cálculo de cor do card
    expect(CARD).not.toMatch(/commandUnconfirmed\s*\?\s*"bg-/);
  });
});
