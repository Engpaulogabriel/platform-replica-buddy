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
  last_changed_by text,
  last_confirmed_state smallint NOT NULL DEFAULT 0);
CREATE TABLE public.profiles (id uuid PRIMARY KEY, email text, full_name text);
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
  await db.exec(mig("20260814200200_automation_log_canonical_truth.sql"));
  await db.exec(`
    INSERT INTO public.farms (id,name) VALUES
      ('${PEROLA}','Fazenda Pérola'), ('${SOSSEGO}','Fazenda Sossego'), ('${SEMEAR}','Fazenda Semear');
    INSERT INTO public.equipments (id,farm_id,name) VALUES
      ('${POCO20}','${PEROLA}','POÇO 20'), ('${POCO02}','${SOSSEGO}','POÇO 02');
  `);
  return db;
}

const USER_A = "44444444-0000-0000-0000-00000000000a";

type Ev = {
  at: string; on: boolean; origin?: string; result?: string; actor?: string;
  user?: string | null; source?: string | null; details?: Record<string, unknown>;
  action?: "status_read" | "polling";
};

/** Data-base dos eventos: ONTEM, em BRT.
 *  Antes era a data FIXA "2026-08-14". Como `audit_automation_log_integrity`
 *  conta ruído numa janela de `interval '48 hours'` a partir de now(), a
 *  fixture expirava sozinha ao passar do segundo dia — os eventos caíam fora
 *  da janela e a rotina deixava de emitir alerta. A regra está correta; o que
 *  estava errado era a data congelada no teste. Ontem mantém todos os horários
 *  no passado e dentro das 48h, qualquer que seja a hora em que a suíte rode. */
const BASE_DATE = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 10);

async function insert(db: PGlite, farm: string, equip: string | null, name: string, e: Ev) {
  await db.query(
    `INSERT INTO public.automation_log (farm_id, equipment_id, equipment_name, action, origin, result,
                                        actor_label, user_id, source_device, details, occurred_at)
     VALUES ($1,$2,$3,$4::public.event_action,$5::public.event_origin,$6::public.event_result,
             $7,$8,$9,$10::jsonb,$11::timestamptz)`,
    [farm, equip, name,
     e.action ?? (e.on ? "turn_on" : "turn_off"), e.origin ?? "local",
     e.result ?? "success", e.actor ?? null, e.user ?? null, e.source ?? null,
     JSON.stringify(e.details ?? {}), `${BASE_DATE}T${e.at}:00-03:00`],
  );
}

// Atribuição da linha oficial (origem + quem).
async function attribution(db: PGlite, equip: string) {
  const r = await db.query<{ origin: string; user_id: string | null; actor_label: string | null; source_device: string | null }>(
    `SELECT origin::text, user_id, actor_label, source_device
       FROM public.automation_log
      WHERE equipment_id = $1 AND noise_reason IS NULL
        AND action IN ('turn_on','turn_off','pump_on','pump_off')
      ORDER BY occurred_at DESC LIMIT 1`, [equip]);
  return r.rows[0];
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

  it("polling/eco/reconexão (origin=reading) são DESCARTADOS — não viram linha nenhuma", async () => {
    await insert(db, PEROLA, POCO20, "POÇO 20", { at: "09:00", on: true });
    await insert(db, PEROLA, POCO20, "POÇO 20", { at: "09:05", on: false, origin: "reading" });
    await insert(db, PEROLA, POCO20, "POÇO 20", { at: "09:06", on: true, origin: "reading" });

    expect(await official(db, POCO20)).toEqual(["09:00 ON"]);
    // regra 3: nada de persistir polling como status_read — o banco não cresce
    const all = await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.automation_log`);
    expect(Number(all.rows[0].n)).toBe(1);
    // mas o ruído é CONTADO, para a rotina de integridade enxergar
    const noise = await db.query<{ reason: string; hits: number }>(
      `SELECT reason, hits FROM public.automation_log_noise_stats WHERE reason='reading_origin'`);
    expect(Number(noise.rows[0].hits)).toBe(2);
  });

  it("comando que NÃO confirmou (fail/timeout) não vira evento de estado — vai p/ técnico", async () => {
    await insert(db, PEROLA, POCO20, "POÇO 20", { at: "10:00", on: true });
    await insert(db, PEROLA, POCO20, "POÇO 20", { at: "10:05", on: false, origin: "remote", result: "fail", user: USER_A });
    await insert(db, PEROLA, POCO20, "POÇO 20", { at: "10:06", on: false, origin: "remote", result: "timeout", user: USER_A });

    // a bomba continua LIGADA: nenhum dos dois confirmou o desligamento
    expect(await official(db, POCO20)).toEqual(["10:00 ON"]);
    const st = await db.query<{ s: number }>(`SELECT last_confirmed_state s FROM public.equipments WHERE id='${POCO20}'`);
    expect(Number(st.rows[0].s)).toBe(1);
    // a falha operacional fica registrada, ligada ao comando, sem fingir estado
    const tech = await db.query<{ kind: string }>(
      `SELECT kind FROM public.agent_technical_events ORDER BY occurred_at`);
    expect(tech.rows.map((r) => r.kind)).toEqual(["command_not_confirmed", "command_timeout"]);
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

// A regressão relatada: a telemetria confirma o estado ANTES de o comando ser
// resolvido, então a linha que identifica o usuário chega depois. Ela não pode
// ser descartada como repetição — precisa PROMOVER a linha existente.
describe("comandos remotos que sumiram — atribuição pela melhor evidência", () => {
  it("telemetria (sem autoria) chega antes; comando remoto promove a linha a Remoto + usuário", async () => {
    // a linha física carrega a procedência declarada pelo agente (details.origin)
    await insert(db, SEMEAR, POCO20, "POÇO 20", {
      at: "07:19", on: true, origin: "system", actor: "Telemetria RF", details: { origin: "remote-cmd" } });
    await insert(db, SEMEAR, POCO20, "POÇO 20", { at: "07:19", on: true, origin: "remote", user: USER_A, actor: null });

    expect(await official(db, POCO20)).toEqual(["07:19 ON"]);   // continua UMA linha
    const a = await attribution(db, POCO20);
    expect(a.origin).toBe("remote");
    expect(a.user_id).toBe(USER_A);
  });

  it("coluna origin='local' mas agente declarou remote-desired → promove (não é botoeira)", async () => {
    // ramo v_state_changed de apply_pump_telemetry credita a COLUNA como 'local'
    // quando o pending_command já expirou, mas details.origin guarda a verdade.
    await insert(db, SEMEAR, POCO20, "POÇO 20", {
      at: "07:20", on: true, origin: "local", actor: "Acionamento local",
      details: { origin: "remote-desired" } });
    await insert(db, SEMEAR, POCO20, "POÇO 20", { at: "07:20", on: true, origin: "remote", user: USER_A });

    const a = await attribution(db, POCO20);
    expect(a.origin).toBe("remote");
    expect(a.user_id).toBe(USER_A);
    expect(await official(db, POCO20)).toHaveLength(1);
  });

  it("comando WhatsApp confirmado aparece como WhatsApp com o operador", async () => {
    await insert(db, SEMEAR, POCO20, "POÇO 20", {
      at: "08:00", on: true, origin: "system", actor: "Telemetria RF", details: { origin: "remote-cmd" } });
    await insert(db, SEMEAR, POCO20, "POÇO 20", {
      at: "08:00", on: true, origin: "remote", source: "whatsapp:Alcione|5577999999999" });

    const a = await attribution(db, POCO20);
    expect(a.origin).toBe("remote");
    expect(a.source_device).toBe("whatsapp:Alcione|5577999999999");
  });

  it("automação promove telemetria, mas comando remoto com usuário tem precedência sobre automação", async () => {
    await insert(db, SEMEAR, POCO20, "POÇO 20", { at: "16:00", on: true, origin: "local" }); // bomba ligada antes
    await insert(db, SEMEAR, POCO20, "POÇO 20", {
      at: "17:00", on: false, origin: "system", actor: "Telemetria RF", details: { origin: "auto" } });
    await insert(db, SEMEAR, POCO20, "POÇO 20", { at: "17:00", on: false, origin: "auto", actor: "Desligamento 17h" });
    expect((await attribution(db, POCO20)).origin).toBe("auto");
    expect((await attribution(db, POCO20)).actor_label).toBe("Desligamento 17h");

    await insert(db, SEMEAR, POCO20, "POÇO 20", { at: "17:01", on: false, origin: "remote", user: USER_A });
    expect((await attribution(db, POCO20)).origin).toBe("remote");
    // segue com as DUAS transições reais (16:00 ON e 17:00 OFF) — nenhuma linha extra
    expect(await official(db, POCO20)).toEqual(["16:00 ON", "17:00 OFF"]);
  });

  it("TX local real NÃO é rebaixado nem promovido indevidamente", async () => {
    await insert(db, SEMEAR, POCO20, "POÇO 20", { at: "09:00", on: true, origin: "local", actor: "Acionamento local" });
    // telemetria sem autoria depois não pode derrubar a atribuição local
    await insert(db, SEMEAR, POCO20, "POÇO 20", { at: "09:00", on: true, origin: "system", actor: "Telemetria RF" });
    expect((await attribution(db, POCO20)).origin).toBe("local");
    expect(await official(db, POCO20)).toHaveLength(1);
  });

  it("remoto SEM usuário identificado não promove — nada vira 'Remoto não identificado'", async () => {
    await insert(db, SEMEAR, POCO20, "POÇO 20", { at: "10:00", on: true, origin: "local", actor: "Acionamento local" });
    await insert(db, SEMEAR, POCO20, "POÇO 20", { at: "10:00", on: true, origin: "remote", user: null, actor: null });
    const a = await attribution(db, POCO20);
    expect(a.origin).toBe("local");     // continua Local, com autoria honesta
    expect(a.user_id).toBeNull();
  });

  it("comando remoto antigo (fora da janela de 180s) não é colado numa transição nova", async () => {
    await insert(db, SEMEAR, POCO20, "POÇO 20", { at: "11:00", on: true, origin: "system", actor: "Telemetria RF" });
    // occurred_at antigo, mas o que vale é a janela em relação a now() da linha existente
    await db.query(
      `UPDATE public.automation_log SET occurred_at = now() - interval '20 minutes',
              created_at = now() - interval '20 minutes' WHERE equipment_id = $1`, [POCO20]);
    await insert(db, SEMEAR, POCO20, "POÇO 20", { at: "11:30", on: true, origin: "remote", user: USER_A });
    const a = await attribution(db, POCO20);
    expect(a.origin).toBe("system");    // não promoveu
    expect(await official(db, POCO20)).toHaveLength(1);
  });
});

// Ajustes obrigatórios da aprovação: promoção só com CORRELAÇÃO FORTE.
describe("promoção exige correlação forte — atuação local nunca é roubada", () => {
  const CMD = "55555555-0000-0000-0000-00000000000c";

  it("comando remoto + telemetria física antes + conclusão depois → UMA linha Remoto + usuário", async () => {
    // (b) linha física: o agente declarou procedência remota em details.origin
    await insert(db, SEMEAR, POCO20, "POÇO 20", {
      at: "07:19", on: true, origin: "system", actor: "Telemetria RF",
      details: { origin: "remote-cmd", command_id: CMD } });
    // (c) conclusão do comando, com o usuário
    await insert(db, SEMEAR, POCO20, "POÇO 20", {
      at: "07:19", on: true, origin: "remote", user: USER_A, actor: "Paulo Gabriel",
      details: { command_id: CMD } });

    expect(await official(db, POCO20)).toEqual(["07:19 ON"]);
    const a = await attribution(db, POCO20);
    expect(a.origin).toBe("remote");
    expect(a.user_id).toBe(USER_A);
    expect(a.actor_label).toBe("Paulo Gabriel");
    const d = await db.query<{ command_id: string }>(
      `SELECT details->>'command_id' command_id FROM public.automation_log WHERE equipment_id='${POCO20}' AND noise_reason IS NULL`);
    expect(d.rows[0].command_id).toBe(CMD);   // vínculo do comando preservado
  });

  it("atuação LOCAL real na janela de 180s NÃO é roubada por comando remoto", async () => {
    // botoeira: o agente declara _origin='local'
    await insert(db, SEMEAR, POCO20, "POÇO 20", {
      at: "08:00", on: true, origin: "local", actor: "Acionamento local",
      details: { origin: "local" } });
    // comando remoto coincidente, sem vínculo com esta linha física
    await insert(db, SEMEAR, POCO20, "POÇO 20", {
      at: "08:01", on: true, origin: "remote", user: USER_A, details: { command_id: CMD } });

    const a = await attribution(db, POCO20);
    expect(a.origin).toBe("local");        // continua Local
    expect(a.user_id).toBeNull();
    expect(await official(db, POCO20)).toHaveLength(1);
    // o comando não some: vira registro técnico auditável
    const tech = await db.query<{ reason: string }>(
      `SELECT details->>'reason' reason FROM public.agent_technical_events WHERE kind='state_conflict'`);
    expect(tech.rows.map((r) => r.reason)).toContain("atribuicao_sem_correlacao_forte");
  });

  it("command_id conflitante invalida a promoção", async () => {
    await insert(db, SEMEAR, POCO20, "POÇO 20", {
      at: "09:00", on: true, origin: "system", details: { origin: "remote-cmd", command_id: CMD } });
    await insert(db, SEMEAR, POCO20, "POÇO 20", {
      at: "09:01", on: true, origin: "remote", user: USER_A,
      details: { command_id: "99999999-0000-0000-0000-000000000099" } });
    expect((await attribution(db, POCO20)).origin).toBe("system");  // não promoveu
  });

  it("sem evidência nenhuma (telemetria pura) não promove", async () => {
    await insert(db, SEMEAR, POCO20, "POÇO 20", {
      at: "10:00", on: true, origin: "system", actor: "Telemetria RF", details: { origin: "system" } });
    await insert(db, SEMEAR, POCO20, "POÇO 20", { at: "10:01", on: true, origin: "remote", user: USER_A });
    expect((await attribution(db, POCO20)).origin).toBe("system");
  });
});

describe("transição confirmada sem atribuição — Origem em apuração", () => {
  it("não some do histórico e abre alerta técnico", async () => {
    await insert(db, PEROLA, POCO20, "POÇO 20", {
      at: "05:00", on: true, origin: "system", actor: "Telemetria RF", details: { origin: "system" } });

    // continua no histórico OFICIAL (some seria mentir sobre o que a bomba fez)
    expect(await official(db, POCO20)).toEqual(["05:00 ON"]);
    expect((await attribution(db, POCO20)).origin).toBe("system");
    const tech = await db.query<{ reason: string; note: string }>(
      `SELECT details->>'reason' reason, details->>'note' note
         FROM public.agent_technical_events WHERE kind='state_conflict'`);
    expect(tech.rows[0].reason).toBe("transicao_confirmada_sem_atribuicao");
    expect(tech.rows[0].note).toMatch(/Origem em apuração/);
  });

  it("não vira Local nem Remoto sem evidência", async () => {
    await insert(db, PEROLA, POCO20, "POÇO 20", { at: "05:10", on: true, origin: "system", details: { origin: "system" } });
    const a = await attribution(db, POCO20);
    expect(a.origin).not.toBe("local");
    expect(a.origin).not.toBe("remote");
    expect(a.user_id).toBeNull();
  });
});

// Cenário exato relatado: a limpeza anterior marcou como duplicada justamente a
// linha que carregava o usuário. O backfill precisa devolver os religamentos.
describe("CASO REAL Semear 14/08 — 13 religamentos remotos voltam ao relatório", () => {
  const POCOS = Array.from({ length: 13 }, (_, i) =>
    `66666666-0000-0000-0000-0000000000${String(i + 10).padStart(2, "0")}`);

  it("13 religamentos voltam como Ligada / Remoto / usuário real / OK — sem duplicar", async () => {
    await db.query(`INSERT INTO public.profiles (id,email,full_name) VALUES ($1,$2,$3)`,
      [USER_A, "paulo@renov.com.br", "Paulo Gabriel"]);

    // estado gravado como estava DEPOIS do hotfix anterior:
    //  • linha física oficial (telemetria, sem autoria)
    //  • linha do comando com o usuário, marcada como 'repeated_state'
    await db.exec(`ALTER TABLE public.automation_log DISABLE TRIGGER trg_enforce_automation_log_state_change`);
    for (const p of POCOS) {
      await db.query(`INSERT INTO public.equipments (id,farm_id,name,last_confirmed_state) VALUES ($1,$2,$3,1)`,
        [p, SEMEAR, `POÇO ${p.slice(-2)}`]);
      await insert(db, SEMEAR, p, "POÇO", {
        at: "07:19", on: true, origin: "system", actor: "Telemetria RF", details: { origin: "remote-cmd" } });
      await insert(db, SEMEAR, p, "POÇO", {
        at: "07:19", on: true, origin: "remote", user: USER_A, actor: "Paulo Gabriel" });
    }
    await db.query(
      `UPDATE public.automation_log SET noise_reason='repeated_state' WHERE origin='remote' AND farm_id=$1`, [SEMEAR]);
    await db.exec(`ALTER TABLE public.automation_log ENABLE TRIGGER trg_enforce_automation_log_state_change`);

    // antes: 13 linhas oficiais, todas sem usuário
    const antes = await db.query<{ n: number }>(
      `SELECT count(*)::int n FROM public.automation_log
        WHERE farm_id=$1 AND noise_reason IS NULL AND user_id IS NOT NULL`, [SEMEAR]);
    expect(Number(antes.rows[0].n)).toBe(0);

    await db.exec(mig("20260814200200_automation_log_canonical_truth.sql"));

    const r = await db.query<any>(
      `SELECT action::text, origin::text, user_id, user_email, actor_label, result::text
         FROM public.automation_log
        WHERE farm_id=$1 AND noise_reason IS NULL
          AND action IN ('turn_on','turn_off','pump_on','pump_off')`, [SEMEAR]);

    expect(r.rows).toHaveLength(13);                                   // uma linha por poço
    expect(r.rows.every((x: any) => x.action === "turn_on")).toBe(true);   // Ligada
    expect(r.rows.every((x: any) => x.origin === "remote")).toBe(true);    // Remoto
    expect(r.rows.every((x: any) => x.user_id === USER_A)).toBe(true);     // usuário real
    expect(r.rows.every((x: any) => x.actor_label === "Paulo Gabriel")).toBe(true);
    expect(r.rows.every((x: any) => x.result === "success")).toBe(true);   // OK
  });

  it("não reintroduz polling, eco, OFF/OFF nem telemetria RF como evento", async () => {
    await db.exec(`ALTER TABLE public.automation_log DISABLE TRIGGER trg_enforce_automation_log_state_change`);
    await db.query(`INSERT INTO public.equipments (id,farm_id,name,last_confirmed_state) VALUES ($1,$2,$3,0)`,
      [POCOS[0], SEMEAR, "POÇO 10"]);
    await insert(db, SEMEAR, POCOS[0], "POÇO 10", { at: "07:19", on: true, origin: "local" });
    await insert(db, SEMEAR, POCOS[0], "POÇO 10", { at: "07:20", on: true, origin: "local" });      // ON/ON
    await insert(db, SEMEAR, POCOS[0], "POÇO 10", { at: "07:21", on: false, origin: "reading" });   // polling
    await insert(db, SEMEAR, POCOS[0], "POÇO 10", { at: "07:30", on: false, origin: "local" });
    await insert(db, SEMEAR, POCOS[0], "POÇO 10", { at: "07:31", on: false, origin: "local" });     // OFF/OFF
    await db.exec(`ALTER TABLE public.automation_log ENABLE TRIGGER trg_enforce_automation_log_state_change`);

    await db.exec(mig("20260814200200_automation_log_canonical_truth.sql"));
    expect(await official(db, POCOS[0])).toEqual(["07:19 ON", "07:30 OFF"]);
  });
});

// Atribuição por last_changed_by só vale quando o casamento com profiles é ÚNICO.
// "Telemetria RF" confirma o ESTADO; nunca pode ocupar o lugar do ator.
describe("Telemetria RF é método, nunca usuário", () => {
  it("remote + Telemetria RF na linha física → usuário HUMANO preservado", async () => {
    await insert(db, SEMEAR, POCO20, "POÇO 20", {
      at: "07:19", on: true, origin: "system", actor: "Telemetria RF",
      source: "serial-bridge", details: { origin: "remote-cmd" } });
    await insert(db, SEMEAR, POCO20, "POÇO 20", {
      at: "07:19", on: true, origin: "remote", user: USER_A, actor: "Paulo Gabriel" });

    const a = await attribution(db, POCO20);
    expect(a.origin).toBe("remote");
    expect(a.actor_label).toBe("Paulo Gabriel");   // ator humano venceu
    expect(a.user_id).toBe(USER_A);
    expect(await official(db, POCO20)).toHaveLength(1);
  });

  it("comando remoto SEM ator não deixa 'Telemetria RF' virar autoria", async () => {
    // trg_log_manual_command grava actor_label=NULL para remoto; o COALESCE
    // antigo preservava o rótulo técnico da linha física — era o bug relatado.
    await insert(db, SEMEAR, POCO20, "POÇO 20", {
      at: "08:00", on: true, origin: "system", actor: "Telemetria RF",
      details: { origin: "remote-cmd" } });
    await insert(db, SEMEAR, POCO20, "POÇO 20", {
      at: "08:00", on: true, origin: "remote", user: USER_A, actor: null });

    const a = await attribution(db, POCO20);
    expect(a.origin).toBe("remote");
    expect(a.user_id).toBe(USER_A);
    expect(a.actor_label).toBeNull();              // NUNCA "Telemetria RF"
  });

  it("telemetria posterior NÃO sobrescreve user_id/actor_label já atribuídos", async () => {
    await insert(db, SEMEAR, POCO20, "POÇO 20", {
      at: "09:00", on: true, origin: "system", details: { origin: "remote-cmd" } });
    await insert(db, SEMEAR, POCO20, "POÇO 20", {
      at: "09:00", on: true, origin: "remote", user: USER_A, actor: "Paulo Gabriel" });
    // nova telemetria do mesmo estado chegando depois (rank 1)
    await insert(db, SEMEAR, POCO20, "POÇO 20", {
      at: "09:01", on: true, origin: "system", actor: "Telemetria RF", details: { origin: "remote-cmd" } });

    const a = await attribution(db, POCO20);
    expect(a.origin).toBe("remote");
    expect(a.user_id).toBe(USER_A);
    expect(a.actor_label).toBe("Paulo Gabriel");
  });

  it("backfill limpa 'Telemetria RF' que já ficou gravado como ator", async () => {
    await db.exec(`ALTER TABLE public.automation_log DISABLE TRIGGER trg_enforce_automation_log_state_change`);
    await insert(db, SEMEAR, POCO20, "POÇO 20", {
      at: "07:19", on: true, origin: "remote", actor: "Telemetria RF", details: { origin: "remote-cmd" } });
    await db.exec(`ALTER TABLE public.automation_log ENABLE TRIGGER trg_enforce_automation_log_state_change`);

    await db.exec(mig("20260814200200_automation_log_canonical_truth.sql"));

    const r = await db.query<any>(
      `SELECT actor_label, details->>'confirmation_method' metodo
         FROM public.automation_log WHERE equipment_id='${POCO20}' AND noise_reason IS NULL`);
    expect(r.rows[0].actor_label).toBeNull();               // saiu da coluna Usuário
    expect(r.rows[0].metodo).toBe("Telemetria RF");         // virou detalhe técnico
  });
});

describe("backfill por last_changed_by — só com casamento único", () => {
  const USER_B = "44444444-0000-0000-0000-00000000000b";

  // Linha física declarada como remote-cmd, sem command_id e sem user_id.
  async function seedOrfa(lastChangedBy: string | null) {
    await db.exec(`ALTER TABLE public.automation_log DISABLE TRIGGER trg_enforce_automation_log_state_change`);
    await db.query(`UPDATE public.equipments SET last_changed_by = $1 WHERE id = $2`, [lastChangedBy, POCO20]);
    await insert(db, PEROLA, POCO20, "POÇO 20", {
      at: "07:19", on: true, origin: "system", actor: null, details: { origin: "remote-cmd" } });
    await db.exec(`ALTER TABLE public.automation_log ENABLE TRIGGER trg_enforce_automation_log_state_change`);
    await db.exec(mig("20260814200200_automation_log_canonical_truth.sql"));
    const r = await db.query<any>(
      `SELECT origin::text, user_id, actor_label, user_email,
              (details->>'attribution_unavailable')::boolean unavailable,
              details->>'attribution_source' src,
              (SELECT count(*)::int FROM public.automation_log
                WHERE equipment_id='${POCO20}' AND noise_reason IS NULL) linhas
         FROM public.automation_log WHERE equipment_id='${POCO20}' AND noise_reason IS NULL`);
    return r.rows;
  }

  it("EXATAMENTE UM profile compatível → preenche user_id e actor_label", async () => {
    await db.query(`INSERT INTO public.profiles (id,email,full_name) VALUES ($1,$2,$3)`,
      [USER_A, "paulo@renov.com.br", "Paulo Gabriel"]);
    const rows = await seedOrfa("Paulo Gabriel");
    expect(rows).toHaveLength(1);
    expect(rows[0].origin).toBe("remote");
    expect(rows[0].user_id).toBe(USER_A);
    expect(rows[0].actor_label).toBe("Paulo Gabriel");
    expect(rows[0].unavailable).toBe(false);
    expect(rows[0].src).toBe("last_changed_by");
  });

  it("DOIS profiles homônimos → NÃO atribui pessoa e não duplica a linha", async () => {
    await db.query(`INSERT INTO public.profiles (id,email,full_name) VALUES ($1,$2,$3),($4,$5,$6)`,
      [USER_A, "paulo1@renov.com.br", "Paulo Gabriel",
       USER_B, "paulo2@renov.com.br", "Paulo Gabriel"]);
    const rows = await seedOrfa("Paulo Gabriel");
    expect(rows).toHaveLength(1);            // nunca duplica por JOIN de nome
    expect(Number(rows[0].linhas)).toBe(1);
    expect(rows[0].origin).toBe("remote");   // origem sobrevive pela evidência técnica
    expect(rows[0].user_id).toBeNull();      // pessoa NÃO é atribuída
    expect(rows[0].actor_label).toBeNull();
    expect(rows[0].unavailable).toBe(true);
  });

  it("ZERO profiles compatíveis → mantém remoto sem autoria", async () => {
    await db.query(`INSERT INTO public.profiles (id,email,full_name) VALUES ($1,$2,$3)`,
      [USER_A, "outro@renov.com.br", "Outra Pessoa"]);
    const rows = await seedOrfa("Fulano Inexistente");
    expect(rows).toHaveLength(1);
    expect(rows[0].origin).toBe("remote");
    expect(rows[0].user_id).toBeNull();
    expect(rows[0].actor_label).toBeNull();
    expect(rows[0].unavailable).toBe(true);
  });

  it("last_changed_by nulo → mantém remoto sem autoria", async () => {
    const rows = await seedOrfa(null);
    expect(rows[0].origin).toBe("remote");
    expect(rows[0].user_id).toBeNull();
    expect(rows[0].unavailable).toBe(true);
  });
});

describe("backfill histórico não inventa usuário", () => {
  it("promove a Remoto pela evidência técnica, mas deixa a autoria indisponível", async () => {
    // linha de 14/08 com details.origin='remote-cmd', sem command_id e sem user_id
    await db.exec(`ALTER TABLE public.automation_log DISABLE TRIGGER trg_enforce_automation_log_state_change`);
    await insert(db, SEMEAR, POCO20, "POÇO 20", {
      at: "07:19", on: true, origin: "system", actor: null, details: { origin: "remote-cmd" } });
    await db.exec(`ALTER TABLE public.automation_log ENABLE TRIGGER trg_enforce_automation_log_state_change`);

    await db.exec(mig("20260814200200_automation_log_canonical_truth.sql"));

    const r = await db.query<any>(
      `SELECT origin::text, user_id, actor_label,
              (details->>'attribution_unavailable')::boolean unavailable,
              details->>'attribution_note' note
         FROM public.automation_log WHERE equipment_id='${POCO20}' AND noise_reason IS NULL`);
    expect(r.rows[0].origin).toBe("remote");        // evidência técnica basta p/ a ORIGEM
    expect(r.rows[0].user_id).toBeNull();           // mas NÃO para a pessoa
    expect(r.rows[0].actor_label).toBeNull();       // nada de "Remoto não identificado"
    expect(r.rows[0].unavailable).toBe(true);
    expect(r.rows[0].note).toBe("Remoto — atribuição histórica indisponível");
    // a frase só aparece na auditoria técnica
    const tech = await db.query<{ note: string }>(
      `SELECT details->>'note' note FROM public.agent_technical_events
        WHERE details->>'reason' = 'atribuicao_historica_indisponivel'`);
    expect(tech.rows[0].note).toBe("Remoto — atribuição histórica indisponível");
  });
});

describe("tráfego normal de polling não insere NADA em automation_log", () => {
  it("200 leituras de polling + eco + startup não criam nenhuma linha", async () => {
    // uma transição legítima primeiro
    await insert(db, PEROLA, POCO20, "POÇO 20", { at: "06:00", on: true, origin: "local" });
    const baseline = await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.automation_log`);
    expect(Number(baseline.rows[0].n)).toBe(1);

    for (let i = 0; i < 100; i++) {
      // polling confirmando o MESMO estado (origin=reading) — o caso mais comum
      await insert(db, PEROLA, POCO20, "POÇO 20", { at: "06:10", on: true, origin: "reading" });
      // eco/retry do mesmo frame por telemetria
      await insert(db, PEROLA, POCO20, "POÇO 20", { at: "06:10", on: true, origin: "system" });
    }
    // leituras de status explícitas e polling declarado
    for (let i = 0; i < 20; i++) {
      await insert(db, PEROLA, POCO20, "POÇO 20", { at: "06:11", on: true, action: "status_read", origin: "reading" });
      await insert(db, PEROLA, POCO20, "POÇO 20", { at: "06:11", on: true, action: "polling", origin: "reading" });
    }

    const after = await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.automation_log`);
    expect(Number(after.rows[0].n)).toBe(1);          // ZERO linhas novas
    expect(await official(db, POCO20)).toEqual(["06:00 ON"]);
    // e nada foi parar no histórico técnico (polling não é exceção útil)
    const tech = await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.agent_technical_events`);
    expect(Number(tech.rows[0].n)).toBe(0);
  });

  it("perda e retorno de comunicação vão para o histórico técnico, não para o oficial", async () => {
    await insert(db, PEROLA, POCO20, "POÇO 20", {
      at: "06:20", on: true, action: "status_read", origin: "system", result: "timeout",
      details: { tipo_evento: "equipamento_offline" } });
    await insert(db, PEROLA, POCO20, "POÇO 20", {
      at: "06:30", on: true, action: "status_read", origin: "system",
      details: { tipo_evento: "equipamento_online" } });

    expect(Number((await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.automation_log`)).rows[0].n)).toBe(0);
    const tech = await db.query<{ kind: string }>(`SELECT kind FROM public.agent_technical_events ORDER BY occurred_at`);
    expect(tech.rows.map((r) => r.kind)).toEqual(["comm_lost", "comm_restored"]);
  });
});

describe("rotina de integridade — rede de segurança", () => {
  it("marca linha indevida que escapou, conta o ruído e não apaga dado oficial", async () => {
    // insere por baixo do trigger, simulando um escape
    await db.exec(`ALTER TABLE public.automation_log DISABLE TRIGGER trg_enforce_automation_log_state_change`);
    await insert(db, PEROLA, POCO20, "POÇO 20", { at: "12:00", on: true, origin: "local" });
    await insert(db, PEROLA, POCO20, "POÇO 20", { at: "12:01", on: true, origin: "local" });  // repetido
    await insert(db, PEROLA, POCO20, "POÇO 20", { at: "12:02", on: false, origin: "reading" }); // leitura
    await db.exec(`ALTER TABLE public.automation_log ENABLE TRIGGER trg_enforce_automation_log_state_change`);

    const marked = await db.query<{ n: number }>(`SELECT public.audit_automation_log_integrity() AS n`);
    expect(Number(marked.rows[0].n)).toBe(2);
    expect(await official(db, POCO20)).toEqual(["12:00 ON"]);
    // nada foi apagado — as 3 linhas continuam lá
    expect(Number((await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.automation_log`)).rows[0].n)).toBe(3);
    const stats = await db.query<{ reason: string }>(`SELECT reason FROM public.automation_log_noise_stats ORDER BY reason`);
    expect(stats.rows.map((r) => r.reason)).toContain("repeated_state");
  });

  it("ruído acima do limite abre alerta técnico para investigação", async () => {
    await db.exec(`ALTER TABLE public.automation_log DISABLE TRIGGER trg_enforce_automation_log_state_change`);
    await insert(db, PEROLA, POCO20, "POÇO 20", { at: "13:00", on: true, origin: "local" });
    for (let i = 0; i < 25; i++) {
      await insert(db, PEROLA, POCO20, "POÇO 20", { at: "13:01", on: true, origin: "local" });
    }
    await db.exec(`ALTER TABLE public.automation_log ENABLE TRIGGER trg_enforce_automation_log_state_change`);

    await db.query(`SELECT public.audit_automation_log_integrity(interval '48 hours', 20)`);
    const alert = await db.query<{ kind: string; details: any }>(
      `SELECT kind, details FROM public.agent_technical_events WHERE kind='noise_threshold'`);
    expect(alert.rows).toHaveLength(1);
    expect(Number(alert.rows[0].details.hits_48h)).toBeGreaterThanOrEqual(20);
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
