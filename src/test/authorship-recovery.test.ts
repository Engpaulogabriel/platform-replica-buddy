import { describe, it, expect } from "vitest";
import {
  buildBatches,
  classifySuggestion,
  applyReconciliation,
  isStrongSource,
  type RemoteEvent,
  type QueueRowState,
} from "@/lib/authorship/reconciliation";

const FARM = "farm-1";
const YURI = "user-yuri";
const ADMIN = "user-admin";

const ev = (id: string, min: number, over: Partial<RemoteEvent> = {}): RemoteEvent => ({
  id,
  farm_id: FARM,
  occurred_at: new Date(Date.UTC(2026, 7, 14, 10, min, 0)).toISOString(),
  action: "turn_on",
  user_id: null,
  ...over,
});

describe("geração de lotes", () => {
  it("agrupa eventos próximos e separa por gap maior que a janela", () => {
    const batches = buildBatches([ev("a", 0), ev("b", 1), ev("c", 30)]);
    expect(batches).toHaveLength(2);
    expect(batches[0].event_ids).toEqual(["a", "b"]);
    expect(batches[0].events_unnamed).toBe(2);
    expect(batches[1].event_ids).toEqual(["c"]);
  });

  it("separa lotes por intenção (ligar/desligar) e ignora ruído", () => {
    const batches = buildBatches([
      ev("on", 0),
      ev("off", 1, { action: "turn_off" }),
      ev("noise", 1, { noise_reason: "duplicidade" }),
    ]);
    expect(batches.map((b) => b.intent).sort()).toEqual(["desligar", "ligar"]);
    expect(batches.flatMap((b) => b.event_ids)).not.toContain("noise");
  });

  it("fazenda sem eventos remotos sem nome não gera lote", () => {
    expect(buildBatches([ev("x", 0, { user_id: YURI })])).toHaveLength(0);
  });
});

describe("classificação da evidência", () => {
  const batch = buildBatches([ev("a", 0), ev("b", 1, { user_id: YURI })])[0];

  it("nome vindo apenas de fonte indireta/legada é corroborated_batch, nunca strong", () => {
    const s = classifySuggestion(batch, []);
    expect(s.suggested_user).toBe(YURI);
    expect(s.suggestion_strength).toBe("corroborated_batch");
    expect(s.suggestion_source).toBe("nome_ja_presente_no_lote:legado_sem_fonte");
  });

  it("trilha direta (command_audit) é strong e informa a fonte", () => {
    const s = classifySuggestion(batch, [{ user_id: ADMIN, fonte: "command_audit" }]);
    expect(s.suggestion_strength).toBe("strong");
    expect(s.suggestion_source).toBe("command_audit");
    expect(s.suggested_user).toBe(ADMIN);
  });

  it("last_changed_by não é fonte forte", () => {
    expect(isStrongSource("last_changed_by")).toBe(false);
    expect(isStrongSource("equipments.last_changed_by")).toBe(false);
    expect(isStrongSource("command_audit")).toBe(true);
  });

  it("mais de uma pessoa nomeada no lote não gera sugestão", () => {
    const b = buildBatches([ev("a", 0), ev("b", 1, { user_id: YURI }), ev("c", 2, { user_id: ADMIN })])[0];
    expect(classifySuggestion(b, []).suggested_user).toBeNull();
  });
});

const queue = (over: Partial<QueueRowState> = {}): QueueRowState => ({
  id: "q1",
  farm_id: FARM,
  status: "pending",
  event_ids: ["a", "b"],
  suggested_user: YURI,
  suggestion_strength: "strong",
  suggestion_source: "command_audit",
  ...over,
});

describe("aplicação com IDs congelados", () => {
  it("aplica somente os IDs autorizados", () => {
    const r = applyReconciliation({
      queue: queue(),
      expectedIds: ["a", "b"],
      currentUnnamedIds: ["b", "a"],
      userId: YURI,
      executor: ADMIN,
      caller: ADMIN,
      role: "platform_admin",
    });
    expect(r.updatedIds.sort()).toEqual(["a", "b"]);
    expect(r.confidence).toBe("strong");
  });

  it("bloqueia quando o conjunto mudou desde a conferência", () => {
    expect(() =>
      applyReconciliation({
        queue: queue(),
        expectedIds: ["a", "b"],
        currentUnnamedIds: ["a"],
        userId: YURI,
        executor: ADMIN,
        caller: ADMIN,
        role: "owner",
      }),
    ).toThrow(/conjunto mudou/i);
  });

  it("bloqueia reaplicação de lote já aplicado (anti-replay)", () => {
    expect(() =>
      applyReconciliation({
        queue: queue({ status: "applied" }),
        expectedIds: ["a", "b"],
        currentUnnamedIds: ["a", "b"],
        userId: YURI,
        executor: ADMIN,
        caller: ADMIN,
        role: "platform_admin",
      }),
    ).toThrow(/anti-replay/i);
  });
});

describe("autorização", () => {
  const base = {
    queue: queue(),
    expectedIds: ["a", "b"],
    currentUnnamedIds: ["a", "b"],
    userId: YURI,
  };

  it("bloqueia usuário comum", () => {
    expect(() =>
      applyReconciliation({ ...base, executor: "user-op", caller: "user-op", role: "operator" }),
    ).toThrow(/sem autorização/i);
  });

  it("bloqueia chamada não autenticada", () => {
    expect(() =>
      applyReconciliation({ ...base, executor: ADMIN, caller: null, role: "platform_admin" }),
    ).toThrow(/não autenticada/i);
  });

  it("bloqueia executor falsificado", () => {
    expect(() =>
      applyReconciliation({ ...base, executor: "outro", caller: ADMIN, role: "platform_admin" }),
    ).toThrow(/difere do usuário autenticado/i);
  });
});

describe("nunca aplicar automaticamente lote apenas corroborado", () => {
  const corr = queue({ suggestion_strength: "corroborated_batch", suggestion_source: "nome_ja_presente_no_lote:legado_sem_fonte" });
  const base = {
    queue: corr,
    expectedIds: ["a", "b"],
    currentUnnamedIds: ["a", "b"],
    userId: YURI,
    executor: ADMIN,
    caller: ADMIN,
    role: "platform_admin" as const,
  };

  it("exige confirmação explícita", () => {
    expect(() => applyReconciliation(base)).toThrow(/Confirmação explícita obrigatória/i);
  });

  it("aplica com confirmação e registra a confiança real", () => {
    const r = applyReconciliation({ ...base, confirmCorroborated: true });
    expect(r.confidence).toBe("corroborated_batch");
    expect(r.updatedIds).toEqual(["a", "b"]);
  });

  it("escolha administrativa diferente da sugestão é registrada como admin_decision", () => {
    const r = applyReconciliation({ ...base, userId: ADMIN });
    expect(r.confidence).toBe("admin_decision");
  });
});
