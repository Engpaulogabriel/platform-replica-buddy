// ─────────────────────────────────────────────────────────────────────────────
// Réplica da cadeia REAL do ledger, em Postgres de verdade
// ─────────────────────────────────────────────────────────────────────────────
// A diferença para o harness anterior: aqui a telemetria entra por
// `apply_pump_telemetry`, como o Agent faz, e não por UPDATE direto de
// last_outputs_state. Foi essa diferença que escondeu de mim o fato de que uma
// transição rende 2 ou 3 linhas — o UPDATE manual pulava o produtor que grava
// a segunda cópia.
//
// As funções não são reescritas para o teste: são o dump vivo do NEW
// (src/test/fixtures/new-live-functions.sql), e os gatilhos têm os nomes reais,
// porque o nome define a ordem de disparo entre os BEFORE INSERT.

import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const FIXTURE = "src/test/fixtures/new-live-functions.sql";
const MIGRATION = "supabase/migrations/20260922170000_canonical_ledger_single_writer.sql";
const AUTORIA = "supabase/migrations/20260922210000_remote_mechanism_authorship.sql";

const SCHEMA = `
CREATE TYPE public.event_origin  AS ENUM ('remote','local','auto','reading','system','whatsapp');
CREATE TYPE public.event_action  AS ENUM ('turn_on','turn_off','status_read','mode_change','reset','polling','pump_on','pump_off');
CREATE TYPE public.event_result  AS ENUM ('success','fail','pending','timeout');
CREATE TYPE public.command_type  AS ENUM ('polling','manual','config','server','repeater','diagnostic','service_test','automation');
CREATE TYPE public.command_status AS ENUM ('pending','sent','delivered','executed','timeout','error','cancelled');

CREATE SCHEMA IF NOT EXISTS auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $f$ SELECT nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $f$;

-- guarda de permissão do enqueue_reset_pump_command: o recorte destes testes
-- é o ledger, não a autorização (coberta em command-identity-guard).
CREATE FUNCTION public.can_write_farm(_u uuid, _f uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT true $f$;
CREATE FUNCTION public.farm_is_operational_here(_f uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT true $f$;

CREATE TABLE public.profiles (id uuid PRIMARY KEY, email text, full_name text);

CREATE TABLE public.plc_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, name text, hw_id text,
  output_count smallint DEFAULT 1, created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now());

CREATE TABLE public.equipments (
  id uuid PRIMARY KEY, farm_id uuid, name text, type text DEFAULT 'poco',
  saida smallint DEFAULT 1, hw_id text, plc_group_id uuid,
  last_outputs_state text, last_confirmed_state smallint, last_signal_bars smallint,
  last_communication timestamptz, last_actuation_origin text, last_changed_by text,
  desired_running boolean, pending_command_id uuid, safety_expired_at timestamptz,
  command_blocked_until timestamptz, forced_shutdown_enabled boolean DEFAULT false,
  maintenance_mode boolean DEFAULT false, active boolean DEFAULT true,
  updated_at timestamptz DEFAULT now());

CREATE TABLE public.commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, equipment_id uuid,
  plc_hw_id text, type public.command_type, status public.command_status DEFAULT 'pending',
  priority int DEFAULT 5, frame text, response text, error_message text,
  retry_count int DEFAULT 0, timeout_ms int DEFAULT 120000, created_by uuid,
  source_device text, client_event_id uuid DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(), sent_at timestamptz, responded_at timestamptz,
  reinforcement boolean DEFAULT false, idempotency_key text);

CREATE TABLE public.command_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), command_id uuid NOT NULL,
  client_event_id uuid, farm_id uuid NOT NULL, equipment_id uuid, equipment_name text,
  user_id uuid, user_email text, actor_label text, origin_kind text, intent text,
  frame text, source_device text, status_final text, command_created_at timestamptz,
  sent_at timestamptz, responded_at timestamptz, captured_at timestamptz DEFAULT now(),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT command_audit_command_uniq UNIQUE (command_id));

CREATE TABLE public.automation_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, equipment_id uuid,
  equipment_name text, occurred_at timestamptz DEFAULT now(),
  origin public.event_origin, action public.event_action, result public.event_result,
  new_state text, client_event_id uuid DEFAULT gen_random_uuid(), source_device text,
  user_id uuid, user_email text, actor_label text, noise_reason text,
  details jsonb DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT now(),
  CONSTRAINT automation_log_farm_client_uniq UNIQUE (farm_id, client_event_id));

CREATE TABLE public.agent_technical_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, equipment_id uuid,
  equipment_name text, kind text, occurred_at timestamptz, details jsonb DEFAULT '{}'::jsonb);

CREATE TABLE public.automation_log_noise_stats (
  farm_id uuid, equipment_id uuid, day date, reason text, hits int DEFAULT 0,
  updated_at timestamptz DEFAULT now(), PRIMARY KEY (farm_id, equipment_id, day, reason));

CREATE TABLE public.automation_execution_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), schedule_id uuid, equipment_id uuid,
  farm_id uuid, action text, scheduled_time text, executed_at timestamptz,
  status text, origin text, details jsonb DEFAULT '{}'::jsonb);

CREATE FUNCTION public.automatic_mode_actor_label(_command_id uuid)
RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT COALESCE(
    (SELECT 'Automático ' || l.scheduled_time FROM public.automation_execution_log l
      WHERE l.details->>'command_id' = _command_id::text AND l.scheduled_time IS NOT NULL
      ORDER BY l.executed_at DESC LIMIT 1), 'Modo Automático');
$f$;

CREATE TABLE public.scheduled_automations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, name text,
  is_active boolean DEFAULT true, time_brt text, days_of_week text[],
  max_retries int, retry_interval_min int);
`;

// Os mesmos gatilhos, com os mesmos nomes, na mesma ordem de disparo do NEW.
const GATILHOS = `
CREATE TRIGGER trg_equipments_log_state_change
AFTER UPDATE OF last_outputs_state ON public.equipments
FOR EACH ROW WHEN (OLD.last_outputs_state IS DISTINCT FROM NEW.last_outputs_state)
EXECUTE FUNCTION public.log_equipment_state_change();

CREATE TRIGGER trg_attribute_scheduled_shutdown
BEFORE INSERT ON public.automation_log
FOR EACH ROW EXECUTE FUNCTION public.attribute_scheduled_shutdown_log();

CREATE TRIGGER trg_enforce_automation_log_actor
BEFORE INSERT ON public.automation_log
FOR EACH ROW EXECUTE FUNCTION public.enforce_automation_log_actor_rule();

CREATE TRIGGER trg_set_automation_actor_label
BEFORE INSERT OR UPDATE OF user_id, user_email, origin, details, source_device, actor_label
ON public.automation_log
FOR EACH ROW EXECUTE FUNCTION public.set_automation_actor_label();

CREATE TRIGGER trg_z_guard_official_report
BEFORE INSERT ON public.automation_log
FOR EACH ROW EXECUTE FUNCTION public.guard_official_report_row();

CREATE TRIGGER trg_log_manual_command
AFTER INSERT OR UPDATE OF status ON public.commands
FOR EACH ROW EXECUTE FUNCTION public.log_manual_command_to_automation_log();
`;

export const ID = {
  fazenda: "11111111-1111-1111-1111-111111111111",
  poco:    "22222222-2222-2222-2222-222222222222",
  plc:     "55555555-5555-5555-5555-555555555555",
  yuri:    "33333333-3333-3333-3333-333333333333",
};

const semGrants = (sql: string) => sql.replace(/^GRANT EXECUTE[^;]+;$/gm, "");

/** Sobe a réplica. `comCorrecao=false` = estado atual de produção. */
export async function bancoDoLedger(comCorrecao = true): Promise<PGlite> {
  const db = await PGlite.create();
  await db.exec(SCHEMA);
  await db.exec(semGrants(readFileSync(FIXTURE, "utf8")));
  await db.exec(GATILHOS);
  if (comCorrecao) {
    await db.exec(semGrants(readFileSync(MIGRATION, "utf8")));
    // só o bloco do classificador: a correção histórica é por ID de produção
    const autoria = readFileSync(AUTORIA, "utf8");
    await db.exec(semGrants(autoria.slice(0, autoria.indexOf("-- ── 2) CORREÇÃO HISTÓRICA"))));
  }

  // PLC de uma saída, como as bombas da Sossego
  await db.exec(`
    INSERT INTO public.profiles (id, email, full_name)
    VALUES ('${ID.yuri}', 'yuri@renov.com', 'Yuri');
    INSERT INTO public.plc_groups (id, farm_id, name, hw_id, output_count)
    VALUES ('${ID.plc}', '${ID.fazenda}', 'PLC 1101', '1101', 1);
    INSERT INTO public.equipments
      (id, farm_id, name, type, saida, hw_id, plc_group_id, last_outputs_state,
       last_confirmed_state, last_communication, last_actuation_origin, desired_running)
    VALUES ('${ID.poco}', '${ID.fazenda}', 'POÇO 02', 'poco', 1, '1101',
            '${ID.plc}', '000000', 0, now(), 'remote-desired', false);
  `);
  return db;
}

/** Um RX chegando, exatamente como o Agent faz. */
export async function rx(db: PGlite, payload: string, opts: {
  commandId?: string | null; origin?: string | null;
} = {}) {
  await db.query(
    `SELECT public.apply_pump_telemetry($1,$2,$3,$4::smallint,$5,$6,$7)`,
    [ID.fazenda, "1101", payload, 4, opts.commandId ?? null,
     `_[1101_0_]{${payload}}_[1101_ETX_]`, opts.origin ?? null]);
}

/** Enfileira um comando manual, como a plataforma/WhatsApp fazem. */
export async function comando(db: PGlite, opts: {
  ligar: boolean; src?: string; createdBy?: string | null;
}): Promise<string> {
  const frame = `[1101_1_]{${opts.ligar ? "1" : "0"}}[1101_ETX_]`;
  const r = await db.query<any>(
    `INSERT INTO public.commands
       (farm_id, equipment_id, plc_hw_id, type, frame, source_device, created_by, status, sent_at)
     VALUES ($1,$2,'1101','manual',$3,$4,$5,'sent', now()) RETURNING id`,
    [ID.fazenda, ID.poco, frame, opts.src ?? "web", opts.createdBy ?? ID.yuri]);
  const id = r.rows[0].id as string;
  await db.query(
    `UPDATE public.equipments SET pending_command_id=$1, desired_running=$2 WHERE id=$3`,
    [id, opts.ligar, ID.poco]);
  return id;
}

/** Linhas que o ledger considera operacionais. */
export async function ledger(db: PGlite) {
  const r = await db.query<any>(`
    SELECT action::text AS acao, origin::text AS origem, actor_label,
           coalesce(source_device,'') AS produtor
      FROM public.automation_log
     WHERE noise_reason IS NULL
       AND action::text IN ('turn_on','turn_off','pump_on','pump_off')
     ORDER BY occurred_at, created_at`);
  return r.rows;
}

/** Tudo que foi gravado, inclusive técnico — para provar que nada se perdeu. */
export async function todasAsLinhas(db: PGlite) {
  const r = await db.query<any>(`
    SELECT action::text AS acao, coalesce(noise_reason,'(OPERACIONAL)') AS categoria,
           coalesce(source_device,'') AS produtor
      FROM public.automation_log ORDER BY created_at`);
  return r.rows;
}

export const resumo = (linhas: any[]) => linhas.map((l) => `${l.acao}/${l.origem}`);

/** A invariante de produção, rodando sobre o banco de teste. */
export async function violacoesDaInvariante(db: PGlite): Promise<number> {
  const r = await db.query<any>(`
    WITH fluxo AS (
      SELECT equipment_id,
             CASE WHEN action IN ('turn_on','pump_on') THEN 1 ELSE 0 END AS est,
             lag(CASE WHEN action IN ('turn_on','pump_on') THEN 1 ELSE 0 END)
               OVER (PARTITION BY equipment_id ORDER BY occurred_at, created_at) AS ant
        FROM public.automation_log
       WHERE noise_reason IS NULL
         AND action IN ('turn_on','turn_off','pump_on','pump_off'))
    SELECT count(*)::int AS n FROM fluxo WHERE ant IS NOT NULL AND est = ant`);
  return r.rows[0].n;
}
