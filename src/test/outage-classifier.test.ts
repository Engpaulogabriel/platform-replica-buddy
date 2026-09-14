// @vitest-environment node
// Falta de comunicação NUNCA é prova de energia. "Possível falta de energia"
// exige TRANSIÇÕES FÍSICAS CONFIRMADAS de bomba (LIGADO → DESLIGADO) em
// sequência curta, sem comando que as explique.
import { describe, it, expect } from "vitest";
import fs from "node:fs"; import path from "node:path";
import { classifyOutage, detectPowerPattern, incidentRef, recoveryMessage,
         INCIDENT_TITLE, THRESHOLDS,
         type OutageEvidence, type PumpOffTransition,
       } from "../../supabase/functions/_shared/outageClassifier.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 7, 24, 17, 0, 0);

/** Sequência de bombas distintas desligando de N em N segundos. */
const seq = (n: number, gapS = 5, base = T0): PumpOffTransition[] =>
  Array.from({ length: n }, (_, i) => ({
    equipmentId: `bomba-${i + 1}`, atMs: base + i * gapS * 1000,
  }));

/** Cenário saudável: agente vivo, bridge conectada, nada desligou. */
const ev = (o: Partial<OutageEvidence> = {}): OutageEvidence => ({
  agentHeartbeatAgeMs: 30_000,
  bridgeConnected: true,
  bridgeIoAgeMs: 20_000,
  totalEquipments: 10,
  affectedEquipments: 5,
  confirmedPumpOffs: [],
  hasCompatibleCommandOrAutomation: false,
  powerSensorDown: null,
  ...o,
});

// ─── OS OITO CENÁRIOS OBRIGATÓRIOS ─────────────────────────────────────────
describe("cenários obrigatórios", () => {
  it("1. 5 bombas perdem comunicação sem confirmação de DESLIGADO → não é energia", () => {
    const c = classifyOutage(ev({ totalEquipments: 5, affectedEquipments: 5,
                                  confirmedPumpOffs: [] }));
    expect(c.type).not.toBe("power_suspected");
    expect(c.type).not.toBe("power_confirmed");
    expect(c.title).not.toMatch(/energia/i);
  });

  it("2. 5 bombas JÁ DESLIGADAS perdem comunicação → não é energia", () => {
    // Bomba já desligada não produz linha `turn_off`: o bit não muda.
    const c = classifyOutage(ev({ totalEquipments: 5, affectedEquipments: 5,
                                  confirmedPumpOffs: [] }));
    expect(c.title).not.toMatch(/energia/i);
    expect(c.power.pumps).toBe(0);
  });

  it("3. UMA bomba ligada passa para desligada → não gera alerta coletivo", () => {
    const c = classifyOutage(ev({ confirmedPumpOffs: seq(1) }));
    expect(c.type).not.toBe("power_suspected");
    expect(c.title).not.toMatch(/energia/i);
  });

  it("4. 4 bombas desligam em sequência curta → PODE gerar falta de energia", () => {
    // 0s, 5s, 12s, 16s — exatamente o padrão descrito na regra de negócio.
    const t: PumpOffTransition[] = [
      { equipmentId: "A", atMs: T0 },
      { equipmentId: "B", atMs: T0 + 5_000 },
      { equipmentId: "C", atMs: T0 + 12_000 },
      { equipmentId: "D", atMs: T0 + 16_000 },
    ];
    const c = classifyOutage(ev({ confirmedPumpOffs: t }));
    expect(c.type).toBe("power_suspected");
    expect(c.title).toBe("Possível falta de energia");
    expect(c.power.pumps).toBe(4);
  });

  it("5. as mesmas 4 desligadas por COMANDO do usuário → não é energia", () => {
    const c = classifyOutage(ev({ confirmedPumpOffs: seq(4),
                                  hasCompatibleCommandOrAutomation: true }));
    expect(c.type).not.toBe("power_suspected");
    expect(c.title).not.toMatch(/energia/i);
  });

  it("6. desligam sozinhas e DEPOIS perdem comunicação → um único alerta de energia", () => {
    const c = classifyOutage(ev({ confirmedPumpOffs: seq(4),
                                  totalEquipments: 4, affectedEquipments: 4,
                                  agentHeartbeatAgeMs: 9 * MIN,   // PC caiu junto
                                  bridgeConnected: false }));
    expect(c.type).toBe("power_suspected");
    // A chave é a MESMA em reavaliações dentro do bucket → upsert, não insert.
    const a = incidentRef("f1", c.type, T0);
    const b = incidentRef("f1", c.type, T0 + 9 * MIN);
    expect(b).toBe(a);
  });

  it("7. rádio/repetidor cai, estado operacional inalterado → não é energia", () => {
    const c = classifyOutage(ev({ totalEquipments: 20, affectedEquipments: 6,
                                  confirmedPumpOffs: [] }));
    expect(c.type).toBe("rf_degraded");
    expect(c.title).not.toMatch(/energia/i);
  });

  it("8. nível/reservatório/sensor mudos não viram bombas desligando", () => {
    // Esses tipos jamais entram em `confirmedPumpOffs` — o trigger os exclui
    // antes de gravar. Aqui a garantia é que silêncio deles não classifica.
    const c = classifyOutage(ev({ totalEquipments: 8, affectedEquipments: 8,
                                  confirmedPumpOffs: [] }));
    expect(c.title).not.toMatch(/energia/i);
    expect(c.type).toBe("indeterminate");
  });
});

// ─── JANELA DESLIZANTE ─────────────────────────────────────────────────────
describe("detectPowerPattern — sequência e bombas distintas", () => {
  it("4 bombas espalhadas por 10 min NÃO formam padrão", () => {
    const t = seq(4, 150);                    // 0, 2min30, 5min, 7min30
    expect(detectPowerPattern(t).qualifies).toBe(false);
  });

  it("a MESMA bomba desligando 4 vezes não são 4 bombas", () => {
    const t: PumpOffTransition[] = [0, 5, 10, 15].map((s) => ({
      equipmentId: "unica", atMs: T0 + s * 1000,
    }));
    const p = detectPowerPattern(t);
    expect(p.pumps).toBe(1);
    expect(p.qualifies).toBe(false);
  });

  it("encontra a melhor janela mesmo com ruído antes", () => {
    const t: PumpOffTransition[] = [
      { equipmentId: "X", atMs: T0 - 20 * MIN },
      ...seq(4, 5, T0),
    ];
    const p = detectPowerPattern(t);
    expect(p.pumps).toBe(4);
    expect(p.qualifies).toBe(true);
    expect(p.startedAtMs).toBe(T0);
  });

  it("3 bombas não bastam; a quarta fecha o padrão", () => {
    expect(detectPowerPattern(seq(3)).qualifies).toBe(false);
    expect(detectPowerPattern(seq(4)).qualifies).toBe(true);
  });

  it("lista vazia é inerte", () => {
    expect(detectPowerPattern([])).toEqual(
      { qualifies: false, pumps: 0, spanMs: 0, startedAtMs: null });
  });
});

// ─── PRECEDÊNCIA ───────────────────────────────────────────────────────────
describe("infraestrutura explica silêncio; transição física explica energia", () => {
  it("sem heartbeat e SEM transição → agente, não energia", () => {
    const c = classifyOutage(ev({ agentHeartbeatAgeMs: 6 * MIN, confirmedPumpOffs: [] }));
    expect(c.type).toBe("agent_offline");
    expect(c.title).toBe(INCIDENT_TITLE.agent_offline);
  });

  it("bridge desconectada e SEM transição → bridge, não energia", () => {
    const c = classifyOutage(ev({ bridgeConnected: false, confirmedPumpOffs: [] }));
    expect(c.type).toBe("bridge_down");
  });

  it("bridge sem RX/TX há muito tempo → bridge", () => {
    expect(classifyOutage(ev({ bridgeIoAgeMs: 6 * MIN })).type).toBe("bridge_down");
  });

  it("sensor físico → confirmada, com precedência sobre tudo", () => {
    const c = classifyOutage(ev({ powerSensorDown: true, agentHeartbeatAgeMs: 9 * MIN }));
    expect(c.type).toBe("power_confirmed");
    expect(c.confidence).toBe("alta");
  });

  it("sensor dizendo que a energia está OK não gera indício", () => {
    expect(classifyOutage(ev({ powerSensorDown: false, confirmedPumpOffs: [] })).type)
      .not.toBe("power_suspected");
  });

  it("nenhuma contagem de poços mudos, sozinha, produz título de energia", () => {
    for (const n of [4, 5, 8, 10]) {
      const c = classifyOutage(ev({ totalEquipments: 10, affectedEquipments: n,
                                    confirmedPumpOffs: [] }));
      expect(c.title, `${n} poços mudos`).not.toMatch(/energia/i);
    }
  });
});

// ─── DEDUPLICAÇÃO ──────────────────────────────────────────────────────────
describe("um incidente, não um alerta a cada tick", () => {
  const FARM = "aaaa-1111";
  it("a mesma janela devolve a MESMA chave — nada de UUID aleatório", () => {
    const t = Date.UTC(2026, 7, 14, 21, 0, 0);
    const a = incidentRef(FARM, "indeterminate", t);
    expect(incidentRef(FARM, "indeterminate", t + 4 * MIN)).toBe(a);
    expect(incidentRef(FARM, "indeterminate", t + 26 * MIN)).toBe(a);
  });

  it("reavaliações ao longo de 30 min não criam chave nova", () => {
    const t = Date.UTC(2026, 7, 14, 21, 0, 0);
    const chaves = new Set([0, 4, 12, 19, 26].map((m) =>
      incidentRef(FARM, "indeterminate", t + m * MIN)));
    expect(chaves.size).toBe(1);
  });

  it("tipo diferente = incidente diferente", () => {
    expect(incidentRef(FARM, "bridge_down", T0)).not.toBe(incidentRef(FARM, "rf_degraded", T0));
  });

  it("fazenda diferente = incidente diferente", () => {
    expect(incidentRef("f1", "indeterminate", T0)).not.toBe(incidentRef("f2", "indeterminate", T0));
  });

  it("a chave é determinística e não contém aleatoriedade", () => {
    expect(incidentRef(FARM, "indeterminate", T0)).toBe(incidentRef(FARM, "indeterminate", T0));
    expect(incidentRef(FARM, "indeterminate", T0)).toMatch(/^aaaa-1111:indeterminate:\d+$/);
  });

  it("a recuperação informa causa, duração e poços", () => {
    const c = classifyOutage(ev({ totalEquipments: 10, affectedEquipments: 10 }));
    const m = recoveryMessage(c, T0, T0 + 22 * MIN, ["POÇO 01", "POÇO 02"]);
    expect(m).toMatch(/Comunicação restabelecida/);
    expect(m).toContain(c.title);
    expect(m).toMatch(/22 min/);
    expect(m).toContain("POÇO 01, POÇO 02");
  });
});

// ─── O CÓDIGO ANTIGO NÃO PODE VOLTAR ───────────────────────────────────────
describe("o bloco #6 do tick não pode voltar a olhar só comunicação", () => {
  const REPO = path.resolve(__dirname, "../..");
  const TICK = fs.readFileSync(
    path.join(REPO, "supabase/functions/critical-alerts-tick/index.ts"), "utf8");
  // Só o CORPO do bloco #6 — comentários de cabeçalho do arquivo não contam.
  const ini = TICK.indexOf("const powerWindowStart");
  const fim = TICK.indexOf("// ─── #7 safety_timer_fired");
  const BLOCO = TICK.slice(ini, fim);

  it("o bloco #6 foi de fato encontrado", () => {
    expect(ini).toBeGreaterThan(0);
    expect(fim).toBeGreaterThan(ini);
  });

  it("nenhum incidente usa crypto.randomUUID como source_ref", () => {
    expect(BLOCO).not.toMatch(/source_ref:\s*crypto\.randomUUID\(\)/);
    expect(TICK).not.toMatch(/source_ref:\s*crypto\.randomUUID\(\)/);
  });

  it("o título de energia não é escrito à mão no tick", () => {
    expect(BLOCO).not.toMatch(/title:\s*"Possível falta de energia"/);
    expect(BLOCO).toContain("title: cls.title");
  });

  it("a mensagem não afirma mais desligamento a partir de perda de comunicação", () => {
    expect(BLOCO).not.toMatch(/perderam comunicação simultaneamente/);
  });

  it("o bloco lê transições físicas de automation_log", () => {
    expect(BLOCO).toContain('.in("action", ["turn_off", "pump_off"])');
    expect(BLOCO).toContain('.in("origin", ["reading", "system"])');
  });

  it("origens intencionais ficam fora da contagem de energia", () => {
    const origins = BLOCO.match(/\.in\("origin", \[[^\]]*\]\)/)?.[0] ?? "";
    expect(origins).not.toContain("local");
    expect(origins).not.toContain("remote");
    expect(origins).not.toContain("auto");
  });

  it("não consulta noise_reason — a coluna NÃO existe em produção", () => {
    // `20260814200300` nunca foi aplicada. Usar a coluna faria o PostgREST
    // devolver 400 e a detecção de energia morreria em silêncio.
    expect(BLOCO).not.toContain("noise_reason");
  });

  it("uma falha na leitura das transições aparece no retorno do tick", () => {
    expect(BLOCO).toContain("pumpOffErr");
    expect(TICK).toContain("power_evidence_error");
  });

  it("o bloco restringe a bombas", () => {
    expect(BLOCO).toMatch(/type === "poco" \|\| e\.type === "bombeamento"/);
  });

  it("o bloco correlaciona com comandos manuais/automação", () => {
    expect(BLOCO).toContain('.in("type", ["manual", "automation"])');
    expect(BLOCO).toContain("hasCompatibleCommandOrAutomation: commandedNearby");
  });

  it("o source_ref passa pelo uuidFromString (a coluna é uuid)", () => {
    expect(BLOCO).toMatch(/uuidFromString\(incidentRef\(/);
  });

  it("o tick usa o classificador", () => {
    expect(BLOCO).toContain("classifyOutage");
    expect(BLOCO).toContain("incidentRef");
  });

  it("os limiares ficam no classificador, não espalhados", () => {
    expect(THRESHOLDS.agentDeadMs).toBe(5 * MIN);
    // Mesmos valores que BLACKOUT_MIN_EQUIPS / BLACKOUT_WINDOW_S já usavam.
    expect(THRESHOLDS.powerMinPumps).toBe(4);
    expect(THRESHOLDS.powerWindowMs).toBe(60_000);
    expect(TICK).toMatch(/const BLACKOUT_MIN_EQUIPS = 4;/);
    expect(TICK).toMatch(/const BLACKOUT_WINDOW_S = 60;/);
  });
});
