// @vitest-environment node
// Migração NÃO destrutiva de Agent legado. Postgres 17 real (pglite).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs"; import path from "node:path";

const REPO = path.resolve(__dirname, "../..");
const MIG = fs.readFileSync(path.join(REPO,
  "supabase/migrations/20260908120000_agent_legacy_enrollment.sql"), "utf8");

const BOOT = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE TABLE public.farms (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text,
  license_key text, max_devices int, device_limit int DEFAULT 1, security_phase int DEFAULT 1);
CREATE TABLE public.provisioning_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid NOT NULL, token text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL, consumed_at timestamptz, consumed_by_machine_hash text,
  consumed_ip text, created_by uuid, created_at timestamptz DEFAULT now(),
  revoked_at timestamptz, revoked_reason text, notes text);
CREATE TABLE public.device_licenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid NOT NULL, license_key text,
  machine_id_hash text, fingerprint jsonb DEFAULT '{}', ip_address text, agent_version text,
  activated_at timestamptz, last_seen_at timestamptz, revoked_at timestamptz,
  current_token_jti text, current_token_expires_at timestamptz, revoked_reason text,
  fingerprint_mismatch_count int DEFAULT 0);
CREATE TABLE public.agent_credentials (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid, email text, auth_user_id uuid);
`;

const HASH = "a".repeat(64), HASH2 = "b".repeat(64);
let db: PGlite; let FARM = "", FARM2 = "", ADMIN = "";

const tok = async (farm: string, opts: { exp?: string; consumed?: string | null; revoked?: boolean } = {}) => {
  const t = "PROV-" + Math.random().toString(16).slice(2, 6).toUpperCase() + "-0000-0000-0000";
  await db.query(
    `INSERT INTO public.provisioning_tokens (farm_id,token,expires_at,created_by,consumed_at,
       consumed_by_machine_hash,revoked_at)
     VALUES ($1,$2,$3::timestamptz,$4,$5::timestamptz,$6,$7::timestamptz)`,
    [farm, t, opts.exp ?? new Date(Date.now() + 3.6e6).toISOString(), ADMIN,
     opts.consumed ?? null, opts.consumed ? HASH : null,
     opts.revoked ? new Date().toISOString() : null]);
  return t;
};
const enroll = async (t: string, hash = HASH) => (await db.query<{ r: Record<string, unknown> }>(
  `SELECT public.enroll_legacy_agent_device($1,$2,'{"cpu":"x"}'::jsonb,'3.25.66') AS r`,
  [t, hash])).rows[0].r;

beforeEach(async () => {
  db = new PGlite(); await db.exec(BOOT); await db.exec(MIG);
  ADMIN = (await db.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0].id;
  FARM = (await db.query<{ id: string }>(
    `INSERT INTO public.farms (name,license_key,max_devices) VALUES ('SOSSEGO','LK-PENDING',2) RETURNING id`)).rows[0].id;
  FARM2 = (await db.query<{ id: string }>(
    `INSERT INTO public.farms (name,max_devices) VALUES ('SEMEAR',2) RETURNING id`)).rows[0].id;
}, 90_000);
afterEach(async () => { await db?.close(); });

describe("6. device_license criada corretamente", () => {
  it("cria a linha com farm, hardware e versão — jti fica NULL para o agent-auth", async () => {
    const r = await enroll(await tok(FARM));
    expect(r.ok).toBe(true);
    const d = await db.query<Record<string, unknown>>(`SELECT * FROM public.device_licenses`);
    expect(d.rows).toHaveLength(1);
    const dev = d.rows[0];
    expect(dev.farm_id).toBe(FARM);
    expect(dev.machine_id_hash).toBe(HASH);
    expect(dev.agent_version).toBe("3.25.66");
    expect(dev.revoked_at).toBeNull();
    expect(dev.activated_at).toBeTruthy();
    expect(dev.last_seen_at).toBeTruthy();
    // agent-auth preenche depois; enrollment NÃO emite token
    expect(dev.current_token_jti).toBeNull();
    expect(dev.current_token_expires_at).toBeNull();
  });
});

describe("5. NÃO destrutivo — nada operacional é tocado", () => {
  it("não cria usuário nem agent_credentials", async () => {
    await enroll(await tok(FARM));
    const c = await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.agent_credentials`);
    expect(Number(c.rows[0].n)).toBe(0);
  });

  it("não lê nem escreve farms.license_key", async () => {
    const antes = (await db.query<{ k: string }>(`SELECT license_key k FROM public.farms WHERE id=$1`, [FARM])).rows[0].k;
    await enroll(await tok(FARM));
    const depois = (await db.query<{ k: string }>(`SELECT license_key k FROM public.farms WHERE id=$1`, [FARM])).rows[0].k;
    expect(depois).toBe(antes);
    const codigo = MIG.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(codigo).not.toMatch(/farms[\s\S]{0,40}license_key\s*=/);
    expect(codigo).not.toContain("createUser");
    expect(codigo).not.toContain("agent_credentials");
    expect(codigo).not.toContain("agent_writer");
  });

  it("não altera security_phase — essa ordem é do procedimento, não da função", async () => {
    await enroll(await tok(FARM));
    const f = await db.query<{ p: number }>(`SELECT security_phase p FROM public.farms WHERE id=$1`, [FARM]);
    expect(Number(f.rows[0].p)).toBe(1);
    const codigo = MIG.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(codigo).not.toContain("security_phase");
  });
});

describe("10. segurança da autorização one-shot", () => {
  it("token expirado → rejeita", async () => {
    const r = await enroll(await tok(FARM, { exp: new Date(Date.now() - 1000).toISOString() }));
    expect(r).toMatchObject({ ok: false, error: "token_expired" });
  });
  it("token revogado → rejeita", async () => {
    expect(await enroll(await tok(FARM, { revoked: true }))).toMatchObject({ ok: false, error: "token_revoked" });
  });
  it("token inexistente → rejeita", async () => {
    expect(await enroll("PROV-DEAD-BEEF-0000-0000")).toMatchObject({ ok: false, error: "token_not_found" });
  });
  it("token já usado por OUTRA máquina → rejeita", async () => {
    const t = await tok(FARM, { consumed: new Date().toISOString() });
    expect(await enroll(t, HASH2)).toMatchObject({ ok: false, error: "token_already_used" });
  });
  it("retry do MESMO hardware é idempotente, não reutilização", async () => {
    const t = await tok(FARM);
    const a = await enroll(t);
    const b = await enroll(t);
    expect(a.ok).toBe(true); expect(b.ok).toBe(true);
    expect(b.idempotent).toBe(true);
    const n = await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.device_licenses`);
    expect(Number(n.rows[0].n)).toBe(1);   // nunca duas licenças
  });
  it("machine_id inválido → rejeita", async () => {
    expect(await enroll(await tok(FARM), "curto")).toMatchObject({ ok: false, error: "invalid_machine_id" });
  });
  it("máquina já vinculada a OUTRA fazenda → rejeita", async () => {
    await enroll(await tok(FARM2));
    expect(await enroll(await tok(FARM))).toMatchObject({ ok: false, error: "machine_bound_to_other_farm" });
  });
  it("não existe parâmetro de fazenda — provisionar outra farm é impossível", () => {
    const codigo = MIG.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    const assinatura = codigo.slice(codigo.indexOf("FUNCTION public.enroll_legacy_agent_device"));
    expect(assinatura.slice(0, assinatura.indexOf(") RETURNS jsonb"))).not.toMatch(/farm/);
    expect(codigo).toContain("v_tok.farm_id");
  });
  it("teto de dispositivos da fazenda é respeitado", async () => {
    await db.query(`UPDATE public.farms SET max_devices=1 WHERE id=$1`, [FARM]);
    await db.query(`INSERT INTO public.device_licenses (farm_id,machine_id_hash) VALUES ($1,$2)`,
      [FARM, "c".repeat(64)]);
    expect(await enroll(await tok(FARM))).toMatchObject({ ok: false, error: "device_limit_reached" });
  });
  it("o token registra QUEM autorizou e QUAL máquina consumiu", async () => {
    const t = await tok(FARM);
    await enroll(t);
    const r = await db.query<{ created_by: string; consumed_by_machine_hash: string; consumed_at: string }>(
      `SELECT created_by, consumed_by_machine_hash, consumed_at FROM public.provisioning_tokens WHERE token=$1`, [t]);
    expect(r.rows[0].created_by).toBe(ADMIN);
    expect(r.rows[0].consumed_by_machine_hash).toBe(HASH);
    expect(r.rows[0].consumed_at).toBeTruthy();
  });
});

describe("9. rollback — revogar a licença basta", () => {
  it("revogar não apaga histórico e libera nova migração", async () => {
    const r1 = await enroll(await tok(FARM));
    await db.query(`UPDATE public.device_licenses SET revoked_at=now(), revoked_reason='rollback piloto'`);
    const r2 = await enroll(await tok(FARM));   // token NOVO, mesma máquina
    expect(r2.ok).toBe(true);
    expect(r2.device_id).not.toBe(r1.device_id);
    const n = await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.device_licenses`);
    expect(Number(n.rows[0].n)).toBe(2);   // a revogada continua lá, auditável
  });
});
