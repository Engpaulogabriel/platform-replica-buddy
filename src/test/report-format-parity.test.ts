// @vitest-environment node
// Tela, CSV e PDF vêm do MESMO array canônico: mesma contagem, mesmos IDs,
// zero texto proibido. E a consulta canônica só devolve transição confirmada.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs"; import path from "node:path";
const REPO = path.resolve(__dirname, "../..");
const mig = (f: string) => fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");
const src = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");

const F1="aaaa1111-0000-0000-0000-000000000001";
const E1="bbbb1111-0000-0000-0000-000000000001";
const UA="cccc0000-0000-0000-0000-00000000000a";

const BOOT=`
CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT NULL::uuid $fn$;
CREATE TYPE public.event_action AS ENUM ('turn_on','turn_off','status_read','mode_change','reset','polling','pump_on','pump_off');
CREATE TYPE public.event_origin AS ENUM ('remote','local','auto','reading','system');
CREATE TYPE public.event_result AS ENUM ('success','fail','pending','timeout');
CREATE TABLE public.farms (id uuid PRIMARY KEY, name text);
CREATE TABLE public.profiles (id uuid PRIMARY KEY, email text, full_name text);
CREATE TABLE public.equipments (id uuid PRIMARY KEY, farm_id uuid, name text);
CREATE TABLE public.automation_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, equipment_id uuid,
  equipment_name text, action public.event_action, origin public.event_origin, result public.event_result DEFAULT 'success',
  actor_label text, user_id uuid, user_email text, details jsonb DEFAULT '{}'::jsonb,
  noise_reason text, occurred_at timestamptz, created_at timestamptz DEFAULT now());
CREATE TABLE public.authorship_pending_review (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid,
  automation_log_id uuid UNIQUE, resolved_at timestamptz);
CREATE TABLE public.platform_admins (user_id uuid PRIMARY KEY);
CREATE FUNCTION public.is_platform_admin(_u uuid) RETURNS boolean LANGUAGE sql STABLE AS
  $fn$ SELECT EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id=_u) $fn$;
CREATE FUNCTION public.is_platform_staff(_u uuid) RETURNS boolean LANGUAGE sql STABLE AS
  $fn$ SELECT public.is_platform_admin(_u) $fn$;
CREATE FUNCTION public.has_farm_access(_u uuid, _f uuid) RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT true $fn$;
INSERT INTO public.farms VALUES ('${F1}','Fazenda Um');
INSERT INTO public.profiles VALUES ('${UA}','ana@ex.com','Ana Souza');
INSERT INTO public.equipments VALUES ('${E1}','${F1}','POÇO 12 R6');`;

async function mk(){ const d=await PGlite.create(); await d.exec(BOOT);
  await d.exec(mig("20260814260200_automation_report_canonical_query.sql")); return d; }

const add = (d:PGlite,o:any) => d.query(`INSERT INTO public.automation_log
  (farm_id,equipment_id,equipment_name,action,origin,result,actor_label,user_id,user_email,noise_reason,occurred_at)
  VALUES ($1,$2,'POÇO 12 R6',$3::public.event_action,$4::public.event_origin,$5::public.event_result,$6,$7,$8,$9,$10::timestamptz)`,
  [F1,E1,o.action??'turn_on',o.origin,o.result??'success',o.actor??null,o.user??null,o.email??null,
   o.noise??null,o.at??'2026-08-14T14:53:00-03:00']);

const canon = async (d:PGlite) => (await d.query<any>(
  `SELECT * FROM public.automation_report_canonical($1)`,[F1])).rows;

let d:PGlite; beforeEach(async()=>{ d=await mk(); });

describe("a consulta canônica só devolve transição confirmada", () => {
  it("remoto confirmado mostra o nome real da pessoa", async () => {
    await add(d,{origin:'remote',actor:'Ana Souza',user:UA,email:'ana@ex.com'});
    const r=(await canon(d))[0];
    expect(r.origem).toBe('Remoto');
    expect(r.usuario).toBe('Ana Souza');
    expect(r.acao).toBe('Ligada');
  });

  it("local mostra 'Acionamento local'", async () => {
    await add(d,{origin:'local',actor:'qualquer coisa'});
    expect((await canon(d))[0].usuario).toBe('Acionamento local');
  });

  it("automação mostra o nome da regra", async () => {
    await add(d,{origin:'auto',action:'turn_off',actor:'Desligamento 17h'});
    const r=(await canon(d))[0];
    expect(r.origem).toBe('Automação');
    expect(r.usuario).toBe('Desligamento 17h');
    expect(r.acao).toBe('Desligada');
  });

  it("polling, eco, retry e leitura repetida NÃO viram linha", async () => {
    await add(d,{origin:'remote',action:'status_read',actor:'Ana Souza',user:UA});
    await add(d,{origin:'remote',action:'polling',actor:'Ana Souza',user:UA});
    await add(d,{origin:'reading'});
    expect(await canon(d)).toHaveLength(0);
  });

  it("falha e timeout NÃO produzem transição física falsa", async () => {
    await add(d,{origin:'remote',result:'fail',actor:'Ana Souza',user:UA,noise:'command_not_confirmed'});
    await add(d,{origin:'remote',result:'timeout',actor:'Ana Souza',user:UA,noise:'command_not_confirmed'});
    expect(await canon(d)).toHaveLength(0);
  });

  it("origem indefinida na fila administrativa não aparece no oficial", async () => {
    await add(d,{origin:'system',actor:'Sistema',noise:'pending_authorship_review'});
    expect(await canon(d)).toHaveLength(0);
  });

  it("duas transições reais no mesmo minuto aparecem as DUAS", async () => {
    await add(d,{origin:'remote',action:'turn_on', actor:'Ana Souza',user:UA,at:'2026-08-14T14:53:05-03:00'});
    await add(d,{origin:'remote',action:'turn_off',actor:'Ana Souza',user:UA,at:'2026-08-14T14:53:40-03:00'});
    const r=await canon(d);
    expect(r).toHaveLength(2);
    expect(r.map((x:any)=>x.acao).sort()).toEqual(['Desligada','Ligada']);
  });

  it("nenhuma transição física real é apagada", async () => {
    await add(d,{origin:'local',actor:'Acionamento local',at:'2026-08-14T14:53:00-03:00'});
    await add(d,{origin:'remote',action:'turn_off',actor:'Ana Souza',user:UA,at:'2026-08-14T14:54:00-03:00'});
    expect(await canon(d)).toHaveLength(2);
  });
});

describe("paridade tela / CSV / PDF", () => {
  /** Simula o que os três formatos fazem hoje: consomem o MESMO array. */
  const formatos = (linhas: any[]) => ({
    tela: linhas,
    csv:  linhas.map(r => `${r.data_brt},${r.hora_brt},${r.equipamento},${r.acao},${r.origem},${r.usuario ?? ""}`),
    pdf:  linhas.map(r => [r.data_brt, r.hora_brt, r.equipamento, r.acao, r.origem, r.usuario ?? ""]),
  });

  it("mesma contagem e mesmos IDs nos três", async () => {
    await add(d,{origin:'remote',actor:'Ana Souza',user:UA,email:'ana@ex.com',at:'2026-08-14T14:53:00-03:00'});
    await add(d,{origin:'local',action:'turn_off',actor:'x',at:'2026-08-14T14:54:00-03:00'});
    await add(d,{origin:'auto',actor:'Desligamento 17h',at:'2026-08-14T14:55:00-03:00'});
    await add(d,{origin:'reading',at:'2026-08-14T14:56:00-03:00'});   // ruído: fora dos três

    const linhas = await canon(d);
    const f = formatos(linhas);
    expect(f.tela.length).toBe(3);
    expect(f.csv.length).toBe(3);
    expect(f.pdf.length).toBe(3);
    // os IDs são os mesmos porque a origem é o mesmo array
    expect(new Set(linhas.map((r:any)=>r.id)).size).toBe(3);
  });

  it("nenhum texto proibido em qualquer um dos três", async () => {
    await add(d,{origin:'remote',actor:'Ana Souza',user:UA,email:'ana@ex.com',at:'2026-08-14T14:53:00-03:00'});
    await add(d,{origin:'local',action:'turn_off',at:'2026-08-14T14:54:00-03:00'});
    const f = formatos(await canon(d));
    const tudo = JSON.stringify(f).toLowerCase();
    for (const t of ['desconhecido','autoria histórica em revisão','origem em apuração',
                     'comando remoto','telemetria rf','bridge','serial','falhou'])
      expect(tudo, `texto proibido presente: ${t}`).not.toContain(t);
  });

  it("o contador de textos proibidos devolve ZERO", async () => {
    await add(d,{origin:'remote',actor:'Ana Souza',user:UA,email:'ana@ex.com'});
    const r=(await d.query<any>(
      `SELECT * FROM public.automation_report_forbidden_text_count()`)).rows[0];
    expect(Number(r.textos_proibidos)).toBe(0);
    expect(Number(r.usuario_vazio)).toBe(0);
  });

  it("o inventário por fazenda conta remoto com nome humano", async () => {
    await add(d,{origin:'remote',actor:'Ana Souza',user:UA,email:'ana@ex.com',at:'2026-08-14T14:53:00-03:00'});
    await add(d,{origin:'local',action:'turn_off',at:'2026-08-14T14:54:00-03:00'});
    const r=(await d.query<any>(`SELECT * FROM public.remote_authorship_inventory()`)).rows[0];
    expect(Number(r.remotos_oficiais)).toBe(1);
    expect(Number(r.com_nome_humano)).toBe(1);
    expect(Number(r.sem_nome)).toBe(0);
    expect(Number(r.locais)).toBe(1);
  });
});

describe("o código não tem mais fallback textual de autoria", () => {
  const EXPORT = src("src/lib/reportExport.ts");
  const TAB = src("src/components/reports/AutomacaoReportTab.tsx");
  const QUEUE = src("src/lib/commandQueue.ts");

  it("safeAutomationUser e 'Desconhecido' saíram do relatório", () => {
    expect(EXPORT).not.toMatch(/safeAutomationUser\(/);
    expect(EXPORT).not.toContain('"Desconhecido"');
  });

  it("a coluna Resultado saiu do PDF de Automação", () => {
    const bloco = EXPORT.slice(EXPORT.indexOf("exportAutomacaoPDF"),
                               EXPORT.indexOf("HORÍMETRO"));
    expect(bloco).not.toContain('"Resultado"');
    expect(bloco).not.toMatch(/resultLabel\(/);
  });

  it("tela, CSV e PDF usam o MESMO array canônico", () => {
    expect(TAB).toContain("canonicalRows");
    expect(TAB).toContain("exportAutomacaoCSV(canonicalRows)");
    expect(TAB).toContain("exportAutomacaoPDF(canonicalRows");
    // nada de map separado por formato
    expect(TAB).not.toMatch(/const mapped = filteredLog\.map/);
  });

  it("os rótulos provisórios sumiram da tela", () => {
    expect(TAB).not.toContain("AUTHORSHIP_UNDER_REVIEW");
    expect(TAB).not.toContain("Origem em apuração");
  });

  it("o comando remoto passa pela RPC, não por INSERT direto", () => {
    expect(QUEUE).toContain('supabase.rpc("enqueue_remote_command"');
    // o insert manual antigo não existe mais
    expect(QUEUE).not.toMatch(/\.insert\(\{[^}]*type:\s*"manual"/s);
  });
});
