// ─────────────────────────────────────────────────────────────────────────────
// Cadeia REAL de classificação do Relatório de Automação, em Postgres de verdade
// ─────────────────────────────────────────────────────────────────────────────
// Mesma lição do webhook: teste que procura string em arquivo prova presença de
// código, não comportamento. Aqui o Postgres é real (PGlite, engine 18.3 com
// plpgsql), os CORPOS das funções são extraídos dos arquivos de migration sem
// edição, e os gatilhos são armados com os nomes reais — o nome define a ordem
// de disparo entre gatilhos BEFORE INSERT, e a ordem importa.
//
// O que o teste exercita é o caminho inteiro:
//   UPDATE equipments.last_outputs_state
//     → trg_equipments_log_state_change → log_equipment_state_change()
//     → classify_physical_transition()
//     → INSERT automation_log → gatilhos BEFORE INSERT (enforce, guard, actor)
//   e então lê o que o relatório leria.

import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const MIG = "supabase/migrations";

/** Extrai o corpo de uma função pelo nome, do arquivo indicado, sem editar. */
export function funcaoDaMigration(arquivo: string, nome: string): string {
  const src = readFileSync(`${MIG}/${arquivo}`, "utf8");
  const marca = `CREATE OR REPLACE FUNCTION ${nome}`;
  const i = src.indexOf(marca);
  if (i < 0) throw new Error(`função ${nome} não encontrada em ${arquivo}`);
  // corpo termina no primeiro `$$;` (ou `$function$;`) após o início
  const fim = [src.indexOf("$$;", i), src.indexOf("$function$;", i)]
    .filter((x) => x > 0).sort((a, b) => a - b)[0];
  if (!fim) throw new Error(`fim da função ${nome} não encontrado`);
  const term = src.startsWith("$function$;", fim) ? "$function$;".length : "$$;".length;
  return src.slice(i, fim + term);
}

const SCHEMA = `
CREATE TYPE public.event_origin AS ENUM ('remote','local','auto','reading','system','whatsapp');
CREATE TYPE public.event_action AS ENUM ('turn_on','turn_off','pump_on','pump_off','status_read');
CREATE TYPE public.event_result AS ENUM ('success','fail','pending','timeout');
CREATE TYPE public.command_type AS ENUM ('manual','polling','config');

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, email text, full_name text);

CREATE TABLE public.equipments (
  id uuid PRIMARY KEY, farm_id uuid, name text, type text DEFAULT 'poco',
  saida smallint DEFAULT 1, hw_id text, plc_group_id uuid,
  last_outputs_state text, last_confirmed_state smallint,
  last_communication timestamptz, last_actuation_origin text,
  last_changed_by text, desired_running boolean);

CREATE TABLE public.commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, equipment_id uuid,
  client_event_id uuid, type public.command_type, frame text, status text DEFAULT 'pending',
  source_device text, created_by uuid, created_at timestamptz DEFAULT now(),
  sent_at timestamptz, responded_at timestamptz);

CREATE TABLE public.command_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), command_id uuid NOT NULL,
  client_event_id uuid, farm_id uuid NOT NULL, equipment_id uuid, equipment_name text,
  user_id uuid, user_email text, actor_label text, origin_kind text, intent text,
  frame text, source_device text, status_final text,
  command_created_at timestamptz, sent_at timestamptz, responded_at timestamptz,
  captured_at timestamptz NOT NULL DEFAULT now(), details jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT command_audit_command_uniq UNIQUE (command_id));

CREATE TABLE public.automation_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, equipment_id uuid,
  equipment_name text, occurred_at timestamptz DEFAULT now(),
  origin public.event_origin, action public.event_action, result public.event_result,
  new_state text, client_event_id uuid, source_device text,
  user_id uuid, user_email text, actor_label text, noise_reason text,
  details jsonb DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT now());

CREATE TABLE public.agent_technical_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, equipment_id uuid,
  equipment_name text, kind text, occurred_at timestamptz, details jsonb DEFAULT '{}'::jsonb);

CREATE TABLE public.automation_log_noise_stats (
  farm_id uuid, equipment_id uuid, day date, reason text, hits int DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (farm_id, equipment_id, day, reason));

CREATE TABLE public.scheduled_automations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, name text,
  is_active boolean DEFAULT true, time_brt text, days_of_week text[],
  max_retries int, retry_interval_min int);
`;

const GATILHOS = `
CREATE TRIGGER trg_equipments_log_state_change
AFTER UPDATE OF last_outputs_state ON public.equipments
FOR EACH ROW WHEN (OLD.last_outputs_state IS DISTINCT FROM NEW.last_outputs_state)
EXECUTE FUNCTION public.log_equipment_state_change();

CREATE TRIGGER trg_enforce_automation_log_state_change
BEFORE INSERT ON public.automation_log
FOR EACH ROW EXECUTE FUNCTION public.enforce_automation_log_state_change();

CREATE TRIGGER trg_set_automation_actor_label
BEFORE INSERT OR UPDATE OF user_id, user_email, origin, details, source_device, actor_label
ON public.automation_log
FOR EACH ROW EXECUTE FUNCTION public.set_automation_actor_label();

CREATE TRIGGER trg_z_guard_official_report
BEFORE INSERT ON public.automation_log
FOR EACH ROW EXECUTE FUNCTION public.guard_official_report_row();

CREATE TRIGGER trg_command_audit_on_finish
AFTER UPDATE OF status ON public.commands
FOR EACH ROW WHEN (NEW.status IN ('executed','timeout','error','cancelled','delivered'))
EXECUTE FUNCTION public.capture_command_audit();
`;

/** Sobe um Postgres com o schema mínimo e as funções REAIS das migrations. */
export async function bancoDaCadeia(): Promise<PGlite> {
  const db = await PGlite.create();
  await db.exec(SCHEMA);

  const CANONICO = "20260814200200_automation_log_canonical_truth.sql";
  const WRITER   = "20260820120000_canonical_physical_writer.sql";
  const AUDIT    = "20260814143900_ca012184-2640-4f8a-937d-c2bbef307bb8.sql";
  const ACTOR    = "20260728235505_1196ab33-5762-44f2-8fbe-3d3f02d30c4c.sql";

  // Estado VIGENTE em produção (antes da correção)
  for (const [arq, fn] of [
    [CANONICO, "public.is_technical_actor_label"],
    [CANONICO, "public.bump_automation_noise"],
    [CANONICO, "public.automation_attribution_rank"],
    [CANONICO, "public.enforce_automation_log_state_change"],
    [AUDIT,    "public.classify_command_origin_kind"],
    [AUDIT,    "public.capture_command_audit"],
    [ACTOR,    "public.set_automation_actor_label"],
    [WRITER,   "public.classify_physical_transition"],
    [WRITER,   "public.log_equipment_state_change"],
    [WRITER,   "public.guard_official_report_row"],
  ] as Array<[string, string]>) {
    await db.exec(funcaoDaMigration(arq, fn));
  }
  await db.exec(GATILHOS);
  return db;
}

/** Aplica a migration P0 inteira, como o banco faria. */
export async function aplicarCorrecaoP0(db: PGlite): Promise<void> {
  const sql = readFileSync(`${MIG}/20260922140000_report_authorship_p0.sql`, "utf8")
    // GRANT para papéis que não existem no banco de teste
    .replace(/^GRANT EXECUTE[^;]+;$/gm, "");
  await db.exec(sql);
}

export const UUID = {
  fazenda: "11111111-1111-1111-1111-111111111111",
  poco:    "22222222-2222-2222-2222-222222222222",
  yuri:    "33333333-3333-3333-3333-333333333333",
  admin:   "44444444-4444-4444-4444-444444444444",
};

/** Fazenda com um poço na saída 1, desligado e comunicando. */
export async function semear(db: PGlite, extra: Record<string, unknown> = {}) {
  await db.exec(`
    INSERT INTO public.profiles (id, email, full_name) VALUES
      ('${UUID.yuri}',  'yuri@renov.com',  'Yuri'),
      ('${UUID.admin}', 'admin@renov.com', 'Admin Renov');
    INSERT INTO public.equipments
      (id, farm_id, name, type, saida, last_outputs_state, last_confirmed_state,
       last_communication, last_actuation_origin, desired_running)
    VALUES ('${UUID.poco}', '${UUID.fazenda}', 'POÇO 15 R3', 'poco', 1,
            '000000', 0, now(), ${extra.origem ? `'${extra.origem}'` : "'remote-desired'"}, false);
  `);
}

/** A transição física: a telemetria grava o novo bitfield. */
export async function telemetria(db: PGlite, bits: string) {
  await db.query(
    `UPDATE public.equipments SET last_outputs_state = $1, last_communication = now()
      WHERE id = $2`, [bits, UUID.poco]);
}

/** O que o relatório leria (mesmo filtro da query do frontend). */
export async function linhasDoRelatorio(db: PGlite) {
  const r = await db.query<any>(`
    SELECT origin::text AS origin, action::text AS action, actor_label, user_id,
           details->>'authorship_source' AS fonte, noise_reason
      FROM public.automation_log
     WHERE action IN ('turn_on','turn_off','pump_on','pump_off')
       AND noise_reason IS NULL
     ORDER BY occurred_at, created_at`);
  return r.rows;
}
