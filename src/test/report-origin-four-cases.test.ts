// @vitest-environment node
// ─────────────────────────────────────────────────────────────────────────────
// Coluna ORIGEM do Relatório: DUAS categorias, e só duas.
// ─────────────────────────────────────────────────────────────────────────────
// A tela tinha seis rótulos e misturava dois eixos: de onde partiu a ordem
// (remoto × local) e por qual canal ela chegou (WhatsApp, motor da nuvem,
// desligamento programado). O operador lia "WhatsApp" e "Automação" como
// origens concorrentes de "Remoto" — são a mesma origem.
//
// REMOTO = o comando partiu do sistema. Quem foi está na coluna NOME.
// LOCAL  = a bomba mudou de estado sem comando correlacionado.
import { describe, it, expect } from "vitest";
import {
  resolveReportOrigin, REPORT_ORIGIN_ICON, REPORT_ORIGIN_ICON_CLASS,
  REPORT_ORIGIN_BADGE, AUTO_ENGINE_SOURCE, type ReportOrigin,
} from "@/lib/reportOrigin";

describe("tudo que partiu do sistema é REMOTO", () => {
  const remotos: Array<[string, string | null]> = [
    ["Remoto", "web-app"],                                              // plataforma
    ["Remoto", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"],      // navegador
    ["WhatsApp", "whatsapp:Yuri Seibert|557798654782"],                 // canal WhatsApp
    ["Automático", "backend-reset:scheduled_shutdown_a1"],              // desligamento programado
    ["Automático", "backend-reset:scheduled_shutdown_a3_forced"],
    ["Automático", AUTO_ENGINE_SOURCE],                                 // motor da nuvem
    ["Modo Automático", AUTO_ENGINE_SOURCE],
    ["Automático", null],                                               // sem source_device
  ];
  for (const [origem, src] of remotos) {
    it(`${origem} / ${src ?? "null"} → Remoto`, () => {
      expect(resolveReportOrigin(origem, src)).toBe("Remoto");
    });
  }
});

describe("só o que não teve comando correlacionado é LOCAL", () => {
  it("atuação local declarada pela telemetria", () => {
    expect(resolveReportOrigin("Manual", null)).toBe("Local");
    expect(resolveReportOrigin("Manual", "agent-serial")).toBe("Local");
  });

  it("transição física sem correlação (origin='system' no banco)", () => {
    expect(resolveReportOrigin("Sistema", "auto-trigger")).toBe("Local");
    expect(resolveReportOrigin("Sistema", null)).toBe("Local");
  });
});

describe("o canal nunca vira categoria visual", () => {
  it("existem exatamente duas origens, e são Remoto e Local", () => {
    const chaves = Object.keys(REPORT_ORIGIN_ICON).sort();
    expect(chaves).toEqual(["Local", "Remoto"]);
    expect(Object.keys(REPORT_ORIGIN_ICON_CLASS).sort()).toEqual(chaves);
    expect(Object.keys(REPORT_ORIGIN_BADGE).sort()).toEqual(chaves);
  });

  it("nenhum rótulo de canal sobrevive como origem", () => {
    for (const canal of ["WhatsApp", "Automação", "Modo Automático", "Sistema"]) {
      expect(["Remoto", "Local"]).toContain(resolveReportOrigin(canal, null));
    }
    // e nenhum deles é chave do mapa de ícones
    for (const canal of ["WhatsApp", "Automação", "Modo Automático", "Sistema"]) {
      expect(Object.keys(REPORT_ORIGIN_ICON)).not.toContain(canal);
    }
  });

  it("a mão é do Local e de mais ninguém", () => {
    expect(REPORT_ORIGIN_ICON["Local"]).toBe("Hand");
    expect(REPORT_ORIGIN_ICON["Remoto"]).toBe("Monitor");
    const icones: ReportOrigin[] = ["Remoto", "Local"];
    expect(new Set(icones.map((o) => REPORT_ORIGIN_ICON[o])).size).toBe(2);
  });

  it("origem desconhecida NÃO vira Remoto", () => {
    // Remoto significa responsabilidade remota COMPROVADA. Um rótulo que não
    // conhecemos não é prova de comando; tratá-lo como Remoto era inventar
    // responsável. Sem prova, a linha é Local.
    expect(resolveReportOrigin("QualquerCoisa", "x")).toBe("Local");
  });
});
