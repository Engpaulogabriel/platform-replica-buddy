// @vitest-environment node
// O desligamento programado aparecia no relatório mas era INVISÍVEL para o
// notificador de WhatsApp, que lê apenas `automation_execution_log`. Yuri e
// Jonatan nunca eram avisados. Aqui garantimos que o pipeline existente passa a
// ser alimentado — sem criar um segundo sistema de envio.
import { describe, it, expect } from "vitest";
import fs from "node:fs"; import path from "node:path";

const REPO = path.resolve(__dirname, "../..");
const SHUTDOWN = fs.readFileSync(
  path.join(REPO, "supabase/functions/scheduled-shutdown/index.ts"), "utf8");
const NOTIFY = fs.readFileSync(
  path.join(REPO, "supabase/functions/whatsapp-automation-notify/index.ts"), "utf8");
/** Só o código: comentários citam nomes de tabela e não podem contar. */
const CODE = SHUTDOWN.split("\n").filter((l) => !l.trim().startsWith("//")
  && !l.trim().startsWith("*") && !l.trim().startsWith("/*")).join("\n");

// ── Reimplementação fiel de logExecution() para testar a REGRA ──────────────
// A função vive dentro de uma Edge Function Deno; aqui validamos o contrato dos
// dados que ela produz, que é o que o notificador consome.
const COMM_STALE_MS = 30 * 60_000;
type Pump = { id: string; name: string; last_communication?: string | null;
              last_actuation_origin?: string | null };

type Rule = { id: string; farm_id: string; name: string; time_brt?: string | null };
function buildRows(a: Rule, scope: Pump[], stillOn: Pump[], now: Date) {
  if (!scope.length) return [];
  const stillOnById = new Map(stillOn.map((p) => [p.id, p]));
  const nowIso = now.toISOString();
  const staleAt = now.getTime() - COMM_STALE_MS;
  return scope.map((p) => {
    const aindaLigada = stillOnById.get(p.id);
    let failureReason: string | null = null;
    if (aindaLigada) {
      const semComm = !aindaLigada.last_communication
        || new Date(aindaLigada.last_communication).getTime() < staleAt;
      failureReason = semComm ? "offline"
        : (String(aindaLigada.last_actuation_origin ?? "").toLowerCase() === "local"
            ? "local_mode" : "no_response");
    }
    return {
      farm_id: a.farm_id, equipment_id: p.id, schedule_id: null,
      action: "desliga", origin: "automacao",
      status: aindaLigada ? "failed" : "success",
      scheduled_time: a.time_brt ?? null, executed_at: nowIso,
      failure_reason: failureReason,
      details: { automation_name: String(a.name).trim(), equipment_name: p.name,
                 automation_id: a.id, source: "scheduled-shutdown" },
    };
  });
}

const NOW = new Date("2026-09-02T20:05:00.000Z");
const SEMEAR = { id: "auto-1", farm_id: "farm-semear", name: "Desligamento 17h Semear", time_brt: "17:00" };
const pump = (n: number): Pump => ({ id: `p${n}`, name: `POÇO ${String(n).padStart(2, "0")} R1` });
const SCOPE14 = Array.from({ length: 14 }, (_, i) => pump(i + 1));

describe("1 a 3. o ciclo produz evento notificável", () => {
  it("1 e 2. 14 bombas desligadas → 14 linhas em automation_execution_log", () => {
    const rows = buildRows(SEMEAR, SCOPE14, [], NOW);
    expect(rows).toHaveLength(14);
    expect(rows.every((r) => r.status === "success")).toBe(true);
    expect(rows.every((r) => r.action === "desliga")).toBe(true);
    expect(rows.every((r) => r.farm_id === "farm-semear")).toBe(true);
  });

  it("3. notified_at não é escrito — fica NULL pelo default da coluna", () => {
    const rows = buildRows(SEMEAR, SCOPE14, [], NOW);
    expect(rows.every((r) => !("notified_at" in r))).toBe(true);
  });

  it("o executed_at é o do passo final, não o de cada tentativa", () => {
    const rows = buildRows(SEMEAR, SCOPE14, [], NOW);
    expect(new Set(rows.map((r) => r.executed_at)).size).toBe(1);
    expect(rows[0].executed_at).toBe(NOW.toISOString());
  });
});

describe("4. o notificador enxerga o evento", () => {
  it("o ARQUIVO grava o contrato exato que o agrupador exige", () => {
    // Sem isto, o teste validaria só a reimplementação local e um `origin`
    // errado no código real passaria despercebido.
    const bloco = CODE.slice(CODE.indexOf("async function logExecution"),
                             CODE.indexOf("async function fetchFarmName"));
    expect(bloco).toMatch(/origin:\s*"automacao"/);
    expect(bloco).toMatch(/action:\s*"desliga"/);
    expect(bloco).toMatch(/status:\s*desligou\s*\?\s*"success"\s*:\s*"failed"/);
    expect(bloco).toMatch(/automation_name:/);
    expect(bloco).toMatch(/failure_reason:/);
    expect(bloco).toMatch(/scheduled_time:\s*a\.time_brt/);
    expect(bloco).toMatch(/farm_id:\s*a\.farm_id/);
    // notified_at jamais é escrito na inserção.
    expect(bloco).not.toMatch(/notified_at:/);
  });

  it("os rótulos de falha do ARQUIVO são os que o notificador traduz", () => {
    const bloco = CODE.slice(CODE.indexOf("async function logExecution"),
                             CODE.indexOf("async function fetchFarmName"));
    expect(bloco).toContain('"offline"');
    expect(bloco).toContain('"local_mode"');
    expect(bloco).toContain('"no_response"');
  });

  it("origin e details batem com o contrato do agrupador", () => {
    // notify: autoName = (r.origin === "automacao" && r.details?.automation_name)
    const r = buildRows(SEMEAR, [pump(1)], [], NOW)[0];
    expect(r.origin).toBe("automacao");
    expect(r.details.automation_name).toBe("Desligamento 17h Semear");
    expect(NOTIFY).toContain('r.origin === "automacao" && r.details?.automation_name');
  });

  it("status está entre os que o notificador busca", () => {
    expect(NOTIFY).toContain('.in("status", ["success", "expired", "failed"])');
    const rows = buildRows(SEMEAR, SCOPE14, [pump(3)], NOW);
    expect(new Set(rows.map((r) => r.status))).toEqual(new Set(["success", "failed"]));
  });

  it("o notificador filtra por notified_at nulo e janela de 5 min", () => {
    expect(NOTIFY).toContain('.is("notified_at", null)');
    expect(NOTIFY).toContain("5 * 60 * 1000");
  });

  it("motivo de falha usa os rótulos que o notificador sabe traduzir", () => {
    expect(NOTIFY).toContain('g.reason === "offline"');
    expect(NOTIFY).toContain('g.reason === "local_mode"');
    const mudo = { ...pump(9), last_communication: "2026-09-02T18:00:00.000Z" };
    const local = { ...pump(8), last_communication: NOW.toISOString(), last_actuation_origin: "local" };
    const semResp = { ...pump(7), last_communication: NOW.toISOString(), last_actuation_origin: "remote" };
    const rows = buildRows(SEMEAR, [mudo, local, semResp], [mudo, local, semResp], NOW);
    expect(rows.map((r) => r.failure_reason)).toEqual(["offline", "local_mode", "no_response"]);
  });
});

describe("7 e 8. uma mensagem por evento lógico, retry não gera spam", () => {
  it("8. existe EXATAMENTE UMA chamada a logExecution, e dentro do passo final", () => {
    // Contar importa: uma segunda chamada gated em `step.attempt` produziria
    // 3 linhas por bomba — exatamente o spam que a tarefa proíbe.
    const chamadas = CODE.match(/await logExecution\(/g) ?? [];
    expect(chamadas).toHaveLength(1);

    // E ela tem de estar dentro do bloco `if (step.final) { ... }`.
    const ini = CODE.indexOf("if (step.final) {");
    const fim = CODE.indexOf("doneSet.add(step.key);");
    const blocoFinal = CODE.slice(ini, fim);
    expect(blocoFinal).toContain("await logExecution(");
    expect(ini).toBeGreaterThan(0);
    expect(fim).toBeGreaterThan(ini);
  });

  it("8c. logExecution NÃO é chamado em nenhum caminho de tentativa", () => {
    const trecho = CODE.slice(CODE.indexOf("if (step.attempt) acted = await commandShutdown"),
                              CODE.indexOf("if (step.final) {"));
    expect(trecho).not.toContain("logExecution");
  });

  it("8b. `steps_done` é a trava de idempotência do passo final", () => {
    expect(CODE).toContain("const doneSet = new Set<string>((run.steps_done ?? []) as string[]);");
    expect(CODE).toContain("steps.find((s) => !doneSet.has(s.key) && elapsed >= s.offset)");
  });

  it("7. uma linha por bomba, sem repetição", () => {
    const rows = buildRows(SEMEAR, SCOPE14, [], NOW);
    expect(new Set(rows.map((r) => r.equipment_id)).size).toBe(rows.length);
  });

  it("escopo vazio não grava nada", () => {
    expect(buildRows(SEMEAR, [], [], NOW)).toHaveLength(0);
    expect(CODE).toContain("if (!scope.length) return;");
  });
});

describe("11 e 12. escopo preservado", () => {
  it("11. bombas que já estavam desligadas entram como success, não como ruído", () => {
    const rows = buildRows(SEMEAR, SCOPE14, [], NOW);
    expect(rows.filter((r) => r.status === "failed")).toHaveLength(0);
  });

  it("12. nenhuma fazenda é tratada de forma especial — sem hardcode", () => {
    const bloco = CODE.slice(CODE.indexOf("async function logExecution"));
    expect(bloco.slice(0, 2500)).not.toMatch(/SEMEAR|Semear|semear|SOSSEGO|Sossego/);
    const r = buildRows({ ...SEMEAR, farm_id: "outra", name: "R" }, [pump(1)], [], NOW)[0];
    expect(r.farm_id).toBe("outra");
  });

  it("a regra sem nome ainda produz automation_name utilizável", () => {
    const bloco = CODE.slice(CODE.indexOf("async function logExecution"));
    expect(bloco).toContain('"Desligamento Programado"');
  });
});

describe("15 a 18. nada além do necessário foi tocado", () => {
  it("15 e 16. o envio direto a ALERT_RECIPIENTS continua intacto", () => {
    expect(CODE).toContain('const ALERT_RECIPIENTS = ["5577999608294", "5577981503951"];');
    expect(CODE).toContain("await sendConsolidated(supabase, a, farmName, total, off, onPumps);");
  });

  it("18. nenhum telefone de operador aparece no código", () => {
    expect(SHUTDOWN).not.toContain("5577998654782");   // Yuri
    expect(SHUTDOWN).not.toContain("5577988120550");   // Jonatan
  });

  it("não cria um segundo sistema de envio: logExecution não fala com a Meta", () => {
    const bloco = CODE.slice(CODE.indexOf("async function logExecution"),
                             CODE.indexOf("async function fetchFarmName"));
    expect(bloco).not.toMatch(/graph\.facebook|sendTemplate|sendText|fetch\(/);
    expect(bloco).toContain('from("automation_execution_log").insert(rows)');
  });

  it("17. nenhuma alteração no Histórico de Conversas", () => {
    expect(SHUTDOWN).not.toContain("whatsapp_message_log");
  });

  it("não altera whatsapp_operators, config, RLS nem telefones", () => {
    const bloco = CODE.slice(CODE.indexOf("async function logExecution"),
                             CODE.indexOf("async function fetchFarmName"));
    expect(bloco).not.toMatch(/whatsapp_operators|whatsapp_config|update\(|delete\(/);
  });

  it("falha ao gravar não derruba o ciclo, mas é logada", () => {
    const bloco = CODE.slice(CODE.indexOf("async function logExecution"));
    expect(bloco).toContain("automation_execution_log falhou");
    expect(bloco).not.toMatch(/throw /);
  });
});
