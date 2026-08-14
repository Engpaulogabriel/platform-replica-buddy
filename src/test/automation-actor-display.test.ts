// Coluna Usuário = SÓ autoria humana.
// "Telemetria RF" é MÉTODO DE CONFIRMAÇÃO FÍSICA — nunca um ator. Estes testes
// travam a separação entre `actor_label` (quem) e `source_device`/método (como).
import { describe, it, expect } from "vitest";
import { isTechnicalActorLabel, resolveConfirmationMethod } from "@/lib/automationLog";

describe("rótulo técnico nunca é usuário", () => {
  it("reconhece os rótulos técnicos proibidos na coluna Usuário", () => {
    for (const s of [
      "Telemetria RF", "telemetria rf", "  Telemetria RF  ", "Telemetria",
      "RF", "agent", "Agente", "serial", "serial-bridge", "bridge",
      "system", "Sistema", "cloud", "auto-trigger", "agent-restart",
    ]) {
      expect(isTechnicalActorLabel(s)).toBe(true);
    }
  });

  it("não confunde nome de pessoa com rótulo técnico", () => {
    for (const s of [
      "Paulo Gabriel", "Alcione", "Luiz Carlos", "paulo@renov.com.br",
      "WhatsApp · Alcione", "Desligamento 17h", "Sistemas Agrícolas Ltda",
      "Rafael Serrano", // começa com "RF"? não — só casa token inteiro
    ]) {
      expect(isTechnicalActorLabel(s)).toBe(false);
    }
  });

  it("string vazia/nula não é técnica (é ausência de ator)", () => {
    expect(isTechnicalActorLabel(null)).toBe(false);
    expect(isTechnicalActorLabel(undefined)).toBe(false);
    expect(isTechnicalActorLabel("   ")).toBe(false);
  });
});

describe("método de confirmação física vai para o detalhe, não para o usuário", () => {
  const row = (over: Record<string, any> = {}) =>
    ({ actor_label: null, source_device: null, origin: "remote", user_id: null,
       user_email: null, details: {}, ...over }) as any;

  it("actor_label='Telemetria RF' vira texto de confirmação", () => {
    expect(resolveConfirmationMethod(row({ actor_label: "Telemetria RF" })))
      .toBe("Confirmado por telemetria RF");
  });

  it("source_device='serial-bridge' também indica confirmação por RF", () => {
    expect(resolveConfirmationMethod(row({ source_device: "serial-bridge" })))
      .toBe("Confirmado por telemetria RF");
  });

  it("ator humano NÃO gera método técnico", () => {
    expect(resolveConfirmationMethod(row({ actor_label: "Paulo Gabriel" }))).toBeNull();
  });

  it("WhatsApp não vira método técnico", () => {
    expect(resolveConfirmationMethod(row({ source_device: "whatsapp:Alcione|5577999" }))).toBeNull();
  });
});
