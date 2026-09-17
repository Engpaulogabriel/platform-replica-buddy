// @vitest-environment node
// A proteção de comutação é OPT-IN por poço, nasce desligada, e quando
// desligada é COMPLETAMENTE inerte. Só platform_admin/platform_support configuram.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs"; import path from "node:path";
const REPO = path.resolve(__dirname, "../..");
const mig = (f: string) => fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");

const F1="aaaa1111-0000-0000-0000-000000000001", F2="aaaa2222-0000-0000-0000-000000000002";
const E1="bbbb1111-0000-0000-0000-000000000001";   // POÇO 12 R6 (fazenda 1)
const E2="bbbb2222-0000-0000-0000-000000000002";   // POÇO 11    (fazenda 1)
const E3="bbbb3333-0000-0000-0000-000000000003";   // outra fazenda
const ADMIN="eeee0000-0000-0000-0000-00000000000e";
const TEC  ="eeee0000-0000-0000-0000-00000000000f";
const OWNER="eeee0000-0000-0000-0000-000000000010";

const BOOT=`
CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT NULL::uuid $fn$;
CREATE TYPE public.command_type AS ENUM ('manual','polling','reset','automation','config');
CREATE TYPE public.command_status AS ENUM ('pending','sent','delivered','executed','timeout','error','cancelled');
CREATE TABLE public.farms (id uuid PRIMARY KEY, name text, switching_protection_seconds int DEFAULT 30);
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
  last_outputs_state text, command_blocked_until timestamptz,
  last_confirmed_transition_at timestamptz, last_confirmed_transition_state boolean);
CREATE TABLE public.commands (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, equipment_id uuid,
  type public.command_type DEFAULT 'manual', status public.command_status DEFAULT 'pending',
  source_device text, priority int DEFAULT 5, created_at timestamptz DEFAULT now());
CREATE TABLE public.agent_technical_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid,
  equipment_id uuid, kind text, occurred_at timestamptz, details jsonb DEFAULT '{}'::jsonb);
INSERT INTO public.farms VALUES ('${F1}','Fazenda Um',30),('${F2}','Fazenda Dois',30);
INSERT INTO public.profiles VALUES ('${ADMIN}','ad@ex.com','Admin Renov'),('${TEC}','t@ex.com','Técnico'),('${OWNER}','o@ex.com','Dono');
INSERT INTO public.platform_admins VALUES ('${ADMIN}');
INSERT INTO public.platform_support VALUES ('${TEC}');
INSERT INTO public.equipments (id,farm_id,name,last_outputs_state) VALUES
  ('${E1}','${F1}','POÇO 12 R6','{0}'),('${E2}','${F1}','POÇO 11','{0}'),('${E3}','${F2}','POÇO 20','{0}');`;

async function mk(){
  const d=await PGlite.create(); await d.exec(BOOT);
  // estado ANTERIOR: a função publicada como global e com poços travados
  await d.query(`UPDATE public.equipments SET command_blocked_until = now() + interval '30 seconds'`);
  // a correção
  await d.exec(mig("20260814240000_switching_protection_opt_in.sql"));
  // gatilhos (no banco real são criados junto da estrutura da proteção)
  await d.exec(`
    CREATE TRIGGER trg_arm_switching_protection BEFORE UPDATE ON public.equipments
      FOR EACH ROW EXECUTE FUNCTION public.arm_switching_protection();
    CREATE TRIGGER trg_enforce_switching_protection BEFORE INSERT ON public.commands
      FOR EACH ROW EXECUTE FUNCTION public.enforce_switching_protection();`);
  return d;
}

const ligar  = (d:PGlite,e:string,secs:number|null=30,actor=ADMIN) =>
  d.query(`SELECT * FROM public.set_switching_protection($1,true,$2,$3)`,[e,secs,actor]);
const desligar = (d:PGlite,e:string,actor=ADMIN) =>
  d.query(`SELECT * FROM public.set_switching_protection($1,false,NULL,$3::uuid)`.replace('$3','$3'),[e,null,actor]);
/** simula a confirmação física: o estado de saída muda */
const confirmar = (d:PGlite,e:string,out:string) =>
  d.query(`UPDATE public.equipments SET last_outputs_state=$2 WHERE id=$1`,[e,out]);
const comando = (d:PGlite,e:string,farm=F1) =>
  d.query(`INSERT INTO public.commands (farm_id,equipment_id,type) VALUES ($1,$2,'manual')`,[farm,e]);
const lock = async (d:PGlite,e:string) => (await d.query<any>(
  `SELECT command_blocked_until, switching_protection_enabled FROM public.equipments WHERE id=$1`,[e])).rows[0];

let d:PGlite; beforeEach(async()=>{ d=await mk(); });

describe("desarme do que já foi publicado", () => {
  it("nenhum poço fica bloqueado depois da correção", async () => {
    expect((await d.query<any>(
      `SELECT count(*) n FROM public.equipments WHERE command_blocked_until IS NOT NULL`)).rows[0].n).toBe(0);
  });
  it("todos os poços nascem com a proteção DESLIGADA", async () => {
    expect((await d.query<any>(
      `SELECT count(*) n FROM public.equipments WHERE switching_protection_enabled`)).rows[0].n).toBe(0);
  });
});

describe("poço DESLIGADO: função completamente inerte", () => {
  it("confirmação física não arma trava nenhuma", async () => {
    await confirmar(d,E1,'{1}');
    expect((await lock(d,E1)).command_blocked_until).toBeNull();
  });
  it("comando passa normalmente, mesmo logo após a mudança física", async () => {
    await confirmar(d,E1,'{1}');
    await expect(comando(d,E1)).resolves.toBeDefined();
    await expect(comando(d,E1)).resolves.toBeDefined();   // dois seguidos: passa
  });
  it("check_switching_protection libera e NÃO registra auditoria", async () => {
    const r=(await d.query<any>(`SELECT * FROM public.check_switching_protection($1)`,[E1])).rows[0];
    expect(r.allowed).toBe(true);
    expect(r.message).toBeNull();
    expect((await d.query<any>(
      `SELECT count(*) n FROM public.agent_technical_events`)).rows[0].n).toBe(0);
  });
  it("switching_protection_status devolve destravado", async () => {
    const r=(await d.query<any>(`SELECT * FROM public.switching_protection_status($1)`,[E1])).rows[0];
    expect(r.locked).toBe(false);
    expect(r.seconds_remaining).toBe(0);
  });
});

describe("poço LIGADO: a trava funciona, só nele", () => {
  it("confirmação física arma a trava e o comando seguinte é recusado", async () => {
    await ligar(d,E1);
    await confirmar(d,E1,'{1}');
    expect((await lock(d,E1)).command_blocked_until).not.toBeNull();
    await expect(comando(d,E1)).rejects.toThrow(/Proteção de comutação ativa/);
  });

  it("o poço VIZINHO da mesma fazenda continua livre", async () => {
    await ligar(d,E1);
    await confirmar(d,E1,'{1}');
    await confirmar(d,E2,'{1}');                    // vizinho também mudou
    expect((await lock(d,E2)).command_blocked_until).toBeNull();
    await expect(comando(d,E2)).resolves.toBeDefined();
  });

  it("outra FAZENDA não é afetada", async () => {
    await ligar(d,E1);
    await confirmar(d,E3,'{1}');
    expect((await lock(d,E3)).command_blocked_until).toBeNull();
    await expect(comando(d,E3,F2)).resolves.toBeDefined();
  });

  it("desligar libera IMEDIATAMENTE, mesmo com trava ativa", async () => {
    await ligar(d,E1); await confirmar(d,E1,'{1}');
    await expect(comando(d,E1)).rejects.toThrow(/Proteção de comutação/);
    await d.query(`SELECT * FROM public.set_switching_protection($1,false,NULL,$2)`,[E1,ADMIN]);
    expect((await lock(d,E1)).command_blocked_until).toBeNull();
    await expect(comando(d,E1)).resolves.toBeDefined();
  });

  it("comandos de segurança/emergência passam mesmo com a trava armada", async () => {
    await ligar(d,E1); await confirmar(d,E1,'{1}');
    for (const src of ['backend-reset','forced-shutdown','cloud-protective','safety-x']) {
      await expect(d.query(
        `INSERT INTO public.commands (farm_id,equipment_id,type,source_device) VALUES ($1,$2,'manual',$3)`,
        [F1,E1,src])).resolves.toBeDefined();
    }
    await expect(d.query(
      `INSERT INTO public.commands (farm_id,equipment_id,type,priority) VALUES ($1,$2,'manual',0)`,
      [F1,E1])).resolves.toBeDefined();
  });

  it("polling nunca é bloqueado", async () => {
    await ligar(d,E1); await confirmar(d,E1,'{1}');
    await expect(d.query(
      `INSERT INTO public.commands (farm_id,equipment_id,type) VALUES ($1,$2,'polling')`,
      [F1,E1])).resolves.toBeDefined();
  });

  it("a recusa vira auditoria técnica, fora do Relatório de Automação", async () => {
    await ligar(d,E1); await confirmar(d,E1,'{1}');
    const r=(await d.query<any>(`SELECT * FROM public.check_switching_protection($1,$2,'painel')`,[E1,ADMIN])).rows[0];
    expect(r.allowed).toBe(false);
    const ev=(await d.query<any>(`SELECT * FROM public.agent_technical_events`)).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0].details.reason).toBe('switching_protection_active');
  });

  it("janela por poço é respeitada", async () => {
    await ligar(d,E1,120);
    await confirmar(d,E1,'{1}');
    const r=(await d.query<any>(`SELECT * FROM public.switching_protection_status($1)`,[E1])).rows[0];
    expect(r.seconds_remaining).toBeGreaterThan(100);
  });
});

describe("quem pode configurar", () => {
  it("platform_admin pode", async () => {
    await expect(ligar(d,E1,30,ADMIN)).resolves.toBeDefined();
  });
  it("técnico de platform_support pode", async () => {
    await expect(ligar(d,E1,30,TEC)).resolves.toBeDefined();
  });
  it("owner NÃO pode", async () => {
    await expect(ligar(d,E1,30,OWNER)).rejects.toThrow(/somente platform_admin ou técnico/);
  });
  it("janela fora do intervalo é recusada", async () => {
    await expect(ligar(d,E1,0,ADMIN)).rejects.toThrow(/fora do intervalo/);
    await expect(ligar(d,E1,601,ADMIN)).rejects.toThrow(/fora do intervalo/);
  });
  it("cada alteração vira auditoria com autor", async () => {
    await ligar(d,E1,30,TEC);
    await d.query(`SELECT * FROM public.set_switching_protection($1,false,NULL,$2)`,[E1,ADMIN]);
    const a=(await d.query<any>(
      `SELECT * FROM public.switching_protection_audit ORDER BY changed_at`)).rows;
    expect(a).toHaveLength(2);
    expect(a[0].enabled).toBe(true);  expect(a[0].changed_by).toBe(TEC);
    expect(a[1].enabled).toBe(false); expect(a[1].changed_by).toBe(ADMIN);
  });
  it("equipamento inexistente é recusado", async () => {
    await expect(ligar(d,'00000000-0000-0000-0000-000000000000',30,ADMIN))
      .rejects.toThrow(/não existe/);
  });
});
