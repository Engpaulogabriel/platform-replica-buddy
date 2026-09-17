// @vitest-environment jsdom
// O Relatório OFICIAL e o MINI relatório são independentes. Nenhum rótulo
// técnico pode ocupar Origem ou Usuário no oficial (tela, CSV e PDF).
import { describe, it, expect, vi } from "vitest";
// automationLog importa o client do Supabase no topo; aqui só nos interessam
// as funções puras, então o client vira um stub.
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: () => ({}) } }));
import fs from "node:fs";
import path from "node:path";
import { sanitizeOfficialLabel, isMissingNoiseColumn } from "@/lib/automationLog";
import type { AutomationLogEntry } from "@/lib/automationLog";
import { miniOrigin, miniActor, MINI_ORIGIN_LABEL, buildMiniStatusHistory } from "@/lib/dashboardMiniHistory";

const REPO = path.resolve(__dirname, "../..");
const src = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");
const LOG    = src("src/lib/automationLog.ts");
const TAB    = src("src/components/reports/AutomacaoReportTab.tsx");
const EXPORT = src("src/lib/reportExport.ts");

const PROIBIDOS = ["Sistema", "System", "Telemetria RF", "Acionamento RF", "RF",
                   "Bridge", "Serial", "Comando Remoto", "Remoto não identificado",
                   "Origem em apuração", "Autoria histórica em revisão", "Desconhecido"];

describe("3. zero texto proibido no oficial", () => {
  for (const t of PROIBIDOS.filter((x) => x !== "Remoto não identificado")) {
    it(`"${t}" é higienizado para vazio`, () => {
      expect(sanitizeOfficialLabel(t)).toBe("");
    });
  }

  it("UUID cru também some", () => {
    expect(sanitizeOfficialLabel("3f2b9c11-aaaa-bbbb-cccc-ddddeeee0000")).toBe("");
  });

  it("pessoa e regra de verdade passam intactas", () => {
    expect(sanitizeOfficialLabel("Yuri Seibert")).toBe("Yuri Seibert");
    expect(sanitizeOfficialLabel("Desligamento 17h Semear")).toBe("Desligamento 17h Semear");
    expect(sanitizeOfficialLabel("Acionamento local")).toBe("Acionamento local");
    expect(sanitizeOfficialLabel("Local (painel)")).toBe("Local (painel)");
  });

  it("resolveUser não devolve mais 'Sistema'", () => {
    const corpo = LOG.slice(LOG.indexOf("const resolveUser"), LOG.indexOf("const resolveUser") + 2000);
    expect(corpo).not.toMatch(/return "Sistema";/);
  });

  it("a tela não tem fallback genérico", () => {
    expect(TAB).not.toContain('"Desconhecido"');
    expect(TAB).toContain("sanitizeOfficialLabel");
  });

  it("o CSV/PDF não inventam autoria", () => {
    expect(EXPORT).not.toContain('? user.trim() : "Desconhecido"');
  });
});

describe("2. sem falha/timeout como evento físico; mesma fonte nos três", () => {
  it("a coluna Resultado saiu do PDF de Automação", () => {
    const bloco = EXPORT.slice(EXPORT.indexOf("exportAutomacaoPDF"), EXPORT.indexOf("HORÍMETRO"));
    expect(bloco).not.toContain('"Resultado"');
    expect(bloco).not.toMatch(/resultLabel\(r\.result\)/);
  });

  it("tela, CSV e PDF partem do MESMO array canônico", () => {
    expect(TAB).toContain("canonicalRows");
    expect(TAB).toContain("exportAutomacaoCSV(canonicalRows)");
    expect(TAB).toContain("exportAutomacaoPDF(canonicalRows");
    expect(TAB).not.toMatch(/const mapped = filteredLog\.map/);
  });
});

describe("4. ruído não entra no oficial", () => {
  it("as consultas do oficial filtram noise_reason IS NULL", () => {
    const n = (LOG.match(/\.is\("noise_reason", null\)/g) ?? []).length;
    expect(n, "as duas consultas do oficial precisam do filtro").toBeGreaterThanOrEqual(2);
  });

  it("se a coluna ainda não existir, o relatório não quebra", () => {
    expect(isMissingNoiseColumn({ code: "42703" })).toBe(true);
    expect(isMissingNoiseColumn({ message: 'column "noise_reason" does not exist' })).toBe(true);
    expect(isMissingNoiseColumn({ code: "22P02" })).toBe(false);
    expect(LOG).toContain("isMissingNoiseColumn(");
  });
});

// ── ISOLAMENTO ─────────────────────────────────────────────────────────────
describe("1. Relatório e mini relatório são independentes", () => {
  const ent = (o: Partial<AutomationLogEntry>): AutomationLogEntry => ({
    id: "x", farmId: "f", date: "14/08/2026", time: "21:03", ts: "2026-08-15T00:03:00Z",
    equipmentId: "eq-1", pump: "POÇO 01", action: "Desligada",
    origin: "Manual", user: null, result: "success", synced: true, ...o,
  } as AutomationLogEntry);

  it("o mini relatório NÃO usa as funções do oficial", () => {
    // sanitizeOfficialLabel é do oficial; miniActor tem denylist própria
    expect(miniActor(ent({ origin: "Remoto", user: "Telemetria RF" }))).toBeNull();
    expect(miniActor(ent({ origin: "Manual" }))).toBe("Acionamento local");
  });

  it("o oficial NÃO importa NADA de dashboardMiniHistory", () => {
    for (const f of ["src/components/reports/AutomacaoReportTab.tsx",
                     "src/lib/reportExport.ts", "src/lib/automationLog.ts"]) {
      expect(src(f), `${f} importa o módulo do mini`).not.toContain("dashboardMiniHistory");
    }
  });

  it("automationLog não exporta mais símbolo de mini relatório", () => {
    for (const sym of ["miniOrigin", "miniActor", "MINI_ORIGIN_LABEL", "MINI_ORIGIN_CLASS",
                       "commBarsFor", "isTechnicalLabel", "buildMiniStatusHistory",
                       "buildMiniCommandHistory"]) {
      expect(LOG, `automationLog ainda tem ${sym}`).not.toContain(sym);
    }
  });

  it("o módulo do mini tem as cinco origens e as barras", () => {
    const MINI = src("src/lib/dashboardMiniHistory.ts");
    for (const o of ["local", "remoto", "whatsapp", "auto", "automatico"])
      expect(MINI, `origem ${o} ausente`).toContain(o);
    for (const b of ["LOCAL", "REMOTO", "WHATSAPP", "AUTOMAÇÃO", "AUTO"])
      expect(MINI, `badge ${b} ausente`).toContain(b);
    expect(MINI).toContain("commBarsFor");
    expect(MINI).toContain("buildMiniStatusHistory");
    expect(MINI).toContain("buildMiniCommandHistory");
    // e não puxa nada do oficial
    expect(MINI).not.toContain("sanitizeOfficialLabel");
    expect(MINI).not.toContain("loadAutomationLogRange");
    expect(MINI).not.toContain("startAutomationLogSync");
  });

  it("PumpCard e o hook do dashboard consomem o módulo novo", () => {
    expect(src("src/components/dashboard/PumpCard.tsx")).toContain("@/lib/dashboardMiniHistory");
    expect(src("src/hooks/useDashboardEquipment.ts")).toContain("@/lib/dashboardMiniHistory");
  });

  it("o oficial NÃO usa as funções do mini", () => {
    expect(TAB).not.toContain("miniOrigin");
    expect(TAB).not.toContain("MINI_ORIGIN_LABEL");
    expect(TAB).not.toContain("buildMiniStatusHistory");
    expect(EXPORT).not.toContain("MINI_ORIGIN");
  });

  it("mexer no oficial não muda os rótulos do mini", () => {
    expect(MINI_ORIGIN_LABEL.local).toBe("LOCAL");
    expect(MINI_ORIGIN_LABEL.auto).toBe("AUTOMAÇÃO");
    expect(miniOrigin(ent({ origin: "Automático", user: "Desligamento 17h Semear" }))).toBe("auto");
  });

  it("mexer no mini não muda o oficial: 'Local (painel)' segue válido lá", () => {
    // o mini usa "Acionamento local"; o oficial usa "Local (painel)".
    // São vocabulários distintos, de propósito.
    expect(sanitizeOfficialLabel("Local (painel)")).toBe("Local (painel)");
    expect(buildMiniStatusHistory("eq-1", "POÇO 01", [ent({ origin: "Manual" })], 1)[0].actor)
      .toBe("Acionamento local");
  });

  it("o card e as barras não foram tocados por esta restauração", () => {
    const CARD = src("src/components/dashboard/PumpCard.tsx");
    expect(CARD).toContain('data-testid="pump-refresh-button"');
    expect(CARD).toContain('data-testid="comm-bars"');
    expect(CARD).toContain('data-testid="header-state"');
    expect(CARD).toContain("commBarsFor");
    expect(CARD).not.toContain("sanitizeOfficialLabel");   // o oficial não vaza pro card
  });
});
