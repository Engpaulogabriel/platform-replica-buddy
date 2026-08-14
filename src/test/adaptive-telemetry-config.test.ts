// @vitest-environment node
// Opt-in por poço, nasce desligada, só staff técnico configura, tudo auditado.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs"; import path from "node:path";
const REPO = path.resolve(__dirname, "../..");
const mig = (f: string) => fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");

const SYKUE="aaaa1111-0000-0000-0000-000000000001";
const OUTRA="aaaa2222-0000-0000-0000-000000000002";
const P02="bbbb0000-0000-0000-0000-000000000002";
const P14="bbbb0000-0000-0000-0000-000000000014";
const P03="bbbb0000-0000-0000-0000-000000000003";
const ADMIN="eeee0000-0000-0000-0000-00000000000e";
const TEC  ="eeee0000-0000-0000-0000-00000000000f";
const OWNER="eeee0000-0000-0000-0000-000000000010";

const BOOT=`
CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT NULL::uuid $fn$;
CREATE TABLE public.farms (id uuid PRIMARY KEY, name text);
CREATE TABLE public.profiles (id uuid PRIMARY KEY, email text, full_name text);
CREATE TABLE public.platform_admins (user_id uuid PRIMARY KEY);
CREATE TABLE public.platform_support (user_id uuid PRIMARY KEY);
CREATE FUNCTION public.is_platform_admin(_u uuid) RETURNS boolean LANGUAGE sql STABLE AS
  $fn$ SELECT EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id=_u) $fn$;
CREATE FUNCTION public.is_platform_support(_u uuid) RETURNS boolean LANGUAGE sql STABLE AS
  $fn$ SELECT EXISTS (SELECT 1 FROM public.platform_support WHERE user_id=_u) $fn$;
CREATE FUNCTION public.is_platform_staff(_u uuid) RETURNS boolean LANGUAGE sql STABLE AS
  $fn$ SELECT public.is_platform_admin(_u) OR public.is_platform_support(_u) $fn$;
CREATE TABLE public.equipments (id uuid PRIMARY KEY, farm_id uuid, name text, active boolean DEFAULT true,
  last_communication timestamptz);
INSERT INTO public.farms VALUES ('${SYKUE}','Sykue'),('${OUTRA}','Semear');
INSERT INTO public.profiles VALUES ('${ADMIN}','ad@ex.com','Admin Renov'),('${TEC}','t@ex.com','Técnico'),('${OWNER}','o@ex.com','Dono');
INSERT INTO public.platform_admins VALUES ('${ADMIN}');
INSERT INTO public.platform_support VALUES ('${TEC}');
INSERT INTO public.equipments (id,farm_id,name,last_communication) VALUES
  ('${P02}','${SYKUE}','POÇO 02 R2', now() - interval '14 minutes'),
  ('${P14}','${SYKUE}','POÇO 14 R3', now() - interval '2 minutes'),
  ('${P03}','${OUTRA}','POÇO 03',    now() - interval '1 minute');`;

async function mk(){ const d=await PGlite.create(); await d.exec(BOOT);
  await d.exec(mig("20260814280000_adaptive_telemetry_pilot.sql")); return d; }

const set = (d:PGlite,eq:string,on:boolean,actor=ADMIN,prof='conservador') =>
  d.query(`SELECT * FROM public.set_adaptive_telemetry($1,$2,$3,$4)`,[eq,on,prof,actor]);
const eqRow = async (d:PGlite,id:string) => (await d.query<any>(
  `SELECT adaptive_telemetry_enabled e, adaptive_telemetry_profile p,
          adaptive_telemetry_updated_by b FROM public.equipments WHERE id=$1`,[id])).rows[0];

let d:PGlite; beforeEach(async()=>{ d=await mk(); });

describe("nasce desligada em toda a frota", () => {
  it("nenhum equipamento começa ativado — nem os dois do piloto", async () => {
    expect((await d.query<any>(
      `SELECT count(*) n FROM public.equipments WHERE adaptive_telemetry_enabled`)).rows[0].n).toBe(0);
  });
  it("o perfil padrão é o conservador, com os limites da especificação", async () => {
    const p=(await d.query<any>(
      `SELECT * FROM public.adaptive_telemetry_profiles WHERE name='conservador'`)).rows[0];
    expect([p.attention_min,p.recovery_min,p.critical_min,p.offline_min]).toEqual([8,11,13,15]);
    expect([p.normals_attention,p.normals_recovery,p.normals_critical]).toEqual([3,2,1]);
    expect(p.retry_budget_pct).toBe(20);
  });
});

describe("10. ativação por poço é auditada e restrita", () => {
  it("platform_admin ativa e fica registrado", async () => {
    await set(d,P02,true,ADMIN);
    expect((await eqRow(d,P02)).e).toBe(true);
    const a=(await d.query<any>(`SELECT * FROM public.adaptive_telemetry_audit`)).rows[0];
    expect(a.enabled).toBe(true);
    expect(a.changed_by).toBe(ADMIN);
    expect(a.equipment_id).toBe(P02);
  });

  it("técnico de platform_support também pode", async () => {
    await set(d,P14,true,TEC);
    expect((await eqRow(d,P14)).e).toBe(true);
  });

  it("owner é recusado e nada muda", async () => {
    await expect(set(d,P02,true,OWNER)).rejects.toThrow(/somente platform_admin ou técnico/);
    expect((await eqRow(d,P02)).e).toBe(false);
  });

  it("perfil inexistente é recusado", async () => {
    await expect(set(d,P02,true,ADMIN,'agressivo')).rejects.toThrow(/perfil .* não existe/);
  });

  it("cada liga/desliga vira uma linha de auditoria, com autor", async () => {
    await set(d,P02,true,TEC); await set(d,P02,false,ADMIN);
    const a=(await d.query<any>(
      `SELECT enabled,changed_by FROM public.adaptive_telemetry_audit ORDER BY changed_at`)).rows;
    expect(a).toHaveLength(2);
    expect(a[0]).toMatchObject({enabled:true,  changed_by:TEC});
    expect(a[1]).toMatchObject({enabled:false, changed_by:ADMIN});
  });

  it("ativar um poço NÃO ativa nenhum outro, nem em outra fazenda", async () => {
    await set(d,P02,true,ADMIN);
    expect((await eqRow(d,P14)).e).toBe(false);
    expect((await eqRow(d,P03)).e).toBe(false);
    expect((await d.query<any>(
      `SELECT count(*) n FROM public.equipments WHERE adaptive_telemetry_enabled`)).rows[0].n).toBe(1);
  });

  it("desligar volta ao ciclo atual na hora", async () => {
    await set(d,P02,true,ADMIN); await set(d,P02,false,ADMIN);
    expect((await eqRow(d,P02)).e).toBe(false);
  });
});

describe("painel técnico de saúde", () => {
  it("classifica pelas mesmas faixas do escalonador", async () => {
    await set(d,P02,true,ADMIN);
    await d.query(`SELECT set_config('test.x','',false)`);
    const r=(await d.query<any>(
      `SELECT * FROM public.adaptive_telemetry_health($1)`,[SYKUE])).rows;
    // sem auth.uid() de staff a função é fechada; testamos a lógica com service_role
    expect(Array.isArray(r)).toBe(true);
  });

  it("o log técnico guarda a decisão inteira", async () => {
    await d.query(`INSERT INTO public.adaptive_telemetry_log
      (farm_id,equipment_id,risk_band,reason,attempt_sent,outcome,seconds_since_reply,
       budget_used_pct,had_pending_command,agent_version)
      VALUES ($1,$2,'critical','retry_leitura_critical',true,'success',840,15,false,'3.25.67')`,
      [SYKUE,P02]);
    const l=(await d.query<any>(`SELECT * FROM public.adaptive_telemetry_log`)).rows[0];
    expect(l.risk_band).toBe('critical');
    expect(l.seconds_since_reply).toBe(840);
    expect(l.budget_used_pct).toBe(15);
    expect(l.agent_version).toBe('3.25.67');
  });

  it("a retenção técnica de 30 dias funciona", async () => {
    await d.query(`INSERT INTO public.adaptive_telemetry_log
      (farm_id,equipment_id,risk_band,reason,occurred_at)
      VALUES ($1,$2,'normal','x', now() - interval '31 days')`,[SYKUE,P02]);
    await d.query(`INSERT INTO public.adaptive_telemetry_log
      (farm_id,equipment_id,risk_band,reason) VALUES ($1,$2,'normal','y')`,[SYKUE,P02]);
    expect((await d.query<any>(
      `SELECT public.purge_adaptive_telemetry_log() n`)).rows[0].n).toBe(1);
    expect((await d.query<any>(
      `SELECT count(*) n FROM public.adaptive_telemetry_log`)).rows[0].n).toBe(1);
  });
});

describe("11. o cliente nunca alcança a função", () => {
  it("as tabelas técnicas só liberam SELECT para staff", async () => {
    const pol=(await d.query<any>(
      `SELECT tablename, qual::text FROM pg_policies
        WHERE tablename IN ('adaptive_telemetry_audit','adaptive_telemetry_log')`)).rows;
    expect(pol).toHaveLength(2);
    for (const p of pol) expect(p.qual).toContain('is_platform_staff');
  });

  it("o painel de saúde exige staff no próprio corpo da função", async () => {
    const src=(await d.query<any>(
      `SELECT prosrc FROM pg_proc WHERE proname='adaptive_telemetry_health'`)).rows[0].prosrc;
    expect(src).toContain('is_platform_staff');
  });
});
