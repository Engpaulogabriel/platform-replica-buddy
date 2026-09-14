// @vitest-environment node
// autoState ponta a ponta: banco → hook → PumpTable → PumpCard.
// Prova que a prop é realmente calculada e passada, sem query por card e sem
// duplicar lógica de schedule no frontend.
import { describe, it, expect } from "vitest";
import fs from "node:fs"; import path from "node:path";
import { autoState, type AutoState } from "../lib/automaticPumpState.ts";

const REPO = path.resolve(__dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");
const CARD  = read("src/components/dashboard/PumpCard.tsx");
const TABLE = read("src/components/dashboard/PumpTable.tsx");
const HOOK  = read("src/hooks/useDashboardEquipment.ts");
const CLOUD = read("src/hooks/useCadastrosCloud.ts");
const MIG   = read("supabase/migrations/20260904120000_automation_tick_resilient_idempotent.sql");
const semComentario = (s: string) =>
  s.split("\n").filter((l) => { const t = l.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*"); }).join("\n");

describe("1 a 3. a cadeia de dados existe de ponta a ponta", () => {
  it("o SELECT do banco traz automatic_on_attempt_since", () => {
    expect(CLOUD).toContain('"automatic_on_attempt_since," +');
    expect(CLOUD).toContain("automatic_on_attempt_since?: string | null;");
    expect(MIG).toContain("ADD COLUMN IF NOT EXISTS automatic_on_attempt_since timestamptz");
  });

  it("o hook mapeia o campo para o objeto Pump", () => {
    expect(HOOK).toContain("automaticOnAttemptSince: e.automatic_on_attempt_since");
    expect(HOOK).toContain("desiredRunning: e.desired_running ?? null");
  });

  it("o tipo Pump declara os dois campos", () => {
    expect(TABLE).toContain("desiredRunning?: boolean | null;");
    expect(TABLE).toContain("automaticOnAttemptSince?: number;");
  });

  it("2. a PumpTable calcula e PASSA autoState ao card", () => {
    expect(TABLE).toContain("const autoStates = useMemo(");
    expect(TABLE).toContain("autoState({");
    expect(TABLE).toContain("autoState={autoStates.get(pump.id)}");
  });

  it("o card consome a prop", () => {
    expect(CARD).toContain("autoState?: AutoState;");
    expect(CARD).toContain('autoState ?? "idle"');
    expect(CARD).toContain("prev.autoState !== next.autoState ||");
  });
});

describe("13 e 14. sem query por card, sem lógica de schedule duplicada", () => {
  it("13. o cálculo é UM useMemo sobre dados já em memória", () => {
    const bloco = semComentario(TABLE).slice(
      semComentario(TABLE).indexOf("const autoStates = useMemo("),
      semComentario(TABLE).indexOf("return m;"));
    expect(bloco).not.toMatch(/supabase|\.from\(|useQuery|useEffect|await /);
  });

  it("13b. o card não consulta nada", () => {
    expect(semComentario(CARD)).not.toMatch(/supabase\.from\(|\.rpc\(/);
  });

  it("14. nenhuma lógica de janela/schedule no card nem na tabela", () => {
    for (const proibido of ["time_on", "time_off", "days_of_week",
                            "automation_schedules", "automatic_desired_state"]) {
      expect(semComentario(CARD), `card: ${proibido}`).not.toContain(proibido);
      expect(semComentario(TABLE), `table: ${proibido}`).not.toContain(proibido);
    }
  });

  it("o desired vem do backend (desired_running), não de cálculo local", () => {
    expect(TABLE).toContain('desired: p.desiredRunning === true ? "on" : p.desiredRunning === false ? "off" : null');
  });
});

describe("3 a 11. os estados saem corretos para dados reais de bomba", () => {
  const NOW = new Date("2026-09-04T12:00:00Z");
  /** Reproduz exatamente o que a PumpTable monta. */
  const calc = (p: {
    autoAtivo: boolean; desiredRunning: boolean | null; running: boolean;
    online: boolean; commStatus?: string; pending?: string; attemptMs?: number;
  }): AutoState => {
    const confiavel = p.online && p.commStatus !== "offline";
    return autoState({
      engineEnabled: p.autoAtivo,
      desired: p.desiredRunning === true ? "on" : p.desiredRunning === false ? "off" : null,
      physicalRunning: confiavel ? p.running : null,
      hasPendingCommand: p.pending === "turning_on" || p.pending === "turning_off",
      attemptSince: p.attemptMs ? new Date(p.attemptMs) : null,
      online: confiavel, now: NOW,
    });
  };
  const base = { autoAtivo: true, desiredRunning: true, running: false, online: true };

  it("3. bomba coerente (ligada, desired ON) → AUTO normal", () => {
    expect(calc({ ...base, running: true })).toBe("idle");
  });

  it("4 e 8. deveria estar ON, está OFF, sem tentativa → aguardando partida", () => {
    const st = calc(base);
    expect(st).toBe("waiting_start");
    expect(st).not.toBe("failed");
  });

  it("5. comando em curso → Ligando", () => {
    expect(calc({ ...base, pending: "turning_on" })).toBe("starting");
  });

  it("6 e 9. offline → Sem comunicação, nunca falha", () => {
    expect(calc({ ...base, online: false })).toBe("no_comm");
    expect(calc({ ...base, commStatus: "offline" })).toBe("no_comm");
    expect(calc({ ...base, online: false, attemptMs: NOW.getTime() - 60 * 60_000 })).toBe("no_comm");
  });

  it("7. tentativa real >= 15 min sem confirmar → failed", () => {
    expect(calc({ ...base, attemptMs: NOW.getTime() - 15 * 60_000 })).toBe("failed");
    expect(calc({ ...base, attemptMs: NOW.getTime() - 14 * 60_000 })).toBe("starting");
  });

  it("10. confirmou ON → falha some", () => {
    expect(calc({ ...base, running: true, attemptMs: NOW.getTime() - 60 * 60_000 })).toBe("idle");
  });

  it("11. AUTO desativado → 'off', jamais falha", () => {
    expect(calc({ ...base, autoAtivo: false, attemptMs: NOW.getTime() - 60 * 60_000 })).toBe("off");
  });

  it("12. o estado é derivado dos dados — refresh reproduz o mesmo", () => {
    const i = { ...base, attemptMs: NOW.getTime() - 20 * 60_000 };
    expect(calc(i)).toBe(calc(i));
  });
});

describe("4. o aviso removido não pode voltar", () => {
  it("PumpCard não contém 'Comando não confirmado' nem 'aguardando nova leitura'", () => {
    expect(CARD).not.toContain("Comando não confirmado");
    expect(CARD).not.toContain("aguardando nova leitura");
  });

  it("nenhum badge equivalente é renderizado a partir de commandUnconfirmed", () => {
    // O REQUISITO é visual: o aviso não pode aparecer no card. A variável
    // interna pode existir — ela alimenta consumo técnico legítimo. O que se
    // exige é que não haja JSX pendurado nela.
    const code = semComentario(CARD);
    const usos = [...code.matchAll(/commandUnconfirmed/g)];
    for (const u of usos) {
      const trecho = code.slice(u.index ?? 0, (u.index ?? 0) + 200);
      expect(trecho, "commandUnconfirmed não pode renderizar JSX").not.toMatch(/&&\s*\(?\s*</);
    }
  });

  it("estado físico continua independente de timeout/comm_fail", () => {
    // A cor operacional sai do estado confirmado, nunca de falha técnica.
    const i = CARD.indexOf("animate-pump-glow");
    const volta = CARD.slice(Math.max(0, i - 900), i + 200);
    expect(volta).not.toContain("commandUnconfirmed");
    expect(volta).not.toContain("comm_fail");
  });
});

describe("não-regressão do card", () => {
  it("cor física, toggle, mini relatório, barras e manutenção intactos", () => {
    for (const marca of ["animate-pump-glow", "Switch", "Signal", "PopoverContent",
                         "inMaintenance", "maintenanceTooltip", "onToggle", "onRefresh"]) {
      expect(CARD, marca).toContain(marca);
    }
  });

  it("a cor física não depende do estado AUTO", () => {
    const i = CARD.indexOf("animate-pump-glow");
    expect(CARD.slice(Math.max(0, i - 900), i + 200)).not.toContain("autoState");
  });

  it("!isTransitioning preservado nas animações", () => {
    expect(CARD).toContain("!isTransitioning");
  });
});
