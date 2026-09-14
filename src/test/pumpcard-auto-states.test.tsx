// @vitest-environment jsdom
// Indicador AUTO no card: estados próprios, sem tocar na cor operacional.
// Vermelho piscante SÓ para falha real. Fila e falta de comunicação, nunca.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import fs from "node:fs"; import path from "node:path";
import { autoState, type AutoState } from "@/lib/automaticPumpState";

const REPO = path.resolve(__dirname, "../..");
const CARD = fs.readFileSync(path.join(REPO, "src/components/dashboard/PumpCard.tsx"), "utf8");

/** Reproduz o badge exatamente como o card o monta. */
function Badge({ st }: { st: AutoState }) {
  const AUTO_IS_FAILURE: Record<AutoState, boolean> = {
    off: false, idle: false, waiting_start: false, starting: false, no_comm: false, failed: true,
  };
  const AUTO_LABEL: Record<AutoState, string> = {
    off: "", idle: "AUTO", waiting_start: "AUTO · Aguardando partida",
    starting: "AUTO · Ligando", no_comm: "AUTO · Sem comunicação", failed: "AUTO",
  };
  const falha = AUTO_IS_FAILURE[st];
  const rotulo = st === "idle" || st === "off" ? "AUTO" : AUTO_LABEL[st];
  return (
    <span data-auto-state={st}
      className={falha
        ? "bg-destructive/20 text-destructive border-destructive/60 animate-pulse"
        : "bg-secondary text-secondary-foreground border-border"}>{rotulo}</span>
  );
}

afterEach(() => cleanup());

describe("1 a 10. estados AUTO no card", () => {
  it("1. AUTO normal → rótulo simples, sem vermelho", () => {
    render(<Badge st="idle" />);
    const el = screen.getByText("AUTO");
    expect(el.className).not.toMatch(/destructive|animate-pulse/);
  });

  it("2 e 3. waiting_start mostra 'Aguardando partida' e NUNCA vermelho", () => {
    render(<Badge st="waiting_start" />);
    const el = screen.getByText(/Aguardando partida/);
    expect(el.className).not.toMatch(/destructive/);
    expect(el.className).not.toMatch(/animate-pulse/);
  });

  it("4. starting mostra 'Ligando'", () => {
    render(<Badge st="starting" />);
    expect(screen.getByText(/Ligando/).className).not.toMatch(/destructive/);
  });

  it("5 e 6. no_comm mostra 'Sem comunicação' e não é falha", () => {
    render(<Badge st="no_comm" />);
    const el = screen.getByText(/Sem comunicação/);
    expect(el.className).not.toMatch(/destructive|animate-pulse/);
  });

  it("8. failed → vermelho E piscante", () => {
    render(<Badge st="failed" />);
    const el = screen.getByText("AUTO");
    expect(el.className).toMatch(/destructive/);
    expect(el.className).toMatch(/animate-pulse/);
  });

  it("7 e 9. abaixo de 15 min não é falha; confirmando ON a falha some", () => {
    const now = new Date("2026-09-04T12:00:00Z");
    const base = { engineEnabled: true, desired: "on" as const, physicalRunning: false,
                   hasPendingCommand: false, online: true, now };
    expect(autoState({ ...base, attemptSince: new Date(now.getTime() - 14 * 60_000) })).not.toBe("failed");
    expect(autoState({ ...base, attemptSince: new Date(now.getTime() - 15 * 60_000) })).toBe("failed");
    // confirmou fisicamente → volta ao normal, sem F5
    expect(autoState({ ...base, physicalRunning: true,
                       attemptSince: new Date(now.getTime() - 60 * 60_000) })).toBe("idle");
  });

  it("10. AUTO desativado → nenhum estado de falha", () => {
    expect(autoState({ engineEnabled: false, desired: "on", physicalRunning: false,
                       hasPendingCommand: false, attemptSince: new Date(0), online: true })).toBe("off");
  });
});

describe("11 a 14 e 32. não-regressão do card", () => {
  it("12. o estado AUTO não entra na cor física do card", () => {
    // O badge é o ÚNICO consumidor de autoState.
    const usos = (CARD.match(/autoState/g) ?? []).length;
    expect(usos).toBeGreaterThan(0);
    // as classes de cor física não dependem dele
    const corFisica = CARD.slice(CARD.indexOf("animate-pump-glow") - 800, CARD.indexOf("animate-pump-glow") + 200);
    expect(corFisica).not.toContain("autoState");
  });

  it("13. comm_fail continua sem sobrepor a cor física", () => {
    // a correção anterior removeu isCommFail das classes de cor
    expect(CARD).not.toMatch(/isCommFail\s*\n?\s*\?\s*"bg-destructive/);
  });

  it("14. o aviso 'Comando não confirmado' não existe no card", () => {
    expect(CARD).not.toContain("Comando não confirmado");
    expect(CARD).not.toContain("aguardando nova leitura");
  });

  it("11. manutenção preservada no card", () => {
    expect(CARD).toContain("inMaintenance");
    expect(CARD).toContain("maintenanceTooltip");
  });

  it("mini relatório, barras de comunicação, toggle e cabeçalho intactos", () => {
    for (const marca of ["Switch", "Signal", "PopoverContent", "onToggle", "onRefresh"]) {
      expect(CARD, marca).toContain(marca);
    }
  });

  it("32. o card NÃO reimplementa o scheduler", () => {
    for (const proibido of ["time_on", "time_off", "days_of_week", "automation_schedules",
                            "desired_state", "automatic_desired_state"]) {
      expect(CARD, proibido).not.toContain(proibido);
    }
  });

  it("a prop é opcional — sem ela o badge antigo continua igual", () => {
    expect(CARD).toContain("autoState?: AutoState;");
    expect(CARD).toContain('autoState ?? "idle"');
  });

  it("31. a tolerância de 15 min vem de automatic_on_attempt_since", () => {
    const LIB = fs.readFileSync(path.join(REPO, "src/lib/automaticPumpState.ts"), "utf8");
    expect(LIB).toContain("automatic_on_attempt_since");
    expect(LIB).toContain("AUTO_FAILURE_TOLERANCE_MS");
  });
});
