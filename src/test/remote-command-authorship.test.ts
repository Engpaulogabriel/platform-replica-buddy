// @vitest-environment node
// Nenhum comando remoto pode sair sem autor. A autoria vem de auth.uid() no
// servidor, o command_id é imutável, e não existe caminho alternativo.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs"; import path from "node:path";
const REPO = path.resolve(__dirname, "../..");
const mig = (f: string) => fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");

const F1="aaaa1111-0000-0000-0000-000000000001";
const E1="bbbb1111-0000-0000-0000-000000000001";
const UA ="cccc0000-0000-0000-0000-00000000000a";   // Ana
const UB ="cccc0000-0000-0000-0000-00000000000b";   // Bruno

/** auth.uid() é uma variável de sessão que os testes trocam — como no login real. */
const BOOT=`
CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $fn$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $fn$;
CREATE TYPE public.command_type AS ENUM ('manual','polling','reset','automation','config');
CREATE TYPE public.command_status AS ENUM ('pending','sent','delivered','executed','timeout','error','cancelled');
CREATE TABLE public.farms (id uuid PRIMARY KEY, name text);
CREATE TABLE public.profiles (id uuid PRIMARY KEY, email text, full_name text);
CREATE TABLE public.equipments (id uuid PRIMARY KEY, farm_id uuid, name text);
CREATE TABLE public.commands (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, equipment_id uuid,
  plc_hw_id text, type public.command_type DEFAULT 'manual', status public.command_status DEFAULT 'pending',
  priority int DEFAULT 5, frame text, timeout_ms int, created_by uuid, client_event_id uuid,
  source_device text, created_at timestamptz DEFAULT now());
CREATE TABLE public.command_audit (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), command_id uuid UNIQUE,
  client_event_id uuid, farm_id uuid, equipment_id uuid, equipment_name text, user_id uuid, user_email text,
  actor_label text, origin_kind text, intent text, frame text, source_device text, status_final text,
  command_created_at timestamptz, details jsonb DEFAULT '{}'::jsonb);
CREATE FUNCTION public.has_farm_access(_u uuid, _f uuid) RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT true $fn$;
INSERT INTO public.farms VALUES ('${F1}','Fazenda Um');
INSERT INTO public.profiles VALUES ('${UA}','ana@ex.com','Ana Souza'),('${UB}','bruno@ex.com','Bruno Lima');
INSERT INTO public.equipments VALUES ('${E1}','${F1}','POÇO 12 R6');`;

async function mk(){ const d=await PGlite.create(); await d.exec(BOOT);
  await d.exec(mig("20260814260000_remote_command_authorship_chain.sql")); return d; }

/** entra como esse usuário */
const login = (d:PGlite,u:string|null) =>
  d.query(`SELECT set_config('test.uid', $1, false)`,[u ?? '']);

const enqueue = (d:PGlite,intent:string,key:string|null=null) =>
  d.query<any>(`SELECT * FROM public.enqueue_remote_command($1,$2,'FRAME',NULL,$3)`,
               [E1,intent,key]);

const audit = async (d:PGlite,cmd:string) => (await d.query<any>(
  `SELECT * FROM public.command_audit WHERE command_id=$1`,[cmd])).rows[0];

let d:PGlite; beforeEach(async()=>{ d=await mk(); });

describe("a autoria vem do servidor", () => {
  it("Ana manda Ligar: o autor é Ana, com nome e e-mail reais", async () => {
    await login(d,UA);
    const r=(await enqueue(d,'turn_on')).rows[0];
    expect(r.actor_user_id).toBe(UA);
    expect(r.actor_label).toBe('Ana Souza');
    expect(r.actor_email).toBe('ana@ex.com');
    const a=await audit(d,r.command_id);
    expect(a.user_id).toBe(UA);
    expect(a.intent).toBe('turn_on');
    expect(a.details.authorship_source).toBe('command_audit');
  });

  it("Bruno manda Desligar em seguida: autoria de Ana NÃO é sobrescrita", async () => {
    await login(d,UA); const a=(await enqueue(d,'turn_on')).rows[0];
    await login(d,UB); const b=(await enqueue(d,'turn_off')).rows[0];
    expect(a.command_id).not.toBe(b.command_id);
    expect((await audit(d,a.command_id)).actor_label).toBe('Ana Souza');
    expect((await audit(d,b.command_id)).actor_label).toBe('Bruno Lima');
  });

  it("o frontend NÃO consegue escolher o autor — só auth.uid() vale", async () => {
    await login(d,UB);
    const r=(await enqueue(d,'turn_on')).rows[0];
    // não há parâmetro de usuário na RPC: quem está logado é quem assina
    expect(r.actor_user_id).toBe(UB);
  });

  it("sem usuário autenticado o comando é recusado", async () => {
    await login(d,null);
    await expect(enqueue(d,'turn_on')).rejects.toThrow(/usuário autenticado/);
    expect((await d.query<any>(`SELECT count(*) n FROM public.commands`)).rows[0].n).toBe(0);
  });

  it("usuário sem perfil com nome/e-mail é recusado — nada de autor vazio", async () => {
    await d.query(`INSERT INTO public.profiles VALUES ($1,NULL,NULL)`,
                  ['dddd0000-0000-0000-0000-00000000000d']);
    await login(d,'dddd0000-0000-0000-0000-00000000000d');
    await expect(enqueue(d,'turn_on')).rejects.toThrow(/não tem perfil/);
  });

  it("o snapshot do perfil sobrevive à mudança de nome depois", async () => {
    await login(d,UA);
    const r=(await enqueue(d,'turn_on')).rows[0];
    await d.query(`UPDATE public.profiles SET full_name='Outro Nome' WHERE id=$1`,[UA]);
    expect((await audit(d,r.command_id)).actor_label).toBe('Ana Souza');
  });

  it("intenção inválida é recusada", async () => {
    await login(d,UA);
    await expect(enqueue(d,'explodir')).rejects.toThrow(/intenção inválida/);
  });
});

describe("command_id e idempotência", () => {
  it("o mesmo command_id vai para commands e command_audit", async () => {
    await login(d,UA);
    const r=(await enqueue(d,'turn_on')).rows[0];
    expect((await d.query<any>(
      `SELECT id FROM public.commands`)).rows[0].id).toBe(r.command_id);
    expect((await audit(d,r.command_id)).command_id).toBe(r.command_id);
  });

  it("repetir a mesma idempotency key devolve o MESMO comando", async () => {
    await login(d,UA);
    const a=(await enqueue(d,'turn_on','k-1')).rows[0];
    const b=(await enqueue(d,'turn_on','k-1')).rows[0];
    expect(b.command_id).toBe(a.command_id);
    expect((await d.query<any>(`SELECT count(*) n FROM public.commands`)).rows[0].n).toBe(1);
  });

  it("a autoria do comando é imutável", async () => {
    await login(d,UA);
    const r=(await enqueue(d,'turn_on')).rows[0];
    await expect(d.query(`UPDATE public.commands SET created_by=$1 WHERE id=$2`,[UB,r.command_id]))
      .rejects.toThrow(/autoria do comando é imutável/);
  });

  it("comando recusado não deixa trilha órfã (tudo ou nada)", async () => {
    await login(d,UA);
    // equipamento inexistente: a RPC aborta antes de escrever qualquer coisa
    await expect(d.query(
      `SELECT * FROM public.enqueue_remote_command($1,'turn_on','FRAME')`,
      ['99999999-9999-9999-9999-999999999999'])).rejects.toThrow(/não existe/);
    expect((await d.query<any>(`SELECT count(*) n FROM public.command_audit`)).rows[0].n).toBe(0);
    expect((await d.query<any>(`SELECT count(*) n FROM public.commands`)).rows[0].n).toBe(0);
  });
});

describe("não existe fallback inseguro", () => {
  it("INSERT direto em commands é RECUSADO com a flag ligada (padrão)", async () => {
    await login(d,UA);
    await expect(d.query(
      `INSERT INTO public.commands (farm_id,equipment_id,type,frame,created_by)
       VALUES ($1,$2,'manual','FRAME',$3)`,[F1,E1,UA]))
      .rejects.toThrow(/enqueue_remote_command/);
  });

  it("INSERT direto SEM autor é recusado mesmo com a flag desligada", async () => {
    await d.query(`UPDATE public.farms SET command_rpc_enforced=false`);
    await login(d,UA);
    await expect(d.query(
      `INSERT INTO public.commands (farm_id,equipment_id,type,frame)
       VALUES ($1,$2,'manual','FRAME')`,[F1,E1]))
      .rejects.toThrow(/sem actor_user_id é proibido/);
  });

  it("INSERT direto COM autor mas SEM trilha é recusado mesmo com a flag desligada", async () => {
    await d.query(`UPDATE public.farms SET command_rpc_enforced=false`);
    await login(d,UA);
    await expect(d.query(
      `INSERT INTO public.commands (farm_id,equipment_id,type,frame,created_by)
       VALUES ($1,$2,'manual','FRAME',$3)`,[F1,E1,UA]))
      .rejects.toThrow(/sem trilha em command_audit é proibido/);
  });

  it("a flag NUNCA permite comando sem autor — é rollback observável, não brecha", async () => {
    await d.query(`UPDATE public.farms SET command_rpc_enforced=false`);
    await login(d,UA);
    // caminho legítimo com a flag desligada: trilha primeiro, comando depois
    const cmd='11111111-2222-3333-4444-555555555555';
    await d.query(`INSERT INTO public.command_audit (command_id,farm_id,equipment_id,user_id,user_email,actor_label,intent)
                   VALUES ($1,$2,$3,$4,'ana@ex.com','Ana Souza','turn_on')`,[cmd,F1,E1,UA]);
    await expect(d.query(
      `INSERT INTO public.commands (id,farm_id,equipment_id,type,frame,created_by)
       VALUES ($1,$2,$3,'manual','FRAME',$4)`,[cmd,F1,E1,UA])).resolves.toBeDefined();
  });

  it("polling e caminhos de máquina não são afetados", async () => {
    for (const [tipo,src] of [['polling',null],['manual','backend-reset'],
                              ['manual','forced-shutdown'],['manual','safety-x'],
                              ['manual','automation-scheduler']] as const) {
      await expect(d.query(
        `INSERT INTO public.commands (farm_id,equipment_id,type,frame,source_device)
         VALUES ($1,$2,$3::public.command_type,'FRAME',$4)`,[F1,E1,tipo,src]))
        .resolves.toBeDefined();
    }
  });
});

describe("observabilidade", () => {
  it("a saúde da autoria reporta zero comando sem autor", async () => {
    await login(d,UA);
    await enqueue(d,'turn_on','k-a'); await enqueue(d,'turn_off','k-b');
    const h=(await d.query<any>(`SELECT * FROM public.command_authorship_health()`)).rows[0];
    expect(Number(h.manuais_24h)).toBe(2);
    expect(Number(h.sem_autor)).toBe(0);
    expect(Number(h.sem_trilha)).toBe(0);
    expect(Number(h.sem_idempotencia)).toBe(0);
    expect(h.rpc_obrigatoria).toBe(true);
  });
});
