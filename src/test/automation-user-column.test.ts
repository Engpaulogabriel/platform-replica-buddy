// Coluna Usuário: nenhum rótulo técnico/canal pode virar pessoa.
import { describe, it, expect } from "vitest";
import { isTechnicalActorLabel, AUTHORSHIP_UNDER_REVIEW } from "@/lib/automationLog";

describe("proibidos na coluna Usuário", () => {
  it("rejeita todos os rótulos técnicos e de canal", () => {
    for (const s of ["Comando Remoto", "comando remoto", "Telemetria RF", "RF", "Agent",
                     "Bridge", "Serial", "Sistema", "remote", "Remoto", "unknown", "N/A", "n/a"]) {
      expect(isTechnicalActorLabel(s)).toBe(true);
    }
  });
  it("preserva pessoas e rótulos legítimos", () => {
    for (const s of ["Yuri Seibert", "Automação 17h Semear", "WhatsApp · Alcione",
                     "Nome Sobrenome", "seibertyuri@gmail.com"]) {
      expect(isTechnicalActorLabel(s)).toBe(false);
    }
  });
  it("texto de revisão é exatamente o exigido", () => {
    expect(AUTHORSHIP_UNDER_REVIEW).toBe("Autoria histórica em revisão");
  });
});
