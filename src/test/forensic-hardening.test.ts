// @vitest-environment node
// FASE 2D — hardening da trilha forense. Postgres 17 real (pglite), com SET ROLE:
// superusuário ignora RLS, e um teste que rodasse como superuser não provaria nada.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs"; import path from "node:path";

const REPO = path.resolve(__dirname, "../..");
const rd = (f: string) => fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");
const M1 = rd("20260905140000_technical_events_center.sql");
const M2 = rd("20260905160000_technical_events_client_event_id.sql");
const M3 = rd("20260906120000_record_agent_technical_event.sql");
const M4 = rd("20260906140000_forensic_trail_hardening.sql");

const BOOT = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid; $$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;
CREATE TYPE public.app_role AS ENUM ('owner','admin','operator','viewer','supervisor');
CREATE TABLE public.farms (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
CREATE TABLE public.equipments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid);
CREATE TABLE public.platform_admins (user_id uuid PRIMARY KEY);
CREATE TABLE public.user_roles (user_id uuid, farm_id uuid, role public.app_role);
CREATE TABLE public.device_licenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid NOT NULL,
  license_key text, machine_id_hash text, fingerprint jsonb, ip_address text,
  agent_version text, activated_at timestamptz DEFAULT now(),
  last_seen_at timestamptz DEFAULT now(), revoked_at timestamptz,
  current_token_jti text, current_token_expires_at timestamptz);
ALTER TABLE public.device_licenses ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.device_licenses TO authenticated;
CREATE OR REPLACE FUNCTION public.is_platform_admin(_u uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id=_u); $$;
CREATE OR REPLACE FUNCTION public.is_platform_staff(_u uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id=_u); $$;
CREATE OR REPLACE FUNCTION public.has_farm_role(_u uuid,_f uuid,_r public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_u AND farm_id=_f AND role=_r); $$;
CREATE OR REPLACE FUNCTION public.has_farm_access(_u uuid,_f uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_u AND farm_id=_f); $$;
-- policy VULNERÁVEL, tal como estava em produção: é ela que a 2D remove.
CREATE POLICY device_licenses_select_platform_staff ON public.device_licenses
  FOR SELECT TO authenticated USING (public.is_platform_staff(auth.uid()));
CREATE POLICY device_licenses_select_farm_owner ON public.device_licenses
  FOR SELECT TO authenticated USING (public.has_farm_role(auth.uid(), farm_id, 'owner'::app_role));
`;

let db: PGlite;
let FARM = "", FARM2 = "", OWNER = "", OWNER2 = "", STAFF = "", NINGUEM = "";
let JTI = "", JTI_EXP = "", JTI_REV = "", JTI_NULL = "";
interface Rows { rows: unknown[] }

async function asUser(role: "anon" | "authenticated", u: string | null, sql: string): Promise<Rows> {
  await db.exec(`SET ROLE ${role};`);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [u ?? ""]);
  try { return (await db.query(sql)) as Rows; } finally { await db.exec(`RESET ROLE;`); }
}
const negado = async (r: "anon" | "authenticated", u: string | null, sql: string) => {
  try { const x = await asUser(r, u, sql); return Array.isArray(x.rows) ? x.rows.length === 0 : true; }
  catch { return true; }
};
const rpc = async (jti: string, tipo = "plc_offline") => {
  const r = await db.query<{ id: string | null }>(
    `SELECT public.record_agent_technical_event($1::uuid,$2,'plc','error') AS id`, [jti, tipo]);
  return r.rows[0].id;
};

beforeEach(async () => {
  db = new PGlite();
  await db.exec(BOOT);
  for (const m of [M1, M2, M3, M4]) await db.exec(m);
  const mk = async () => (await db.query<{ id: string }>(
    `INSERT INTO auth.users (id) VALUES (gen_random_uuid()) RETURNING id`)).rows[0].id;
  OWNER = await mk(); OWNER2 = await mk(); STAFF = await mk(); NINGUEM = await mk();
  await db.query(`INSERT INTO public.platform_admins VALUES ($1)`, [STAFF]);
  FARM = (await db.query<{ id: string }>(`INSERT INTO public.farms (name) VALUES ('SOSSEGO') RETURNING id`)).rows[0].id;
  FARM2 = (await db.query<{ id: string }>(`INSERT INTO public.farms (name) VALUES ('SEMEAR') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO public.user_roles VALUES ($1,$2,'owner'),($3,$4,'owner')`,
    [OWNER, FARM, OWNER2, FARM2]);
  const lic = async (farm: string, exp: string | null, rev: boolean) =>
    (await db.query<{ j: string }>(
      `INSERT INTO public.device_licenses (farm_id,current_token_jti,current_token_expires_at,revoked_at)
       VALUES ($1, gen_random_uuid()::text, $2::timestamptz, $3) RETURNING current_token_jti AS j`,
      [farm, exp, rev ? new Date().toISOString() : null])).rows[0].j;
  JTI      = await lic(FARM, new Date(Date.now() + 600_000).toISOString(), false);
  JTI_EXP  = await lic(FARM, new Date(Date.now() - 600_000).toISOString(), false);
  JTI_REV  = await lic(FARM, new Date(Date.now() + 600_000).toISOString(), true);
  JTI_NULL = await lic(FARM, null, false);
}, 90_000);
afterEach(async () => { await db?.close(); });

describe("1 a 3. o jti saiu da vista do cliente", () => {
  it("1. o dono da fazenda NÃO lê current_token_jti", async () => {
    expect(await negado("authenticated", OWNER,
      `SELECT current_token_jti FROM public.device_licenses`)).toBe(true);
  });
  it("2. anon não lê nada de device_licenses", async () => {
    expect(await negado("anon", null, `SELECT * FROM public.device_licenses`)).toBe(true);
  });
  it("3. dono de outra fazenda também não lê", async () => {
    expect(await negado("authenticated", OWNER2, `SELECT current_token_jti FROM public.device_licenses`)).toBe(true);
    expect(await negado("authenticated", NINGUEM, `SELECT * FROM public.device_licenses`)).toBe(true);
  });
  it("staff da plataforma continua vendo (operação preservada)", async () => {
    const r = await asUser("authenticated", STAFF, `SELECT id FROM public.device_licenses`);
    expect(r.rows.length).toBeGreaterThan(0);
  });
  it("o dono continua vendo o estado do device — sem campo sensível", async () => {
    const r = await asUser("authenticated", OWNER,
      `SELECT * FROM public.farm_device_status('${FARM}')`);
    expect(r.rows.length).toBeGreaterThan(0);
    const cols = Object.keys(r.rows[0] as Record<string, unknown>);
    for (const proibida of ["current_token_jti", "license_key", "fingerprint",
                            "machine_id_hash", "ip_address", "current_token_expires_at"]) {
      expect(cols, proibida).not.toContain(proibida);
    }
  });
  it("o dono NÃO enxerga device de outra fazenda pela RPC", async () => {
    const r = await asUser("authenticated", OWNER, `SELECT * FROM public.farm_device_status('${FARM2}')`);
    expect(r.rows).toHaveLength(0);
  });
});

describe("4 a 10. autenticação da ingestão", () => {
  it("4. jti válido → evento entra", async () => { expect(await rpc(JTI)).toBeTruthy(); });
  it("5. jti expirado → rejeita", async () => { expect(await rpc(JTI_EXP)).toBeNull(); });
  it("6. expires_at NULL → rejeita (NULL é inválido)", async () => {
    expect(await rpc(JTI_NULL)).toBeNull();
  });
  it("7. jti revogado → rejeita", async () => { expect(await rpc(JTI_REV)).toBeNull(); });
  it("8. jti inexistente → rejeita", async () => {
    expect(await rpc("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
  it("9. jti duplicado é impossível pelo índice UNIQUE", async () => {
    await expect(db.query(
      `INSERT INTO public.device_licenses (farm_id,current_token_jti,current_token_expires_at)
       VALUES ($1,$2,now()+interval '10 min')`, [FARM2, JTI])).rejects.toThrow();
  });
  it("10. não existe parâmetro de fazenda — farm_id vem da licença", async () => {
    // escopo: SÓ a RPC do Agent. `farm_device_status(_farm_id)` legitimamente
    // recebe fazenda — ela é consulta do dono, não ingestão.
    const c = M4.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    const rpcAgent = c.slice(c.indexOf("FUNCTION public.record_agent_technical_event"));
    expect(rpcAgent.slice(0, rpcAgent.indexOf(") RETURNS uuid"))).not.toMatch(/_farm_id/);
    expect(rpcAgent).toContain("SELECT dl.farm_id INTO v_farm");
    // e o evento gravado pertence à fazenda da licença
    await rpc(JTI);
    const r = await db.query<{ farm_id: string }>(`SELECT farm_id FROM public.technical_events`);
    expect(r.rows[0].farm_id).toBe(FARM);
  });
});

describe("11 a 15. escrita e procedência", () => {
  it("11. INSERT direto por anon e authenticated comum → bloqueado", async () => {
    const sql = `INSERT INTO public.technical_events (farm_id,event_type,category)
                 VALUES ('${FARM}','forjado','system')`;
    expect(await negado("anon", null, sql)).toBe(true);
    expect(await negado("authenticated", OWNER, sql)).toBe(true);
    expect(await negado("authenticated", NINGUEM, sql)).toBe(true);
  });
  it("12 e 13. UPDATE e DELETE bloqueados para todos", async () => {
    await rpc(JTI);
    await expect(db.query(`UPDATE public.technical_events SET event_type='x'`)).rejects.toThrow();
    await expect(db.query(`DELETE FROM public.technical_events`)).rejects.toThrow();
    expect(await negado("authenticated", STAFF, `UPDATE public.technical_events SET event_type='x'`)).toBe(true);
  });
  it("14. attestation_source do Agent é 'agent', definido server-side", async () => {
    await rpc(JTI);
    const r = await db.query<{ a: string }>(`SELECT attestation_source a FROM public.technical_events`);
    expect(r.rows[0].a).toBe("agent");
  });
  it("15. forjar attestation_source é impossível: não há parâmetro", () => {
    const c = M4.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    // o TIPO chama-se tech_attestation_source; o que não pode existir é um
    // PARÂMETRO de procedência na assinatura da RPC do Agent.
    const assinatura = c.slice(c.indexOf("FUNCTION public.record_agent_technical_event"));
    expect(assinatura.slice(0, assinatura.indexOf(") RETURNS uuid"))).not.toMatch(/attestation/);
    expect(c).toContain("'agent'::public.tech_attestation_source");
  });
  it("o caminho da Cloud grava 'cloud', não 'agent'", async () => {
    await db.query(`SELECT public.record_technical_event($1::uuid,'cloud_evt',`
      + `'system'::public.tech_event_category)`, [FARM]);
    const r = await db.query<{ a: string }>(
      `SELECT attestation_source a FROM public.technical_events WHERE event_type='cloud_evt'`);
    expect(r.rows[0].a).toBe("cloud");
  });
});

describe("9. a FASE 2C fica intacta", () => {
  it("monitor, buffer e hooks do Agent não foram tocados", () => {
    const agent = fs.readFileSync(path.join(REPO, "electron-agent/main.cjs"), "utf8");
    for (const s of ['techEnqueueSafe("plc_offline"', 'techEnqueueSafe("plc_online"',
                     'techEnqueueSafe("bridge_offline"', 'techEnqueueSafe("serial_error"',
                     "TECH.applyProbe(techMonitor,", "TECH.bufferAppend"]) {
      expect(agent, s).toContain(s);
    }
    expect(agent).toContain("const SAFETY_WINDOW_MS = 120_000;");
    expect(agent).toContain("const POLL_INTERVAL_MS = 10_000;");
  });
});

describe("PILOTO — rate limit por tipo com discriminador", () => {
  const emitir = async (jti: string, tipo: string, gateway: string | null, n: number) => {
    let ok = 0;
    for (let i = 0; i < n; i++) {
      const r = await db.query<{ id: string | null }>(
        `SELECT public.record_agent_technical_event($1::uuid,$2,'plc','error','agent',
           NULL,$3) AS id`, [jti, tipo, gateway]);
      if (r.rows[0].id) ok++;
    }
    return ok;
  };

  it("uma PLC em laço é contida em 10/min", async () => {
    expect(await emitir(JTI, "plc_offline", "1314", 25)).toBe(10);
  });

  it("30 PLCs caindo juntas NÃO perdem evidência — teto é por TSNN", async () => {
    // Cenário real de perda total de comunicação: cada gateway tem orçamento
    // próprio. Um teto global por tipo censuraria justamente este incidente.
    let ok = 0;
    for (let i = 0; i < 30; i++) ok += await emitir(JTI, "plc_offline", `TS${i}`, 1);
    expect(ok).toBe(30);
  });

  it("tipos sem discriminador têm 30x de folga sobre o máximo legítimo", async () => {
    // Histerese: 3 sondagens falhas a 60s = 3 min entre transições -> ~1/3min.
    expect(await emitir(JTI, "internet_offline", null, 12)).toBe(10);
  });

  it("o teto de um tipo não consome o de outro", async () => {
    await emitir(JTI, "plc_offline", "1314", 10);
    expect(await emitir(JTI, "plc_online", "1314", 1)).toBe(1);
  });

  it("o teto global de 120/min continua como defesa secundária", () => {
    const c = M4.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(c).toContain("IF v_recent >= 120 THEN RETURN NULL; END IF;");
    expect(c).toContain("IF v_same >= 10 THEN RETURN NULL; END IF;");
  });
});
