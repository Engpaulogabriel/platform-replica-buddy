// @vitest-environment node
// ─────────────────────────────────────────────────────────────────────────────
// Identidade do comando: quem pode gravar o quê — em Postgres de verdade
// ─────────────────────────────────────────────────────────────────────────────
// A exceção que permite comando WhatsApp sem created_by só é segura se um
// cliente autenticado NÃO puder escrever 'whatsapp:...' em source_device. Se
// pudesse, qualquer usuário com escrita na fazenda assinaria uma ação com o
// nome de outra pessoa. Aqui a política e o gatilho REAIS da migration são
// carregados e exercitados com papéis de verdade.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const MIG = "supabase/migrations/20260922150000_whatsapp_identity_guard.sql";

/** Corpo real do gatilho, extraído da migration sem edição. */
function guardaReal(): string {
  const s = readFileSync(MIG, "utf8");
  const i = s.indexOf("CREATE OR REPLACE FUNCTION public.guard_manual_command_without_user");
  return s.slice(i, s.indexOf("$$;", i) + 3);
}

/** Expressão real do WITH CHECK, extraída da migration sem edição. */
function politicaReal(): string {
  const s = readFileSync(MIG, "utf8");
  const i = s.indexOf("ALTER POLICY commands_insert_operators");
  const ini = s.indexOf("WITH CHECK (", i) + "WITH CHECK ".length;
  // fecha no `;` que termina o ALTER POLICY
  const fim = s.indexOf(");", ini) + 1;
  return s.slice(ini, fim);
}

async function banco() {
  const db = await PGlite.create();
  await db.exec(`
    CREATE TYPE public.command_type AS ENUM ('manual','polling','config','service_test');
    CREATE SCHEMA IF NOT EXISTS auth;
    -- auth.uid() lê o mesmo GUC que o PostgREST preenche
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $f$ SELECT nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $f$;
    -- o usuário do teste tem escrita na fazenda: o recorte aqui é source_device
    CREATE FUNCTION public.can_write_farm(_u uuid, _f uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $f$ SELECT _u IS NOT NULL $f$;
    CREATE FUNCTION public.farm_is_operational_here(_f uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $f$ SELECT true $f$;

    CREATE TABLE public.commands (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, equipment_id uuid,
      type public.command_type, frame text, source_device text,
      created_by uuid, created_at timestamptz DEFAULT now());
    ALTER TABLE public.commands ENABLE ROW LEVEL SECURITY;

    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT INSERT, SELECT ON public.commands TO authenticated, service_role;
    GRANT USAGE ON SCHEMA public, auth TO authenticated, service_role;
  `);
  await db.exec(guardaReal());
  await db.exec(`
    CREATE TRIGGER trg_guard_manual_command_without_user
    BEFORE INSERT ON public.commands FOR EACH ROW
    EXECUTE FUNCTION public.guard_manual_command_without_user();

    CREATE POLICY commands_insert_operators ON public.commands
      FOR INSERT TO authenticated WITH CHECK ${politicaReal()};
  `);
  return db;
}

const FAZENDA = "11111111-1111-1111-1111-111111111111";
const USUARIO = "33333333-3333-3333-3333-333333333333";

async function inserir(db: PGlite, papel: string, cmd: {
  src: string | null; createdBy: string | null;
}): Promise<{ ok: boolean; erro?: string }> {
  try {
    await db.exec(`SET ROLE ${papel};`);
    await db.exec(`SELECT set_config('request.jwt.claim.sub','${USUARIO}',false);`);
    await db.query(
      `INSERT INTO public.commands (farm_id, type, frame, source_device, created_by)
       VALUES ($1,'manual','[3031_1_]{100000}',$2,$3)`,
      [FAZENDA, cmd.src, cmd.createdBy]);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, erro: String(e.message ?? e) };
  } finally {
    await db.exec(`RESET ROLE;`);
  }
}

describe("falsificação de autoria pela API", () => {
  it("usuário autenticado NÃO consegue escrever source_device 'whatsapp:'", async () => {
    const db = await banco();
    const r = await inserir(db, "authenticated",
      { src: "whatsapp:Yuri|5577999604782", createdBy: USUARIO });
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/row-level security|violates/i);
  });

  it("nem com created_by nulo", async () => {
    const db = await banco();
    const r = await inserir(db, "authenticated",
      { src: "whatsapp:Yuri|5577999604782", createdBy: null });
    expect(r.ok).toBe(false);
  });

  it("nem forjando automação ('backend-reset:' / 'cloud-')", async () => {
    const db = await banco();
    for (const src of ["backend-reset:scheduled_shutdown:17h", "cloud-automation"]) {
      const r = await inserir(db, "authenticated", { src, createdBy: USUARIO });
      expect(`${src} → ${r.ok}`).toBe(`${src} → false`);
    }
  });

  it("o comando normal do painel continua passando", async () => {
    const db = await banco();
    const r = await inserir(db, "authenticated",
      { src: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", createdBy: USUARIO });
    expect(r.ok).toBe(true);
  });

  it("e 'platform-scheduler', que o front legitimamente usa, também", async () => {
    const db = await banco();
    const r = await inserir(db, "authenticated",
      { src: "platform-scheduler", createdBy: USUARIO });
    expect(r.ok).toBe(true);
  });
});

describe("o serviço do WhatsApp (service_role) continua operando", () => {
  it("grava comando sem created_by com a identidade no source_device", async () => {
    const db = await banco();
    const r = await inserir(db, "service_role",
      { src: "whatsapp:Yuri Seibert|5577999604782", createdBy: null });
    expect(r.ok).toBe(true);

    const linha = (await db.query<any>(
      `SELECT created_by, source_device FROM public.commands`)).rows[0];
    expect(linha.created_by).toBeNull();
    expect(linha.source_device).toBe("whatsapp:Yuri Seibert|5577999604782");
  });

  it("mas comando manual sem created_by e sem canal conhecido continua barrado", async () => {
    const db = await banco();
    const r = await inserir(db, "service_role", { src: "web", createdBy: null });
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/sem created_by/i);
  });

  it("e com created_by continua passando como sempre", async () => {
    const db = await banco();
    const r = await inserir(db, "service_role", { src: "web", createdBy: USUARIO });
    expect(r.ok).toBe(true);
  });
});
