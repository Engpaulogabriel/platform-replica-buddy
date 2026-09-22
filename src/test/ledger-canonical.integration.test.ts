// @vitest-environment node
// ─────────────────────────────────────────────────────────────────────────────
// O ledger operacional: uma transição física = uma linha. Nenhuma = zero.
// ─────────────────────────────────────────────────────────────────────────────
// A telemetria entra por `apply_pump_telemetry`, como o Agent faz. As funções
// são o dump vivo do NEW; os gatilhos têm os nomes reais, porque o nome define
// a ordem de disparo. O primeiro teste mede o estado ATUAL de produção — sem a
// migration — para que a correção seja provada, não afirmada.

import { describe, it, expect } from "vitest";
import {
  bancoDoLedger, rx, comando, ledger, todasAsLinhas, resumo,
  violacoesDaInvariante, ID,
} from "./helpers/ledgerChainDb";

const ON = "1", OFF = "0";

/** O Agent, depois de processar um RX espontâneo local, grava a sua própria
 *  linha — é o produtor `agent-local-actuation` (main.cjs:4299). */
async function linhaDoAgente(db: any, ligou: boolean) {
  await db.query(
    `INSERT INTO public.automation_log
       (farm_id, equipment_id, equipment_name, occurred_at, origin, action, result,
        actor_label, source_device, details)
     VALUES ($1,$2,'POÇO 02', now(), 'local', $3::public.event_action, 'success',
             'Acionamento Local','agent-local-actuation',
             jsonb_build_object('tipo_evento','acionamento_local'))`,
    [ID.fazenda, ID.poco, ligou ? "pump_on" : "pump_off"]);
}

// ── o estado de hoje, medido ───────────────────────────────────────────────
describe("linha de base: produção, sem a migration", () => {
  it("uma única transição remota já rende DUAS linhas operacionais", async () => {
    const db = await bancoDoLedger(false);
    await comando(db, { ligar: true });
    await rx(db, ON);

    expect(resumo(await ledger(db))).toEqual(["turn_on/remote", "pump_on/system"]);
  });

  it("o eco do comando seguido do estado real vira Ligada/Desligada/Ligada", async () => {
    const db = await bancoDoLedger(false);
    await comando(db, { ligar: true });
    await rx(db, ON);    // eco: diz que já ligou
    await rx(db, OFF);   // estado real: ainda não
    await rx(db, ON);    // ligou de verdade

    const acoes = resumo(await ledger(db));
    expect(acoes.filter((a) => a.startsWith("turn_off")).length).toBeGreaterThan(0);
    expect(await violacoesDaInvariante(db)).toBeGreaterThan(0);
  });
});

// ── T1 a T14, com a migration ──────────────────────────────────────────────
describe("ledger canônico", () => {
  it("T1 — 0, alvo 1, RX0, RX1 → exatamente 1 Ligada/Remoto", async () => {
    const db = await bancoDoLedger();
    await comando(db, { ligar: true });
    await rx(db, OFF);
    await rx(db, ON);

    const l = await ledger(db);
    expect(resumo(l)).toEqual(["turn_on/remote"]);
    expect(l[0].actor_label).toBe("Yuri");
  });

  it("T2 — 0, alvo 1, RX0, RX0, timeout → zero", async () => {
    const db = await bancoDoLedger();
    await comando(db, { ligar: true });
    await rx(db, OFF);
    await rx(db, OFF);
    await db.query(`UPDATE public.commands SET status='timeout', responded_at=now()`);

    expect(await ledger(db)).toHaveLength(0);
  });

  it("T3 — 1, alvo 0, RX1, RX0 → exatamente 1 Desligada/Remoto", async () => {
    const db = await bancoDoLedger();
    await rx(db, ON);                       // parte do estado ligado
    await db.query(`DELETE FROM public.automation_log`);
    await comando(db, { ligar: false });
    await rx(db, ON);
    await rx(db, OFF);

    expect(resumo(await ledger(db))).toEqual(["turn_off/remote"]);
  });

  it("T4 — 1, alvo 0, RX1, RX1, timeout → zero", async () => {
    const db = await bancoDoLedger();
    await rx(db, ON);
    await db.query(`DELETE FROM public.automation_log`);
    await comando(db, { ligar: false });
    await rx(db, ON);
    await rx(db, ON);
    await db.query(`UPDATE public.commands SET status='timeout', responded_at=now()`);

    expect(await ledger(db)).toHaveLength(0);
  });

  it("T5 — 0→1 espontâneo sem comando → 1 Ligada/Local", async () => {
    const db = await bancoDoLedger();
    await rx(db, ON, { origin: "local" });

    const l = await ledger(db);
    expect(resumo(l)).toEqual(["turn_on/local"]);
    expect(l[0].actor_label).toBe("Acionamento local");
  });

  it("T6 — 1→0 espontâneo sem comando → 1 Desligada/Local", async () => {
    const db = await bancoDoLedger();
    await rx(db, ON, { origin: "local" });
    await db.query(`DELETE FROM public.automation_log`);
    await rx(db, OFF, { origin: "local" });

    expect(resumo(await ledger(db))).toEqual(["turn_off/local"]);
  });

  it("T7 — polling 0→0 repetido → zero", async () => {
    const db = await bancoDoLedger();
    for (let i = 0; i < 4; i++) await rx(db, OFF);
    expect(await ledger(db)).toHaveLength(0);
  });

  it("T8 — polling 1→1 repetido → zero", async () => {
    const db = await bancoDoLedger();
    await rx(db, ON, { origin: "local" });
    await db.query(`DELETE FROM public.automation_log`);
    for (let i = 0; i < 4; i++) await rx(db, ON);
    expect(await ledger(db)).toHaveLength(0);
  });

  it("T9 — uma transição remota → UMA linha operacional no total", async () => {
    const db = await bancoDoLedger();
    await comando(db, { ligar: true });
    await rx(db, ON);

    expect(await ledger(db)).toHaveLength(1);
    // e nada se perdeu: as outras cópias continuam na tabela, como técnicas
    const todas = await todasAsLinhas(db);
    expect(todas.length).toBeGreaterThan(1);
    expect(todas.filter((t: any) => t.categoria !== "(OPERACIONAL)").length).toBeGreaterThan(0);
  });

  it("T10 — intenção de comando → zero linha operacional", async () => {
    const db = await bancoDoLedger();
    await comando(db, { ligar: true });            // sem nenhum RX
    // o gatilho de intenção dispara quando o comando termina
    await db.query(`UPDATE public.commands SET status='executed', responded_at=now()`);

    expect(await ledger(db)).toHaveLength(0);
    const intent = (await todasAsLinhas(db)).filter((t: any) => t.categoria === "remote_command_intent");
    expect(intent.length).toBe(1);                 // preservada como auditoria
  });

  it("T11 — TX de segurança com erro → zero linha operacional", async () => {
    const db = await bancoDoLedger();
    await rx(db, ON, { origin: "local" });
    await db.query(`DELETE FROM public.automation_log`);
    await db.query(`
      INSERT INTO public.automation_log
        (farm_id, equipment_id, equipment_name, occurred_at, origin, action, result,
         source_device, details)
      VALUES ($1,$2,'POÇO 02', now(),'system','turn_off','success',
              'backend-reset:turn_on_timeout',
              jsonb_build_object('systemic',true,'command_status','error',
                                 'error_message','TX 0 de seguranca sem confirmacao apos 60s'))`,
      [ID.fazenda, ID.poco]);

    expect(await ledger(db)).toHaveLength(0);
    expect((await todasAsLinhas(db))[0].categoria).toBe("command_not_confirmed");
  });

  it("T12 — Sossego: RX1, RX0, RX1 com alvo 1 → uma Ligada, nenhuma Desligada", async () => {
    const db = await bancoDoLedger();
    const cmd = await comando(db, { ligar: true, src: "cloud-automation", createdBy: null });
    await rx(db, ON, { commandId: cmd });   // eco: resposta do próprio comando
    await rx(db, OFF);                      // telemetria: ainda desligada
    await rx(db, ON);                       // telemetria: ligou de verdade

    const acoes = resumo(await ledger(db));
    expect(acoes).toEqual(["turn_on/remote"]);
    expect(acoes).not.toContain("turn_off/local");
    expect(await violacoesDaInvariante(db)).toBe(0);
  });

  it("T13 — depois do comando expirar, transição espontânea volta a ser Local", async () => {
    const db = await bancoDoLedger();
    await comando(db, { ligar: true });
    await db.query(`UPDATE public.commands SET status='timeout', responded_at=now()`);
    await db.query(`UPDATE public.equipments SET pending_command_id=NULL WHERE id=$1`, [ID.poco]);
    await rx(db, ON, { origin: "local" });

    expect(resumo(await ledger(db))).toEqual(["turn_on/local"]);
  });

  it("T14 — agente + telemetria da mesma atuação → UMA linha", async () => {
    const db = await bancoDoLedger();
    await rx(db, ON, { origin: "local" });   // o Agent processa o RX espontâneo…
    await linhaDoAgente(db, true);           // …e grava a própria linha

    expect(await ledger(db)).toHaveLength(1);
    const doAgente = (await todasAsLinhas(db))
      .filter((t: any) => t.produtor === "agent-local-actuation");
    expect(doAgente[0].categoria).toBe("agent_local_state_report");  // preservada
  });

  it("a invariante vale em todos os cenários acima", async () => {
    const db = await bancoDoLedger();
    await comando(db, { ligar: true });
    await rx(db, OFF); await rx(db, ON); await rx(db, ON); await rx(db, OFF);
    await linhaDoAgente(db, false);
    expect(await violacoesDaInvariante(db)).toBe(0);
  });
});

// ── autoria de mecanismo remoto sem usuário humano ────────────────────────
describe("Modo Automático é responsabilidade remota comprovada", () => {
  it("T15 — comando cloud-automation + transição física → Remoto com nome da regra", async () => {
    const db = await bancoDoLedger();
    // o motor cria o comando sem created_by, como em produção
    const r = await db.query<any>(
      `INSERT INTO public.commands
         (farm_id, equipment_id, plc_hw_id, type, frame, source_device, created_by, status, sent_at)
       VALUES ($1,$2,'1101','manual','[1101_1_]{1}[1101_ETX_]','cloud-automation',NULL,'sent',now())
       RETURNING id`, [ID.fazenda, ID.poco]);
    const cmd = r.rows[0].id;
    await db.query(`UPDATE public.equipments SET pending_command_id=$1, desired_running=true WHERE id=$2`,
      [cmd, ID.poco]);
    await db.query(
      `INSERT INTO public.automation_execution_log
         (equipment_id, farm_id, action, scheduled_time, executed_at, status, details)
       VALUES ($1,$2,'liga','21:02', now(),'success', jsonb_build_object('command_id',$3::text))`,
      [ID.poco, ID.fazenda, cmd]);

    await rx(db, "1");

    const l = await ledger(db);
    expect(resumo(l)).toEqual(["turn_on/auto"]);
    expect(l[0].actor_label).toBe("Automático 21:02");
    expect(l[0].actor_label).not.toBe("Acionamento local");
  });

  it("T16 — sem regra nomeada, o rótulo é 'Modo Automático', nunca inventado", async () => {
    const db = await bancoDoLedger();
    const r = await db.query<any>(
      `INSERT INTO public.commands
         (farm_id, equipment_id, plc_hw_id, type, frame, source_device, created_by, status, sent_at)
       VALUES ($1,$2,'1101','manual','[1101_1_]{1}[1101_ETX_]','cloud-automation',NULL,'sent',now())
       RETURNING id`, [ID.fazenda, ID.poco]);
    await db.query(`UPDATE public.equipments SET pending_command_id=$1, desired_running=true WHERE id=$2`,
      [r.rows[0].id, ID.poco]);
    await rx(db, "1");

    const l = await ledger(db);
    expect(l[0].origem).toBe("auto");
    expect(l[0].actor_label).toBe("Modo Automático");
  });

  it("T17 — mecanismo técnico NÃO vira autoria operacional", async () => {
    // backend-reset:local_shutdown_detected é CONSEQUÊNCIA de desligamento
    // local; atribuí-lo como remoto inverteria causa e efeito.
    const db = await bancoDoLedger();
    await rx(db, "1", { origin: "local" });
    await db.query(`DELETE FROM public.automation_log`);
    await db.query(
      `INSERT INTO public.commands
         (farm_id, equipment_id, plc_hw_id, type, frame, source_device, created_by, status, sent_at)
       VALUES ($1,$2,'1101','manual','[1101_1_]{0}[1101_ETX_]','backend-reset:local_shutdown_detected',
               NULL,'sent',now())`, [ID.fazenda, ID.poco]);
    await rx(db, "0", { origin: "local" });

    const l = await ledger(db);
    expect(resumo(l)).toEqual(["turn_off/local"]);
    expect(l[0].actor_label).toBe("Acionamento local");
  });

  it("T18 — comando de automação que não confirmou não atribui nada", async () => {
    const db = await bancoDoLedger();
    await db.query(
      `INSERT INTO public.commands
         (farm_id, equipment_id, plc_hw_id, type, frame, source_device, created_by, status, sent_at, responded_at)
       VALUES ($1,$2,'1101','manual','[1101_1_]{1}[1101_ETX_]','cloud-automation',NULL,'timeout',now(),now())`,
      [ID.fazenda, ID.poco]);
    await rx(db, "1", { origin: "local" });

    const l = await ledger(db);
    expect(l[0].origem).toBe("local");          // sem mecanismo responsável válido
    expect(l[0].actor_label).toBe("Acionamento local");
  });
});
