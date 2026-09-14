// @vitest-environment node
// Ausência de autoria NÃO é prova de atuação local. Evento com evidência de
// remoto e sem pessoa recuperável fica fora do oficial — nunca vira Local.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs"; import path from "node:path";
const REPO = path.resolve(__dirname, "../..");
const mig = (f: string) => fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");

const F="aaaa1111-0000-0000-0000-000000000001";
const E="bbbb1111-0000-0000-0000-000000000001";
const UA="cccc0000-0000-0000-0000-00000000000a";
const AUT="dddd0000-0000-0000-0000-00000000000d";

const BOOT=`
CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT NULL::uuid $fn$;
CREATE TYPE public.event_action AS ENUM ('turn_on','turn_off','status_read','mode_change','reset','polling','pump_on','pump_off');
CREATE TYPE public.event_origin AS ENUM ('remote','local','auto','reading','system','whatsapp');
CREATE TYPE public.event_result AS ENUM ('success','fail','pending','timeout');
CREATE TYPE public.command_type AS ENUM ('manual','polling','reset','automation','config');
CREATE TABLE public.farms (id uuid PRIMARY KEY, name text);
CREATE TABLE public.profiles (id uuid PRIMARY KEY, email text, full_name text);
CREATE TABLE public.equipments (id uuid PRIMARY KEY, farm_id uuid, name text, type text DEFAULT 'poco',
  saida int DEFAULT 1, active boolean DEFAULT true, last_outputs_state text,
  last_communication timestamptz DEFAULT now(), last_actuation_origin text, last_changed_by text);
CREATE TABLE public.commands (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, equipment_id uuid,
  type public.command_type DEFAULT 'manual', frame text, source_device text, created_by uuid,
  created_at timestamptz DEFAULT now());
CREATE TABLE public.command_audit (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), command_id uuid UNIQUE,
  farm_id uuid, equipment_id uuid, user_id uuid, user_email text, actor_label text,
  origin_kind text, intent text, command_created_at timestamptz);
CREATE TABLE public.scheduled_automations (id uuid PRIMARY KEY, farm_id uuid, name text, time_brt text,
  days_of_week text[], max_retries int DEFAULT 3, retry_interval_min int DEFAULT 5, is_active boolean DEFAULT true);
CREATE TABLE public.automation_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, equipment_id uuid,
  equipment_name text, action public.event_action, origin public.event_origin,
  result public.event_result DEFAULT 'success', actor_label text, user_id uuid, user_email text,
  new_state text, client_event_id uuid, source_device text, details jsonb DEFAULT '{}'::jsonb,
  noise_reason text, occurred_at timestamptz, created_at timestamptz DEFAULT now());
CREATE FUNCTION public.is_technical_actor_label(_l text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $fn$
  SELECT lower(btrim(COALESCE(_l,''))) ~ '^(telemetria( rf)?|rf|agent|serial|bridge|system|sistema)([ -].*)?$' $fn$;
INSERT INTO public.farms VALUES ('${F}','Semear');
INSERT INTO public.profiles VALUES ('${UA}','ana@ex.com','Ana Souza');
INSERT INTO public.equipments (id,farm_id,name,last_outputs_state) VALUES ('${E}','${F}','POÇO 10 R4','0');
INSERT INTO public.scheduled_automations VALUES ('${AUT}','${F}','Desligamento 17h Semear','17:00',
  ARRAY['sun','mon','tue','wed','thu','fri','sat'],3,5,true);`;

async function mk(){ const d=await PGlite.create(); await d.exec(BOOT);
  await d.exec(mig("20260820120000_canonical_physical_writer.sql"));
  await d.exec(mig("20260820120100_recover_hidden_transitions.sql")); return d; }

/** linha histórica escondida, inserida sem passar por trigger */
const escondido = (d:PGlite, o:any) =>
  d.query(`INSERT INTO public.automation_log
    (farm_id,equipment_id,equipment_name,action,origin,result,actor_label,details,noise_reason,occurred_at)
    VALUES ($1,$2,'POÇO 10 R4',$3::public.event_action,$4::public.event_origin,'success',
            $5,$6::jsonb,'pending_authorship_review',now()) RETURNING id`,
    [F,E,o.action??'turn_on',o.origin??'remote',o.actor??null,JSON.stringify(o.details??{})]);

const recuperar = (d:PGlite) => d.query<any>(`SELECT * FROM public.recover_hidden_transitions(48)`);
const linha = async (d:PGlite) => (await d.query<any>(
  `SELECT origin::text o, actor_label, user_id, noise_reason FROM public.automation_log LIMIT 1`)).rows[0];

let d:PGlite; beforeEach(async()=>{ d=await mk(); });

describe("evidência de remoto sem pessoa NÃO vira Local", () => {
  for (const marca of ['remote-cmd','remote-desired','remote']) {
    it(`details.origin=${marca} sem command_audit permanece fora do oficial`, async () => {
      await escondido(d,{origin:'remote', details:{origin:marca}});
      const r=(await recuperar(d)).rows[0];
      expect(Number(r.mantidos_privados)).toBe(1);
      expect(Number(r.local_real)).toBe(0);
      const l=await linha(d);
      expect(l.noise_reason).toBe('pending_authorship_review');  // segue privado
      expect(l.o).not.toBe('local');                             // NUNCA vira Local
    });
  }

  it("command_id em details, sem pessoa, também permanece fora", async () => {
    await escondido(d,{origin:'remote', details:{command_id:'11111111-2222-3333-4444-555555555555'}});
    const r=(await recuperar(d)).rows[0];
    expect(Number(r.mantidos_privados)).toBe(1);
    expect((await linha(d)).o).not.toBe('local');
  });

  it("comando compatível na janela, sem autoria, permanece fora", async () => {
    await d.query(`INSERT INTO public.commands (farm_id,equipment_id,type,created_at)
                   VALUES ($1,$2,'manual',now())`,[F,E]);
    await escondido(d,{origin:'system', details:{}});
    const r=(await recuperar(d)).rows[0];
    expect(Number(r.mantidos_privados)).toBe(1);
    expect((await linha(d)).o).not.toBe('local');
  });

  it("a decisão fica auditada como kept_technical_only", async () => {
    await escondido(d,{origin:'remote', details:{origin:'remote-cmd'}});
    await recuperar(d);
    const a=(await d.query<any>(
      `SELECT action, phase_a_category, reason FROM public.automation_cleanup_audit`)).rows[0];
    expect(a.action).toBe('kept_technical_only');
    expect(a.phase_a_category).toBe('REMOTE_NO_PERSON');
  });

  it("remote_without_person lista o que ficará privado, com a evidência", async () => {
    await escondido(d,{origin:'remote', details:{origin:'remote-desired'}});
    const l=(await d.query<any>(`SELECT * FROM public.remote_without_person(48)`)).rows;
    expect(l).toHaveLength(1);
    expect(l[0].evidencia).toMatch(/remote-desired|origin=remote/);
  });
});

describe("os três casos que DEVEM ser reclassificados", () => {
  it("command_audit com usuário → Remoto + nome real", async () => {
    await escondido(d,{origin:'remote', details:{origin:'remote-cmd'}});
    await d.query(`INSERT INTO public.command_audit
      (command_id,farm_id,equipment_id,user_id,user_email,actor_label,origin_kind,intent,command_created_at)
      VALUES (gen_random_uuid(),$1,$2,$3,'ana@ex.com','Ana Souza','panel','turn_on',now())`,[F,E,UA]);
    const r=(await recuperar(d)).rows[0];
    expect(Number(r.remoto)).toBe(1);
    expect(Number(r.mantidos_privados)).toBe(0);
    const l=await linha(d);
    expect(l.o).toBe('remote'); expect(l.actor_label).toBe('Ana Souza');
    expect(l.user_id).toBe(UA); expect(l.noise_reason).toBeNull();
  });

  it("automação comprovada → Automação + nome da regra", async () => {
    await d.query(`UPDATE public.equipments SET last_changed_by='Desligamento 17h Semear' WHERE id=$1`,[E]);
    await d.query(`INSERT INTO public.commands (farm_id,equipment_id,type,source_device)
                   VALUES ($1,$2,'reset','backend-reset:scheduled_shutdown_a1')`,[F,E]);
    await escondido(d,{action:'turn_off', origin:'system'});
    const r=(await recuperar(d)).rows[0];
    expect(Number(r.automacao)).toBe(1);
    const l=await linha(d);
    expect(l.o).toBe('auto'); expect(l.actor_label).toBe('Desligamento 17h Semear');
    expect(l.noise_reason).toBeNull();
  });

  it("TX espontâneo SEM comando e SEM marca remota → Local + Acionamento local", async () => {
    await escondido(d,{origin:'local', details:{actuation_origin:'local'}});
    const r=(await recuperar(d)).rows[0];
    expect(Number(r.local_real)).toBe(1);
    expect(Number(r.mantidos_privados)).toBe(0);
    const l=await linha(d);
    expect(l.o).toBe('local'); expect(l.actor_label).toBe('Acionamento local');
    expect(l.noise_reason).toBeNull();
  });
});

describe("reversibilidade", () => {
  it("rollback devolve a linha ao estado anterior", async () => {
    await escondido(d,{origin:'local', details:{actuation_origin:'local'}});
    const run=(await recuperar(d)).rows[0].run_id;
    expect((await linha(d)).noise_reason).toBeNull();
    await d.query(`SELECT public.rollback_recovery_run($1)`,[run]);
    expect((await linha(d)).noise_reason).toBe('pending_authorship_review');
  });

  it("rodar duas vezes não altera nada na segunda", async () => {
    await escondido(d,{origin:'local', details:{actuation_origin:'local'}});
    expect(Number((await recuperar(d)).rows[0].recuperados)).toBe(1);
    expect(Number((await recuperar(d)).rows[0].recuperados)).toBe(0);
  });
});
