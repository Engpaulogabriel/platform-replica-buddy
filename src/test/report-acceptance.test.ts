import { describe, it, expect } from "vitest";
import { auditAcceptance, farmScoreboard, CRITERIA, type AuditEvent } from "@/lib/authorship/acceptance";

const e = (over: Partial<AuditEvent> = {}): AuditEvent => ({
  farm_id: "f1",
  origin: "remote",
  user_id: null,
  actor_label: null,
  ...over,
});

describe("auditor de aceitação", () => {
  it("não repete critério — cada um aparece exatamente uma vez", () => {
    const res = auditAcceptance([e(), e(), e({ origin: "local", user_id: "u1" })]);
    const nomes = res.map((r) => r.criterio);
    expect(nomes).toEqual([...CRITERIA]);
    expect(new Set(nomes).size).toBe(nomes.length);
  });

  it("conta remotos sem usuário e sem fonte auditável", () => {
    const res = auditAcceptance([e(), e({ user_id: "u1", authorship_source: "command_audit" })]);
    expect(res.find((r) => r.criterio === "remoto sem usuário")!.violacoes).toBe(1);
    expect(res.find((r) => r.criterio === "remoto sem fonte auditável")!.violacoes).toBe(1);
  });

  it("aponta rótulo técnico usado como usuário", () => {
    const res = auditAcceptance([e({ actor_label: "Telemetria RF" })]);
    expect(res.find((r) => r.criterio === "rótulo provisório como usuário")!.passou).toBe(false);
  });

  it("passa quando toda autoria remota está resolvida", () => {
    const res = auditAcceptance([
      e({ user_id: "u1", actor_label: "Yuri Seibert", authorship_source: "command_audit" }),
    ]);
    expect(res.every((r) => r.passou)).toBe(true);
  });

  it("ignora eventos marcados como ruído", () => {
    const res = auditAcceptance([e({ noise_reason: "duplicidade" })]);
    expect(res.every((r) => r.violacoes === 0)).toBe(true);
  });
});

describe("placar por fazenda", () => {
  it("fazenda sem eventos aparece com contagem zero", () => {
    const rows = farmScoreboard(
      [
        { id: "f1", name: "Semear" },
        { id: "f2", name: "Sykue" },
      ],
      [e({ farm_id: "f1" })],
    );
    expect(rows).toHaveLength(2);
    const sykue = rows.find((r) => r.farm_id === "f2")!;
    expect(sykue.eventos).toBe(0);
    expect(sykue.remotos_sem_nome).toBe(0);
    expect(rows.find((r) => r.farm_id === "f1")!.remotos_sem_nome).toBe(1);
  });
});
