// @vitest-environment node
// O Relatório oficial é uma tabela de seis colunas, sem detalhe técnico.
import { describe, it, expect } from "vitest";
import fs from "node:fs"; import path from "node:path";
const REPO = path.resolve(__dirname, "../..");
const src = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");
// ── SEIS COLUNAS E NENHUM TEXTO TÉCNICO NA TELA ───────────────────────────
describe("relatório oficial: DATA | HORA | POÇO | AÇÃO | ORIGEM | NOME", () => {
  const TAB2 = src("src/components/reports/AutomacaoReportTab.tsx");
  const EXP2 = src("src/lib/reportExport.ts");

  it("a coluna Resultado saiu da tela", () => {
    expect(TAB2).not.toContain('<TableHead className="text-muted-foreground">Resultado</TableHead>');
  });

  it("as seis colunas oficiais estão presentes", () => {
    for (const c of ["Data", "Hora", "Poço", "Ação", "Origem", "Nome"])
      expect(TAB2, `coluna ${c} ausente`).toContain(`>${c}</TableHead>`);
  });

  it("'Confirmado por' e o detalhe técnico saíram da tela", () => {
    expect(TAB2).not.toContain("Confirmado por");
    expect(TAB2).not.toContain("<TechDetail item=");
  });

  it("a coluna Resultado saiu do PDF", () => {
    const bloco = EXP2.slice(EXP2.indexOf("exportAutomacaoPDF"), EXP2.indexOf("HORÍMETRO"));
    expect(bloco).not.toContain('"Resultado"');
  });
});
