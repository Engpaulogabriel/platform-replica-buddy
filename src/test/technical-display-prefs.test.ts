// @vitest-environment node
// A preferência nasce desligada, só staff técnico escreve, e a leitura falha
// fechada para todo o resto.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs"; import path from "node:path";
const REPO = path.resolve(__dirname, "../..");
const mig = (f: string) => fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");

const ADMIN="eeee0000-0000-0000-0000-00000000000e";
const TEC  ="eeee0000-0000-0000-0000-00000000000f";
const OWNER="eeee0000-0000-0000-0000-000000000010";

const BOOT=`
CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT NULL::uuid $fn$;
CREATE TABLE public.platform_admins (user_id uuid PRIMARY KEY);
CREATE TABLE public.platform_support (user_id uuid PRIMARY KEY);
CREATE FUNCTION public.is_platform_admin(_u uuid) RETURNS boolean LANGUAGE sql STABLE AS
  $fn$ SELECT EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id=_u) $fn$;
CREATE FUNCTION public.is_platform_support(_u uuid) RETURNS boolean LANGUAGE sql STABLE AS
  $fn$ SELECT EXISTS (SELECT 1 FROM public.platform_support WHERE user_id=_u) $fn$;
CREATE FUNCTION public.is_platform_staff(_u uuid) RETURNS boolean LANGUAGE sql STABLE AS
  $fn$ SELECT public.is_platform_admin(_u) OR public.is_platform_support(_u) $fn$;
INSERT INTO public.platform_admins VALUES ('${ADMIN}');
INSERT INTO public.platform_support VALUES ('${TEC}');`;

async function mk(){ const d=await PGlite.create(); await d.exec(BOOT);
  await d.exec(mig("20260814250000_technical_display_prefs.sql")); return d; }

const get = async (d:PGlite,u:string|null) => (await d.query<any>(
  `SELECT public.get_technical_display_pref($1::uuid) AS v`,[u])).rows[0].v;
const set = (d:PGlite,u:string,v:boolean) =>
  d.query(`SELECT public.set_technical_display_pref($1,$2)`,[v,u]);

let d:PGlite; beforeEach(async()=>{ d=await mk(); });

describe("padrão desligado", () => {
  it("admin sem linha nenhuma recebe false", async () => expect(await get(d,ADMIN)).toBe(false));
  it("técnico sem linha nenhuma recebe false", async () => expect(await get(d,TEC)).toBe(false));
  it("owner recebe false", async () => expect(await get(d,OWNER)).toBe(false));
  it("usuário nulo recebe false", async () => expect(await get(d,null)).toBe(false));
  it("a coluna tem DEFAULT false", async () => {
    await d.query(`INSERT INTO public.technical_display_prefs (user_id) VALUES ($1)`,[ADMIN]);
    expect((await d.query<any>(
      `SELECT show_technical_times v FROM public.technical_display_prefs`)).rows[0].v).toBe(false);
  });
});

describe("quem pode ligar", () => {
  it("platform_admin liga e o valor persiste", async () => {
    await set(d,ADMIN,true);
    expect(await get(d,ADMIN)).toBe(true);
  });
  it("técnico liga e o valor persiste", async () => {
    await set(d,TEC,true);
    expect(await get(d,TEC)).toBe(true);
  });
  it("owner é recusado", async () => {
    await expect(set(d,OWNER,true)).rejects.toThrow(/somente platform_admin ou técnico/);
    expect(await get(d,OWNER)).toBe(false);
  });
  it("usuário nulo é recusado", async () => {
    await expect(d.query(`SELECT public.set_technical_display_pref(true, NULL)`))
      .rejects.toThrow(/sem usuário autenticado/);
  });
});

describe("persistência e isolamento", () => {
  it("desligar volta a false", async () => {
    await set(d,ADMIN,true);  expect(await get(d,ADMIN)).toBe(true);
    await set(d,ADMIN,false); expect(await get(d,ADMIN)).toBe(false);
  });
  it("é idempotente: ligar duas vezes não duplica linha", async () => {
    await set(d,ADMIN,true); await set(d,ADMIN,true);
    expect((await d.query<any>(
      `SELECT count(*) n FROM public.technical_display_prefs`)).rows[0].n).toBe(1);
  });
  it("a preferência de um NÃO vaza para outro", async () => {
    await set(d,ADMIN,true);
    expect(await get(d,TEC)).toBe(false);
    expect(await get(d,OWNER)).toBe(false);
  });
  it("updated_at avança a cada alteração", async () => {
    await set(d,ADMIN,true);
    const t1=(await d.query<any>(`SELECT updated_at FROM public.technical_display_prefs`)).rows[0].updated_at;
    await set(d,ADMIN,false);
    const t2=(await d.query<any>(`SELECT updated_at FROM public.technical_display_prefs`)).rows[0].updated_at;
    expect(new Date(t2).getTime()).toBeGreaterThanOrEqual(new Date(t1).getTime());
  });
});

describe("falha fechada na leitura", () => {
  it("linha ligada de quem PERDEU o papel técnico devolve false", async () => {
    await set(d,TEC,true);
    expect(await get(d,TEC)).toBe(true);
    await d.query(`DELETE FROM public.platform_support WHERE user_id=$1`,[TEC]);
    expect(await get(d,TEC)).toBe(false);   // o papel manda, não a linha
  });
  it("linha ligada inserida à força para não-staff não vale nada", async () => {
    await d.query(`INSERT INTO public.technical_display_prefs (user_id, show_technical_times)
                   VALUES ($1,true)`,[OWNER]);
    expect(await get(d,OWNER)).toBe(false);
  });
});
