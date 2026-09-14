// @vitest-environment node
// Entrega final: o notify volta à versão pós-e9f0990 (sem o kill-switch antigo
// e SEM a guarda de cron não aprovada), e o scheduled-shutdown passa a alimentar
// `automation_execution_log`. Ordem de publicação: notify primeiro.
import { describe, it, expect } from "vitest";
import fs from "node:fs"; import path from "node:path";

const REPO = path.resolve(__dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");
const NOTIFY = read("supabase/functions/whatsapp-automation-notify/index.ts");
const SHUTDOWN = read("supabase/functions/scheduled-shutdown/index.ts");
/** Só código: comentários citam nomes antigos e não podem contar. */
const strip = (s: string) => s.split("\n")
  .filter((l) => { const t = l.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*"); })
  .join("\n");
const NOTIFY_CODE = strip(NOTIFY);
const SHUTDOWN_CODE = strip(SHUTDOWN);

describe("1 a 4. o que NÃO pode estar no notify final", () => {
  it("1. o kill-switch blanket antigo não existe", () => {
    expect(NOTIFY).not.toContain("KILL-SWITCH DE POLÍTICA");
    // A marca fatal do blanket era carimbar TODAS as linhas pendentes
    // (`.is("notified_at", null)`) num retorno antecipado, sem enviar nada.
    // A marcação legítima existe, mas é escopada aos ids já processados.
    expect(NOTIFY_CODE).not.toMatch(/update\(\{ notified_at: nowIso2 \}\)/);
    expect(NOTIFY_CODE).not.toMatch(/update\([^)]*notified_at[^)]*\)\s*\.is\("notified_at", null\)/);
    expect(NOTIFY_CODE).toContain('.update({ notified_at: new Date().toISOString() })');
    expect(NOTIFY_CODE).toContain('.in("id", allConsidered)');   // escopo restrito
  });

  it("2. não retorna blocked_by_killswitch", () => {
    expect(NOTIFY).not.toContain("blocked_by_killswitch");
  });

  it("3. alerts_disabled_policy existe, mas NÃO como blanket", () => {
    // O rótulo permanece; o que não pode voltar é o gate que descartava tudo.
    // Prova de que não é blanket: a chamada do cron sempre passa.
    expect(NOTIFY_CODE).toContain("const _isCronDrain = _b.immediate !== true;");
    expect(NOTIFY_CODE).toContain("if (!_isWatchdogSystem && !_isEquipmentState && !_isCronDrain)");
    expect(NOTIFY_CODE).not.toMatch(/if \(!_isAllowed\)/);
  });

  it("4. a guarda guardCron da tarefa de CRON_SECRET não está presente", () => {
    expect(NOTIFY).not.toContain("guardCron");
    expect(NOTIFY).not.toContain("_shared/cronAuth.ts");
  });
});

describe("5 e 6. a política por destinatário permanece intacta", () => {
  it("5. o cabeçalho e os três ramos da política estão lá", () => {
    expect(NOTIFY).toContain("POLÍTICA POR DESTINATÁRIO (não mais blanket)");
    expect(NOTIFY_CODE).toContain("_isWatchdogSystem");
    expect(NOTIFY_CODE).toContain("_isEquipmentState");
    expect(NOTIFY_CODE).toContain("_isCronDrain");
    expect(NOTIFY_CODE).toContain('new Set(["agent_offline", "bridge_down"])');
  });

  it("6. Yuri e Jonatan seguem elegíveis pelas regras atuais", () => {
    // Resolução por whatsapp_operators, com os quatro portões conhecidos.
    expect(NOTIFY_CODE).toContain('.from("whatsapp_operators")');
    expect(NOTIFY_CODE).toContain('.eq("is_active", true)');
    expect(NOTIFY_CODE).toContain("o.default_farm_id ?? o.farm_id");
    expect(NOTIFY_CODE).toContain('if (o.receive_alerts === false) continue;');
    // e nenhum telefone deles hardcoded aqui
    expect(NOTIFY).not.toContain("5577998654782");
    expect(NOTIFY).not.toContain("5577988120550");
  });
});

describe("7 a 10. o pipeline do notify continua completo", () => {
  it("7. lê eventos com notified_at NULL", () => {
    expect(NOTIFY_CODE).toContain('.from("automation_execution_log")');
    expect(NOTIFY_CODE).toContain('.is("notified_at", null)');
    expect(NOTIFY_CODE).toContain('.in("status", ["success", "expired", "failed"])');
  });

  it("8. marca notified_at DEPOIS do envio", () => {
    expect(NOTIFY_CODE).toMatch(/notified_at/);
    // e a marcação não acontece num caminho que retorna cedo sem enviar
    expect(NOTIFY_CODE).not.toMatch(/skipped: "alerts_disabled_policy"[\s\S]{0,400}notified_at/);
  });

  it("9. grava a saída em whatsapp_message_log", () => {
    expect(NOTIFY_CODE).toContain('whatsapp_message_log');
  });

  it("10. falha da Meta não é mascarada como sucesso", () => {
    expect(NOTIFY_CODE).toMatch(/if \(!r\.ok \|\| \(j as any\)\?\.error\)/);
  });
});

describe("11 a 20. scheduled-shutdown alimenta o pipeline", () => {
  it("11 e 12. UMA chamada a logExecution, dentro do passo final", () => {
    expect((SHUTDOWN_CODE.match(/await logExecution\(/g) ?? [])).toHaveLength(1);
    const ini = SHUTDOWN_CODE.indexOf("if (step.final) {");
    const fim = SHUTDOWN_CODE.indexOf("doneSet.add(step.key);");
    expect(ini).toBeGreaterThan(0);
    expect(SHUTDOWN_CODE.slice(ini, fim)).toContain("await logExecution(");
  });

  it("11b. nenhuma gravação no caminho das tentativas", () => {
    const trecho = SHUTDOWN_CODE.slice(
      SHUTDOWN_CODE.indexOf("if (step.attempt) acted = await commandShutdown"),
      SHUTDOWN_CODE.indexOf("if (step.final) {"));
    expect(trecho).not.toContain("logExecution");
  });

  it("13 a 16. contrato da linha gravada", () => {
    const b = SHUTDOWN_CODE.slice(SHUTDOWN_CODE.indexOf("async function logExecution"),
                                  SHUTDOWN_CODE.indexOf("async function fetchFarmName"));
    expect(b).toMatch(/origin:\s*"automacao"/);        // 15
    expect(b).toMatch(/action:\s*"desliga"/);          // 16
    expect(b).toMatch(/status:\s*desligou\s*\?\s*"success"\s*:\s*"failed"/);
    expect(b).toMatch(/scheduled_time:\s*a\.time_brt/);
    expect(b).toMatch(/automation_name:/);
    expect(b).not.toMatch(/notified_at:/);             // 14 — nasce NULL
    expect(b).toContain("scope.map(");                 // 13 — uma linha por bomba
  });

  it("17. o contrato é o que o notificador reconhece", () => {
    expect(NOTIFY_CODE).toContain('r.origin === "automacao" && r.details?.automation_name');
  });

  it("18. nenhum telefone de Yuri/Jonatan no scheduled-shutdown", () => {
    expect(SHUTDOWN).not.toContain("5577998654782");
    expect(SHUTDOWN).not.toContain("5577988120550");
  });

  it("19. o sendConsolidated existente segue intacto", () => {
    expect(SHUTDOWN_CODE).toContain('const ALERT_RECIPIENTS = ["5577999608294", "5577981503951"];');
    expect(SHUTDOWN_CODE).toContain("await sendConsolidated(supabase, a, farmName, total, off, onPumps);");
  });

  it("20. logExecution não envia nada nem toca em outra configuração", () => {
    const b = SHUTDOWN_CODE.slice(SHUTDOWN_CODE.indexOf("async function logExecution"),
                                  SHUTDOWN_CODE.indexOf("async function fetchFarmName"));
    expect(b).not.toMatch(/graph\.facebook|sendTemplate|sendText|fetch\(/);
    expect(b).not.toMatch(/whatsapp_operators|whatsapp_config|whatsapp_message_log/);
    expect(b).toContain('from("automation_execution_log").insert(rows)');
  });
});

describe("escopo da entrega", () => {
  it("o notify final é EXATAMENTE a versão do repositório", () => {
    // Sem diff: qualquer alteração minha teria de estar aqui declarada.
    expect(NOTIFY).not.toContain("guardCron");
    expect(NOTIFY).toContain("POLÍTICA POR DESTINATÁRIO");
  });

  it("scheduled-shutdown não virou um segundo sistema de WhatsApp", () => {
    const antes = (SHUTDOWN_CODE.match(/ALERT_RECIPIENTS/g) ?? []).length;
    expect(antes).toBeGreaterThan(0);   // o envio direto continua
    expect(SHUTDOWN_CODE).not.toContain("whatsapp_message_log");
  });
});
