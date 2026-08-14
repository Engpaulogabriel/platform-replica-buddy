// @vitest-environment node
//
// Relatório de Automação — só transição confirmada vira linha.
// Roda PostgreSQL de verdade (pglite) carregando as migrations REAIS:
//   • 20260814200000 — guarda da fonte (trigger BEFORE INSERT)
//   • 20260814200100 — limpeza do histórico contaminado
// Os casos abaixo são os relatados em produção (Pérola/Poço 20, Sossego/Poço 02,
// automação das 17h da Semear).
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "../..");
const mig = (f: string) => fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");

const PEROLA = "11111111-0000-0000-0000-000000000001";
const SOSSEGO = "11111111-0000-0000-0000-000000000002";
const SEMEAR = "11111111-0000-0000-0000-000000000003";
const POCO20 = "22222222-0000-0000-0000-000000000020";
const POCO02 = "22222222-0000-0000-0000-000000000002";

// Schema mínimo de que as migrations dependem (vive noutras migrations).
const BOOTSTRAP = `
CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE anon;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT NULL::uuid $fn$;
CREATE TYPE public.event_action AS ENUM ('turn_on','turn_off','status_read','mode_change','reset','polling','pump_on','pump_off');
CREATE TYPE public.event_origin AS ENUM ('remote','local','auto','reading','system');
CREATE TYPE public.event_result AS ENUM ('success','fail','pending','timeout');
CREATE TABLE public.farms (id uuid PRIMARY KEY, name text NOT NULL);
CREATE TABLE public.equipments (
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES public.farms(id), name text,
  last_confirmed_state smallint NOT NULL DEFAULT 0);
CREATE TABLE public.automation_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL, equipment_id uuid, equipment_name text NOT NULL,
  action public.event_action NOT NULL, origin public.event_origin NOT NULL,
  result public.event_result NOT NULL DEFAULT 'success',
  actor_label text, user_id uuid, user_email text, new_state text,
  source_device text, details jsonb, client_event_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION public.has_farm_access(uuid, uuid) RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT true $fn$;
`;

async function freshDb() {
  const db = await PGlite.create();
  await db.exec(BOOTSTRAP);
  await db.exec(mig("20260814200000_automation_log_transition_only.sql"));
  await db.exec(`
    INSERT INTO public.farms (id,name) VALUES
      ('${PEROLA}','Fazenda Pérola'), ('${SOSSEGO}','Fazenda Sossego'), ('${SEMEAR}','Fazenda Semear');
    INSERT INTO public.equipments (id,farm_id,name) VALUES
      ('${POCO20}','${PEROLA}','POÇO 20'), ('${POCO02}','${SOSSEGO}','POÇO 02');
  `);
  return db;
}

type Ev = { at: string; on: boolean; origin?: string; result?: string; actor?: string };

async function insert(db: PGlite, farm: string, equip: string | null, name: string, e: Ev) {
  await db.query(
    `INSERT INTO public.automation_log (farm_id, equipment_id, equipment_name, action, origin, result, actor_label, occurred_at)
     VALUES ($1,$2,$3,$4::public.event_action,$5::public.event_origin,$6::public.event_result,$7,$8::timestamptz)`,
    [farm, equip, name, e.on ? "turn_on" : "turn_off", e.origin ?? "local",
     e.result ?? "success", e.actor ?? null, `2026-08-14T${e.at}:00-03:00`],
  );
}

// Histórico OFICIAL, exatamente o que o relatório deve exibir.
async function official(db: PGlite, equip: string) {
  const r = await db.query<{ hhmm: string; action: string; origin: string }>(
    `SELECT to_char(occurred_at AT TIME ZONE 'America/Bahia','HH24:MI') AS hhmm,
            action::text, origin::text
       FROM public.automation_log
      WHERE equipment_id = $1 AND noise_reason IS NULL
        AND action IN ('turn_on','turn_off','pump_on','pump_off')
      ORDER BY occurred_at`, [equip]);
  return r.rows.map((x) => `${x.hhmm} ${x.action === "turn_on" ? "ON" : "OFF"}`);
}

let db: PGlite;
beforeEach(async () => { db = await freshDb(); });

describe("fonte — só transição confirmada entra no relatório", () => {
  it("CASO REAL Pérola/Poço 20: OFF 07:11 → ON 07:19 → OFF 07:29 → OFF 07:33", async () => {
    for (const e of [
      { at: "07:11", on: false }, // repete o estado inicial (desligado) → ruído
      { at: "07:19", on: true },  // transição real
      { at: "07:29", on: false }, // transição real
      { at: "07:33", on: false }, // OFF repetido → ruído
    ]) await insert(db, PEROLA, POCO20, "POÇO 20", e);

    expect(await official(db, POCO20)).toEqual(["07:19 ON", "07:29 OFF"]);
  });

  it("OFF repetido e ON repetido nunca geram linha, em qualquer quantidade", async () => {
    for (const e of [
      { at: "08:00", on: true }, { at: "08:01", on: true }, { at: "08:02", on: true },
      { at: "08:10", on: false }, { at: "08:11", on: false }, { at: "08:12", on: false },
    ]) await insert(db, PEROLA, POCO20, "POÇO 20", e);

    expect(await official(db, POCO20)).toEqual(["08:00 ON", "08:10 OFF"]);
  });

  it("polling/eco/reconexão (origin=reading) nunca entram — viram trilha técnica", async () => {
    await insert(db, PEROLA, POCO20, "POÇO 20", { at: "09:00", on: true });
    await insert(db, PEROLA, POCO20, "POÇO 20", { at: "09:05", on: false, origin: "reading" });
    await insert(db, PEROLA, POCO20, "POÇO 20", { at: "09:06", on: true, origin: "reading" });

    expect(await official(db, POCO20)).toEqual(["09:00 ON"]);
    const noise = await db.query<{ action: string; noise_reason: string }>(
      `SELECT action::text, noise_reason FROM public.automation_log WHERE noise_reason IS NOT NULL ORDER BY occurred_at`);
    expect(noise.rows).toHaveLength(2);
    // rebaixadas para telemetria técnica, não apagadas
    expect(noise.rows.every((r) => r.action === "status_read" && r.noise_reason === "reading_origin")).toBe(true);
  });

  it("comando que NÃO confirmou (fail/timeout) não vira evento de estado", async () => {
    await insert(db, PEROLA, POCO20, "POÇO 20", { at: "10:00", on: true });
    await insert(db, PEROLA, POCO20, "POÇO 20", { at: "10:05", on: false, origin: "remote", result: "fail" });
    await insert(db, PEROLA, POCO20, "POÇO 20", { at: "10:06", on: false, origin: "remote", result: "timeout" });

    // a bomba continua LIGADA: nenhum dos dois confirmou o desligamento
    expect(await official(db, POCO20)).toEqual(["10:00 ON"]);
    const st = await db.query<{ s: number }>(`SELECT last_confirmed_state s FROM public.equipments WHERE id='${POCO20}'`);
    expect(Number(st.rows[0].s)).toBe(1);
  });

  it("TX espontâneo local alternando em menos de 1 minuto gera as DUAS linhas", async () => {
    await insert(db, SOSSEGO, POCO02, "POÇO 02", { at: "11:00", on: true, origin: "local" });
    await insert(db, SOSSEGO, POCO02, "POÇO 02", { at: "11:00", on: false, origin: "local" });

    const r = await db.query<{ n: number }>(
      `SELECT count(*)::int n FROM public.automation_log WHERE equipment_id='${POCO02}' AND noise_reason IS NULL`);
    expect(Number(r.rows[0].n)).toBe(2); // atuação local real nunca se perde
  });

  it("CASO REAL Sossego/Poço 02: OFF 06:48 → ON 06:50 → OFF 06:50", async () => {
    await insert(db, SOSSEGO, POCO02, "POÇO 02", { at: "06:48", on: false, origin: "reading" }); // eco/polling
    await insert(db, SOSSEGO, POCO02, "POÇO 02", { at: "06:50", on: true, origin: "local" });    // TX espontâneo
    await insert(db, SOSSEGO, POCO02, "POÇO 02", { at: "06:50", on: false, origin: "local" });   // TX espontâneo

    expect(await official(db, POCO02)).toEqual(["06:50 ON", "06:50 OFF"]);
  });

  it("automação 17h da Semear: exatamente um OFF por poço, origem auto", async () => {
    const pocos = Array.from({ length: 16 }, (_, i) =>
      `33333333-0000-0000-0000-0000000000${String(i + 10).padStart(2, "0")}`);
    for (const p of pocos) {
      await db.query(`INSERT INTO public.equipments (id,farm_id,name,last_confirmed_state) VALUES ($1,$2,$3,1)`,
        [p, SEMEAR, `POÇO ${p.slice(-2)}`]);
      // desligamento programado + retentativas/eco do mesmo estado
      await insert(db, SEMEAR, p, "POÇO", { at: "17:00", on: false, origin: "auto", actor: "Desligamento 17h" });
      await insert(db, SEMEAR, p, "POÇO", { at: "17:01", on: false, origin: "auto" });
      await insert(db, SEMEAR, p, "POÇO", { at: "17:02", on: false, origin: "reading" });
    }
    const r = await db.query<{ equipment_id: string; n: number; origin: string }>(
      `SELECT equipment_id, count(*)::int n, min(origin::text) origin
         FROM public.automation_log
        WHERE farm_id='${SEMEAR}' AND noise_reason IS NULL
          AND action IN ('turn_on','turn_off','pump_on','pump_off')
        GROUP BY equipment_id`);
    expect(r.rows).toHaveLength(16);
    expect(r.rows.every((x) => Number(x.n) === 1)).toBe(true);   // um OFF por poço
    expect(r.rows.every((x) => x.origin === "auto")).toBe(true); // origem AUTO preservada
  });
});

describe("limpeza do histórico já contaminado", () => {
  // Insere DIRETO, sem passar pela guarda, para simular o que já está gravado.
  async function seedRaw(farm: string, equip: string, name: string, evs: Ev[]) {
    await db.exec(`ALTER TABLE public.automation_log DISABLE TRIGGER trg_enforce_automation_log_state_change`);
    for (const e of evs) await insert(db, farm, equip, name, e);
    await db.exec(`ALTER TABLE public.automation_log ENABLE TRIGGER trg_enforce_automation_log_state_change`);
  }

  it("limpa Pérola/Poço 20 preservando a alternância real", async () => {
    await seedRaw(PEROLA, POCO20, "POÇO 20", [
      { at: "07:11", on: false }, { at: "07:19", on: true },
      { at: "07:29", on: false }, { at: "07:33", on: false },
    ]);
    expect(await official(db, POCO20)).toHaveLength(4); // contaminado

    await db.exec(mig("20260814200100_automation_log_history_cleanup.sql"));

    expect(await official(db, POCO20)).toEqual(["07:19 ON", "07:29 OFF"]);
    const st = await db.query<{ s: number }>(`SELECT last_confirmed_state s FROM public.equipments WHERE id='${POCO20}'`);
    expect(Number(st.rows[0].s)).toBe(0); // reconciliado com o histórico limpo
  });

  it("preserva OFF→ON→OFF real e remove só os consecutivos iguais", async () => {
    await seedRaw(SOSSEGO, POCO02, "POÇO 02", [
      { at: "05:00", on: true }, { at: "05:01", on: true },   // 2º = ruído
      { at: "05:02", on: false },
      { at: "05:03", on: true },                               // alternância real
      { at: "05:04", on: false }, { at: "05:05", on: false },  // 2º = ruído
    ]);
    await db.exec(mig("20260814200100_automation_log_history_cleanup.sql"));
    expect(await official(db, POCO02)).toEqual(["05:00 ON", "05:02 OFF", "05:03 ON", "05:04 OFF"]);
  });

  it("gera relatório antes/depois por fazenda e equipamento, com Pérola/Sossego/Semear primeiro", async () => {
    await seedRaw(PEROLA, POCO20, "POÇO 20", [
      { at: "07:11", on: false }, { at: "07:19", on: true },
      { at: "07:29", on: false }, { at: "07:33", on: false },
    ]);
    await db.exec(mig("20260814200100_automation_log_history_cleanup.sql"));

    const rep = await db.query<any>(
      `SELECT farm_name, equipment_name, before_count, removed_total, after_count, batch_order
         FROM public.automation_log_cleanup_report ORDER BY batch_order, farm_name`);
    const perola = rep.rows.find((r: any) => r.farm_name === "Fazenda Pérola");
    expect(perola).toMatchObject({ before_count: 4, removed_total: 2, after_count: 2, batch_order: 1 });
    // ordem de execução: Pérola(1) → Sossego(2) → Semear(3) → demais(9)
    expect(rep.rows.map((r: any) => r.batch_order)).toEqual([...rep.rows.map((r: any) => r.batch_order)].sort());
  });

  it("é reversível e idempotente", async () => {
    await seedRaw(PEROLA, POCO20, "POÇO 20", [
      { at: "07:11", on: false }, { at: "07:19", on: true }, { at: "07:33", on: true },
    ]);
    await db.exec(mig("20260814200100_automation_log_history_cleanup.sql"));
    const after1 = await official(db, POCO20);
    // reexecutar não muda nada
    await db.query(`SELECT public.cleanup_automation_log_farm('${PEROLA}', gen_random_uuid(), 1)`);
    expect(await official(db, POCO20)).toEqual(after1);
    // rollback devolve tudo (nada foi apagado)
    await db.exec(`UPDATE public.automation_log SET noise_reason = NULL`);
    expect(await official(db, POCO20)).toHaveLength(3);
  });
});
