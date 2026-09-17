// @vitest-environment node
// A fonte sanitizada não pode devolver NENHUM dado técnico de comunicação, e a
// autorização tem que refletir os papéis reais (platform_admins/platform_support).
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs"; import path from "node:path";
const REPO = path.resolve(__dirname, "../..");
const mig = (f: string) => fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");

const FARM="aaaa1111-0000-0000-0000-000000000001";
const ADMIN="cccc0000-0000-0000-0000-0000000000a1";
const TEC  ="cccc0000-0000-0000-0000-0000000000a2";
const OWNER="cccc0000-0000-0000-0000-0000000000a3";
const OPER ="cccc0000-0000-0000-0000-0000000000a4";

const BOOT=`
CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT NULL::uuid $fn$;
CREATE TABLE public.platform_admins (user_id uuid PRIMARY KEY);
CREATE TABLE public.platform_support (user_id uuid PRIMARY KEY);
CREATE FUNCTION public.is_platform_admin(_u uuid) RETURNS boolean LANGUAGE sql STABLE AS
  $fn$ SELECT EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id=_u) $fn$;
CREATE FUNCTION public.is_platform_support(_u uuid) RETURNS boolean LANGUAGE sql STABLE AS
  $fn$ SELECT EXISTS (SELECT 1 FROM public.platform_support WHERE user_id=_u) $fn$;
CREATE FUNCTION public.has_farm_access(_u uuid, _f uuid) RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT true $fn$;
CREATE TABLE public.equipments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, name text,
  active boolean DEFAULT true, last_outputs_state text, last_communication timestamptz,
  desired_running boolean, last_actuation_origin text, maintenance_mode boolean DEFAULT false,
  command_blocked_until timestamptz);
INSERT INTO public.platform_admins VALUES ('${ADMIN}');
INSERT INTO public.platform_support VALUES ('${TEC}');`;

async function mk(){ const d=await PGlite.create(); await d.exec(BOOT);
  await d.exec(mig("20260814230000_technical_telemetry_privacy.sql")); return d; }

const can = async (d:PGlite,u:string) =>
  (await d.query<any>(`SELECT public.can_view_technical_telemetry($1) AS v`,[u])).rows[0].v;

let d:PGlite; beforeEach(async()=>{ d=await mk(); });

describe("autorização única de telemetria técnica", () => {
  it("platform_admin pode", async () => expect(await can(d,ADMIN)).toBe(true));
  it("técnico (platform_support) pode", async () => expect(await can(d,TEC)).toBe(true));
  it("owner NÃO pode", async () => expect(await can(d,OWNER)).toBe(false));
  it("operador NÃO pode", async () => expect(await can(d,OPER)).toBe(false));
  it("usuário inexistente/nulo NÃO pode (falha fechada)", async () => {
    expect(await can(d,'00000000-0000-0000-0000-000000000000')).toBe(false);
    expect((await d.query<any>(
      `SELECT public.can_view_technical_telemetry(NULL) AS v`)).rows[0].v).toBe(false);
  });
});

describe("fonte operacional sanitizada", () => {
  const seed = async (over:Partial<Record<string,unknown>>={}) => {
    await d.query(`INSERT INTO public.equipments
      (farm_id,name,last_outputs_state,last_communication,desired_running,last_actuation_origin)
      VALUES ($1,'POÇO 12 R6',$2,$3,$4,$5)`,
      [FARM, over.out ?? '{1}', over.comm ?? new Date().toISOString(),
       over.desired ?? true, 'remote']);
  };
  const rows = async () => (await d.query<any>(
    `SELECT * FROM public.dashboard_equipment_operational($1)`,[FARM])).rows;

  it("não devolve NENHUMA coluna de tempo, sinal, polling ou bridge", async () => {
    await seed();
    const cols = Object.keys((await rows())[0]);
    const proibidas = /communication|polling|_at$|timestamp|signal|rx|tx|bridge|agent|version|latency|com_port/i;
    for (const c of cols) expect(c, `coluna sensível exposta: ${c}`).not.toMatch(proibidas);
    expect(cols.sort()).toEqual([
      "actuation_origin","desired_running","id","is_offline","is_unstable",
      "maintenance_mode","name","read_token","running","switching_locked",
    ]);
  });

  it("nenhum VALOR devolvido parece um horário ou data", async () => {
    await seed();
    const v = Object.values((await rows())[0]).map(String).join(" | ");
    expect(v).not.toMatch(/\d{4}-\d{2}-\d{2}/);      // ISO
    expect(v).not.toMatch(/\d{1,2}:\d{2}:\d{2}/);    // relógio
  });

  it("is_offline segue a MESMA regra de 15 minutos", async () => {
    await seed({ comm: new Date(Date.now()-2*60_000).toISOString() });
    expect((await rows())[0].is_offline).toBe(false);
    await d.query(`DELETE FROM public.equipments`);
    await seed({ comm: new Date(Date.now()-16*60_000).toISOString() });
    expect((await rows())[0].is_offline).toBe(true);
  });

  it("estado ligado/desligado continua correto (a operação não muda)", async () => {
    await seed({ out: '{1}' });
    expect((await rows())[0].running).toBe(true);
    await d.query(`DELETE FROM public.equipments`);
    await seed({ out: '{0}' });
    expect((await rows())[0].running).toBe(false);
  });

  it("read_token muda quando chega leitura nova e é estável quando não chega", async () => {
    await seed({ comm: '2026-08-14T10:00:00Z' });
    const t1 = (await rows())[0].read_token;
    expect((await rows())[0].read_token).toBe(t1);              // estável
    await d.query(`UPDATE public.equipments SET last_communication='2026-08-14T10:00:10Z'`);
    expect((await rows())[0].read_token).not.toBe(t1);          // detecta resposta
  });

  it("read_token não permite recuperar o horário", async () => {
    await seed({ comm: '2026-08-14T10:00:00Z' });
    const t = (await rows())[0].read_token as string;
    expect(t).toMatch(/^[0-9a-f]{32}$/);        // hash, não timestamp
    expect(t).not.toContain("2026");
    expect(t).not.toContain("10:00");
  });

  it("equipamento inativo não aparece", async () => {
    await seed();
    await d.query(`UPDATE public.equipments SET active=false`);
    expect(await rows()).toHaveLength(0);
  });
});
