// @vitest-environment node
// Recuperação de autoria em LOTE: descobrir, decidir e GRAVAR o nome real.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs"; import path from "node:path";
const REPO = path.resolve(__dirname, "../..");
const mig = (f: string) => fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");
const F1="aaaa1111-0000-0000-0000-000000000001", F2="aaaa2222-0000-0000-0000-000000000002";
const E1="bbbb1111-0000-0000-0000-000000000001";
const UA="cccc0000-0000-0000-0000-00000000000a", UB="cccc0000-0000-0000-0000-00000000000b";
const ADMIN="eeee0000-0000-0000-0000-00000000000e";
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
-- trilha legada genérica: o catálogo dinâmico deve encontrá-la sozinho
CREATE TABLE public.device_audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid,
  user_id uuid, action text, created_at timestamptz DEFAULT now());
CREATE FUNCTION public.has_farm_access(uuid, uuid) RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT true $fn$;
INSERT INTO public.farms VALUES ('${F1}','Fazenda Um'),('${F2}','Fazenda Dois');
INSERT INTO public.profiles VALUES ('${UA}','a@ex.com','Pessoa A'),('${UB}','b@ex.com','Pessoa B'),('${ADMIN}','ad@ex.com','Admin');
INSERT INTO public.equipments VALUES ('${E1}','${F1}','BOMBA 1',NULL,NULL,0);`;

async function db0(){ const d=await PGlite.create(); await d.exec(BOOT);
  await d.exec(mig("20260814202000_remote_authorship_recovery.sql")); return d; }
async function ev(d:PGlite,o:{farm?:string;user?:string|null;at:string;on?:boolean;details?:any;name?:string}){
  const r=await d.query<any>(`INSERT INTO public.automation_log
    (farm_id,equipment_id,equipment_name,action,origin,user_id,details,occurred_at)
    VALUES ($1,$2,$3,$4::public.event_action,'remote',$5,$6::jsonb,$7::timestamptz) RETURNING id`,
    [o.farm??F1,E1,o.name??"BOMBA 1",(o.on??true)?"turn_on":"turn_off",o.user??null,
     JSON.stringify(o.details??{}),o.at]);
  if(!o.user) await d.query(`INSERT INTO public.authorship_pending_review (farm_id,automation_log_id) VALUES ($1,$2)`,[o.farm??F1,r.rows[0].id]);
  return r.rows[0].id as string; }
const T=(m:number,s=0)=>`2026-08-11T21:${String(19+m).padStart(2,"0")}:${String(s).padStart(2,"0")}-03:00`;

let d:PGlite; beforeEach(async()=>{ d=await db0(); });

describe("descoberta de fontes e candidatos", () => {
  it("catálogo encontra trilhas legadas sozinho (sem lista fixa)", async () => {
    const r=await d.query<any>(`SELECT tabela FROM public.authorship_source_catalog()`);
    const t=r.rows.map((x:any)=>x.tabela);
    expect(t).toContain("device_audit_log");   // descoberta dinâmica
    expect(t).toContain("commands");
    expect(t).not.toContain("automation_log");
  });

  it("candidatos vêm de command_audit, commands, details e trilha temporal", async () => {
    const id=await ev(d,{at:T(0),details:{user_email:"a@ex.com"}});
    await d.query(`INSERT INTO public.device_audit_log (farm_id,user_id,action,created_at)
                   VALUES ($1,$2,'clicou',$3::timestamptz)`,[F1,UA,T(0,30)]);
    const c=await d.query<any>(`SELECT DISTINCT user_id, fonte FROM public.remote_event_authorship_candidates($1)`,[id]);
    const fontes=c.rows.map((x:any)=>x.fonte);
    expect(c.rows.every((x:any)=>x.user_id===UA)).toBe(true);
    expect(fontes).toContain("details_json");
    expect(fontes).toContain("device_audit_log");
  });
});

describe("decisão por lote", () => {
  it("lote com UMA pessoa já identificada → reconciliar o lote inteiro", async () => {
    await ev(d,{at:T(0),user:UA});
    await ev(d,{at:T(1)}); await ev(d,{at:T(2)});
    const r=await d.query<any>(`SELECT * FROM public.remote_authorship_decision($1)`,[F1]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].sem_nome).toBe(2);
    expect(r.rows[0].conflito).toBe(false);
    expect(r.rows[0].pessoa_candidata).toBe("Pessoa A");
    expect(r.rows[0].acao_proposta).toMatch(/RECONCILIAR lote inteiro/);
  });

  it("lote com DUAS pessoas → escolha administrativa, nunca automática", async () => {
    await ev(d,{at:T(0),user:UA}); await ev(d,{at:T(1),user:UB}); await ev(d,{at:T(2)});
    const r=await d.query<any>(`SELECT * FROM public.remote_authorship_decision($1)`,[F1]);
    expect(r.rows[0].conflito).toBe(true);
    expect(r.rows[0].acao_proposta).toMatch(/ESCOLHA ADMINISTRATIVA/);
  });

  it("eventos de outra fazenda não entram no lote", async () => {
    await ev(d,{at:T(0),user:UA}); await ev(d,{at:T(1)});
    await ev(d,{farm:F2,at:T(1)});
    const r=await d.query<any>(`SELECT fazenda, eventos FROM public.remote_authorship_decision()`);
    expect(r.rows.find((x:any)=>x.fazenda==="Fazenda Um").eventos).toBe(2);
    expect(r.rows.find((x:any)=>x.fazenda==="Fazenda Dois").eventos).toBe(1);
  });
});

describe("fila e aplicação em lote", () => {
  it("aplica o lote inteiro numa escolha só e fecha as pendências", async () => {
    await ev(d,{at:T(0),user:UA});
    const i1=await ev(d,{at:T(1)}); const i2=await ev(d,{at:T(2)});
    await d.query(`SELECT public.enqueue_remote_reconciliation($1)`,[F1]);
    const q=await d.query<any>(`SELECT id, suggested_user, events_unnamed FROM public.remote_reconciliation_queue`);
    expect(q.rows).toHaveLength(1);
    expect(q.rows[0].suggested_user).toBe(UA);

    const n=await d.query<any>(`SELECT public.apply_remote_reconciliation($1,$2,$3::uuid[],$4) n`,
      [q.rows[0].id, UA, [i1,i2], ADMIN]);
    expect(Number(n.rows[0].n)).toBe(2);
    const r=await d.query<any>(`SELECT user_id, actor_label, user_email,
      details->>'authorship_source' src, details->>'authorship_verified_by' by
      FROM public.automation_log WHERE id = ANY($1::uuid[])`,[[i1,i2]]);
    expect(r.rows.every((x:any)=>x.user_id===UA)).toBe(true);
    expect(r.rows.every((x:any)=>x.actor_label==="Pessoa A")).toBe(true);
    expect(r.rows.every((x:any)=>x.src==="batch_reconciliation")).toBe(true);
    expect(r.rows.every((x:any)=>x.by===ADMIN)).toBe(true);
    const p=await d.query<any>(`SELECT count(*)::int n FROM public.authorship_pending_review WHERE resolved_at IS NULL`);
    expect(Number(p.rows[0].n)).toBe(0);
  });

  it("aborta se o conjunto de ids mudou desde a conferência", async () => {
    await ev(d,{at:T(0),user:UA}); const i1=await ev(d,{at:T(1)}); const i2=await ev(d,{at:T(2)});
    await d.query(`SELECT public.enqueue_remote_reconciliation($1)`,[F1]);
    const q=await d.query<any>(`SELECT id FROM public.remote_reconciliation_queue`);
    await expect(d.query(`SELECT public.apply_remote_reconciliation($1,$2,$3::uuid[],$4)`,
      [q.rows[0].id, UA, [i1], ADMIN])).rejects.toThrow(/conjunto mudou/);
    const r=await d.query<any>(`SELECT count(*)::int n FROM public.automation_log WHERE user_id IS NULL`);
    expect(Number(r.rows[0].n)).toBe(2);   // nada alterado
  });

  it("anti-replay: lote aplicado não pode ser reaplicado", async () => {
    await ev(d,{at:T(0),user:UA}); const i1=await ev(d,{at:T(1)});
    await d.query(`SELECT public.enqueue_remote_reconciliation($1)`,[F1]);
    const q=await d.query<any>(`SELECT id FROM public.remote_reconciliation_queue`);
    await d.query(`SELECT public.apply_remote_reconciliation($1,$2,$3::uuid[],$4)`,[q.rows[0].id,UA,[i1],ADMIN]);
    await expect(d.query(`SELECT public.apply_remote_reconciliation($1,$2,$3::uuid[],$4)`,
      [q.rows[0].id,UA,[i1],ADMIN])).rejects.toThrow(/já applied/);
  });

  it("nunca toca evento local, automação ou outra fazenda", async () => {
    await ev(d,{at:T(0),user:UA}); const i1=await ev(d,{at:T(1)});
    await d.query(`INSERT INTO public.automation_log (farm_id,equipment_id,equipment_name,action,origin,occurred_at)
      VALUES ($1,$2,'BOMBA 1','turn_on','local',$3::timestamptz),($1,$2,'BOMBA 1','turn_off','auto',$3::timestamptz)`,
      [F1,E1,T(1,30)]);
    await d.query(`SELECT public.enqueue_remote_reconciliation($1)`,[F1]);
    const q=await d.query<any>(`SELECT id FROM public.remote_reconciliation_queue`);
    await d.query(`SELECT public.apply_remote_reconciliation($1,$2,$3::uuid[],$4)`,[q.rows[0].id,UA,[i1],ADMIN]);
    const r=await d.query<any>(`SELECT origin::text o, user_id FROM public.automation_log WHERE origin IN ('local','auto')`);
    expect(r.rows.every((x:any)=>x.user_id===null)).toBe(true);
  });

  it("grava o registro append-only do lote em authorship_reconciliation_batches", async () => {
    await ev(d,{at:T(0),user:UA}); const i1=await ev(d,{at:T(1)}); const i2=await ev(d,{at:T(2)});
    await d.query(`SELECT public.enqueue_remote_reconciliation($1)`,[F1]);
    const q=await d.query<any>(`SELECT id FROM public.remote_reconciliation_queue`);
    await d.query(`SELECT public.apply_remote_reconciliation($1,$2,$3::uuid[],$4,$5)`,
      [q.rows[0].id,UA,[i1,i2],ADMIN,'evidência de teste']);
    const b=await d.query<any>(`SELECT farm_id, events_total, applied_user, applied_email, applied_actor,
      applied_by, evidence, confidence, source FROM public.authorship_reconciliation_batches`);
    expect(b.rows).toHaveLength(1);
    expect(b.rows[0].events_total).toBe(2);
    expect(b.rows[0].applied_user).toBe(UA);
    expect(b.rows[0].applied_email).toBe("a@ex.com");
    expect(b.rows[0].applied_actor).toBe("Pessoa A");
    expect(b.rows[0].applied_by).toBe(ADMIN);
    expect(b.rows[0].evidence).toBe("evidência de teste");
    expect(b.rows[0].confidence).toBe("strong");
    expect(b.rows[0].source).toBe("batch_reconciliation");
  });

  it("tabelas e funções da fila existem (migration autocontida)", async () => {
    for (const t of ["remote_reconciliation_queue","authorship_reconciliation_batches"]) {
      const r=await d.query<any>(`SELECT to_regclass('public.'||$1) t`,[t]);
      expect(r.rows[0].t).not.toBeNull();
    }
    for (const f of ["remote_authorship_decision","enqueue_remote_reconciliation",
                     "apply_remote_reconciliation","remote_event_authorship_candidates",
                     "authorship_source_catalog"]) {
      const r=await d.query<any>(`SELECT count(*)::int n FROM pg_proc WHERE proname=$1`,[f]);
      expect(Number(r.rows[0].n)).toBeGreaterThan(0);
    }
    // RLS ligada: operador comum não escreve
    const rls=await d.query<any>(`SELECT relrowsecurity FROM pg_class WHERE relname='authorship_reconciliation_batches'`);
    expect(rls.rows[0].relrowsecurity).toBe(true);
    const pol=await d.query<any>(`SELECT count(*)::int n FROM pg_policies
      WHERE tablename='authorship_reconciliation_batches' AND cmd<>'SELECT'`);
    expect(Number(pol.rows[0].n)).toBe(0);   // só SELECT; escrita apenas via SECURITY DEFINER
  });

  it("executor é obrigatório e user_id precisa existir", async () => {
    await ev(d,{at:T(0),user:UA}); const i1=await ev(d,{at:T(1)});
    await d.query(`SELECT public.enqueue_remote_reconciliation($1)`,[F1]);
    const q=await d.query<any>(`SELECT id FROM public.remote_reconciliation_queue`);
    await expect(d.query(`SELECT public.apply_remote_reconciliation($1,$2,$3::uuid[],NULL)`,
      [q.rows[0].id,UA,[i1]])).rejects.toThrow(/executor obrigatório/);
    await expect(d.query(`SELECT public.apply_remote_reconciliation($1,$2,$3::uuid[],$4)`,
      [q.rows[0].id,"99999999-9999-9999-9999-999999999999",[i1],ADMIN])).rejects.toThrow(/não existe em profiles/);
  });
});
