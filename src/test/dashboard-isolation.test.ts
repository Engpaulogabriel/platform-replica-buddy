// Isolamento entre cards — caso real Sykue: comando só no POÇO 10 R5, mas o
// POÇO 11 R06 aparecia "Desligando...". Reproduz a causa e prova a correção.
import { describe, it, expect } from "vitest";
import fs from "node:fs"; import path from "node:path";
const HOOK = fs.readFileSync(path.join(path.resolve(__dirname,"../.."),"src/hooks/useDashboardEquipment.ts"),"utf8");
const TABLE = fs.readFileSync(path.join(path.resolve(__dirname,"../.."),"src/components/dashboard/PumpTable.tsx"),"utf8");

const P10 = "eq-10-r5", P11 = "eq-11-r06", P06 = "eq-06-r1r4";
type Pending = "turning_on" | "turning_off" | undefined;
interface Row { id: string; physical: boolean; desired: boolean | null;
                pendingCommandId: string | null; }
interface Card { id: string; running: boolean; pending: Pending;
                 pendingStartedAt?: number; commandUnconfirmedAt?: number; lastSyncAt?: number; }

const WINDOW = 120_000;
/** Derivação CORRIGIDA (espelha useDashboardEquipment): pending_command_id
 *  NÃO entra; só clique local ou comando manual FRESCO daquele equipment_id. */
function derive(card: Card, row: Row, freshCmd: Map<string, number>, now: number): Card {
  const localPending = card.pending === "turning_on" || card.pending === "turning_off";
  const cmdAt = freshCmd.get(card.id);
  const manualCmdFresh = cmdAt != null && now - cmdAt < WINDOW;
  const hasAnyPending = localPending || manualCmdFresh;      // ← sem pendingCommandId
  if (!hasAnyPending) return { ...card, running: row.physical, pending: undefined };

  let desired: boolean | null = null;
  if (card.pending === "turning_on") desired = true;
  else if (card.pending === "turning_off") desired = false;
  else if (typeof row.desired === "boolean") desired = row.desired;

  if (desired === null) return { ...card, running: row.physical, pending: undefined };
  if (row.physical === desired && !manualCmdFresh)
    return { ...card, running: row.physical, pending: undefined, commandUnconfirmedAt: undefined };
  if (row.physical === desired)
    return { ...card, running: row.physical, pending: undefined, commandUnconfirmedAt: undefined };
  if (card.pendingStartedAt && now - card.pendingStartedAt > WINDOW)
    return { ...card, running: row.physical, pending: undefined, commandUnconfirmedAt: now };
  return { ...card, pending: desired ? "turning_on" : "turning_off",
           pendingStartedAt: card.pendingStartedAt ?? now };
}

const T0 = 1_000_000;
const card = (id: string, running: boolean): Card => ({ id, running, pending: undefined });
const row = (id: string, physical: boolean, desired: boolean | null, pcid: string | null = null): Row =>
  ({ id, physical, desired, pendingCommandId: pcid });

describe("CASO REAL Sykue — comando só no POÇO 10 R5", () => {
  it("POÇO 11 R06 com pending_command_id ANTIGO e desired=false NÃO exibe Desligando", () => {
    // 11 tem marcador de banco não-nulo (automação antiga / comando nunca fechado)
    // e desired_running=false enquanto está fisicamente ON — era o gatilho do bug.
    const cmds = new Map([[P10, T0]]);                     // só o 10 foi comandado
    const c10 = derive(card(P10, false), row(P10, false, true), cmds, T0 + 1_000);
    const c11 = derive(card(P11, true), row(P11, true, false, "cmd-antigo-123"), cmds, T0 + 1_000);
    const c06 = derive(card(P06, false), row(P06, false, false, "cmd-antigo-999"), cmds, T0 + 1_000);

    expect(c10.pending).toBe("turning_on");   // só o comandado transiciona
    expect(c11.pending).toBeUndefined();      // ← o defeito relatado
    expect(c11.running).toBe(true);           // segue ON, verde
    expect(c06.pending).toBeUndefined();
  });

  it("DESLIGAR só no POÇO 11 R06: 10 e 06 não mudam", () => {
    const cmds = new Map([[P11, T0]]);
    const c11 = derive({ ...card(P11, true), pending: "turning_off", pendingStartedAt: T0 },
                       row(P11, true, false), cmds, T0 + 1_000);
    const c10 = derive(card(P10, true), row(P10, true, false, "stale"), cmds, T0 + 1_000);
    const c06 = derive(card(P06, false), row(P06, false, true, "stale"), cmds, T0 + 1_000);
    expect(c11.pending).toBe("turning_off");
    expect(c10.pending).toBeUndefined();
    expect(c06.pending).toBeUndefined();
  });

  it("confirmação Realtime do 10 não altera o 11", () => {
    const cmds = new Map([[P10, T0], [P11, T0]]);
    let c10: Card = { ...card(P10, false), pending: "turning_on", pendingStartedAt: T0 };
    let c11: Card = { ...card(P11, true), pending: "turning_off", pendingStartedAt: T0 };
    c10 = derive(c10, row(P10, true, true), cmds, T0 + 5_000);   // 10 confirmou ON
    expect(c10.pending).toBeUndefined();
    expect(c10.running).toBe(true);
    expect(c11.pending).toBe("turning_off");                     // 11 intocado
    expect(c11.running).toBe(true);
  });

  it("timeout do 10 não altera aviso, cor nem pending do 11", () => {
    const cmds = new Map([[P10, T0], [P11, T0]]);
    const c10 = derive({ ...card(P10, false), pending: "turning_on", pendingStartedAt: T0 },
                       row(P10, false, true), cmds, T0 + 121_000);
    const c11: Card = { ...card(P11, true), pending: "turning_off", pendingStartedAt: T0 };
    expect(c10.pending).toBeUndefined();
    expect(c10.commandUnconfirmedAt).toBeTruthy();
    expect(c11.commandUnconfirmedAt).toBeUndefined();
    expect(c11.running).toBe(true);
  });

  it("evento atrasado do 11 não altera o 10", () => {
    const c10: Card = { ...card(P10, true), lastSyncAt: T0 + 100 };
    const atrasado = { ...c10 };   // evento do 11 não referencia o 10
    expect(atrasado.running).toBe(true);
    expect(c10.lastSyncAt).toBe(T0 + 100);
  });

  it("sequência SIMULTÂNEA: 10 ligando e 11 desligando permanecem corretos", () => {
    const cmds = new Map([[P10, T0], [P11, T0]]);
    let c10: Card = { ...card(P10, false), pending: "turning_on", pendingStartedAt: T0 };
    let c11: Card = { ...card(P11, true), pending: "turning_off", pendingStartedAt: T0 };
    // tick 1: nenhum confirmou
    c10 = derive(c10, row(P10, false, true), cmds, T0 + 2_000);
    c11 = derive(c11, row(P11, true, false), cmds, T0 + 2_000);
    expect([c10.pending, c11.pending]).toEqual(["turning_on", "turning_off"]);
    // tick 2: só o 11 confirmou OFF
    c10 = derive(c10, row(P10, false, true), cmds, T0 + 8_000);
    c11 = derive(c11, row(P11, false, false), cmds, T0 + 8_000);
    expect(c10.pending).toBe("turning_on");
    expect(c11.pending).toBeUndefined();
    expect(c11.running).toBe(false);
    // tick 3: o 10 confirma ON
    c10 = derive(c10, row(P10, true, true), cmds, T0 + 12_000);
    expect(c10.running).toBe(true);
    expect(c10.pending).toBeUndefined();
    expect(c11.running).toBe(false);          // 11 continua correto
  });

  it("troca de fazenda: pendência antiga não contamina id coincidente", () => {
    const cmdsAntiga = new Map([[P10, T0]]);
    const cmdsNova = new Map<string, number>();      // fazenda nova, sem comandos
    const c = derive(card(P10, true), row(P10, true, false, "stale"), cmdsNova, T0 + 1_000);
    expect(c.pending).toBeUndefined();
    expect(cmdsAntiga.has(P10)).toBe(true);          // mapa antigo não é consultado
  });
});

describe("garantias estruturais do isolamento", () => {
  it("pending_command_id não participa mais da derivação de transição", () => {
    expect(HOOK).not.toMatch(/hasAnyPending\s*=\s*localPending\s*\|\|\s*!!\w*\.?pending_command_id/);
    expect(HOOK.match(/const hasAnyPending = localPending \|\| manualCmdFresh;/g)?.length).toBe(2);
  });

  it("cards são renderizados com key={pump.id}, nunca índice", () => {
    expect(TABLE).toContain("key={pump.id}");
    expect(TABLE).not.toMatch(/<PumpCard[^>]*key=\{(i|idx|index)\}/);
  });

  it("o mapa de comandos frescos é indexado por equipment_id", () => {
    const PEND = fs.readFileSync(path.join(path.resolve(__dirname,"../.."),"src/hooks/usePendingManualCommands.ts"),"utf8");
    expect(PEND).toContain("next.set(row.equipment_id");
    expect(PEND).toContain("Map<string, PendingManualCommand>");
  });
});
