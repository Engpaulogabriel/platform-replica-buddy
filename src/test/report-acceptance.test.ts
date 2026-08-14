// @vitest-environment node
// Critérios de aceite (Etapa D): o validador precisa REPROVAR quando há violação
// e PASSAR quando o histórico está limpo — em TODAS as fazendas.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs"; import path from "node:path";
const REPO = path.resolve(__dirname, "../..");
const mig = (f: string) => fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");
const F1="aaaa1111-0000-0000-0000-000000000001", F2="aaaa2222-0000-0000-0000-000000000002";
const E1="bbbb1111-0000-0000-0000-000000000001", E2="bbbb2222-0000-0000-0000-000000000002";
const UA="cccc0000-0000-0000-0000-00000000000a", ADMIN="eeee0000-0000-0000-0000-00000000000e";
const BOOT=`
CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE anon;
CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT NULL::uuid $fn$;
CREATE TYPE public.event_action AS ENUM ('turn_on','turn_off','status_read','mode_change','reset','polling','pump_on','pump_off');
CREATE TYPE public.event_origin AS ENUM ('remote','local','auto','reading','system');
CREATE TYPE public.event_result AS ENUM ('success','fail','pending','timeout');
CREATE TYPE public.command_type AS ENUM ('manual','polling','reset','automation');
CREATE TYPE public.command_status AS ENUM ('pending','sent','delivered','executed','timeout','error','cancelled');
CREATE TABLE public.farms (id uuid PRIMARY KEY, name text NOT NULL);
CREATE TABLE public.profiles (id uuid PRIMARY KEY, email text, full_name text);
CREATE TABLE public.whatsapp_operators (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, name text, phone text, user_id uuid);
CREATE TABLE public.equipments (id uuid PRIMARY KEY, farm_id uuid, name text, last_changed_by text,
  last_actuation_origin text, last_confirmed_state smallint DEFAULT 0);
CREATE TABLE public.commands (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, equipment_id uuid,
  type public.command_type DEFAULT 'manual', status public.command_status DEFAULT 'pending', frame text,
  source_device text, created_by uuid, client_event_id uuid, created_at timestamptz DEFAULT now(),
  sent_at timestamptz, responded_at timestamptz);
CREATE TABLE public.automation_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, equipment_id uuid,
  equipment_name text, action public.event_action, origin public.event_origin, result public.event_result DEFAULT 'success',
  actor_label text, user_id uuid, user_email text, source_device text, details jsonb DEFAULT '{}'::jsonb,
  client_event_id uuid, noise_reason text, occurred_at timestamptz, created_at timestamptz DEFAULT now());
CREATE TABLE public.authorship_pending_review (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid,
  automation_log_id uuid UNIQUE, resolved_at timestamptz, resolved_by uuid);
CREATE TABLE public.command_audit (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), command_id uuid UNIQUE,
  client_event_id uuid, farm_id uuid, equipment_id uuid, user_id uuid, user_email text, actor_label text,
  origin_kind text, intent text, command_created_at timestamptz);
CREATE FUNCTION public.has_farm_access(uuid, uuid) RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT true $fn$;
CREATE FUNCTION public.is_technical_actor_label(_l text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $fn$
  SELECT lower(btrim(COALESCE(_l,''))) ~ '^(telemetria|telemetria rf|rf|agent|agente|serial|serial-bridge|bridge|system|sistema|cloud|auto-trigger|comando remoto|remoto|remote|unknown)([ -].*)?$' $fn$;
INSERT INTO public.farms VALUES ('${F1}','Fazenda Um'),('${F2}','Fazenda Dois');
INSERT INTO public.profiles VALUES ('${UA}','a@ex.com','Pessoa A'),('${ADMIN}','ad@ex.com','Admin');
INSERT INTO public.equipments VALUES ('${E1}','${F1}','BOMBA 1',NULL,NULL,0),('${E2}','${F2}','BOMBA 2',NULL,NULL,0);`;

async function mk(){ const d=await PGlite.create(); await d.exec(BOOT);
  await d.exec(mig("20260814202000_remote_authorship_recovery.sql"));
  await d.exec(mig("20260814203000_report_audit_and_acceptance.sql"));
  await d.exec(mig("20260814203100_fix_acceptance_and_audit.sql")); return d; }
async function add(d:PGlite,o:any){
  await d.query(`INSERT INTO public.automation_log
    (farm_id,equipment_id,equipment_name,action,origin,result,actor_label,user_id,user_email,details,noise_reason,occurred_at)
    VALUES ($1,$2,$3,$4::public.event_action,$5::public.event_origin,$6::public.event_result,$7,$8,$9,$10::jsonb,$11,$12::timestamptz)`,
    [o.farm??F1,o.equip??E1,'BOMBA',o.action??'turn_on',o.origin,o.result??'success',o.actor??null,
     o.user??null,o.email??null,JSON.stringify(o.details??{}),o.noise??null,o.at??'2026-08-11T21:19:00-03:00']);}
const acc = async (d:PGlite,farm?:string) => (await d.query<any>(
  farm?`SELECT * FROM public.automation_report_acceptance($1)`:`SELECT * FROM public.automation_report_acceptance()`,
  farm?[farm]:[])).rows;

let d:PGlite; beforeEach(async()=>{ d=await mk(); });

describe("Etapa D — critérios de aceite", () => {
  it("histórico limpo: TODOS os critérios PASSAM, nas duas fazendas", async () => {
    await add(d,{origin:'remote',user:UA,email:'a@ex.com',actor:'Pessoa A',details:{authorship_source:'command_audit'}});
    await add(d,{farm:F2,equip:E2,origin:'auto',actor:'Desligamento 17h',action:'turn_off'});
    await add(d,{farm:F2,equip:E2,origin:'local',actor:'Acionamento local',details:{origin:'local'},at:'2026-08-11T21:25:00-03:00'});
    const r = await acc(d);
    expect(r.every((x:any)=>x.situacao==='PASSOU')).toBe(true);
  });

  it("REPROVA remoto sem usuário", async () => {
    await add(d,{origin:'remote'});
    const r=(await acc(d)).find((x:any)=>x.criterio.startsWith('1.'));
    expect(r.situacao).toBe('REPROVADO'); expect(r.violacoes).toBe(1);
  });

  it("REPROVA rótulo técnico e rótulo provisório como usuário", async () => {
    await add(d,{origin:'remote',user:UA,email:'a@ex.com',actor:'Telemetria RF',details:{authorship_source:'x'}});
    await add(d,{origin:'remote',user:UA,email:'a@ex.com',actor:'Autoria histórica em revisão',
                 details:{authorship_source:'x'},at:'2026-08-11T21:30:00-03:00'});
    const r=await acc(d);
    expect(r.find((x:any)=>x.criterio.startsWith('2.')).situacao).toBe('REPROVADO');
    expect(r.find((x:any)=>x.criterio.startsWith('2b')).situacao).toBe('REPROVADO');
  });

  it("REPROVA técnico/polling e duplicidade sem transição física", async () => {
    await add(d,{origin:'reading'});
    await add(d,{origin:'local',actor:'Acionamento local',details:{origin:'local'},at:'2026-08-11T21:19:00-03:00'});
    await add(d,{origin:'local',actor:'Acionamento local',details:{origin:'local'},at:'2026-08-11T21:20:00-03:00'});
    const r=await acc(d);
    expect(r.find((x:any)=>x.criterio.startsWith('3.')).situacao).toBe('REPROVADO');
    expect(r.find((x:any)=>x.criterio.startsWith('4.')).situacao).toBe('REPROVADO');
  });

  it("REPROVA automação sem regra e remoto sem fonte auditável", async () => {
    await add(d,{origin:'auto',action:'turn_off'});
    await add(d,{origin:'remote',user:UA,email:'a@ex.com',actor:'Pessoa A',at:'2026-08-11T21:31:00-03:00'});
    const r=await acc(d);
    expect(r.find((x:any)=>x.criterio.startsWith('6.')).situacao).toBe('REPROVADO');
    expect(r.find((x:any)=>x.criterio.startsWith('5.')).situacao).toBe('REPROVADO');
  });

  it("valida por fazenda e globalmente — violação numa não some na outra", async () => {
    await add(d,{farm:F2,equip:E2,origin:'remote'});   // só a F2 viola
    expect((await acc(d,F1)).every((x:any)=>x.situacao==='PASSOU')).toBe(true);
    expect((await acc(d,F2)).find((x:any)=>x.criterio.startsWith('1.')).situacao).toBe('REPROVADO');
    expect((await acc(d)).find((x:any)=>x.criterio.startsWith('1.')).situacao).toBe('REPROVADO');
  });

  it("panorama por fazenda conta cada categoria", async () => {
    await add(d,{origin:'remote',user:UA,email:'a@ex.com',actor:'Pessoa A',details:{authorship_source:'command_audit'}});
    await add(d,{origin:'remote',at:'2026-08-11T21:32:00-03:00'});
    await add(d,{origin:'reading',noise:'reading_origin',at:'2026-08-11T21:33:00-03:00'});
    const r=(await d.query<any>(`SELECT * FROM public.automation_report_farm_audit()`)).rows;
    const f1=r.find((x:any)=>x.fazenda==='Fazenda Um');
    expect(f1.remotos_com_nome).toBe(1);
    expect(f1.remotos_sem_nome).toBe(1);
    expect(f1.tecnicos_ruido_excluido).toBe(1);
  });
});

describe("bugs corrigidos de 20260814203000", () => {
  it("cada critério aparece EXATAMENTE uma vez, mesmo com violações", async () => {
    // duplicidade real: dois ON seguidos no mesmo equipamento
    await add(d,{origin:'local',actor:'A',details:{origin:'local'},at:'2026-08-11T21:19:00-03:00'});
    await add(d,{origin:'local',actor:'A',details:{origin:'local'},at:'2026-08-11T21:20:00-03:00'});
    const r = await acc(d);
    const nomes = r.map((x:any)=>x.criterio);
    expect(new Set(nomes).size).toBe(nomes.length);          // zero duplicata
    expect(nomes).toHaveLength(8);                            // 8 critérios fixos
    const c4 = r.filter((x:any)=>x.criterio.startsWith('4.'));
    expect(c4).toHaveLength(1);                               // era 2 antes
    expect(c4[0].situacao).toBe('REPROVADO');
    expect(c4[0].violacoes).toBe(1);
  });

  it("critério sem violação aparece uma vez como PASSOU", async () => {
    const r = await acc(d);
    expect(r).toHaveLength(8);
    expect(r.every((x:any)=>x.situacao==='PASSOU' && x.violacoes===0)).toBe(true);
  });

  it("fazenda SEM eventos não inventa contagem (artefato de LEFT JOIN)", async () => {
    await add(d,{origin:'remote',user:UA,email:'a@ex.com',actor:'Pessoa A',details:{authorship_source:'command_audit'}});
    const r=(await d.query<any>(`SELECT * FROM public.automation_report_farm_audit()`)).rows;
    const vazia=r.find((x:any)=>x.fazenda==='Fazenda Dois');
    expect(vazia.eventos_oficiais).toBe(0);
    expect(vazia.transicoes_sem_prova).toBe(0);   // era 1 antes
    expect(vazia.locais).toBe(0);
    expect(vazia.remotos_sem_nome).toBe(0);
  });
});

describe("Etapa B.2 — divisão de lote", () => {
  it("divide o lote e mantém as travas", async () => {
    const ids:string[]=[];
    for (let i=0;i<4;i++){
      const r=await d.query<any>(`INSERT INTO public.automation_log
        (farm_id,equipment_id,equipment_name,action,origin,occurred_at)
        VALUES ($1,$2,'BOMBA','turn_on','remote',$3::timestamptz) RETURNING id`,
        [F1,E1,`2026-08-11T21:2${i}:00-03:00`]); ids.push(r.rows[0].id); }
    await d.query(`SELECT public.enqueue_remote_reconciliation($1)`,[F1]);
    const q=await d.query<any>(`SELECT id, event_ids FROM public.remote_reconciliation_queue`);
    const novo=await d.query<any>(`SELECT public.split_reconciliation_batch($1,$2::uuid[],$3) id`,
      [q.rows[0].id,[ids[0],ids[1]],ADMIN]);
    const all=await d.query<any>(`SELECT events_total FROM public.remote_reconciliation_queue ORDER BY events_total`);
    expect(all.rows.map((x:any)=>x.events_total)).toEqual([2,2]);
    expect(novo.rows[0].id).toBeTruthy();
    // subconjunto inválido aborta
    await expect(d.query(`SELECT public.split_reconciliation_batch($1,$2::uuid[],$3)`,
      [q.rows[0].id,['99999999-9999-9999-9999-999999999999'],ADMIN])).rejects.toThrow(/não pertence/);
  });
});
