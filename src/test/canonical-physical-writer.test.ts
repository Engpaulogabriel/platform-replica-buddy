// @vitest-environment node
// O writer físico classifica ANTES de gravar. Transição física real NUNCA vira
// ruído por falta de autoria — e nenhum texto técnico entra como pessoa.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs"; import path from "node:path";
const REPO = path.resolve(__dirname, "../..");
const mig = (f: string) => fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");

const F="aaaa1111-0000-0000-0000-000000000001";
const E="bbbb1111-0000-0000-0000-000000000001";
const UA="cccc0000-0000-0000-0000-00000000000a";
const UB="cccc0000-0000-0000-0000-00000000000b";
const UW="cccc0000-0000-0000-0000-00000000000c";
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
  SELECT lower(btrim(COALESCE(_l,''))) ~ '^(telemetria( rf)?|acionamento rf|rf|agent|agente|serial|bridge|system|sistema|cloud|comando remoto|remoto|unknown)([ -].*)?$' $fn$;
INSERT INTO public.farms VALUES ('${F}','Semear');
INSERT INTO public.profiles VALUES ('${UA}','ana@ex.com','Ana Souza'),('${UB}','bruno@ex.com','Bruno Lima'),('${UW}','paulo@ex.com','Paulo Gabriel');
INSERT INTO public.equipments (id,farm_id,name,last_outputs_state) VALUES ('${E}','${F}','POÇO 10 R4','0');
INSERT INTO public.scheduled_automations VALUES ('${AUT}','${F}','Desligamento 17h Semear','17:00',
  ARRAY['sun','mon','tue','wed','thu','fri','sat'],3,5,true);`;

async function mk(){
  const d=await PGlite.create(); await d.exec(BOOT);
  await d.exec(mig("20260820120000_canonical_physical_writer.sql"));
  await d.exec(`CREATE TRIGGER trg_log_state AFTER UPDATE OF last_outputs_state ON public.equipments
                FOR EACH ROW EXECUTE FUNCTION public.log_equipment_state_change();`);
  await d.exec(`CREATE TRIGGER trg_z_guard BEFORE INSERT ON public.automation_log
                FOR EACH ROW EXECUTE FUNCTION public.guard_official_report_row();`);
  return d;
}
/** a PLC confirma fisicamente */
const confirma = (d:PGlite, estado:string) =>
  d.query(`UPDATE public.equipments SET last_outputs_state=$1, last_communication=now() WHERE id=$2`,[estado,E]);
const cmdAudit = (d:PGlite,o:any) =>
  d.query(`INSERT INTO public.command_audit (command_id,farm_id,equipment_id,user_id,user_email,actor_label,origin_kind,intent,command_created_at)
           VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,now())`,
          [F,E,o.user,o.email,o.actor,o.kind??'panel',o.intent]);
const linhas = async (d:PGlite) => (await d.query<any>(
  `SELECT origin::text o, action::text a, actor_label, user_id, noise_reason,
          details->>'confirmation_method' cm
     FROM public.automation_log ORDER BY occurred_at, created_at`)).rows;
const oficiais = async (d:PGlite) => (await linhas(d)).filter((r:any)=>r.noise_reason===null);

let d:PGlite; beforeEach(async()=>{ d=await mk(); });

describe("1 a 3. comando com autoria real vira linha oficial", () => {
  it("1. Ana liga remoto → Ligado | Remoto | Ana Souza", async () => {
    await cmdAudit(d,{user:UA,email:'ana@ex.com',actor:'Ana Souza',intent:'turn_on'});
    await confirma(d,'1');
    const [r]=await oficiais(d);
    expect(r.a).toBe('turn_on'); expect(r.o).toBe('remote');
    expect(r.actor_label).toBe('Ana Souza'); expect(r.user_id).toBe(UA);
    expect(r.noise_reason).toBeNull();
  });

  it("2. Bruno desliga em seguida → Desligado | Remoto | Bruno Lima", async () => {
    await cmdAudit(d,{user:UA,email:'ana@ex.com',actor:'Ana Souza',intent:'turn_on'});
    await confirma(d,'1');
    await cmdAudit(d,{user:UB,email:'bruno@ex.com',actor:'Bruno Lima',intent:'turn_off'});
    await confirma(d,'0');
    const rs=await oficiais(d);
    expect(rs).toHaveLength(2);
    expect(rs[1].actor_label).toBe('Bruno Lima');
    expect(rs[0].actor_label).toBe('Ana Souza');   // autoria de Ana preservada
  });

  it("3. WhatsApp com operador vinculado → WhatsApp + nome real", async () => {
    await cmdAudit(d,{user:UW,email:'paulo@ex.com',actor:'Paulo Gabriel',kind:'whatsapp',intent:'turn_on'});
    await confirma(d,'1');
    const [r]=await oficiais(d);
    expect(r.o).toBe('whatsapp'); expect(r.actor_label).toBe('Paulo Gabriel');
  });
});

describe("4 a 6. automação e local", () => {
  it("4. automação programada → Automação + nome da regra", async () => {
    await d.query(`UPDATE public.equipments SET last_outputs_state='1', last_changed_by='Desligamento 17h Semear' WHERE id=$1`,[E]);
    await d.query(`INSERT INTO public.commands (farm_id,equipment_id,type,source_device)
                   VALUES ($1,$2,'reset','backend-reset:scheduled_shutdown_a1')`,[F,E]);
    await confirma(d,'0');
    const r=(await oficiais(d)).at(-1);
    expect(r.o).toBe('auto'); expect(r.actor_label).toBe('Desligamento 17h Semear');
    expect(r.noise_reason).toBeNull();
  });

  it("6. TX espontâneo sem comando → Local + Acionamento local", async () => {
    await confirma(d,'1');
    const [r]=await oficiais(d);
    expect(r.o).toBe('local'); expect(r.actor_label).toBe('Acionamento local');
    expect(r.noise_reason).toBeNull();
  });

  it("6b. Local logo depois de outra mudança continua entrando", async () => {
    await cmdAudit(d,{user:UA,email:'ana@ex.com',actor:'Ana Souza',intent:'turn_on'});
    await confirma(d,'1');
    await confirma(d,'0');   // ninguém comandou o desligamento
    const rs=await oficiais(d);
    expect(rs).toHaveLength(2);
    expect(rs[1].o).toBe('local');
    expect(rs[1].actor_label).toBe('Acionamento local');
  });
});

describe("7 e 8. o que NÃO pode virar linha oficial", () => {
  it("7. leitura repetida do mesmo estado não cria linha", async () => {
    await confirma(d,'1');
    await confirma(d,'1');
    await confirma(d,'1');
    expect(await oficiais(d)).toHaveLength(1);
  });

  it("7b. polling/status_read/eco inseridos direto ficam fora", async () => {
    for (const a of ['status_read','polling','mode_change']) {
      await d.query(`INSERT INTO public.automation_log (farm_id,equipment_id,equipment_name,action,origin,occurred_at)
                     VALUES ($1,$2,'P',$3::public.event_action,'remote',now())`,[F,E,a]);
    }
    expect(await oficiais(d)).toHaveLength(0);
  });

  it("8. falha/timeout sem confirmação física fica fora", async () => {
    for (const res of ['fail','timeout']) {
      await d.query(`INSERT INTO public.automation_log (farm_id,equipment_id,equipment_name,action,origin,result,actor_label,occurred_at)
                     VALUES ($1,$2,'P','turn_off','remote',$3::public.event_result,'Ana Souza',now())`,[F,E,res]);
    }
    expect(await oficiais(d)).toHaveLength(0);
  });
});

describe("9 e 12. o incidente não pode voltar", () => {
  it("9. NENHUMA transição física recebe pending_authorship_review", async () => {
    await cmdAudit(d,{user:UA,email:'ana@ex.com',actor:'Ana Souza',intent:'turn_on'});
    await confirma(d,'1');
    await confirma(d,'0');
    const todas=await linhas(d);
    for (const r of todas)
      expect(r.noise_reason, `${r.o}/${r.a} escondido`).not.toBe('pending_authorship_review');
  });

  it("9b. remoto SEM command_audit vira Local, nunca some", async () => {
    await confirma(d,'1');
    const [r]=await oficiais(d);
    expect(r.noise_reason).toBeNull();
    expect(r.o).toBe('local');
  });

  it("12. nenhum texto proibido no actor_label das linhas oficiais", async () => {
    await cmdAudit(d,{user:UA,email:'ana@ex.com',actor:'Ana Souza',intent:'turn_on'});
    await confirma(d,'1');
    await confirma(d,'0');
    const proibidos=/telemetria|acionamento rf|^rf$|bridge|serial|sistema|system|comando remoto|origem em apura|autoria hist/i;
    for (const r of await oficiais(d))
      expect(r.actor_label ?? '', `vazou: ${r.actor_label}`).not.toMatch(proibidos);
  });

  it("Telemetria RF fica SÓ em details.confirmation_method", async () => {
    await confirma(d,'1');
    const [r]=await oficiais(d);
    expect(r.cm).toBe('telemetria_rf');          // interno, para auditoria
    expect(r.actor_label).not.toMatch(/telemetria/i);
  });

  it("origin=system inserido direto é normalizado para Local, não escondido", async () => {
    await d.query(`INSERT INTO public.automation_log (farm_id,equipment_id,equipment_name,action,origin,result,occurred_at)
                   VALUES ($1,$2,'P','turn_on','system','success',now())`,[F,E]);
    const [r]=await oficiais(d);
    expect(r.noise_reason).toBeNull();
    expect(r.o).toBe('local');
    expect(r.actor_label).toBe('Acionamento local');
  });

  it("rótulo técnico é limpo mas a LINHA permanece oficial", async () => {
    await d.query(`INSERT INTO public.automation_log (farm_id,equipment_id,equipment_name,action,origin,result,actor_label,occurred_at)
                   VALUES ($1,$2,'P','turn_off','local','success','Telemetria RF',now())`,[F,E]);
    const [r]=await oficiais(d);
    expect(r.noise_reason).toBeNull();
    expect(r.actor_label).toBe('Acionamento local');
  });
});
