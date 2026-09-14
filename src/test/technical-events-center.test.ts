// @vitest-environment node
// Centro de Evidências Técnicas — FASE 1 (infraestrutura).
// Postgres 17 real (pglite) rodando a migration de verdade.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs"; import path from "node:path";

const REPO = path.resolve(__dirname, "../..");
const MIG = path.join(REPO, "supabase/migrations/20260905140000_technical_events_center.sql");
const MIG_SQL = fs.readFileSync(MIG, "utf8");
const HELPER = fs.readFileSync(path.join(REPO, "src/lib/technicalEvents.ts"), "utf8");

const BOOT = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid; $$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;
CREATE TABLE public.farms (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
CREATE TABLE public.equipments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, name text);
CREATE TABLE public.platform_admins (user_id uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION public.is_platform_admin(_u uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id=_u); $$;
CREATE TABLE public.farm_access (user_id uuid, farm_id uuid);
CREATE OR REPLACE FUNCTION public.has_farm_access(_u uuid, _f uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT EXISTS (SELECT 1 FROM public.farm_access WHERE user_id=_u AND farm_id=_f); $$;
`;

let db: PGlite; let FARM = "", EQ = "", ADMIN = "", MEMBRO = "", ESTRANHO = "";
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

beforeEach(async () => {
  db = new PGlite(); await db.exec(BOOT); await db.exec(MIG_SQL);
  const mk = async () => (await db.query<{ id: string }>(
    `INSERT INTO auth.users (id) VALUES (gen_random_uuid()) RETURNING id`)).rows[0].id;
  ADMIN = await mk(); MEMBRO = await mk(); ESTRANHO = await mk();
  await db.query(`INSERT INTO public.platform_admins VALUES ($1)`, [ADMIN]);
  FARM = (await db.query<{ id: string }>(
    `INSERT INTO public.farms (name) VALUES ('SOSSEGO') RETURNING id`)).rows[0].id;
  EQ = (await db.query<{ id: string }>(
    `INSERT INTO public.equipments (farm_id,name) VALUES ($1,'POÇO 01') RETURNING id`, [FARM])).rows[0].id;
  await db.query(`INSERT INTO public.farm_access VALUES ($1,$2)`, [MEMBRO, FARM]);
}, 90_000);
afterEach(async () => { await db?.close(); });

describe("estrutura e enums", () => {
  it("as 17 categorias, 4 severidades e 9 origens existem", async () => {
    const n = async (t: string) => Number((await db.query<{ c: number }>(
      `SELECT count(*)::int c FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname=$1`,
      [t])).rows[0].c);
    expect(await n("tech_event_category")).toBe(17);
    expect(await n("tech_event_severity")).toBe(4);
    expect(await n("tech_event_origin")).toBe(9);
  });

  it("todos os 7 índices exigidos existem", async () => {
    const r = await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename='technical_events'`);
    const defs = r.rows.map((x) => x.indexdef).join("\n");
    for (const col of ["created_at", "farm_id", "equipment_id", "category",
                       "severity", "event_type", "correlation_id"]) {
      expect(defs, col).toContain(col);
    }
  });

  it("grava um evento completo com payload e metadata", async () => {
    const r = await db.query<{ id: string }>(
      `SELECT public.record_technical_event($1,'polling_timeout','polling','warning','agent',
        $2,'1314','agent','3.25.66','v6',gen_random_uuid(),
        '{"timeout_ms":13000,"rssi":-97}'::jsonb,'{"nota":"x"}'::jsonb) AS id`, [FARM, EQ]);
    expect(r.rows[0].id).toBeTruthy();
    const ev = await db.query<{ event_type: string; payload: Record<string, number> }>(
      `SELECT event_type, payload FROM public.technical_events`);
    expect(ev.rows[0].event_type).toBe("polling_timeout");
    expect(ev.rows[0].payload.rssi).toBe(-97);
  });

  it("eventos de infraestrutura não precisam de equipamento", async () => {
    const r = await db.query<{ id: string }>(
      `SELECT public.record_technical_event($1,'internet_offline','internet','critical','agent') AS id`, [FARM]);
    expect(r.rows[0].id).toBeTruthy();
  });

  it("correlation_id agrupa a cadeia de um incidente", async () => {
    const cid = (await db.query<{ c: string }>(`SELECT gen_random_uuid() c`)).rows[0].c;
    for (const [t, c] of [["heartbeat_missed","heartbeat"],["internet_offline","internet"],
                          ["plc_offline","plc"],["polling_timeout","polling"],
                          ["internet_recovered","internet"]] as const) {
      await db.query(`SELECT public.record_technical_event($1,$2,$3::public.tech_event_category,
        'error','agent',NULL,NULL,NULL,NULL,NULL,$4)`, [FARM, t, c, cid]);
    }
    const r = await db.query<{ n: number }>(
      `SELECT count(*)::int n FROM public.technical_events WHERE correlation_id=$1`, [cid]);
    expect(Number(r.rows[0].n)).toBe(5);
  });

  it("payload/metadata precisam ser objeto JSON", async () => {
    await expect(db.query(
      `INSERT INTO public.technical_events (farm_id,event_type,category,payload)
       VALUES ($1,'x','system','[1,2]'::jsonb)`, [FARM])).rejects.toThrow();
  });
});

describe("retenção permanente e append-only", () => {
  beforeEach(async () => {
    await db.query(`SELECT public.record_technical_event($1,'agent_started','startup')`, [FARM]);
  });

  it("UPDATE e DELETE são bloqueados", async () => {
    await expect(db.query(`UPDATE public.technical_events SET event_type='z'`)).rejects.toThrow();
    await expect(db.query(`DELETE FROM public.technical_events`)).rejects.toThrow();
    const r = await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.technical_events`);
    expect(Number(r.rows[0].n)).toBe(1);
  });

  it("nem authenticated tem privilégio de UPDATE/DELETE", async () => {
    expect(await negado("authenticated", ADMIN, `UPDATE public.technical_events SET event_type='z'`)).toBe(true);
    expect(await negado("authenticated", ADMIN, `DELETE FROM public.technical_events`)).toBe(true);
  });

  it("NÃO existe rotina de purga/TTL para esta tabela", () => {
    const codigo = MIG_SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(codigo).not.toMatch(/DELETE\s+FROM\s+public\.technical_events/i);
    expect(codigo).not.toMatch(/purge_technical_events|cleanup_technical_events/i);
    expect(codigo).not.toMatch(/cron\.schedule/i);
  });

  it("apagar o equipamento não apaga a evidência nem trava a exclusão", async () => {
    await db.query(`SELECT public.record_technical_event($1,'plc_offline','plc','error','plc',$2)`, [FARM, EQ]);
    await db.query(`DELETE FROM public.equipments WHERE id=$1`, [EQ]);
    const r = await db.query<{ n: number; equipment_id: string | null }>(
      `SELECT count(*)::int n FROM public.technical_events`);
    expect(Number(r.rows[0].n)).toBe(2);
  });
});

describe("RLS", () => {
  beforeEach(async () => {
    await db.query(`SELECT public.record_technical_event($1,'agent_started','startup')`, [FARM]);
  });
  it("anon não lê nem escreve", async () => {
    expect(await negado("anon", null, `SELECT * FROM public.technical_events`)).toBe(true);
    expect(await negado("anon", null,
      `INSERT INTO public.technical_events (farm_id,event_type,category) VALUES ('${FARM}','x','system')`)).toBe(true);
  });
  it("o REVOKE de anon é explícito (RLS é a 2ª camada, não a única)", () => {
    // A sabotagem "GRANT SELECT TO anon" não quebra o teste de comportamento,
    // porque a RLS continua barrando. Isso é defesa em profundidade — mas o
    // REVOKE precisa de cobertura própria, senão some sem ninguém notar.
    const codigo = MIG_SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(codigo).toMatch(/REVOKE ALL ON public\.technical_events FROM PUBLIC, anon;/);
    expect(codigo).toMatch(/REVOKE ALL ON FUNCTION public\.record_technical_event\([\s\S]*?\) FROM PUBLIC, anon;/);
    expect(codigo).not.toMatch(/GRANT[^;]*\bTO\b[^;]*\banon\b/);
    // e o GRANT da tabela nunca pode incluir UPDATE/DELETE
    expect(codigo).toMatch(/GRANT SELECT, INSERT ON public\.technical_events TO authenticated;/);
  });

  it("usuário sem acesso à fazenda não lê", async () => {
    const r = await asUser("authenticated", ESTRANHO, `SELECT * FROM public.technical_events`);
    expect(r.rows).toHaveLength(0);
  });
  it("membro da fazenda lê a própria; admin lê tudo", async () => {
    expect((await asUser("authenticated", MEMBRO, `SELECT * FROM public.technical_events`)).rows.length).toBeGreaterThan(0);
    expect((await asUser("authenticated", ADMIN, `SELECT * FROM public.technical_events`)).rows.length).toBeGreaterThan(0);
  });
});

describe("BARREIRA: auditoria não toca na operação", () => {
  const PROIBIDOS = ["desired_running", "pending_command_id", "command_blocked_until",
    "public.commands", "automation_schedules", "automation_engine", "scheduled_automations",
    "run_automation_tick", "run_peak_hour_tick", "enqueue_reset_pump_command",
    "last_outputs_state", "platform_set_farm_suspended", "license_key"];
  const codigo = MIG_SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

  it("nenhum símbolo operacional no código da migration", () => {
    for (const p of PROIBIDOS) expect(codigo, p).not.toContain(p);
  });

  it("a migration só escreve na própria tabela", () => {
    expect(codigo).not.toMatch(/UPDATE\s+public\.(farms|equipments|commands)/i);
    expect(codigo).not.toMatch(/ALTER\s+TABLE\s+public\.(farms|equipments|commands)/i);
    const inserts = codigo.match(/INSERT INTO public\.[a-z_]+/g) ?? [];
    for (const i of inserts) expect(i).toBe("INSERT INTO public.technical_events");
  });

  it("gravar evento NUNCA levanta exceção — auditoria não derruba operação", async () => {
    // farm inexistente viola a FK; a função tem de absorver e devolver NULL.
    const r = await db.query<{ id: string | null }>(
      `SELECT public.record_technical_event('00000000-0000-0000-0000-000000000000','x','system') AS id`);
    expect(r.rows[0].id).toBeNull();
    expect(codigo).toContain("EXCEPTION WHEN OTHERS THEN");
  });

  it("o helper TS é o único caminho e também não lança", () => {
    expect(HELPER).toContain("record_technical_event");
    expect(HELPER).toContain("try {");
    expect(HELPER).toContain("return null;");
    for (const p of PROIBIDOS) expect(HELPER, p).not.toContain(p);
  });

  it("FASE 1: nada chama o helper ainda (sem integração)", () => {
    const usos = fs.readdirSync(path.join(REPO, "src/lib"))
      .filter((f) => f.endsWith(".ts") && f !== "technicalEvents.ts")
      .filter((f) => fs.readFileSync(path.join(REPO, "src/lib", f), "utf8")
        .includes("recordTechnicalEvent"));
    expect(usos).toEqual([]);
  });
});
