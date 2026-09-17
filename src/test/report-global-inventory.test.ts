// @vitest-environment node
// FASE A — o inventário global precisa ENCONTRAR cada categoria de problema
// (A a G) em QUALQUER fazenda, e o aceite global precisa REPROVAR enquanto
// houver uma única linha suja em qualquer lugar do histórico.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs"; import path from "node:path";
const REPO = path.resolve(__dirname, "../..");
const mig = (f: string) => fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");

const F1="aaaa1111-0000-0000-0000-000000000001", F2="aaaa2222-0000-0000-0000-000000000002";
const E1="bbbb1111-0000-0000-0000-000000000001", E2="bbbb2222-0000-0000-0000-000000000002";
const UA="cccc0000-0000-0000-0000-00000000000a";

const BOOT=`
CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE anon;
CREATE TYPE public.event_action AS ENUM ('turn_on','turn_off','status_read','mode_change','reset','polling','pump_on','pump_off');
CREATE TYPE public.event_origin AS ENUM ('remote','local','auto','reading','system');
CREATE TYPE public.event_result AS ENUM ('success','fail','pending','timeout');
CREATE TABLE public.farms (id uuid PRIMARY KEY, name text NOT NULL);
CREATE TABLE public.automation_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, equipment_id uuid,
  equipment_name text, action public.event_action, origin public.event_origin, result public.event_result DEFAULT 'success',
  actor_label text, user_id uuid, user_email text, details jsonb DEFAULT '{}'::jsonb,
  noise_reason text, occurred_at timestamptz, created_at timestamptz DEFAULT now());
CREATE TABLE public.command_audit (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), command_id uuid UNIQUE,
  farm_id uuid, equipment_id uuid, user_id uuid, user_email text, actor_label text,
  origin_kind text, intent text, command_created_at timestamptz);
CREATE FUNCTION public.is_technical_actor_label(_l text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $fn$
  SELECT lower(btrim(COALESCE(_l,''))) ~ '^(telemetria|telemetria rf|rf|agent|agente|serial|serial-bridge|bridge|system|sistema|cloud|auto-trigger|comando remoto|remoto|remote|unknown)([ -].*)?$' $fn$;
INSERT INTO public.farms VALUES ('${F1}','Fazenda Um'),('${F2}','Fazenda Dois');`;

async function mk(){ const d=await PGlite.create(); await d.exec(BOOT);
  await d.exec(mig("20260814220000_report_global_inventory.sql")); return d; }

async function add(d:PGlite,o:any){
  await d.query(`INSERT INTO public.automation_log
    (farm_id,equipment_id,equipment_name,action,origin,result,actor_label,user_id,user_email,details,noise_reason,occurred_at)
    VALUES ($1,$2,$3,$4::public.event_action,$5::public.event_origin,$6::public.event_result,$7,$8,$9,$10::jsonb,$11,$12::timestamptz)`,
    [o.farm??F1, o.equip===null?null:(o.equip??E1), 'BOMBA', o.action??'turn_on', o.origin,
     o.result??'success', o.actor??null, o.user??null, o.email??null,
     JSON.stringify(o.details??{}), o.noise??null, o.at??'2026-08-11T21:19:00-03:00']);}

/** Uma linha remota impecável — a referência de "OK". */
const limpa = (extra:any={}) => ({origin:'remote', user:UA, email:'a@ex.com', actor:'Pessoa A',
  details:{authorship_source:'command_audit'}, ...extra});

const issues = async (d:PGlite) => (await d.query<any>(
  `SELECT id, issue FROM public.automation_row_classified`)).rows;
const resumo = async (d:PGlite) => (await d.query<any>(
  `SELECT * FROM public.automation_issue_summary()`)).rows;
const aceite = async (d:PGlite) => (await d.query<any>(
  `SELECT * FROM public.automation_global_acceptance()`)).rows;
const inv = async (d:PGlite) => (await d.query<any>(
  `SELECT * FROM public.automation_global_inventory()`)).rows;
const conta = (rows:any[], cat:string) => Number(rows.find(r=>r.categoria===cat)?.ocorrencias ?? -1);

let d:PGlite; beforeEach(async()=>{ d=await mk(); });

describe("FASE A — inventário global", () => {

  it("linha impecável é OK e não gera nenhuma violação", async () => {
    await add(d, limpa());
    expect((await issues(d))[0].issue).toBe('OK');
    expect((await aceite(d)).every(r=>r.situacao==='PASSOU')).toBe(true);
  });

  it("A — origin 'system' é origem indefinida (o 'Origem em apuração' da tela)", async () => {
    await add(d,{origin:'system', actor:'Pessoa A', user:UA, email:'a@ex.com'});
    expect(conta(await resumo(d),'A_origem_indefinida')).toBe(1);
    expect((await aceite(d)).find(r=>r.categoria==='A_origem_indefinida').situacao).toBe('REPROVADO');
  });

  it("B — usuário técnico/genérico é pego em todas as variações", async () => {
    const labels = ['Telemetria RF','RF','Agent','Bridge','Serial','Sistema','Comando Remoto',
                    'Autoria histórica em revisão','Origem em apuração'];
    for (const [i,l] of labels.entries())
      await add(d, limpa({actor:l, at:`2026-08-11T21:${20+i}:00-03:00`}));
    expect(conta(await resumo(d),'B_usuario_tecnico')).toBe(labels.length);
  });

  it("C — remoto sem user_id, sem e-mail ou sem nome cai em remoto_sem_autor", async () => {
    await add(d,{origin:'remote', actor:'Pessoa A', email:'a@ex.com'});            // sem user_id
    await add(d,{origin:'remote', actor:'Pessoa A', user:UA, at:'2026-08-11T21:21:00-03:00'}); // sem e-mail
    await add(d,{origin:'remote', user:UA, email:'a@ex.com', at:'2026-08-11T21:22:00-03:00'}); // sem nome
    expect(conta(await resumo(d),'C_remoto_sem_autor')).toBe(3);
  });

  it("D — Local com comando remoto compatível na janela é reclassificado", async () => {
    await add(d,{origin:'local', actor:'Acionamento local', at:'2026-08-11T21:19:00-03:00'});
    await d.query(`INSERT INTO public.command_audit
      (command_id,farm_id,equipment_id,user_id,intent,command_created_at)
      VALUES (gen_random_uuid(),$1,$2,$3,'turn_on','2026-08-11T21:19:30-03:00')`,[F1,E1,UA]);
    expect(conta(await resumo(d),'D_local_com_comando')).toBe(1);
  });

  it("D — Local sem comando compatível continua Local legítimo", async () => {
    await add(d,{origin:'local', actor:'Acionamento local'});
    // comando remoto existe, mas para o OUTRO sentido e fora da janela
    await d.query(`INSERT INTO public.command_audit
      (command_id,farm_id,equipment_id,user_id,intent,command_created_at)
      VALUES (gen_random_uuid(),$1,$2,$3,'turn_off','2026-08-11T19:00:00-03:00')`,[F1,E1,UA]);
    expect(conta(await resumo(d),'D_local_com_comando')).toBe(0);
    expect((await issues(d))[0].issue).toBe('OK');
  });

  it("E — automação sem nome de regra é violação", async () => {
    await add(d,{origin:'auto', action:'turn_off'});
    expect(conta(await resumo(d),'E_auto_sem_regra')).toBe(1);
  });

  it("F — polling/status_read/telemetria no relatório oficial é violação", async () => {
    await add(d,{origin:'remote', action:'status_read', actor:'Pessoa A', user:UA, email:'a@ex.com'});
    await add(d,{origin:'remote', action:'polling', actor:'Pessoa A', user:UA, email:'a@ex.com',
                 at:'2026-08-11T21:21:00-03:00'});
    await add(d,{origin:'reading', at:'2026-08-11T21:22:00-03:00'});
    expect(conta(await resumo(d),'F_tecnico')).toBe(3);
  });

  it("F — o mesmo evento marcado como ruído NÃO conta (já está fora do oficial)", async () => {
    await add(d,{origin:'reading', noise:'reading_origin'});
    expect(conta(await resumo(d),'F_tecnico')).toBe(0);
    expect((await issues(d)).length).toBe(0);
  });

  it("G — sem confirmação física é violação; state_confirmed salva a linha", async () => {
    await add(d, limpa({result:'pending'}));
    await add(d, limpa({result:'timeout', at:'2026-08-11T21:21:00-03:00'}));
    await add(d, limpa({equip:null, at:'2026-08-11T21:22:00-03:00'}));
    expect(conta(await resumo(d),'G_sem_prova')).toBe(3);
    // mesma linha, mas com confirmação explícita no details → deixa de ser G
    await add(d, limpa({result:'pending', at:'2026-08-11T21:23:00-03:00',
      details:{authorship_source:'command_audit', state_confirmed:'true'}}));
    expect(conta(await resumo(d),'G_sem_prova')).toBe(3);
  });

  it("duplicidade: duas linhas oficiais seguidas com o mesmo estado alvo", async () => {
    await add(d, limpa({action:'turn_on', at:'2026-08-11T21:19:00-03:00'}));
    await add(d, limpa({action:'turn_on', at:'2026-08-11T21:20:00-03:00'}));
    await add(d, limpa({action:'turn_off',at:'2026-08-11T21:21:00-03:00'}));
    const f1=(await inv(d)).find(r=>r.fazenda==='Fazenda Um');
    expect(Number(f1.duplicidades)).toBe(1);
  });

  it("cobre TODAS as fazendas — sujeira na segunda não some no global", async () => {
    await add(d, limpa());                                          // F1 limpa
    await add(d,{farm:F2, equip:E2, origin:'system', actor:'Pessoa A'}); // F2 suja
    const linhas=await inv(d);
    expect(Number(linhas.find(r=>r.fazenda==='Fazenda Um').origem_indefinida)).toBe(0);
    expect(Number(linhas.find(r=>r.fazenda==='Fazenda Dois').origem_indefinida)).toBe(1);
    const a=(await aceite(d)).find(r=>r.categoria==='A_origem_indefinida');
    expect(a.situacao).toBe('REPROVADO');
    expect(a.fazendas_afetadas).toBe('Fazenda Dois');
  });

  it("fazenda sem nenhum evento aparece na tabela com zeros, não some", async () => {
    await add(d, limpa());
    const linhas=await inv(d);
    expect(linhas.map(r=>r.fazenda).sort()).toEqual(['Fazenda Dois','Fazenda Um']);
    const f2=linhas.find(r=>r.fazenda==='Fazenda Dois');
    expect(Number(f2.total_oficial)).toBe(0);
    expect(Number(f2.sem_prova)).toBe(0);   // LEFT JOIN não pode inventar contagem
  });

  it("o aceite global lista as 7 categorias, sempre, mesmo com base limpa", async () => {
    await add(d, limpa());
    const a=await aceite(d);
    expect(a.length).toBe(7);
    expect(a.every(r=>Number(r.violacoes)===0 && r.situacao==='PASSOU')).toBe(true);
    expect(a.every(r=>r.fazendas_afetadas==='—')).toBe(true);
  });

  it("automation_issue_rows devolve os IDs e filtra por categoria", async () => {
    await add(d,{origin:'system', actor:'Pessoa A'});
    await add(d,{origin:'auto', action:'turn_off', at:'2026-08-11T21:21:00-03:00'});
    const todos=(await d.query<any>(`SELECT * FROM public.automation_issue_rows()`)).rows;
    expect(todos.length).toBe(2);
    const soA=(await d.query<any>(`SELECT * FROM public.automation_issue_rows($1)`,['A'])).rows;
    expect(soA.length).toBe(1);
    expect(soA[0].categoria).toBe('A_origem_indefinida');
    expect(soA[0].fazenda).toBe('Fazenda Um');
    expect(soA[0].id).toBeTruthy();
  });
});
