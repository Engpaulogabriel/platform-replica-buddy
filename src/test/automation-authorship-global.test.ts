// @vitest-environment node
//
// AUTORIA GLOBAL — várias fazendas, vários usuários, várias origens.
// Nenhum nome de pessoa ou fazenda real: a prova é sempre um UUID.
// Roda PostgreSQL de verdade (pglite) sobre as migrations reais.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "../..");
const mig = (f: string) => fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");

const F1 = "aaaa1111-0000-0000-0000-000000000001";
const F2 = "aaaa2222-0000-0000-0000-000000000002";
const E1 = "bbbb1111-0000-0000-0000-000000000001"; // equipamento da F1
const E2 = "bbbb2222-0000-0000-0000-000000000002"; // equipamento da F2
const UA = "cccc0000-0000-0000-0000-00000000000a"; // usuário A (painel, F1)
const UB = "cccc0000-0000-0000-0000-00000000000b"; // usuário B (painel, F2)
const UC = "cccc0000-0000-0000-0000-00000000000c"; // usuário C (WhatsApp)
const UD = "cccc0000-0000-0000-0000-00000000000d"; // homônimo de A, UUID diferente

const BOOTSTRAP = `
CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE anon;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT NULL::uuid $fn$;
CREATE TYPE public.event_action AS ENUM ('turn_on','turn_off','status_read','mode_change','reset','polling','pump_on','pump_off');
CREATE TYPE public.event_origin AS ENUM ('remote','local','auto','reading','system');
CREATE TYPE public.event_result AS ENUM ('success','fail','pending','timeout');
CREATE TYPE public.command_type AS ENUM ('manual','polling','reset','automation');
CREATE TYPE public.command_status AS ENUM ('pending','sent','delivered','executed','timeout','error','cancelled');
CREATE TABLE public.farms (id uuid PRIMARY KEY, name text NOT NULL);
CREATE TABLE public.profiles (id uuid PRIMARY KEY, email text, full_name text);
CREATE TABLE public.equipments (
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES public.farms(id), name text,
  last_changed_by text, last_actuation_origin text, last_confirmed_state smallint NOT NULL DEFAULT 0);
CREATE TABLE public.commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid NOT NULL, equipment_id uuid,
  type public.command_type NOT NULL DEFAULT 'manual', status public.command_status NOT NULL DEFAULT 'pending',
  frame text, source_device text, created_by uuid, client_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz, responded_at timestamptz);
CREATE TABLE public.automation_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL, equipment_id uuid, equipment_name text NOT NULL,
  action public.event_action NOT NULL, origin public.event_origin NOT NULL,
  result public.event_result NOT NULL DEFAULT 'success',
  actor_label text, user_id uuid, user_email text, new_state text,
  source_device text, details jsonb DEFAULT '{}'::jsonb, client_event_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION public.has_farm_access(uuid, uuid) RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT true $fn$;
INSERT INTO public.farms (id,name) VALUES ('${F1}','Fazenda Um'), ('${F2}','Fazenda Dois');
INSERT INTO public.profiles (id,email,full_name) VALUES
  ('${UA}','a@ex.com','Nome Repetido'), ('${UB}','b@ex.com','Usuario B'),
  ('${UC}','c@ex.com','Usuario C'),     ('${UD}','d@ex.com','Nome Repetido');
INSERT INTO public.equipments (id,farm_id,name) VALUES ('${E1}','${F1}','BOMBA 1'), ('${E2}','${F2}','BOMBA 2');
`;

async function freshDb() {
  const db = await PGlite.create();
  await db.exec(BOOTSTRAP);
  await db.exec(mig("20260814200000_automation_log_transition_only.sql"));
  await db.exec(mig("20260814200200_automation_log_canonical_truth.sql"));
  return db;
}

// insere direto, simulando o que já está gravado (sem passar pela guarda)
async function raw(db: PGlite, o: {
  farm: string; equip: string; name: string; on: boolean; origin: string;
  actor?: string | null; user?: string | null; source?: string | null;
  details?: Record<string, unknown>; at?: string;
}) {
  await db.exec(`ALTER TABLE public.automation_log DISABLE TRIGGER trg_enforce_automation_log_state_change`);
  await db.query(
    `INSERT INTO public.automation_log (farm_id,equipment_id,equipment_name,action,origin,actor_label,
                                        user_id,source_device,details,occurred_at)
     VALUES ($1,$2,$3,$4::public.event_action,$5::public.event_origin,$6,$7,$8,$9::jsonb,$10::timestamptz)`,
    [o.farm, o.equip, o.name, o.on ? "turn_on" : "turn_off", o.origin, o.actor ?? null,
     o.user ?? null, o.source ?? null, JSON.stringify(o.details ?? {}),
     o.at ?? new Date(Date.now() - 3600_000).toISOString()]);
  await db.exec(`ALTER TABLE public.automation_log ENABLE TRIGGER trg_enforce_automation_log_state_change`);
}

const rows = async (db: PGlite, equip: string) =>
  (await db.query<any>(
    `SELECT origin::text, user_id, user_email, actor_label,
            details->>'authorship_source' src, details->>'confirmation_method' metodo
       FROM public.automation_log WHERE equipment_id=$1 ORDER BY occurred_at`, [equip])).rows;

let db: PGlite;
beforeEach(async () => { db = await freshDb(); });

describe("autoria global — fazendas e usuários diferentes não se misturam", () => {
  it("usuário A (F1) e usuário B (F2) são recuperados por command_audit, cada um na sua fazenda", async () => {
    const c1 = "dddd0000-0000-0000-0000-000000000001";
    const c2 = "dddd0000-0000-0000-0000-000000000002";
    await db.query(`INSERT INTO public.commands (id,farm_id,equipment_id,frame,created_by,status)
                    VALUES ($1,$2,$3,'{1}',$4,'executed'),($5,$6,$7,'{1}',$8,'executed')`,
      [c1, F1, E1, UA, c2, F2, E2, UB]);
    await raw(db, { farm: F1, equip: E1, name: "BOMBA 1", on: true, origin: "remote",
                    actor: "Telemetria RF", details: { command_id: c1 } });
    await raw(db, { farm: F2, equip: E2, name: "BOMBA 2", on: true, origin: "remote",
                    actor: "Telemetria RF", details: { command_id: c2 } });

    await db.exec(mig("20260814200300_command_audit_and_authorship_backfill.sql"));

    const r1 = (await rows(db, E1))[0];
    const r2 = (await rows(db, E2))[0];
    expect(r1.user_id).toBe(UA);
    expect(r1.user_email).toBe("a@ex.com");
    expect(r1.src).toBe("command_audit");
    expect(r1.metodo).toBe("Telemetria RF");   // método saiu da coluna Usuário
    expect(r2.user_id).toBe(UB);               // fazenda 2 não herdou o autor da 1
    expect(r2.user_email).toBe("b@ex.com");
  });

  it("comando WhatsApp (usuário C) mantém origem remota e o autor correto", async () => {
    const c3 = "dddd0000-0000-0000-0000-000000000003";
    await db.query(`INSERT INTO public.commands (id,farm_id,equipment_id,frame,created_by,status,source_device)
                    VALUES ($1,$2,$3,'{1}',$4,'executed','whatsapp:Operador|5577999')`, [c3, F1, E1, UC]);
    await raw(db, { farm: F1, equip: E1, name: "BOMBA 1", on: true, origin: "remote",
                    source: "whatsapp:Operador|5577999", details: { command_id: c3 } });

    await db.exec(mig("20260814200300_command_audit_and_authorship_backfill.sql"));
    const r = (await rows(db, E1))[0];
    expect(r.user_id).toBe(UC);
    expect(r.origin).toBe("remote");
    const kind = await db.query<any>(`SELECT origin_kind FROM public.command_audit WHERE command_id=$1`, [c3]);
    expect(kind.rows[0].origin_kind).toBe("whatsapp");
  });

  it("autoria sobrevive ao DELETE do comando (command_audit é append-only)", async () => {
    const c4 = "dddd0000-0000-0000-0000-000000000004";
    await db.exec(mig("20260814200300_command_audit_and_authorship_backfill.sql"));
    await db.query(`INSERT INTO public.commands (id,farm_id,equipment_id,frame,created_by,status)
                    VALUES ($1,$2,$3,'{1}',$4,'pending')`, [c4, F1, E1, UA]);
    await db.query(`DELETE FROM public.commands WHERE id=$1`, [c4]);   // apagado sem passar por 'executed'

    const a = await db.query<any>(`SELECT user_id, user_email, actor_label, intent FROM public.command_audit WHERE command_id=$1`, [c4]);
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0].user_id).toBe(UA);
    expect(a.rows[0].actor_label).toBe("Nome Repetido");
    expect(a.rows[0].intent).toBe("turn_on");
  });

  it("telemetria RF posterior não apaga a autoria já gravada", async () => {
    const c5 = "dddd0000-0000-0000-0000-000000000005";
    await db.query(`INSERT INTO public.commands (id,farm_id,equipment_id,frame,created_by,status)
                    VALUES ($1,$2,$3,'{1}',$4,'executed')`, [c5, F1, E1, UA]);
    await raw(db, { farm: F1, equip: E1, name: "BOMBA 1", on: true, origin: "remote",
                    user: UA, actor: "Usuario A", details: { command_id: c5 } });
    await db.exec(mig("20260814200300_command_audit_and_authorship_backfill.sql"));
    // telemetria chegando depois, pela guarda normal
    await db.query(
      `INSERT INTO public.automation_log (farm_id,equipment_id,equipment_name,action,origin,actor_label,details,occurred_at)
       VALUES ($1,$2,'BOMBA 1','turn_on','system','Telemetria RF','{"origin":"remote-cmd"}'::jsonb, now())`,
      [F1, E1]);
    const r = await rows(db, E1);
    expect(r[0].user_id).toBe(UA);
    expect(r[0].actor_label).toBe("Usuario A");
  });
});

describe("hierarquia de evidência — UUID é a prova, nome nunca é", () => {
  it("last_changed_by com user:<UUID> atribui; homônimo não confunde", async () => {
    // dois perfis com o MESMO full_name e UUIDs diferentes
    await db.query(`UPDATE public.equipments
                       SET last_changed_by = $1, last_actuation_origin = 'remote-desired'
                     WHERE id = $2`, [`painel|user:${UD}`, E1]);
    await raw(db, { farm: F1, equip: E1, name: "BOMBA 1", on: true, origin: "remote" });

    await db.exec(mig("20260814200300_command_audit_and_authorship_backfill.sql"));
    const r = (await rows(db, E1))[0];
    expect(r.user_id).toBe(UD);              // o UUID decidiu, não o nome
    expect(r.src).toBe("last_changed_by_uuid");
  });

  it("last_changed_by só com NOME (sem UUID) NÃO atribui — vira pendência", async () => {
    await db.query(`UPDATE public.equipments
                       SET last_changed_by = 'Nome Repetido', last_actuation_origin = 'remote-desired'
                     WHERE id = $1`, [E1]);
    await raw(db, { farm: F1, equip: E1, name: "BOMBA 1", on: true, origin: "remote", actor: "Telemetria RF" });

    await db.exec(mig("20260814200300_command_audit_and_authorship_backfill.sql"));
    const r = (await rows(db, E1))[0];
    expect(r.user_id).toBeNull();
    expect(r.actor_label).toBeNull();        // nunca "Telemetria RF"
    const p = await db.query<any>(`SELECT reason FROM public.authorship_pending_review WHERE resolved_at IS NULL`);
    expect(p.rows).toHaveLength(1);
  });

  it("last_changed_by com UUID mas origem LOCAL não atribui autoria remota", async () => {
    await db.query(`UPDATE public.equipments
                       SET last_changed_by = $1, last_actuation_origin = 'local' WHERE id = $2`,
      [`painel|user:${UA}`, E1]);
    await raw(db, { farm: F1, equip: E1, name: "BOMBA 1", on: true, origin: "remote" });
    await db.exec(mig("20260814200300_command_audit_and_authorship_backfill.sql"));
    expect((await rows(db, E1))[0].user_id).toBeNull();
  });

  it("details.user_id válido atribui (prioridade 2)", async () => {
    await raw(db, { farm: F1, equip: E1, name: "BOMBA 1", on: true, origin: "remote",
                    details: { user_id: UB } });
    await db.exec(mig("20260814200300_command_audit_and_authorship_backfill.sql"));
    const r = (await rows(db, E1))[0];
    expect(r.user_id).toBe(UB);
    expect(r.src).toBe("details_user");
  });

  it("comando LOCAL verdadeiro e AUTOMAÇÃO não viram remoto nem ganham autor", async () => {
    await raw(db, { farm: F1, equip: E1, name: "BOMBA 1", on: true, origin: "local", actor: "Acionamento local" });
    await raw(db, { farm: F2, equip: E2, name: "BOMBA 2", on: false, origin: "auto", actor: "Desligamento programado" });
    await db.exec(mig("20260814200300_command_audit_and_authorship_backfill.sql"));

    expect((await rows(db, E1))[0].origin).toBe("local");
    expect((await rows(db, E1))[0].user_id).toBeNull();
    expect((await rows(db, E2))[0].origin).toBe("auto");
    expect((await rows(db, E2))[0].actor_label).toBe("Desligamento programado");
    // nenhuma pendência: pendência é só para REMOTO sem autoria
    const p = await db.query<any>(`SELECT count(*)::int n FROM public.authorship_pending_review WHERE resolved_at IS NULL`);
    expect(Number(p.rows[0].n)).toBe(0);
  });
});

describe("relatório de impacto e idempotência", () => {
  it("relatório global por fazenda soma corretamente", async () => {
    const c = "dddd0000-0000-0000-0000-00000000000f";
    await db.query(`INSERT INTO public.commands (id,farm_id,equipment_id,frame,created_by,status)
                    VALUES ($1,$2,$3,'{1}',$4,'executed')`, [c, F1, E1, UA]);
    await raw(db, { farm: F1, equip: E1, name: "BOMBA 1", on: true, origin: "remote",
                    actor: "Telemetria RF", details: { command_id: c } });
    await raw(db, { farm: F2, equip: E2, name: "BOMBA 2", on: true, origin: "remote" }); // sem prova

    await db.exec(mig("20260814200300_command_audit_and_authorship_backfill.sql"));
    const rep = await db.query<any>(
      `SELECT farm_name, remotos_total, com_autor_ok, recuperados_command_audit, pendencias
         FROM public.automation_log_authorship_report
        WHERE run_id=(SELECT run_id FROM public.automation_log_authorship_report ORDER BY run_at DESC LIMIT 1)
        ORDER BY farm_name`);
    const f1 = rep.rows.find((x: any) => x.farm_name === "Fazenda Um");
    const f2 = rep.rows.find((x: any) => x.farm_name === "Fazenda Dois");
    expect(f1.com_autor_ok).toBe(1);
    expect(f1.recuperados_command_audit).toBe(1);
    expect(f1.pendencias).toBe(0);
    expect(f2.com_autor_ok).toBe(0);
    expect(f2.pendencias).toBe(1);           // sem prova → pendência, não invenção
  });

  it("é idempotente: reexecutar não muda autoria nem duplica linhas", async () => {
    const c = "dddd0000-0000-0000-0000-0000000000ff";
    await db.query(`INSERT INTO public.commands (id,farm_id,equipment_id,frame,created_by,status)
                    VALUES ($1,$2,$3,'{1}',$4,'executed')`, [c, F1, E1, UA]);
    await raw(db, { farm: F1, equip: E1, name: "BOMBA 1", on: true, origin: "remote",
                    details: { command_id: c } });
    await db.exec(mig("20260814200300_command_audit_and_authorship_backfill.sql"));
    const antes = await rows(db, E1);
    await db.query(`SELECT public.backfill_automation_log_authorship()`);
    const depois = await rows(db, E1);
    expect(depois).toHaveLength(antes.length);
    expect(depois[0].user_id).toBe(antes[0].user_id);
  });

  it("rollback devolve ao estado sem autoria (nada foi apagado)", async () => {
    const c = "dddd0000-0000-0000-0000-0000000000ee";
    await db.query(`INSERT INTO public.commands (id,farm_id,equipment_id,frame,created_by,status)
                    VALUES ($1,$2,$3,'{1}',$4,'executed')`, [c, F1, E1, UA]);
    await raw(db, { farm: F1, equip: E1, name: "BOMBA 1", on: true, origin: "remote",
                    details: { command_id: c } });
    await db.exec(mig("20260814200300_command_audit_and_authorship_backfill.sql"));
    expect((await rows(db, E1))[0].user_id).toBe(UA);

    await db.exec(`UPDATE public.automation_log SET user_id=NULL, user_email=NULL, actor_label=NULL
                    WHERE details ? 'authorship_source'`);
    expect((await rows(db, E1))[0].user_id).toBeNull();
    // a auditoria do comando permanece — a prova não se perde
    const a = await db.query<any>(`SELECT count(*)::int n FROM public.command_audit`);
    expect(Number(a.rows[0].n)).toBeGreaterThan(0);
  });
});
