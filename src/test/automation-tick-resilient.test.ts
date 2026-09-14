// @vitest-environment node
// Modo Automático. O incidente da SOSSEGO (engine=false) expôs uma fragilidade
// maior: janela de 2 min sem catch-up, bloqueio temporário consumindo o evento
// em silêncio, e ausência de idempotência. Aqui tudo isso roda em Postgres 17
// real (pglite) contra a função de verdade.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs"; import path from "node:path";

const REPO = path.resolve(__dirname, "../..");
const MIG = path.join(REPO,
  "supabase/migrations/20260904120000_automation_tick_resilient_idempotent.sql");
const MIG_SQL = fs.readFileSync(MIG, "utf8");

let db: PGlite; let FARM = ""; let EQ = ""; let SCHED = "";

const SCHEMA = `
  CREATE TYPE public.command_type AS ENUM ('polling','manual','config','server','repeater','diagnostic','service_test','automation');
  CREATE TYPE public.equipment_type AS ENUM ('poco','bombeamento','nivel','repetidor');
  CREATE TABLE public.farms (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, timezone text DEFAULT 'America/Sao_Paulo');
  CREATE TABLE public.plc_groups (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), hw_id text, output_count int DEFAULT 1);
  CREATE TABLE public.equipments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, name text,
    type public.equipment_type DEFAULT 'poco', saida int DEFAULT 1, hw_id text DEFAULT '13140001',
    active boolean DEFAULT true, maintenance_mode boolean DEFAULT false,
    last_outputs_state text DEFAULT '000000', last_communication timestamptz, pending_command_id uuid,
    command_blocked_until timestamptz, desired_running boolean DEFAULT false,
    last_actuation_origin text, plc_group_id uuid, updated_at timestamptz DEFAULT now());
  CREATE TABLE public.commands (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, equipment_id uuid,
    plc_hw_id text, type public.command_type, priority int, frame text,
    timeout_ms int, source_device text, status text DEFAULT 'pending',
    created_at timestamptz DEFAULT now(), sent_at timestamptz, responded_at timestamptz);
  CREATE TABLE public.automation_schedules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, equipment_id uuid,
    time_on text, time_off text, days text[] DEFAULT ARRAY['sun','mon','tue','wed','thu','fri','sat'],
    mode text DEFAULT 'both', active boolean DEFAULT true,
    last_on_executed_at timestamptz, last_off_executed_at timestamptz);
  CREATE TABLE public.automation_engine (farm_id uuid PRIMARY KEY, enabled boolean DEFAULT true, updated_at timestamptz DEFAULT now());
  CREATE TABLE public.automation_holiday_configs (farm_id uuid, equipment_id uuid, enabled boolean, mode text, special_time_on text, special_time_off text);
  CREATE TABLE public.automation_execution_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), schedule_id uuid, equipment_id uuid,
    farm_id uuid, action text, scheduled_time text, executed_at timestamptz DEFAULT now(),
    status text, origin text, failure_reason text, notified_at timestamptz, details jsonb);
  CREATE TABLE public.automation_fired (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), fired_at timestamptz);
  CREATE TABLE public.rf_routing (farm_id uuid, radio text, via_repetidor boolean);
  CREATE OR REPLACE FUNCTION public.renov_combined_payload(_current_state text,_saida int,_turn_on boolean,_total int)
  RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
  DECLARE v_n int; v_pos int; v_state text;
  BEGIN v_n := GREATEST(1, LEAST(6, COALESCE(_total,1))); v_pos := GREATEST(1, LEAST(v_n, COALESCE(_saida,1)));
    IF _current_state ~ ('^[01]{' || v_n || '}$') THEN v_state := _current_state;
    ELSIF _current_state ~ '^[01]{6}$' THEN v_state := substring(_current_state from 1 for v_n);
    ELSE v_state := repeat('0', v_n); END IF;
    RETURN overlay(v_state placing CASE WHEN _turn_on THEN '1' ELSE '0' END from v_pos for 1); END $$;
  CREATE OR REPLACE FUNCTION public.enqueue_turn_on_timeout_resets(_f uuid) RETURNS void LANGUAGE sql AS $$ SELECT NULL::void $$;
`;

/** Horário local (BRT) deslocado em `deltaMin` a partir de agora, como "HH:MM". */
function hhmmLocal(deltaMin: number): string {
  const brt = new Date(Date.now() - 3 * 3600_000 + deltaMin * 60_000);
  return `${String(brt.getUTCHours()).padStart(2, "0")}:${String(brt.getUTCMinutes()).padStart(2, "0")}`;
}

async function tick() {
  const r = await db.query<{ enqueued_count: number; schedules_evaluated: number }>(
    `SELECT * FROM public.run_automation_tick()`);
  return r.rows[0];
}
const cmds = async () => Number((await db.query<{ n: string }>(
  `SELECT count(*) AS n FROM public.commands`)).rows[0].n);
const logs = async (status?: string) => (await db.query<{ action: string; status: string; details: Record<string, unknown> }>(
  status ? `SELECT action,status,details FROM public.automation_execution_log WHERE status=$1 ORDER BY executed_at` 
         : `SELECT action,status,details FROM public.automation_execution_log ORDER BY executed_at`,
  status ? [status] : [])).rows;

beforeEach(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(MIG_SQL);
  const f = await db.query<{ id: string }>(`INSERT INTO public.farms (name) VALUES ('F') RETURNING id`);
  FARM = f.rows[0].id;
  await db.query(`INSERT INTO public.automation_engine (farm_id, enabled) VALUES ($1, true)`, [FARM]);
  await db.query(`INSERT INTO public.rf_routing VALUES ($1,'R1',false)`, [FARM]);
  const e = await db.query<{ id: string }>(
    `INSERT INTO public.equipments (farm_id, name) VALUES ($1,'POÇO 01') RETURNING id`, [FARM]);
  EQ = e.rows[0].id;
}, 60_000);
afterEach(async () => { await db?.close(); });

async function schedule(timeOn: string | null, timeOff: string | null, mode = "both") {
  const r = await db.query<{ id: string }>(
    `INSERT INTO public.automation_schedules (farm_id, equipment_id, time_on, time_off, mode)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`, [FARM, EQ, timeOn, timeOff, mode]);
  SCHED = r.rows[0].id;
  return SCHED;
}

// ── 1 e 2: a chave geral ───────────────────────────────────────────────────
describe("1 e 2. automation_engine é a chave geral", () => {
  it("1. engine=false → NADA é avaliado (a causa do incidente)", async () => {
    await db.query(`UPDATE public.automation_engine SET enabled=false WHERE farm_id=$1`, [FARM]);
    await schedule(hhmmLocal(-5), hhmmLocal(120));
    const r = await tick();
    expect(r.schedules_evaluated).toBe(0);
    expect(await cmds()).toBe(0);
    expect(await logs()).toHaveLength(0);   // nem rastro — exatamente o incidente
  });

  it("2. engine=true → o schedule é avaliado e executa", async () => {
    await schedule(hhmmLocal(-5), hhmmLocal(120));
    const r = await tick();
    expect(r.schedules_evaluated).toBe(1);
    expect(await cmds()).toBe(1);
  });
});

// ── 3 a 7: ligar, desligar e catch-up limitado ─────────────────────────────
describe("3 a 7. LIGAR, DESLIGAR e catch-up com validade", () => {
  it("3. LIGAR no horário → command ON criado", async () => {
    await schedule(hhmmLocal(0), hhmmLocal(120));
    await tick();
    const c = await db.query<{ frame: string; source_device: string }>(
      `SELECT frame, source_device FROM public.commands`);
    expect(c.rows).toHaveLength(1);
    expect(c.rows[0].frame).toMatch(/\{1/);            // bit da saída 1 = ligar
    expect(c.rows[0].source_device).toBe("cloud-automation");
  });

  it("4. DESLIGAR no horário → command OFF criado", async () => {
    await db.query(`UPDATE public.equipments SET last_outputs_state='100000' WHERE id=$1`, [EQ]);
    await schedule(hhmmLocal(-300), hhmmLocal(0));
    await tick();
    const c = await db.query<{ frame: string }>(`SELECT frame FROM public.commands`);
    expect(c.rows).toHaveLength(1);
    expect(c.rows[0].frame).toMatch(/\{0/);
  });

  it("5. tick perdido por 4 minutos → evento é RECUPERADO", async () => {
    // 21:02 perdido; tick volta às 21:06. Com WINDOW_MIN=2 estaria perdido.
    await schedule(hhmmLocal(-4), hhmmLocal(120));
    await tick();
    expect(await cmds()).toBe(1);
    const l = await logs("success");
    expect(Number((l[0].details as Record<string, number>).late_minutes)).toBe(4);
  });

  it("6. sem time_off, o ON vale até o fim do dia — 90 min depois ainda liga", async () => {
    // NÃO existe mais CATCHUP_MAX_MIN: o que manda é a janela, não o relógio.
    await schedule(hhmmLocal(-90), null, "on-only");
    await tick();
    expect(await cmds()).toBe(1);
  });

  it("7. time_off já passou → NÃO recupera o time_on antigo", async () => {
    // on 08:00 / off 12:00, agora 12:10 → o ON não faz mais sentido.
    await schedule(hhmmLocal(-250), hhmmLocal(-10));
    await tick();
    const on = (await logs()).filter((x) => x.action === "liga");
    expect(on).toHaveLength(0);
  });

  it("7b. ANTES do time_off, o ON atrasado ainda é recuperado", async () => {
    await schedule(hhmmLocal(-240), hhmmLocal(60));
    await tick();
    expect(await cmds()).toBe(1);
  });
});

// ── 8 a 10: bloqueio temporário NÃO consome o evento ───────────────────────
describe("8 a 10. pending_command e command_blocked_until", () => {
  it("8. pending_command → adia, não perde, e registra UMA vez", async () => {
    await db.query(`UPDATE public.equipments SET pending_command_id=gen_random_uuid() WHERE id=$1`, [EQ]);
    await schedule(hhmmLocal(-1), hhmmLocal(120));
    await tick(); await tick(); await tick();          // três ticks seguidos
    expect(await cmds()).toBe(0);
    const l = await logs("skipped");
    expect(l).toHaveLength(1);                          // sem spam
    expect(l[0].details).toMatchObject({ reason: "pending_command", deferred: true });
    // NÃO consumiu o evento
    const s = await db.query<{ last_on_executed_at: string | null }>(
      `SELECT last_on_executed_at FROM public.automation_schedules WHERE id=$1`, [SCHED]);
    expect(s.rows[0].last_on_executed_at).toBeNull();
  });

  it("9. command_blocked_until → adia com motivo próprio", async () => {
    await db.query(`UPDATE public.equipments SET command_blocked_until=now()+interval '2 minutes' WHERE id=$1`, [EQ]);
    await schedule(hhmmLocal(-1), hhmmLocal(120));
    await tick();
    expect(await cmds()).toBe(0);
    expect((await logs("skipped"))[0].details).toMatchObject({ reason: "command_blocked" });
  });

  it("10. ao liberar o bloqueio → executa UMA única vez", async () => {
    await db.query(`UPDATE public.equipments SET command_blocked_until=now()+interval '2 minutes' WHERE id=$1`, [EQ]);
    await schedule(hhmmLocal(-1), hhmmLocal(120));
    await tick();
    expect(await cmds()).toBe(0);
    await db.query(`UPDATE public.equipments SET command_blocked_until=NULL WHERE id=$1`, [EQ]);
    await tick(); await tick();                         // dois ticks após liberar
    expect(await cmds()).toBe(1);
  });
});

// ── 11 a 12: já no estado desejado ─────────────────────────────────────────
describe("11 e 12. already_running / already_off", () => {
  it("11. já ligada → consome o evento ON sem duplicar", async () => {
    await db.query(`UPDATE public.equipments SET last_outputs_state='100000' WHERE id=$1`, [EQ]);
    await schedule(hhmmLocal(-1), hhmmLocal(120));
    await tick();
    expect(await cmds()).toBe(0);
    expect((await logs("skipped"))[0].details).toMatchObject({ reason: "already_running" });
    const s = await db.query<{ last_on_executed_at: string | null }>(
      `SELECT last_on_executed_at FROM public.automation_schedules WHERE id=$1`, [SCHED]);
    expect(s.rows[0].last_on_executed_at).not.toBeNull();   // consumido
  });

  it("12. já desligada → consome o evento OFF sem duplicar", async () => {
    await schedule(hhmmLocal(-300), hhmmLocal(-1));
    await tick();
    expect(await cmds()).toBe(0);
    const l = (await logs("skipped")).filter((x) => x.action === "desliga");
    expect(l[0].details).toMatchObject({ reason: "already_stopped" });
  });
});

// ── 13 e 14: manutenção ────────────────────────────────────────────────────
describe("13 e 14. manutenção continua absoluta", () => {
  it("13 e 5. manutenção dentro da janela → não liga", async () => {
    await db.query(`UPDATE public.equipments SET maintenance_mode=true WHERE id=$1`, [EQ]);
    await schedule(hhmmLocal(-1), hhmmLocal(120));
    await tick();
    expect(await cmds()).toBe(0);
    expect((await logs("skipped"))[0].details).toMatchObject({ reason: "maintenance" });
  });

  it("6. manutenção REMOVIDA ainda dentro da janela → volta a reconciliar e LIGA", async () => {
    // Semântica corrigida: manutenção suspende, não consome. Quem manda é o
    // estado desejado, não um evento gasto.
    await db.query(`UPDATE public.equipments SET maintenance_mode=true WHERE id=$1`, [EQ]);
    await schedule(hhmmLocal(-30), hhmmLocal(300));
    await tick();
    expect(await cmds()).toBe(0);
    await db.query(`UPDATE public.equipments SET maintenance_mode=false WHERE id=$1`, [EQ]);
    await tick();
    expect(await cmds()).toBe(1);
  });

  it("7. manutenção removida FORA da janela → não liga", async () => {
    await db.query(`UPDATE public.equipments SET maintenance_mode=true WHERE id=$1`, [EQ]);
    await schedule(hhmmLocal(-300), hhmmLocal(-10));
    await tick();
    await db.query(`UPDATE public.equipments SET maintenance_mode=false WHERE id=$1`, [EQ]);
    await tick();
    const on = (await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM public.commands WHERE idempotency_key LIKE '%:on:%'`)).rows[0].n;
    expect(Number(on)).toBe(0);
  });

  it("14. manutenção + OFF → permitido", async () => {
    await db.query(`UPDATE public.equipments SET maintenance_mode=true, last_outputs_state='100000' WHERE id=$1`, [EQ]);
    await schedule(hhmmLocal(-300), hhmmLocal(-1));
    await tick();
    expect(await cmds()).toBe(1);
  });
});

// ── 15 a 17: idempotência e peak-hour ──────────────────────────────────────
describe("15 a 17. idempotência e convivência com o peak-hour", () => {
  it("15. o evento é idempotente — chave determinística por dia", async () => {
    await schedule(hhmmLocal(-1), hhmmLocal(120));
    await tick();
    const c = await db.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM public.commands`);
    // Bucket de MINUTO: colide entre ticks do mesmo minuto, mas permite
    // retentativa no minuto seguinte — senão uma falha travaria o dia inteiro.
    expect(c.rows[0].idempotency_key).toMatch(
      new RegExp(`^automation:${SCHED}:${EQ}:on:\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$`));
    await db.query(`UPDATE public.equipments SET pending_command_id=NULL, command_blocked_until=NULL WHERE id=$1`, [EQ]);
    await tick();
    expect(await cmds()).toBe(1);   // mesmo minuto → não duplica
  });

  it("16. peak-hour já ligou → schedule não duplica", async () => {
    await db.query(`UPDATE public.equipments SET last_outputs_state='100000' WHERE id=$1`, [EQ]);
    await db.query(`INSERT INTO public.commands (farm_id, equipment_id, type, priority, frame, timeout_ms, source_device)
                    VALUES ($1,$2,'manual',1,'x',120000,'peak-hour')`, [FARM, EQ]);
    await schedule(hhmmLocal(-1), hhmmLocal(120));
    await tick();
    expect(await cmds()).toBe(1);   // só o do peak-hour
  });

  it("17. peak-hour ainda pendente → o schedule NÃO é perdido", async () => {
    await db.query(`UPDATE public.equipments SET pending_command_id=gen_random_uuid(),
                    command_blocked_until=now()+interval '2 minutes' WHERE id=$1`, [EQ]);
    await schedule(hhmmLocal(-1), hhmmLocal(120));
    await tick();
    expect(await cmds()).toBe(0);
    // libera (o peak-hour confirmou e a bomba ficou LIGADA)
    await db.query(`UPDATE public.equipments SET pending_command_id=NULL,
                    command_blocked_until=NULL, last_outputs_state='100000' WHERE id=$1`, [EQ]);
    await tick();
    expect(await cmds()).toBe(0);   // reconhece already_running
    const s = await db.query<{ last_on_executed_at: string | null }>(
      `SELECT last_on_executed_at FROM public.automation_schedules WHERE id=$1`, [SCHED]);
    expect(s.rows[0].last_on_executed_at).not.toBeNull();
  });
});

// ── contrato e escopo ──────────────────────────────────────────────────────
describe("escopo e não-regressão", () => {
  it("o gate automation_engine NÃO foi afrouxado", () => {
    expect(MIG_SQL).toContain("JOIN public.automation_engine ae ON ae.farm_id = s.farm_id AND ae.enabled = true");
  });

  it("a trava de concorrência existe", () => {
    expect(MIG_SQL).toContain("pg_try_advisory_xact_lock");
  });

  it("nem WINDOW_MIN nem CATCHUP_MAX_MIN existem — quem manda é o estado", () => {
    const code = MIG_SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toContain("WINDOW_MIN");
    expect(code).not.toContain("CATCHUP_MAX_MIN");
    expect(code).toContain("public.automatic_desired_state(");
  });

  it("as linhas de deferimento não viram WhatsApp", () => {
    // o notificador lê apenas ('success','expired','failed')
    const notify = fs.readFileSync(path.join(REPO,
      "supabase/functions/whatsapp-automation-notify/index.ts"), "utf8");
    expect(notify).toContain(`.in("status", ["success", "expired", "failed"])`);
    expect(MIG_SQL).toContain("'skipped', 'automatico'");
  });

  it("não toca scheduled-shutdown, peak-hour, schedules nem dados de fazenda", () => {
    const code = MIG_SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    // peak-hour É redefinido de propósito (teto único de partida) — testado à parte.
    for (const p of ["scheduled_automations", "scheduled_shutdowns",
                     "DROP TABLE", "DELETE FROM public.automation_schedules"]) {
      expect(code, p).not.toContain(p);
    }
    expect(code).not.toMatch(/SEMEAR|Semear|SOSSEGO|Sossego/);
  });

  it("cria a coluna de idempotência (não existe em produção)", () => {
    expect(MIG_SQL).toContain("ADD COLUMN IF NOT EXISTS idempotency_key text");
    expect(MIG_SQL).toContain("CREATE UNIQUE INDEX IF NOT EXISTS uq_commands_idempotency");
  });
});

// ── PARTIDA ESCALONADA ─────────────────────────────────────────────────────
describe("fila de recuperação: nunca liga várias bombas de uma vez", () => {
  /** Cria N bombas, todas com o mesmo schedule já vencido e todas OFF. */
  async function recuperacaoColetiva(n: number, farm = FARM) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const e = await db.query<{ id: string }>(
        `INSERT INTO public.equipments (farm_id, name, saida) VALUES ($1,$2,$3) RETURNING id`,
        [farm, `POÇO ${String(i + 1).padStart(2, "0")}`, i + 1]);
      ids.push(e.rows[0].id);
      await db.query(
        `INSERT INTO public.automation_schedules (farm_id, equipment_id, time_on, time_off)
         VALUES ($1,$2,$3,$4)`, [farm, e.rows[0].id, hhmmLocal(-10 + i), hhmmLocal(120)]);
    }
    return ids;
  }
  const onCmds = async (farm = FARM) => Number((await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM public.commands
      WHERE farm_id=$1 AND idempotency_key LIKE '%:on:%'`, [farm])).rows[0].n);

  it("1. 4 bombas desired ON + physical OFF no mesmo tick → SÓ 1 comando", async () => {
    await db.query(`DELETE FROM public.equipments WHERE id=$1`, [EQ]);
    await recuperacaoColetiva(4);
    await tick();
    expect(await onCmds()).toBe(1);
  });

  it("2. segundo tick dentro do stagger → nenhuma segunda partida", async () => {
    await db.query(`DELETE FROM public.equipments WHERE id=$1`, [EQ]);
    await recuperacaoColetiva(4);
    await tick(); await tick(); await tick();
    expect(await onCmds()).toBe(1);
  });

  it("3 e 4. passado o stagger → a segunda bomba parte", async () => {
    await db.query(`DELETE FROM public.equipments WHERE id=$1`, [EQ]);
    await recuperacaoColetiva(4);
    await tick();
    expect(await onCmds()).toBe(1);
    // envelhece o comando além do stagger e libera o equipamento
    // V5: resolve a tentativa (safety encerrou) — envelhecer não libera slot.
    await db.query(`UPDATE public.commands SET status='timeout', responded_at=now(),
                    created_at = created_at - interval '61 seconds' WHERE status IN ('pending','sent')`);
    await db.query(`UPDATE public.equipments SET pending_command_id=NULL, command_blocked_until=NULL,
                    last_outputs_state='000000' WHERE farm_id=$1`, [FARM]);
    await tick();
    expect(await onCmds()).toBe(2);
  });

  it("5. sequência das 4 → nunca mais de uma partida por janela de stagger", async () => {
    await db.query(`DELETE FROM public.equipments WHERE id=$1`, [EQ]);
    await recuperacaoColetiva(4);
    for (let i = 0; i < 4; i++) {
      await tick();
      expect(await onCmds()).toBe(i + 1);
      await db.query(`UPDATE public.commands SET status='timeout', responded_at=now(),
                      created_at = created_at - interval '61 seconds' WHERE status IN ('pending','sent')`);
      await db.query(`UPDATE public.equipments SET pending_command_id=NULL, command_blocked_until=NULL
                      WHERE farm_id=$1`, [FARM]);
    }
    expect(await onCmds()).toBe(4);
  });

  it("6 e 7. primeira falha → a fila NÃO trava; a segunda prossegue", async () => {
    await db.query(`DELETE FROM public.equipments WHERE id=$1`, [EQ]);
    await recuperacaoColetiva(3);
    await tick();
    expect(await onCmds()).toBe(1);
    // a primeira nunca confirmou: comando envelhece, safety liberaria o pending
    await db.query(`UPDATE public.commands SET status='timeout', responded_at=now(),
                    created_at = created_at - interval '61 seconds' WHERE status IN ('pending','sent')`);
    await db.query(`UPDATE public.equipments SET pending_command_id=NULL, command_blocked_until=NULL WHERE farm_id=$1`, [FARM]);
    await tick();
    expect(await onCmds()).toBe(2);   // avançou mesmo sem confirmação
  });

  it("8. outra fazenda tem fila própria e não espera esta", async () => {
    await db.query(`DELETE FROM public.equipments WHERE id=$1`, [EQ]);
    await recuperacaoColetiva(3);
    const f2 = await db.query<{ id: string }>(`INSERT INTO public.farms (name) VALUES ('F2') RETURNING id`);
    const FARM2 = f2.rows[0].id;
    await db.query(`INSERT INTO public.automation_engine (farm_id, enabled) VALUES ($1,true)`, [FARM2]);
    await db.query(`INSERT INTO public.rf_routing VALUES ($1,'R1',false)`, [FARM2]);
    await recuperacaoColetiva(3, FARM2);
    await tick();
    expect(await onCmds(FARM)).toBe(1);
    expect(await onCmds(FARM2)).toBe(1);   // cada fazenda andou uma
  });

  it("9. o lock é POR FAZENDA, não global", () => {
    expect(MIG_SQL).toContain("pg_try_advisory_xact_lock(hashtextextended('auto:' || v_sched.farm_id::text, 0))");
    expect(MIG_SQL).not.toContain("hashtextextended('run_automation_tick', 0)");
  });

  it("10. queda prolongada + retorno → religamento escalonado, não simultâneo", async () => {
    await db.query(`DELETE FROM public.equipments WHERE id=$1`, [EQ]);
    await recuperacaoColetiva(4);
    // 4 bombas atrasadas há muito, todas OFF: o cenário 23:00→02:00
    await tick();
    expect(await onCmds()).toBe(1);
    const espera = await logs("skipped");
    expect(espera.filter((x) => (x.details as Record<string, string>).reason === "waiting_start_slot").length)
      .toBeGreaterThanOrEqual(1);
  });

  it("11. bomba sem estado confiável não bloqueia as outras", async () => {
    await db.query(`DELETE FROM public.equipments WHERE id=$1`, [EQ]);
    const ids = await recuperacaoColetiva(3);
    // a primeira da ordem está com pending (comunicação não voltou)
    await db.query(`UPDATE public.equipments SET pending_command_id=gen_random_uuid() WHERE id=$1`, [ids[0]]);
    await tick();
    expect(await onCmds()).toBe(1);   // a próxima da fila andou
  });

  it("12. bomba já ON não entra na fila", async () => {
    await db.query(`DELETE FROM public.equipments WHERE id=$1`, [EQ]);
    const ids = await recuperacaoColetiva(2);
    await db.query(`UPDATE public.equipments SET last_outputs_state='100000' WHERE id=$1`, [ids[0]]);
    await tick();
    const l = await logs("skipped");
    expect(l.some((x) => (x.details as Record<string, string>).reason === "already_running")).toBe(true);
    expect(await onCmds()).toBe(1);   // só a que estava OFF
  });

  it("13. bomba em manutenção não entra na fila de ON", async () => {
    await db.query(`DELETE FROM public.equipments WHERE id=$1`, [EQ]);
    const ids = await recuperacaoColetiva(2);
    await db.query(`UPDATE public.equipments SET maintenance_mode=true WHERE id=$1`, [ids[0]]);
    await tick();
    const c = await db.query<{ equipment_id: string }>(
      `SELECT equipment_id FROM public.commands`);
    expect(c.rows.map((r) => r.equipment_id)).not.toContain(ids[0]);
  });

  it("17 e 20. aguardando fila NÃO é falha; time_off remove da fila", async () => {
    await db.query(`DELETE FROM public.equipments WHERE id=$1`, [EQ]);
    await recuperacaoColetiva(3);
    await tick();
    const l = await logs("skipped");
    const fila = l.filter((x) => (x.details as Record<string, string>).reason === "waiting_start_slot");
    expect(fila.length).toBeGreaterThan(0);
    // 17. status é 'skipped', não 'failed' → o card não pode ficar vermelho
    expect(fila.every((x) => x.status === "skipped")).toBe(true);
    // 20. quando o time_off chega, o ON deixa de ser válido
    await db.query(`UPDATE public.automation_schedules SET time_off=$1 WHERE farm_id=$2`, [hhmmLocal(-1), FARM]);
    await db.query(`UPDATE public.commands SET status='timeout', responded_at=now(),
                    created_at = created_at - interval '61 seconds' WHERE status IN ('pending','sent')`);
    await db.query(`UPDATE public.equipments SET pending_command_id=NULL, command_blocked_until=NULL WHERE farm_id=$1`, [FARM]);
    const antes = await onCmds();
    await tick();
    expect(await onCmds()).toBe(antes);   // nenhuma nova partida
  });

  it("a auditoria da fila registra o contexto, uma vez por evento/dia", async () => {
    await db.query(`DELETE FROM public.equipments WHERE id=$1`, [EQ]);
    await recuperacaoColetiva(3);
    await tick(); await tick(); await tick();
    const fila = (await logs("skipped")).filter(
      (x) => (x.details as Record<string, string>).reason === "waiting_start_slot");
    // 2 bombas esperando, 1 linha cada — sem spam a cada tick
    expect(fila).toHaveLength(2);
    expect(fila[0].details).toMatchObject({ batch_size: 1, stagger_seconds: 60 });
  });
});

// ── ESCOPO: tudo isto só vale com AUTO ativo ───────────────────────────────
describe("escopo — automation_engine.enabled governa TODA a lógica", () => {
  async function comAuto(enabled: boolean) {
    await db.query(`UPDATE public.automation_engine SET enabled=$1 WHERE farm_id=$2`, [enabled, FARM]);
  }

  it("1. AUTO=false + dentro da janela ON → nenhum comando", async () => {
    await comAuto(false);
    await schedule(hhmmLocal(-1), hhmmLocal(120));
    await tick();
    expect(await cmds()).toBe(0);
  });

  it("2, 3 e 4. AUTO=false + recuperação coletiva → nenhuma fila, nenhuma partida", async () => {
    await comAuto(false);
    await db.query(`DELETE FROM public.equipments WHERE id=$1`, [EQ]);
    for (let i = 0; i < 4; i++) {
      const e = await db.query<{ id: string }>(
        `INSERT INTO public.equipments (farm_id, name, saida) VALUES ($1,$2,$3) RETURNING id`,
        [FARM, `P${i}`, i + 1]);
      await db.query(`INSERT INTO public.automation_schedules (farm_id, equipment_id, time_on, time_off)
                      VALUES ($1,$2,$3,$4)`, [FARM, e.rows[0].id, hhmmLocal(-10), hhmmLocal(120)]);
    }
    const r = await tick();
    expect(r.schedules_evaluated).toBe(0);
    expect(await cmds()).toBe(0);
    expect(await logs()).toHaveLength(0);
  });

  it("5. AUTO=false + time_off passou → nenhum desligamento POR ESTE motor", async () => {
    await comAuto(false);
    await db.query(`UPDATE public.equipments SET last_outputs_state='100000' WHERE id=$1`, [EQ]);
    await schedule(hhmmLocal(-300), hhmmLocal(-1));
    await tick();
    expect(await cmds()).toBe(0);
  });

  it("6. AUTO=true → o reconciliador volta a funcionar", async () => {
    await schedule(hhmmLocal(-1), hhmmLocal(120));
    await tick();
    expect(await cmds()).toBe(1);
  });

  it("7. desativar AUTO durante a fila cancela as partidas seguintes", async () => {
    await db.query(`DELETE FROM public.equipments WHERE id=$1`, [EQ]);
    for (let i = 0; i < 3; i++) {
      const e = await db.query<{ id: string }>(
        `INSERT INTO public.equipments (farm_id, name, saida) VALUES ($1,$2,$3) RETURNING id`,
        [FARM, `P${i}`, i + 1]);
      await db.query(`INSERT INTO public.automation_schedules (farm_id, equipment_id, time_on, time_off)
                      VALUES ($1,$2,$3,$4)`, [FARM, e.rows[0].id, hhmmLocal(-10), hhmmLocal(120)]);
    }
    await tick();
    expect(await cmds()).toBe(1);
    await comAuto(false);
    await db.query(`UPDATE public.commands SET status='timeout', responded_at=now(),
                    created_at = created_at - interval '61 seconds' WHERE status IN ('pending','sent')`);
    await db.query(`UPDATE public.equipments SET pending_command_id=NULL, command_blocked_until=NULL WHERE farm_id=$1`, [FARM]);
    await tick(); await tick();
    expect(await cmds()).toBe(1);   // fila cancelada
  });

  it("8. reativar AUTO recalcula pela janela e volta a reconciliar", async () => {
    await comAuto(false);
    await schedule(hhmmLocal(-1), hhmmLocal(120));
    await tick();
    expect(await cmds()).toBe(0);
    await comAuto(true);
    await tick();
    expect(await cmds()).toBe(1);
  });

  it("não vira killswitch global: o gate está SÓ no cursor deste motor", () => {
    // Só o SQL executável — os comentários explicam o gate e não contam.
    const code = MIG_SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect((code.match(/automation_engine/g) ?? [])).toHaveLength(1);
    expect(code).toContain("JOIN public.automation_engine ae ON ae.farm_id = s.farm_id AND ae.enabled = true");
    // e não toca nos motores independentes
    for (const outro of ["scheduled_automations", "enqueue_remote_command"]) {
      expect(code, outro).not.toContain(outro);
    }
  });
});

// ── GRUPOS CONFIGURÁVEIS ───────────────────────────────────────────────────
describe("partida em GRUPO, configurável por fazenda", () => {
  async function nBombas(n: number, farm = FARM) {
    for (let i = 0; i < n; i++) {
      const e = await db.query<{ id: string }>(
        `INSERT INTO public.equipments (farm_id, name, saida) VALUES ($1,$2,$3) RETURNING id`,
        [farm, `P${i}`, (i % 6) + 1]);
      await db.query(`INSERT INTO public.automation_schedules (farm_id, equipment_id, time_on, time_off)
                      VALUES ($1,$2,$3,$4)`, [farm, e.rows[0].id, hhmmLocal(-40 + i), hhmmLocal(180)]);
    }
  }
  async function config(batch: number, stagger = 60, on = true, farm = FARM) {
    await db.query(`UPDATE public.farms SET automatic_start_batch_size=$1,
                    automatic_start_stagger_seconds=$2, automatic_start_stagger_enabled=$3
                    WHERE id=$4`, [batch, stagger, on, farm]);
  }
  const onN = async (farm = FARM) => Number((await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM public.commands WHERE farm_id=$1 AND idempotency_key LIKE '%:on:%'`,
    [farm])).rows[0].n);
  /**
   * V5: o slot é ESTADO, não tempo. Envelhecer o comando não basta — a
   * tentativa precisa ser RESOLVIDA, como o agente faria (safety encerrando em
   * 120s marca status='timeout' + responded_at). Só então o slot libera.
   */
  async function proximoGrupo(farm = FARM, stagger = 60) {
    await db.query(
      `UPDATE public.commands SET status='timeout', responded_at=now(),
              created_at = created_at - make_interval(secs => $1)
        WHERE farm_id=$2 AND status IN ('pending','sent')`, [stagger + 1, farm]);
    await db.query(`UPDATE public.equipments SET pending_command_id=NULL, command_blocked_until=NULL WHERE farm_id=$1`, [farm]);
  }

  it("1. batch=1 + 4 bombas → 1 por grupo", async () => {
    await db.query(`DELETE FROM public.equipments WHERE id=$1`, [EQ]);
    await config(1); await nBombas(4);
    await tick(); expect(await onN()).toBe(1);
    await proximoGrupo(); await tick(); expect(await onN()).toBe(2);
  });

  it("2. batch=2 + 4 bombas → 2 + 2", async () => {
    await db.query(`DELETE FROM public.equipments WHERE id=$1`, [EQ]);
    await config(2); await nBombas(4);
    await tick(); expect(await onN()).toBe(2);
    await proximoGrupo(); await tick(); expect(await onN()).toBe(4);
  });

  it("3. batch=3 + 10 bombas → 3 + 3 + 3 + 1", async () => {
    await db.query(`DELETE FROM public.equipments WHERE id=$1`, [EQ]);
    await config(3); await nBombas(10);
    const grupos: number[] = [];
    let anterior = 0;
    for (let g = 0; g < 4; g++) {
      await tick();
      const total = await onN();
      grupos.push(total - anterior); anterior = total;
      await proximoGrupo();
    }
    expect(grupos).toEqual([3, 3, 3, 1]);
  });

  it("4. batch=4 + 12 bombas → 4 + 4 + 4", async () => {
    await db.query(`DELETE FROM public.equipments WHERE id=$1`, [EQ]);
    await config(4); await nBombas(12);
    const grupos: number[] = []; let anterior = 0;
    for (let g = 0; g < 3; g++) {
      await tick();
      const t = await onN(); grupos.push(t - anterior); anterior = t;
      await proximoGrupo();
    }
    expect(grupos).toEqual([4, 4, 4]);
  });

  it("5. nunca excede batch_size, em nenhum tick", async () => {
    await db.query(`DELETE FROM public.equipments WHERE id=$1`, [EQ]);
    await config(2); await nBombas(9);
    let anterior = 0;
    for (let g = 0; g < 5; g++) {
      await tick();
      const t = await onN();
      expect(t - anterior).toBeLessThanOrEqual(2);
      anterior = t; await proximoGrupo();
    }
  });

  it("6 e 7. batches diferentes por fazenda, sem interferência", async () => {
    await db.query(`DELETE FROM public.equipments WHERE id=$1`, [EQ]);
    await config(1); await nBombas(4);
    const f2 = await db.query<{ id: string }>(`INSERT INTO public.farms (name) VALUES ('F2') RETURNING id`);
    const F2 = f2.rows[0].id;
    await db.query(`INSERT INTO public.automation_engine (farm_id, enabled) VALUES ($1,true)`, [F2]);
    await db.query(`INSERT INTO public.rf_routing VALUES ($1,'R1',false)`, [F2]);
    await config(3, 60, true, F2); await nBombas(6, F2);
    await tick();
    expect(await onN(FARM)).toBe(1);   // fazenda A: batch 1
    expect(await onN(F2)).toBe(3);     // fazenda B: batch 3
  });

  it("8 e 10. o stagger é gate ADICIONAL, aplicado DEPOIS do slot", async () => {
    // V5: primeiro o slot precisa estar livre (tentativa resolvida); só então o
    // stagger separa os grupos. Nunca "passaram 90s, libero mesmo com a
    // anterior ainda STARTING".
    await db.query(`DELETE FROM public.equipments WHERE id=$1`, [EQ]);
    await config(2, 90); await nBombas(4);
    await tick(); expect(await onN()).toBe(2);

    // tentativas AINDA ABERTAS: nem com 200s o grupo seguinte parte
    await db.query(`UPDATE public.commands SET created_at = created_at - interval '200 seconds'`);
    await db.query(`UPDATE public.equipments SET pending_command_id=NULL, command_blocked_until=NULL WHERE farm_id=$1`, [FARM]);
    await tick(); expect(await onN()).toBe(2);

    // resolvidas, mas dentro do stagger de 90s → ainda espera
    await db.query(`UPDATE public.commands SET status='timeout', responded_at=now(),
                    created_at = now() - interval '10 seconds' WHERE status IN ('pending','sent')`);
    await tick(); expect(await onN()).toBe(2);

    // resolvidas E fora do stagger → o grupo seguinte parte
    await db.query(`UPDATE public.commands SET created_at = now() - interval '91 seconds'`);
    await tick(); expect(await onN()).toBe(4);
  });

  it("9. grupo anterior ainda pending → o próximo não inicia", async () => {
    await db.query(`DELETE FROM public.equipments WHERE id=$1`, [EQ]);
    await config(2); await nBombas(6);
    await tick(); expect(await onN()).toBe(2);
    await tick(); await tick();
    expect(await onN()).toBe(2);
  });

  it("11. falha parcial do grupo não trava a fila", async () => {
    await db.query(`DELETE FROM public.equipments WHERE id=$1`, [EQ]);
    await config(2); await nBombas(6);
    await tick(); expect(await onN()).toBe(2);
    await proximoGrupo();               // nenhuma confirmou; o stagger venceu
    await tick(); expect(await onN()).toBe(4);
  });

  it("escalonamento DESATIVADO → libera todas de uma vez", async () => {
    await db.query(`DELETE FROM public.equipments WHERE id=$1`, [EQ]);
    await config(1, 60, false); await nBombas(5);
    await tick();
    expect(await onN()).toBe(5);
  });

  it("15. o teto conta partidas do peak-hour também", async () => {
    await db.query(`DELETE FROM public.equipments WHERE id=$1`, [EQ]);
    await config(2); await nBombas(4);
    // o peak-hour já deu 2 partidas nesta fazenda agora há pouco
    for (let i = 0; i < 2; i++) {
      await db.query(`INSERT INTO public.commands (farm_id, equipment_id, type, priority, frame, timeout_ms, source_device)
        SELECT $1, id, 'manual', 1, '[1314_1_]{100000}[1314_ETX_]', 120000, 'peak-hour'
          FROM public.equipments WHERE farm_id=$1 LIMIT 1`, [FARM]);
    }
    await tick();
    expect(await onN()).toBe(0);   // teto já ocupado pelo peak-hour
  });

  it("os parâmetros vivem em farms e são editáveis", () => {
    expect(MIG_SQL).toContain("ADD COLUMN IF NOT EXISTS automatic_start_batch_size int NOT NULL DEFAULT 1");
    expect(MIG_SQL).toContain("ADD COLUMN IF NOT EXISTS automatic_start_stagger_seconds int NOT NULL DEFAULT 60");
    expect(MIG_SQL).toContain("ADD COLUMN IF NOT EXISTS automatic_start_stagger_enabled boolean NOT NULL DEFAULT true");
    // batch NÃO é derivado da quantidade de bombas
    const code = MIG_SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/count\(\*\)[^;]*equipments[^;]*batch/i);
  });
});

// ── ESTADO DESEJADO: janela que atravessa a meia-noite ─────────────────────
describe("1 a 4, 20 e 21. estado desejado e janela 23:00 → 17:00", () => {
  /** Chama a função pura de estado desejado no Postgres. */
  const desired = async (on: string, off: string, days: string[], nowMin: number,
                         dowToday: string, dowPrev: string) =>
    (await db.query<{ d: string | null }>(
      `SELECT public.automatic_desired_state($1,$2,$3,'both',$4,$5,$6) AS d`,
      [on, off, days, nowMin, dowToday, dowPrev])).rows[0].d;

  const M = (h: number, m = 0) => h * 60 + m;
  const SEG = ["mon"];

  it("1. volta às 03:00 dentro de 23:00→17:00 → desired ON", async () => {
    // ciclo começou SEGUNDA 23:00; agora é TERÇA 03:00
    expect(await desired("23:00", "17:00", SEG, M(3), "tue", "mon")).toBe("on");
  });

  it("2. volta às 10:00 → ainda ON", async () => {
    expect(await desired("23:00", "17:00", SEG, M(10), "tue", "mon")).toBe("on");
  });

  it("3. volta às 16:50 → ainda ON", async () => {
    expect(await desired("23:00", "17:00", SEG, M(16, 50), "tue", "mon")).toBe("on");
  });

  it("4. volta às 17:01 → NÃO liga (desired OFF)", async () => {
    expect(await desired("23:00", "17:00", SEG, M(17, 1), "tue", "mon")).toBe("off");
  });

  it("21. o ciclo pertence ao dia em que COMEÇA", async () => {
    // terça 03:00 com apenas SEGUNDA marcada → pertence ao ciclo de segunda
    expect(await desired("23:00", "17:00", SEG, M(3), "tue", "mon")).toBe("on");
    // quarta 03:00 (véspera = terça, não marcada) → não governa
    expect(await desired("23:00", "17:00", SEG, M(3), "wed", "tue")).toBeNull();
    // segunda 23:30 → o ciclo começou hoje
    expect(await desired("23:00", "17:00", SEG, M(23, 30), "mon", "sun")).toBe("on");
  });

  it("janela comum 08:00→17:00 se comporta como esperado", async () => {
    const D = ["tue"];
    expect(await desired("08:00", "17:00", D, M(7, 59), "tue", "mon")).toBeNull();
    expect(await desired("08:00", "17:00", D, M(8), "tue", "mon")).toBe("on");
    expect(await desired("08:00", "17:00", D, M(12), "tue", "mon")).toBe("on");
    expect(await desired("08:00", "17:00", D, M(17), "tue", "mon")).toBe("off");
    expect(await desired("08:00", "17:00", D, M(23), "tue", "mon")).toBe("off");
  });

  it("dia não marcado → o schedule não governa", async () => {
    expect(await desired("08:00", "17:00", ["wed"], M(12), "tue", "mon")).toBeNull();
  });

  it("19. OFF perdido por 30 min → o reconciliador desliga (sem WINDOW_MIN)", async () => {
    await db.query(`UPDATE public.equipments SET last_outputs_state='100000' WHERE id=$1`, [EQ]);
    await schedule(hhmmLocal(-300), hhmmLocal(-30));
    await tick();
    const c = await db.query<{ frame: string }>(`SELECT frame FROM public.commands`);
    expect(c.rows).toHaveLength(1);
    expect(c.rows[0].frame).toMatch(/\{0/);
  });
});

// ── PEAK-HOUR: mesmo teto, maintenance guard preservado ────────────────────
describe("11 e 12. peak-hour respeita o teto e mantém a trava de manutenção", () => {
  it("12. o MAINTENANCE GUARD do peak-hour foi preservado palavra por palavra", () => {
    const orig = fs.readFileSync(path.join(REPO,
      "supabase/migrations/20260902120000_maintenance_blocks_automatic_turn_on.sql"), "utf8");
    const guard = `IF COALESCE(v_eq.maintenance_mode, false) = true THEN
          v_skipped_maint := v_skipped_maint + 1;
          CONTINUE;
        END IF;`;
    expect(orig).toContain(guard);      // existe na versão vigente
    expect(MIG_SQL).toContain(guard);   // e continua na nova
    expect(MIG_SQL).toContain("MAINTENANCE GUARD");
  });

  it("11. o peak-hour usa o MESMO batch_size/stagger da fazenda", () => {
    const bloco = MIG_SQL.slice(MIG_SQL.indexOf("CREATE OR REPLACE FUNCTION public.run_peak_hour_tick"));
    expect(bloco).toContain("automatic_start_batch_size");
    expect(bloco).toContain("automatic_start_stagger_seconds");
    expect(bloco).toContain("automatic_start_stagger_enabled");
    // V5: usa a MESMA função de contagem por ESTADO do reconciliador —
    // teto único por fazenda, sem duplicar a regra.
    expect(bloco).toContain("public.count_automatic_start_slots_in_use(v_cfg.farm_id)");
    expect(bloco).toContain("(v_in_flight + v_started_now) >= v_batch");
  });

  it("11b. quem não cabe no grupo FICA na fila, não se perde", () => {
    const bloco = MIG_SQL.slice(MIG_SQL.indexOf("CREATE OR REPLACE FUNCTION public.run_peak_hour_tick"));
    expect(bloco).toContain("v_affected := array_append(v_affected, v_eq.id)");
    // só encerra o ciclo quando a fila esvazia
    expect(bloco).toContain("IF array_length(v_affected, 1) IS NULL THEN");
  });

  it("o peak-hour parte da versão VIGENTE, não da original", () => {
    const bloco = MIG_SQL.slice(MIG_SQL.indexOf("CREATE OR REPLACE FUNCTION public.run_peak_hour_tick"));
    expect(bloco).toContain("v_skipped_maint");   // variável introduzida pela 20260902120000
  });
});

// ── REGRESSÃO: variável órfã no ramo OFF adiado ────────────────────────────
// A V3 referenciava `v_off_valid_until` num jsonb_build_object sem declarar a
// variável — resquício do modelo de janela/catch-up. A função era CRIADA sem
// erro, mas o primeiro DESLIGAR adiado por pending/blocked abortaria o tick
// INTEIRO em runtime. Estes testes executam exatamente esses ramos.
describe("regressão: DESLIGAR adiado não pode quebrar o tick", () => {
  /** Bomba LIGADA cujo horário de desligar já passou → desired OFF. */
  async function desiredOffComFisicoOn() {
    await db.query(`UPDATE public.equipments SET last_outputs_state='100000' WHERE id=$1`, [EQ]);
    await schedule(hhmmLocal(-300), hhmmLocal(-5));
  }

  it("8. desired OFF + physical ON + pending_command → não lança, registra deferred", async () => {
    await desiredOffComFisicoOn();
    await db.query(`UPDATE public.equipments SET pending_command_id=gen_random_uuid() WHERE id=$1`, [EQ]);
    const r = await tick();                      // não pode lançar
    expect(r.schedules_evaluated).toBe(1);
    expect(await cmds()).toBe(0);                // nenhum comando duplicado
    const l = (await logs("skipped")).filter((x) => x.action === "desliga");
    expect(l).toHaveLength(1);
    expect(l[0].details).toMatchObject({ reason: "pending_command", deferred: true });
    // e o campo órfão não voltou
    expect(Object.keys(l[0].details as Record<string, unknown>)).not.toContain("valid_until_min");
  });

  it("9. desired OFF + physical ON + command_blocked_until → não lança, registra deferred", async () => {
    await desiredOffComFisicoOn();
    await db.query(`UPDATE public.equipments SET command_blocked_until=now()+interval '2 minutes' WHERE id=$1`, [EQ]);
    const r = await tick();
    expect(r.schedules_evaluated).toBe(1);
    expect(await cmds()).toBe(0);
    const l = (await logs("skipped")).filter((x) => x.action === "desliga");
    expect(l[0].details).toMatchObject({ reason: "command_blocked", deferred: true });
  });

  it("o tick segue processando OUTRA bomba mesmo com o ramo adiado disparado", async () => {
    // bomba A: desired OFF + physical ON + pending → ramo que quebrava
    await desiredOffComFisicoOn();
    await db.query(`UPDATE public.equipments SET pending_command_id=gen_random_uuid() WHERE id=$1`, [EQ]);
    // bomba B: desired ON + physical OFF → deve receber comando normalmente
    const b = await db.query<{ id: string }>(
      `INSERT INTO public.equipments (farm_id, name, saida) VALUES ($1,'POÇO B',2) RETURNING id`, [FARM]);
    await db.query(`INSERT INTO public.automation_schedules (farm_id, equipment_id, time_on, time_off)
                    VALUES ($1,$2,$3,$4)`, [FARM, b.rows[0].id, hhmmLocal(-2), hhmmLocal(120)]);
    const r = await tick();
    expect(r.schedules_evaluated).toBe(2);
    const c = await db.query<{ equipment_id: string }>(`SELECT equipment_id FROM public.commands`);
    expect(c.rows.map((x) => x.equipment_id)).toEqual([b.rows[0].id]);
  });

  it("outra FAZENDA do mesmo tick continua sendo processada", async () => {
    await desiredOffComFisicoOn();
    await db.query(`UPDATE public.equipments SET pending_command_id=gen_random_uuid() WHERE id=$1`, [EQ]);
    const f2 = await db.query<{ id: string }>(`INSERT INTO public.farms (name) VALUES ('F2') RETURNING id`);
    const F2 = f2.rows[0].id;
    await db.query(`INSERT INTO public.automation_engine (farm_id, enabled) VALUES ($1,true)`, [F2]);
    await db.query(`INSERT INTO public.rf_routing VALUES ($1,'R1',false)`, [F2]);
    const e2 = await db.query<{ id: string }>(
      `INSERT INTO public.equipments (farm_id, name, saida) VALUES ($1,'P',1) RETURNING id`, [F2]);
    await db.query(`INSERT INTO public.automation_schedules (farm_id, equipment_id, time_on, time_off)
                    VALUES ($1,$2,$3,$4)`, [F2, e2.rows[0].id, hhmmLocal(-2), hhmmLocal(120)]);
    await tick();
    const n = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM public.commands WHERE farm_id=$1`, [F2]);
    expect(Number(n.rows[0].n)).toBe(1);
  });

  it("nenhuma variável órfã sobrou em nenhum jsonb_build_object", () => {
    // Varre a migration: todo `v_*` usado no corpo tem de estar no DECLARE.
    // É esta checagem que teria pego o bug da V3 antes de qualquer deploy.
    for (const fn of ["run_automation_tick", "run_peak_hour_tick"]) {
      const ini = MIG_SQL.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}`);
      const fim = MIG_SQL.indexOf("$function$;", ini);
      const corpo = MIG_SQL.slice(ini, fim);
      // O DECLARE vai de "AS $function$" até a linha que é exatamente "BEGIN".
      const linhas = corpo.split("\n");
      const iDecl = linhas.findIndex((l) => l.trim() === "DECLARE");
      const iBegin = linhas.findIndex((l, k) => k > iDecl && l.trim() === "BEGIN");
      expect(iDecl, `${fn}: DECLARE não encontrado`).toBeGreaterThan(-1);
      expect(iBegin, `${fn}: BEGIN não encontrado`).toBeGreaterThan(iDecl);
      const decl = new Set(
        linhas.slice(iDecl + 1, iBegin)
          .map((l) => /^\s*([a-zA-Z_]\w*)\b/.exec(l)?.[1])
          .filter((x): x is string => !!x));
      const semLiteral = linhas.slice(iBegin)
        .filter((l) => !l.trim().startsWith("--"))
        .join("\n").replace(/'[^']*'/g, "''");
      for (const m of semLiteral.matchAll(/\b(v_\w+)/g)) {
        expect(decl.has(m[1]), `${fn}: ${m[1]} usada sem DECLARE`).toBe(true);
      }
    }
  });
});

// ── 19 e 20. JUSTIÇA: quem falhou não retoma o slot na frente ──────────────
describe("19 e 20. fila justa após falha", () => {
  it("bomba que acabou de falhar cede a vez para quem ainda não tentou", async () => {
    await db.query(`DELETE FROM public.equipments WHERE id=$1`, [EQ]);
    await db.query(`UPDATE public.farms SET automatic_start_batch_size=1,
                    automatic_start_stagger_seconds=0 WHERE id=$1`, [FARM]);
    // P1 tem horário MAIS ANTIGO — sem a regra de justiça, ela sairia primeiro.
    const mk = async (nome: string, saida: number, min: number) => {
      const e = await db.query<{ id: string }>(
        `INSERT INTO public.equipments (farm_id,name,saida) VALUES ($1,$2,$3) RETURNING id`,
        [FARM, nome, saida]);
      await db.query(`INSERT INTO public.automation_schedules (farm_id,equipment_id,time_on,time_off)
                      VALUES ($1,$2,$3,$4)`, [FARM, e.rows[0].id, hhmmLocal(min), hhmmLocal(180)]);
      return e.rows[0].id;
    };
    const p1 = await mk("P1", 1, -60);   // mais antiga
    const p2 = await mk("P2", 2, -30);

    // P1 já tentou e FALHOU agora há pouco (safety encerrou).
    await db.query(
      `INSERT INTO public.commands (farm_id, equipment_id, type, frame, source_device,
         idempotency_key, status, created_at, responded_at)
       VALUES ($1,$2,'manual','[1314_1_]{1}[1314_ETX_]','cloud-automation',
               'automation:a:b:on:antigo','timeout', now() - interval '150 seconds', now())`,
      [FARM, p1]);

    await tick();
    const c = await db.query<{ equipment_id: string }>(
      `SELECT equipment_id FROM public.commands WHERE status='pending' OR responded_at IS NULL`);
    // o slot foi para P2, não de volta para P1
    expect(c.rows.map((x) => x.equipment_id)).toContain(p2);
    expect(c.rows.map((x) => x.equipment_id)).not.toContain(p1);
  });
});
