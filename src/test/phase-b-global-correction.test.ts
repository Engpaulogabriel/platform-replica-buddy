// @vitest-environment node
// FASE B — a correção precisa realmente limpar o histórico, nunca inventar
// pessoa, nunca apagar dado bruto, e o aceite global tem que fechar em ZERO.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs"; import path from "node:path";
const REPO = path.resolve(__dirname, "../..");
const mig = (f: string) => fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");

const F1="aaaa1111-0000-0000-0000-000000000001", F2="aaaa2222-0000-0000-0000-000000000002";
const E1="bbbb1111-0000-0000-0000-000000000001", E2="bbbb2222-0000-0000-0000-000000000002";
const UA="cccc0000-0000-0000-0000-00000000000a", ADMIN="eeee0000-0000-0000-0000-00000000000e";

const BOOT=`
CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT NULL::uuid $fn$;
CREATE TYPE public.event_action AS ENUM ('turn_on','turn_off','status_read','mode_change','reset','polling','pump_on','pump_off');
CREATE TYPE public.event_origin AS ENUM ('remote','local','auto','reading','system');
CREATE TYPE public.event_result AS ENUM ('success','fail','pending','timeout');
CREATE TABLE public.farms (id uuid PRIMARY KEY, name text NOT NULL);
CREATE TABLE public.profiles (id uuid PRIMARY KEY, email text, full_name text);
CREATE TABLE public.equipments (id uuid PRIMARY KEY, farm_id uuid, name text, active boolean DEFAULT true);
CREATE TABLE public.commands (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, equipment_id uuid,
  created_by uuid, created_at timestamptz DEFAULT now());
CREATE TABLE public.scheduled_automations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
CREATE TABLE public.agent_technical_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid,
  equipment_id uuid, kind text, occurred_at timestamptz, details jsonb DEFAULT '{}'::jsonb);
CREATE TABLE public.automation_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, equipment_id uuid,
  equipment_name text, action public.event_action, origin public.event_origin, result public.event_result DEFAULT 'success',
  actor_label text, user_id uuid, user_email text, details jsonb DEFAULT '{}'::jsonb,
  noise_reason text, occurred_at timestamptz, created_at timestamptz DEFAULT now());
CREATE TABLE public.command_audit (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), command_id uuid UNIQUE,
  farm_id uuid, equipment_id uuid, user_id uuid, user_email text, actor_label text,
  origin_kind text, intent text, command_created_at timestamptz, responded_at timestamptz, status_final text);
CREATE TABLE public.authorship_pending_review (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid,
  automation_log_id uuid UNIQUE, resolved_at timestamptz, resolved_by uuid);
CREATE TABLE public.authorship_reconciliation_batches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid, resolved_at timestamptz);
CREATE TABLE public.remote_reconciliation_queue (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid, automation_log_id uuid, applied_at timestamptz);
CREATE TABLE public.platform_admins (user_id uuid PRIMARY KEY);
CREATE FUNCTION public.is_platform_admin(_u uuid) RETURNS boolean LANGUAGE sql STABLE AS
  $fn$ SELECT EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id=_u) $fn$;
CREATE FUNCTION public.is_platform_staff(_u uuid) RETURNS boolean LANGUAGE sql STABLE AS
  $fn$ SELECT public.is_platform_admin(_u) $fn$;
CREATE FUNCTION public.is_technical_actor_label(_l text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $fn$
  SELECT lower(btrim(COALESCE(_l,''))) ~ '^(telemetria|telemetria rf|rf|agent|agente|serial|serial-bridge|bridge|system|sistema|cloud|auto-trigger|comando remoto|remoto|remote|unknown)([ -].*)?$' $fn$;
CREATE FUNCTION public.parse_user_uuid(_t text) RETURNS uuid LANGUAGE plpgsql IMMUTABLE AS $fn$
  BEGIN RETURN _t::uuid; EXCEPTION WHEN OTHERS THEN RETURN NULL; END $fn$;
INSERT INTO public.farms VALUES ('${F1}','Fazenda Um'),('${F2}','Fazenda Dois');
INSERT INTO public.profiles VALUES ('${UA}','yuri@ex.com','Yuri Seibert'),('${ADMIN}','ad@ex.com','Admin Renov');
INSERT INTO public.platform_admins VALUES ('${ADMIN}');
INSERT INTO public.equipments VALUES ('${E1}','${F1}','POÇO 12 R6',true),('${E2}','${F2}','POÇO 02 R2',true);`;

async function mk(){ const d=await PGlite.create(); await d.exec(BOOT);
  await d.exec(mig("20260814220000_report_global_inventory.sql"));
  await d.exec(mig("20260814221000_automation_report_global_cleanup.sql"));
  await d.exec(mig("20260814221100_automation_report_origin_authorship_finalization.sql"));
  await d.exec(mig("20260814221200_automation_report_future_guard.sql"));
  return d; }

/**
 * Insere uma linha. Por padrão simula HISTÓRICO LEGADO: desfaz a marca que o
 * guarda futuro aplica no INSERT, porque o passado entrou antes da trava
 * existir — é exatamente esse passado que a Fase B precisa corrigir.
 * `raw:true` mantém a decisão do guarda (usado para testá-lo).
 */
async function add(d:PGlite,o:any): Promise<string>{
  const r = await d.query<any>(`INSERT INTO public.automation_log
    (farm_id,equipment_id,equipment_name,action,origin,result,actor_label,user_id,user_email,details,noise_reason,occurred_at)
    VALUES ($1,$2,$3,$4::public.event_action,$5::public.event_origin,$6::public.event_result,$7,$8,$9,$10::jsonb,$11,$12::timestamptz)
    RETURNING id`,
    [o.farm??F1,o.equip??E1,'BOMBA',o.action??'turn_on',o.origin,o.result??'success',o.actor??null,
     o.user??null,o.email??null,JSON.stringify(o.details??{}),o.noise??null,o.at??'2026-08-14T14:53:00-03:00']);
  const id = r.rows[0].id;
  if (!o.raw) await d.query(`UPDATE public.automation_log SET noise_reason=$2 WHERE id=$1`,
                            [id, o.noise ?? null]);
  return id;
}
const cmdAudit = (d:PGlite,o:any) => d.query(`INSERT INTO public.command_audit
  (command_id,farm_id,equipment_id,user_id,user_email,actor_label,intent,command_created_at)
  VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7::timestamptz)`,
  [o.farm??F1,o.equip??E1,o.user??null,o.email??null,o.actor??null,o.intent,o.at]);

const cleanup = (d:PGlite) => d.query<any>(`SELECT * FROM public.run_phase_b_cleanup()`);
const finalize = (d:PGlite) => d.query<any>(`SELECT * FROM public.finalize_origin_and_authorship(gen_random_uuid())`);
const aceite = async (d:PGlite) => (await d.query<any>(`SELECT * FROM public.phase_b_acceptance()`)).rows;
const oficiais = async (d:PGlite) => (await d.query<any>(
  `SELECT * FROM public.automation_log WHERE noise_reason IS NULL ORDER BY occurred_at`)).rows;

let d:PGlite; beforeEach(async()=>{ d=await mk(); });

describe("B.1 — limpeza com trilha, sem apagar nada", () => {
  it("categoria F sai do oficial mas a linha continua existindo", async () => {
    const id = await add(d,{origin:'remote',action:'status_read',actor:'Yuri Seibert',user:UA,email:'yuri@ex.com'});
    await cleanup(d);
    const row = (await d.query<any>(`SELECT * FROM public.automation_log WHERE id=$1`,[id])).rows[0];
    expect(row).toBeDefined();                                  // NÃO foi apagada
    expect(row.noise_reason).toBe('technical_not_a_transition');
    expect(row.user_email).toBe('yuri@ex.com');                 // dado preservado
  });

  it("grava trilha com antes, depois, razão e executor", async () => {
    await add(d,{origin:'reading'});
    await cleanup(d);
    const a=(await d.query<any>(`SELECT * FROM public.automation_cleanup_audit`)).rows[0];
    expect(a.action).toBe('noise_marked');
    expect(a.before_value.noise_reason).toBeNull();
    expect(a.after_value.noise_reason).toBe('technical_not_a_transition');
    expect(a.executed_by).toBe('cleanup_technical_events');
    expect(a.reason).toBeTruthy();
  });

  it("a trilha é append-only: UPDATE e DELETE são recusados", async () => {
    await add(d,{origin:'reading'}); await cleanup(d);
    await expect(d.query(`UPDATE public.automation_cleanup_audit SET reason='x'`)).rejects.toThrow(/append-only/);
    await expect(d.query(`DELETE FROM public.automation_cleanup_audit`)).rejects.toThrow(/append-only/);
  });

  it("'Desligada | Falhou' (POÇO 02 R2) sai do oficial preservando o usuário", async () => {
    const id = await add(d,{farm:F2,equip:E2,action:'turn_off',origin:'remote',result:'fail',
      actor:'Yuri Seibert',user:UA,email:'yuri@ex.com',details:{command_id:'c-1'}});
    await cleanup(d);
    const row=(await d.query<any>(`SELECT * FROM public.automation_log WHERE id=$1`,[id])).rows[0];
    expect(row.noise_reason).toBe('command_not_confirmed');
    expect(row.user_email).toBe('yuri@ex.com');
    expect(row.details.command_id).toBe('c-1');
  });

  it("duplicidade: some a 2ª, fica a 1ª", async () => {
    const a=await add(d,{origin:'local',actor:'Acionamento local',at:'2026-08-14T14:53:00-03:00'});
    const b=await add(d,{origin:'local',actor:'Acionamento local',at:'2026-08-14T14:54:00-03:00'});
    await cleanup(d);
    const rows=(await d.query<any>(`SELECT id,noise_reason FROM public.automation_log`)).rows;
    expect(rows.find(r=>r.id===a).noise_reason).toBeNull();
    expect(rows.find(r=>r.id===b).noise_reason).toBe('duplicate_same_target_state');
  });

  it("NÃO apaga atuação local real que teve transição física intermediária", async () => {
    await add(d,{origin:'local',actor:'Acionamento local',at:'2026-08-14T14:53:00-03:00'});
    const b=await add(d,{origin:'local',actor:'Acionamento local',at:'2026-08-14T14:55:00-03:00'});
    // telemetria física provando que desligou no meio
    await d.query(`INSERT INTO public.agent_technical_events (farm_id,equipment_id,kind,occurred_at,details)
      VALUES ($1,$2,'state','2026-08-14T14:54:00-03:00','{"state":0}'::jsonb)`,[F1,E1]);
    await cleanup(d);
    const row=(await d.query<any>(`SELECT noise_reason FROM public.automation_log WHERE id=$1`,[b])).rows[0];
    expect(row.noise_reason).toBeNull();     // preservada: houve transição real
  });

  it("é idempotente — rodar duas vezes não duplica trilha nem muda contagem", async () => {
    await add(d,{origin:'reading'});
    const r1=(await cleanup(d)).rows[0];
    const r2=(await cleanup(d)).rows[0];
    expect(Number(r1.tecnicos)).toBe(1);
    expect(Number(r2.tecnicos)).toBe(0);
    expect((await d.query<any>(`SELECT count(*) n FROM public.automation_cleanup_audit`)).rows[0].n).toBe(1);
  });

  it("rollback devolve as linhas ao oficial", async () => {
    await add(d,{origin:'reading'});
    const run=(await cleanup(d)).rows[0].run_id;
    await d.query(`SELECT public.rollback_cleanup_run($1)`,[run]);
    expect((await d.query<any>(
      `SELECT noise_reason FROM public.automation_log`)).rows[0].noise_reason).toBeNull();
  });
});

describe("B.2 — origem e autoria por evidência", () => {
  it("origin='system' com command_audit vira Remoto + pessoa REAL", async () => {
    const id=await add(d,{origin:'system',actor:'Sistema'});
    await cmdAudit(d,{user:UA,email:'yuri@ex.com',actor:'Yuri Seibert',intent:'turn_on',
                      at:'2026-08-14T14:53:10-03:00'});
    await finalize(d);
    const r=(await d.query<any>(`SELECT * FROM public.automation_log WHERE id=$1`,[id])).rows[0];
    expect(r.origin).toBe('remote');
    expect(r.user_email).toBe('yuri@ex.com');
    expect(r.actor_label).toBe('Yuri Seibert');
    expect(r.details.authorship_source).toBe('command_audit');
    expect(r.noise_reason).toBeNull();       // continua oficial
  });

  it("rótulo técnico 'Telemetria RF' é substituído por pessoa provada", async () => {
    const id=await add(d,{origin:'remote',actor:'Telemetria RF',user:UA,email:'yuri@ex.com'});
    await cmdAudit(d,{user:UA,email:'yuri@ex.com',actor:'Yuri Seibert',intent:'turn_on',
                      at:'2026-08-14T14:53:05-03:00'});
    await finalize(d);
    const r=(await d.query<any>(`SELECT actor_label FROM public.automation_log WHERE id=$1`,[id])).rows[0];
    expect(r.actor_label).toBe('Yuri Seibert');
  });

  it("SEM prova: sai do oficial e vai para a fila — não inventa ninguém", async () => {
    const id=await add(d,{origin:'system',actor:'Sistema'});
    const out=(await finalize(d)).rows[0];
    expect(Number(out.enfileirados)).toBe(1);
    const r=(await d.query<any>(`SELECT * FROM public.automation_log WHERE id=$1`,[id])).rows[0];
    expect(r.noise_reason).toBe('pending_authorship_review');
    expect(r.user_id).toBeNull();            // NINGUÉM foi inventado
    expect((await d.query<any>(
      `SELECT count(*) n FROM public.authorship_pending_review`)).rows[0].n).toBe(1);
  });

  it("Local com comando remoto compatível é promovido a Remoto com a pessoa certa", async () => {
    const id=await add(d,{origin:'local',actor:'Acionamento local'});
    await cmdAudit(d,{user:UA,email:'yuri@ex.com',actor:'Yuri Seibert',intent:'turn_on',
                      at:'2026-08-14T14:53:20-03:00'});
    await finalize(d);
    const r=(await d.query<any>(`SELECT origin,actor_label FROM public.automation_log WHERE id=$1`,[id])).rows[0];
    expect(r.origin).toBe('remote');
    expect(r.actor_label).toBe('Yuri Seibert');
  });

  it("Local verdadeiro (sem comando algum) NÃO é reclassificado", async () => {
    const id=await add(d,{origin:'local',actor:'Acionamento local'});
    await finalize(d);
    const r=(await d.query<any>(`SELECT origin,actor_label,noise_reason FROM public.automation_log WHERE id=$1`,[id])).rows[0];
    expect(r.origin).toBe('local');
    expect(r.actor_label).toBe('Acionamento local');
    expect(r.noise_reason).toBeNull();
  });

  it("confirmação em lote exige platform_admin, pessoa existente e contagem travada", async () => {
    const id=await add(d,{origin:'system',actor:'Sistema'});
    await finalize(d);
    const b=(await d.query<any>(`INSERT INTO public.authorship_reconciliation_batches (farm_id)
      VALUES ($1) RETURNING id`,[F1])).rows[0].id;
    await d.query(`INSERT INTO public.remote_reconciliation_queue (batch_id,automation_log_id) VALUES ($1,$2)`,[b,id]);

    // não-admin é recusado
    await expect(d.query(`SELECT * FROM public.confirm_authorship_batch($1,$2,$3,1)`,[b,UA,UA]))
      .rejects.toThrow(/platform_admin/);
    // contagem errada aborta
    await expect(d.query(`SELECT * FROM public.confirm_authorship_batch($1,$2,$3,99)`,[b,UA,ADMIN]))
      .rejects.toThrow(/lote mudou/);
    // pessoa inexistente é recusada
    await expect(d.query(`SELECT * FROM public.confirm_authorship_batch($1,$2,$3,1)`,
      [b,'00000000-0000-0000-0000-000000000000',ADMIN])).rejects.toThrow(/não se inventa pessoa/);

    // correto: volta ao oficial com autoria auditável
    await d.query(`SELECT * FROM public.confirm_authorship_batch($1,$2,$3,1)`,[b,UA,ADMIN]);
    const r=(await d.query<any>(`SELECT * FROM public.automation_log WHERE id=$1`,[id])).rows[0];
    expect(r.noise_reason).toBeNull();
    expect(r.origin).toBe('remote');
    expect(r.actor_label).toBe('Yuri Seibert');
    expect(r.details.authorship_source).toBe('admin_decision');
  });
});

describe("B.3 — trava futura", () => {
  const guardado = async (o:any) => {
    const id=await add(d,{...o, raw:true});
    return (await d.query<any>(`SELECT noise_reason FROM public.automation_log WHERE id=$1`,[id])).rows[0].noise_reason;
  };
  it("polling/status_read novo já nasce fora do oficial", async () =>
    expect(await guardado({origin:'remote',action:'polling',actor:'X',user:UA,email:'e'}))
      .toBe('technical_not_a_transition'));
  it("origin='reading' novo já nasce fora", async () =>
    expect(await guardado({origin:'reading'})).toBe('technical_not_a_transition'));
  it("falha sem state_confirmed já nasce fora", async () =>
    expect(await guardado({origin:'remote',result:'fail',actor:'Y',user:UA,email:'e'}))
      .toBe('command_not_confirmed'));
  it("origin='system' novo já nasce fora", async () =>
    expect(await guardado({origin:'system',actor:'Y',user:UA,email:'e'}))
      .toBe('pending_authorship_review'));
  it("rótulo técnico novo já nasce fora", async () =>
    expect(await guardado({origin:'remote',actor:'Telemetria RF',user:UA,email:'e'}))
      .toBe('pending_authorship_review'));
  it("remoto sem usuário já nasce fora", async () =>
    expect(await guardado({origin:'remote',actor:'Fulano'})).toBe('pending_authorship_review'));
  it("automação sem regra já nasce fora", async () =>
    expect(await guardado({origin:'auto',action:'turn_off'})).toBe('pending_authorship_review'));
  it("evento LEGÍTIMO continua entrando normalmente", async () =>
    expect(await guardado({origin:'remote',actor:'Yuri Seibert',user:UA,email:'yuri@ex.com'})).toBeNull());
  it("automação COM regra continua entrando", async () =>
    expect(await guardado({origin:'auto',action:'turn_off',actor:'Desligamento 17h'})).toBeNull());
});

describe("B.4 — aceite global fecha em ZERO", () => {
  it("base suja: reprova; depois da Fase B: tudo PASSOU", async () => {
    // um exemplar de cada problema, nas duas fazendas
    await add(d,{origin:'reading',noise:null});
    await add(d,{origin:'remote',action:'status_read',actor:'Y',user:UA,email:'e',at:'2026-08-14T14:54:00-03:00'});
    await add(d,{origin:'system',actor:'Sistema',at:'2026-08-14T14:55:00-03:00'});
    await add(d,{farm:F2,equip:E2,origin:'remote',actor:'Telemetria RF',user:UA,email:'e',at:'2026-08-14T14:56:00-03:00'});
    await add(d,{farm:F2,equip:E2,origin:'remote',result:'timeout',actor:'Z',user:UA,email:'e',at:'2026-08-14T14:57:00-03:00'});
    await add(d,{farm:F2,equip:E2,origin:'auto',action:'turn_off',at:'2026-08-14T14:58:00-03:00'});

    expect((await aceite(d)).some(r=>r.situacao==='REPROVADO')).toBe(true);

    await cleanup(d); await finalize(d);
    const a=await aceite(d);
    for (const r of a) expect(r.situacao, `${r.criterio}: ${r.violacoes} (${r.fazendas})`).toBe('PASSOU');
  });

  it("nenhum texto proibido sobra em linha oficial", async () => {
    for (const l of ['Origem em apuração','Autoria histórica em revisão','Sistema',
                     'Comando Remoto','Telemetria RF','RF','Bridge','Serial']) {
      await add(d,{origin:'remote',actor:l,user:UA,email:'e',at:'2026-08-14T14:53:00-03:00'});
    }
    await cleanup(d); await finalize(d);
    const t=(await aceite(d)).find(r=>r.criterio.startsWith('8.'));
    expect(t.situacao).toBe('PASSOU');
  });

  it("relatório de impacto conta por fazenda", async () => {
    await add(d,{origin:'reading'});
    await add(d,{origin:'remote',actor:'Yuri Seibert',user:UA,email:'yuri@ex.com',at:'2026-08-14T14:54:00-03:00'});
    await cleanup(d);
    const r=(await d.query<any>(`SELECT * FROM public.phase_b_impact_report()`)).rows;
    const f1=r.find((x:any)=>x.fazenda==='Fazenda Um');
    expect(Number(f1.ruido_tecnico)).toBe(1);
    expect(Number(f1.total_final)).toBe(1);
    expect(r.map((x:any)=>x.fazenda).sort()).toEqual(['Fazenda Dois','Fazenda Um']);
  });
});
