// @vitest-environment node
// REGRA DE SEGURANÇA GLOBAL: bomba em manutenção NUNCA pode ser ligada por
// automação. Defesa em profundidade — o motor pula (Camada 1) e, se algum fluxo
// futuro esquecer, o trigger em `commands` recusa o INSERT (Camada 2).
// Roda em Postgres 17 real (pglite).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs"; import path from "node:path";

let db: PGlite;
let FARM = ""; let EQ_OK = ""; let EQ_MAINT = ""; let EQ_SIBLING = "";

const MIGRATION = path.resolve(__dirname,
  "../../supabase/migrations/20260902120000_maintenance_blocks_automatic_turn_on.sql");

// `set_config(..., false)` = escopo de SESSÃO. Com `true` (transação) o valor
// se perderia entre as queries, porque o pglite abre uma transação por query.
/** Schema mínimo com o que o trigger toca. */
const SCHEMA = `
  CREATE SCHEMA IF NOT EXISTS auth;
  -- pg_cron/service_role não têm usuário autenticado: auth.uid() = NULL.
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
  CREATE TYPE public.command_type AS ENUM ('polling','manual','config','server','repeater','diagnostic','service_test','automation');
  CREATE TYPE public.equipment_type AS ENUM ('poco','bombeamento','nivel','repetidor');
  CREATE TABLE public.farms (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, timezone text DEFAULT 'America/Sao_Paulo');
  CREATE TABLE public.plc_groups (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), hw_id text, output_count int DEFAULT 1);
  CREATE TABLE public.equipments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, name text,
    type public.equipment_type DEFAULT 'poco', saida int DEFAULT 1, hw_id text,
    active boolean DEFAULT true, maintenance_mode boolean DEFAULT false,
    last_outputs_state text, pending_command_id uuid, command_blocked_until timestamptz,
    desired_running boolean DEFAULT false, plc_group_id uuid,
    last_communication timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
  CREATE TABLE public.commands (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, equipment_id uuid,
    plc_hw_id text, type public.command_type, priority int, frame text,
    timeout_ms int, source_device text, status text DEFAULT 'pending',
    created_at timestamptz DEFAULT now());
  CREATE TABLE public.rf_routing (farm_id uuid, radio text, via_repetidor boolean);
  CREATE TABLE public.peak_hour_config (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, enabled boolean DEFAULT true,
    auto_restart boolean DEFAULT true, start_time time, end_time time,
    last_peak_off_at timestamptz, last_peak_on_at timestamptz,
    affected_equipment_ids uuid[] DEFAULT ARRAY[]::uuid[],
    excluded_equipment_ids uuid[] DEFAULT ARRAY[]::uuid[]);
  CREATE OR REPLACE FUNCTION public.renov_combined_payload(
    _current_state text, _saida int, _turn_on boolean, _total int)
  RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
  DECLARE v_n int; v_pos int; v_state text;
  BEGIN
    v_n := GREATEST(1, LEAST(6, COALESCE(_total,1)));
    v_pos := GREATEST(1, LEAST(v_n, COALESCE(_saida,1)));
    IF _current_state ~ ('^[01]{' || v_n || '}$') THEN v_state := _current_state;
    ELSIF _current_state ~ '^[01]{6}$' THEN v_state := substring(_current_state from 1 for v_n);
    ELSE v_state := repeat('0', v_n); END IF;
    RETURN overlay(v_state placing CASE WHEN _turn_on THEN '1' ELSE '0' END from v_pos for 1);
  END; $$;
`;

/** Frame de atuação como os motores montam. */
const frameOn  = (tsnn: string, payload: string) => `[${tsnn}_1_]{${payload}}[${tsnn}_ETX_]\r`;

/** Insere um comando como um MOTOR AUTOMÁTICO (sem usuário autenticado). */
async function insertAuto(eq: string, frame: string, type = "manual", src = "cloud-automation") {
  await db.exec(`SELECT set_config('test.uid', '', false)`);
  return db.query(
    `INSERT INTO public.commands (farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device)
     VALUES ($1,$2,'1314',$3::public.command_type,1,$4,120000,$5) RETURNING id`,
    [FARM, eq, type, frame, src]);
}

/** Insere como OPERADOR autenticado. */
async function insertManual(eq: string, frame: string) {
  await db.exec(`SELECT set_config('test.uid', '11111111-1111-1111-1111-111111111111', false)`);
  return db.query(
    `INSERT INTO public.commands (farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device)
     VALUES ($1,$2,'1314','manual',1,$3,120000,'web') RETURNING id`,
    [FARM, eq, frame]);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(fs.readFileSync(MIGRATION, "utf8"));
  const f = await db.query<{ id: string }>(`INSERT INTO public.farms (name) VALUES ('F') RETURNING id`);
  FARM = f.rows[0].id;
  const mk = async (name: string, saida: number, maint: boolean) => {
    const r = await db.query<{ id: string }>(
      `INSERT INTO public.equipments (farm_id, name, saida, hw_id, maintenance_mode, last_outputs_state)
       VALUES ($1,$2,$3,'13140001',$4,'000000') RETURNING id`, [FARM, name, saida, maint]);
    return r.rows[0].id;
  };
  EQ_OK = await mk("POÇO OK", 1, false);
  EQ_MAINT = await mk("POÇO MANUTENÇÃO", 2, true);
  EQ_SIBLING = await mk("POÇO IRMÃO", 3, false);
  await db.exec(`INSERT INTO public.rf_routing (farm_id, radio, via_repetidor) VALUES ('${FARM}','R1',false)`);
}, 60_000);

afterAll(async () => { await db?.close(); });
beforeEach(async () => { await db.exec(`DELETE FROM public.commands`); });

// ── CAMADA 2: trigger global ───────────────────────────────────────────────
describe("9 a 13. trigger global em commands", () => {
  it("9. LIGAR automático para bomba EM manutenção → recusado", async () => {
    await expect(insertAuto(EQ_MAINT, frameOn("1314", "010000")))
      .rejects.toThrow(/manutenção/i);
    const n = await db.query<{ n: string }>(`SELECT count(*) AS n FROM public.commands`);
    expect(Number(n.rows[0].n)).toBe(0);   // 5 e 15: nada entra na fila
  });

  it("10. LIGAR automático para bomba FORA de manutenção → permitido", async () => {
    await insertAuto(EQ_OK, frameOn("1314", "100000"));
    const n = await db.query<{ n: string }>(`SELECT count(*) AS n FROM public.commands`);
    expect(Number(n.rows[0].n)).toBe(1);
  });

  it("11. DESLIGAR automático para bomba em manutenção → PERMITIDO", async () => {
    await insertAuto(EQ_MAINT, frameOn("1314", "000000"));
    const n = await db.query<{ n: string }>(`SELECT count(*) AS n FROM public.commands`);
    expect(Number(n.rows[0].n)).toBe(1);
  });

  it("12. polling → permitido, mesmo com bit '1' da bomba em manutenção", async () => {
    // Polling usa o MESMO `_1_` e carrega o estado atual: bloquear derrubaria a
    // comunicação de toda PLC com bomba ligada.
    await insertAuto(EQ_MAINT, frameOn("1314", "111111"), "polling", "cloud-polling");
    const n = await db.query<{ n: string }>(`SELECT count(*) AS n FROM public.commands`);
    expect(Number(n.rows[0].n)).toBe(1);
  });

  it("12b. config e diagnóstico também passam", async () => {
    for (const t of ["config", "diagnostic", "server"]) {
      await insertAuto(EQ_MAINT, frameOn("1314", "010000"), t, "x");
    }
    const n = await db.query<{ n: string }>(`SELECT count(*) AS n FROM public.commands`);
    expect(Number(n.rows[0].n)).toBe(3);
  });

  it("13. comando MANUAL autenticado não é afetado nesta tarefa", async () => {
    await insertManual(EQ_MAINT, frameOn("1314", "010000"));
    const n = await db.query<{ n: string }>(`SELECT count(*) AS n FROM public.commands`);
    expect(Number(n.rows[0].n)).toBe(1);
  });

  it("payload combinado: ligar a IRMÃ (saída 3) não é bloqueado pela manutenção da saída 2", async () => {
    // bit da saída 2 é '1' porque ela já está fisicamente ligada; o comando é da saída 3.
    await insertAuto(EQ_SIBLING, frameOn("1314", "011000"));
    const n = await db.query<{ n: string }>(`SELECT count(*) AS n FROM public.commands`);
    expect(Number(n.rows[0].n)).toBe(1);
  });

  it("frame via repetidor também é inspecionado", async () => {
    await expect(insertAuto(EQ_MAINT, "REP:R3:TX:R1:" + frameOn("1314", "010000")))
      .rejects.toThrow(/manutenção/i);
  });

  it("frame sem payload de atuação não é bloqueado", async () => {
    await insertAuto(EQ_MAINT, "[1314_9_]SEM_PAYLOAD[1314_ETX_]");
    const n = await db.query<{ n: string }>(`SELECT count(*) AS n FROM public.commands`);
    expect(Number(n.rows[0].n)).toBe(1);
  });

  it("17. a regra é global: vale para qualquer fazenda, sem hardcode", async () => {
    const f2 = await db.query<{ id: string }>(`INSERT INTO public.farms (name) VALUES ('OUTRA') RETURNING id`);
    const e2 = await db.query<{ id: string }>(
      `INSERT INTO public.equipments (farm_id, name, saida, maintenance_mode, last_outputs_state)
       VALUES ($1,'X',1,true,'000000') RETURNING id`, [f2.rows[0].id]);
    await db.exec(`SELECT set_config('test.uid', '', false)`);
    await expect(db.query(
      `INSERT INTO public.commands (farm_id, equipment_id, type, priority, frame, timeout_ms, source_device)
       VALUES ($1,$2,'manual',1,$3,120000,'motor-futuro')`,
      [f2.rows[0].id, e2.rows[0].id, frameOn("9999", "100000")])).rejects.toThrow(/manutenção/i);
    const src = await db.query<{ prosrc: string }>(
      `SELECT prosrc FROM pg_proc WHERE proname = 'enforce_maintenance_blocks_auto_on'`);
    expect(src.rows[0].prosrc).not.toMatch(/SEMEAR|SOSSEGO|semear|sossego/);
  });
});

// ── CAMADA 1: motor do horário de ponta ────────────────────────────────────
describe("4 a 8. run_peak_hour_tick não religa bomba em manutenção", () => {
  /** Estado: 18h já desligou as três; agora são 21h05 e o tick vai religar. */
  async function armarReligamento() {
    await db.exec(`DELETE FROM public.commands; DELETE FROM public.peak_hour_config;`);
    await db.query(
      `UPDATE public.equipments SET pending_command_id = NULL, command_blocked_until = NULL,
              desired_running = false, last_outputs_state = '000000' WHERE farm_id = $1`, [FARM]);
    // Janela RELATIVA ao relógio, não fixa. Com '18:00'/'21:00' o teste só
    // passava entre 21h e meia-noite: `run_peak_hour_tick` exige
    // `hora_local >= end_time` para religar. `end_time` = agora−1min garante
    // que o ramo de religamento dispare em qualquer horário do dia.
    await db.query(
      `INSERT INTO public.peak_hour_config
         (farm_id, enabled, auto_restart, start_time, end_time,
          last_peak_off_at, last_peak_on_at, affected_equipment_ids)
       VALUES ($1, true, true,
               ((now() AT TIME ZONE 'America/Sao_Paulo') - interval '2 hours')::time,
               ((now() AT TIME ZONE 'America/Sao_Paulo') - interval '1 minute')::time,
               -- Tem de cair no MESMO dia LOCAL de agora: a função exige
               -- (last_peak_off_at AT TIME ZONE tz)::date = data_local_de_hoje.
               -- '1 hour' quebrava logo depois da meia-noite.
               now() - interval '30 seconds',
               NULL, ARRAY[$2::uuid, $3::uuid])`,
      [FARM, EQ_OK, EQ_MAINT]);
  }

  it("4, 5, 6 e 7. a bomba em manutenção não gera comando nem estado pendente", async () => {
    await armarReligamento();
    await db.exec(`SELECT set_config('test.uid', '', false)`);
    await db.query(`SELECT * FROM public.run_peak_hour_tick()`);

    const cmds = await db.query<{ equipment_id: string }>(
      `SELECT equipment_id FROM public.commands`);
    // 5. nenhum comando para a bomba em manutenção
    expect(cmds.rows.map((r) => r.equipment_id)).not.toContain(EQ_MAINT);

    const eq = await db.query<{ pending_command_id: string | null; desired_running: boolean }>(
      `SELECT pending_command_id, desired_running FROM public.equipments WHERE id = $1`, [EQ_MAINT]);
    expect(eq.rows[0].pending_command_id).toBeNull();   // 6
    expect(eq.rows[0].desired_running).toBe(false);     // 7
  });

  it("a bomba FORA de manutenção religa normalmente (16: SEMEAR intacta)", async () => {
    await armarReligamento();
    await db.exec(`SELECT set_config('test.uid', '', false)`);
    await db.query(`SELECT * FROM public.run_peak_hour_tick()`);
    const cmds = await db.query<{ equipment_id: string }>(
      `SELECT equipment_id FROM public.commands`);
    expect(cmds.rows.map((r) => r.equipment_id)).toContain(EQ_OK);
  });

  it("8. sem catch-up: sair da manutenção depois NÃO religa a bomba", async () => {
    await armarReligamento();
    await db.exec(`SELECT set_config('test.uid', '', false)`);
    await db.query(`SELECT * FROM public.run_peak_hour_tick()`);

    // a lista de religamento pendente foi consumida
    const cfg = await db.query<{ affected_equipment_ids: string[] }>(
      `SELECT affected_equipment_ids FROM public.peak_hour_config WHERE farm_id = $1`, [FARM]);
    expect(cfg.rows[0].affected_equipment_ids ?? []).toHaveLength(0);

    // manutenção removida e tick roda de novo → nada é religado
    await db.query(`UPDATE public.equipments SET maintenance_mode = false WHERE id = $1`, [EQ_MAINT]);
    await db.exec(`DELETE FROM public.commands`);
    await db.query(`SELECT * FROM public.run_peak_hour_tick()`);
    const n = await db.query<{ n: string }>(`SELECT count(*) AS n FROM public.commands`);
    expect(Number(n.rows[0].n)).toBe(0);
    await db.query(`UPDATE public.equipments SET maintenance_mode = true WHERE id = $1`, [EQ_MAINT]);
  });

  it("14. manutenção ativada ENTRE tentativas bloqueia a seguinte", async () => {
    await armarReligamento();
    await db.query(`UPDATE public.equipments SET maintenance_mode = false WHERE id = $1`, [EQ_MAINT]);
    await db.exec(`SELECT set_config('test.uid', '', false)`);
    // 1ª tentativa: sem manutenção, o comando sai
    await db.query(`SELECT * FROM public.run_peak_hour_tick()`);
    const antes = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM public.commands WHERE equipment_id = $1`, [EQ_MAINT]);
    expect(Number(antes.rows[0].n)).toBe(1);

    // manutenção entra; nova tentativa direta no INSERT é recusada pela Camada 2
    await db.query(`UPDATE public.equipments SET maintenance_mode = true WHERE id = $1`, [EQ_MAINT]);
    await expect(insertAuto(EQ_MAINT, frameOn("1314", "010000"))).rejects.toThrow(/manutenção/i);
  });
});

// ── Contrato da migration ──────────────────────────────────────────────────
describe("1 a 3 e 18. escopo e não-regressão", () => {
  const SQL = fs.readFileSync(MIGRATION, "utf8");

  it("1 a 3. NÃO redefine os motores que já verificavam manutenção", () => {
    expect(SQL).not.toMatch(/FUNCTION public\.run_automation_tick/);
    expect(SQL).not.toMatch(/FUNCTION public\.run_automacoes_tick/);
  });

  it("não mexe em cron, Edge Function, schedules nem dados", () => {
    expect(SQL).not.toMatch(/cron\.(schedule|unschedule)/);
    expect(SQL).not.toMatch(/DELETE FROM|TRUNCATE|DROP TABLE/);
    expect(SQL).not.toMatch(/UPDATE public\.automation_schedules|UPDATE public\.scheduled_automations/);
  });

  it("18. a trava é só de banco — nenhum arquivo de frontend é necessário", () => {
    expect(SQL).toMatch(/BEFORE INSERT ON public\.commands/);
    expect(SQL).toMatch(/FUNCTION public\.enforce_maintenance_blocks_auto_on/);
  });

  it("o critério de origem é auth.uid(), não lista de source_device", async () => {
    const src = await db.query<{ prosrc: string }>(
      `SELECT prosrc FROM pg_proc WHERE proname = 'enforce_maintenance_blocks_auto_on'`);
    expect(src.rows[0].prosrc).toContain("auth.uid() IS NOT NULL");
    expect(src.rows[0].prosrc).not.toMatch(/source_device\s*=\s*'/);
  });

  it("o peak-hour ganhou o guard e mantém a assinatura", async () => {
    const p = await db.query<{ prosrc: string }>(
      `SELECT prosrc FROM pg_proc WHERE proname = 'run_peak_hour_tick'`);
    expect(p.rows[0].prosrc).toContain("MAINTENANCE GUARD");
    expect(p.rows[0].prosrc).toContain("maintenance_mode");
  });
});
