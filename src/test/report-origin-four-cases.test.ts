// @vitest-environment node
// Coluna ORIGEM do Relatório: quatro casos do produto, mutuamente exclusivos.
// "Modo Automático" (motor da nuvem) deixa de ser confundido com "Automação"
// (desligamento programado e demais rotinas). Regra derivada de `source_device`,
// que já vinha do banco — sem migration.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  resolveReportOrigin, REPORT_ORIGIN_ICON, REPORT_ORIGIN_ICON_CLASS,
  REPORT_ORIGIN_BADGE, AUTO_ENGINE_SOURCE, type ReportOrigin,
} from "@/lib/reportOrigin";

describe("1 a 4. os quatro casos", () => {
  it("1. comando manual pela plataforma → Remoto", () => {
    expect(resolveReportOrigin("Remoto", "web-app")).toBe("Remoto");
  });

  it("2. acionamento físico local → Local", () => {
    expect(resolveReportOrigin("Manual", null)).toBe("Local");
    expect(resolveReportOrigin("Manual", "agent-serial")).toBe("Local");
  });

  it("3. scheduled-shutdown → Automação", () => {
    // O RPC do desligamento programado grava `backend-reset:scheduled_shutdown_aN`.
    expect(resolveReportOrigin("Automático", "backend-reset:scheduled_shutdown_a1")).toBe("Automação");
    expect(resolveReportOrigin("Automático", "backend-reset:scheduled_shutdown_a3_forced")).toBe("Automação");
  });

  it("4. cloud-automation → Modo Automático", () => {
    expect(resolveReportOrigin("Automático", AUTO_ENGINE_SOURCE)).toBe("Modo Automático");
    expect(resolveReportOrigin("Automático", "cloud-automation")).toBe("Modo Automático");
  });

  it("4b. comparação é exata e tolera caixa/espaço, mas não prefixo", () => {
    expect(resolveReportOrigin("Automático", "  Cloud-Automation ")).toBe("Modo Automático");
    // um motor futuro com nome parecido NÃO pode virar Modo Automático por engano
    expect(resolveReportOrigin("Automático", "cloud-automation-v2")).toBe("Automação");
    expect(resolveReportOrigin("Automático", "peak-hour")).toBe("Automação");
  });
});

describe("5 e 6. exclusividade", () => {
  it("5. nenhuma origem automática usa o ícone da mão", () => {
    for (const o of ["Automação", "Modo Automático"] as ReportOrigin[]) {
      expect(REPORT_ORIGIN_ICON[o]).not.toBe("Hand");
    }
    expect(REPORT_ORIGIN_ICON["Local"]).toBe("Hand");
  });

  it("6. os quatro ícones do produto são todos diferentes", () => {
    const quatro: ReportOrigin[] = ["Remoto", "Local", "Automação", "Modo Automático"];
    const icones = quatro.map((o) => REPORT_ORIGIN_ICON[o]);
    expect(new Set(icones).size).toBe(4);
  });

  it("6b. Modo Automático não cai no genérico quando falta source_device", () => {
    // Sem o dado, o seguro é o genérico — nunca afirmar o específico.
    expect(resolveReportOrigin("Automático", null)).toBe("Automação");
    expect(resolveReportOrigin("Automático", undefined)).toBe("Automação");
    expect(resolveReportOrigin("Automático", "")).toBe("Automação");
  });
});

describe("7 a 9. o que NÃO pode mudar", () => {
  it("7. Remoto permanece idêntico: monitor, azul", () => {
    expect(REPORT_ORIGIN_ICON["Remoto"]).toBe("Monitor");
    expect(REPORT_ORIGIN_ICON_CLASS["Remoto"]).toBe("text-info");
    expect(REPORT_ORIGIN_BADGE["Remoto"]).toBe("bg-info/10 text-info");
  });

  it("8. Local permanece idêntico ao que o código já fazia", () => {
    expect(REPORT_ORIGIN_ICON["Local"]).toBe("Hand");
    expect(REPORT_ORIGIN_ICON_CLASS["Local"]).toBe("text-warning");
    expect(REPORT_ORIGIN_BADGE["Local"]).toBe("bg-warning/15 text-warning border border-warning/30");
  });

  it("Automação e Modo Automático são AZUL (--info), como pedido", () => {
    for (const o of ["Automação", "Modo Automático"] as ReportOrigin[]) {
      expect(REPORT_ORIGIN_ICON_CLASS[o]).toBe("text-info");
      expect(REPORT_ORIGIN_BADGE[o]).toBe("bg-info/10 text-info");
    }
  });

  it("WhatsApp segue intocado", () => {
    expect(resolveReportOrigin("WhatsApp", "whatsapp-webhook")).toBe("WhatsApp");
    expect(REPORT_ORIGIN_ICON["WhatsApp"]).toBe("MessageCircle");
  });

  it("origem 'system' é transição sem origem comprovada, não 'Sistema'", () => {
    // O banco grava origin='system' quando a transição física é real mas
    // nenhuma correlação a explicou. Antes isso virava "Local / Acionamento
    // local" — afirmação sobre o mundo físico sem prova. A tela precisa dizer
    // o que de fato se sabe.
    expect(resolveReportOrigin("Sistema", "auto-trigger")).toBe("Origem não identificada");
    expect(resolveReportOrigin("Sistema", null)).toBe("Origem não identificada");
    expect(REPORT_ORIGIN_ICON["Origem não identificada"]).toBe("Server");
  });

  it("origem crua desconhecida não vira rótulo inventado", () => {
    expect(resolveReportOrigin("QualquerCoisa", "x")).toBe("QualquerCoisa");
  });
});

describe("9 e 10. nome e layout", () => {
  it("9. a resolução de ORIGEM não toca no NOME do evento", () => {
    // resolveReportOrigin só recebe origin e source_device — não há caminho
    // pelo qual ela possa alterar actor/nome da automação.
    expect(resolveReportOrigin.length).toBe(2);
  });

  it("10. o tab renderiza ORIGEM pelos helpers, sem coluna nova", () => {
    const tab = fs.readFileSync(path.resolve(__dirname,
      "../components/reports/AutomacaoReportTab.tsx"), "utf8");
    // a decisão vem do módulo puro, não de if solto no componente
    expect(tab).toContain("resolveReportOrigin");
    expect(tab).not.toContain('if (origin === "Automático") return "Automação"');
    // continua passando item.sourceDevice em todos os pontos de origem
    expect(tab).toContain("getOriginLabel(item.origin, item.sourceDevice)");
    expect(tab).toContain("getOriginIcon(item.origin, item.sourceDevice)");
  });
});
