// @vitest-environment node
// Trava operacional de comutação: 30s por poço, armada pela CONFIRMAÇÃO FÍSICA.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs"; import path from "node:path";
const REPO = path.resolve(__dirname, "../..");
const mig = (f: string) => fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");

const FARM = "aaaa0000-0000-0000-0000-00000000000f";
const P12 = "bbbb0000-0000-0000-0000-000000000012";
const P10 = "bbbb0000-0000-0000-0000-000000000010";
const P11 = "bbbb0000-0000-0000-0000-000000000011";
const P06 = "bbbb0000-0000-0000-0000-000000000006";
const ADMIN = "cccc0000-0000-0000-0000-0000000000ad";

const BOOT = `
CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE anon;
CREATE TYPE public.command_type AS ENUM ('manual','polling','reset','automation');
CREATE TYPE public.command_status AS ENUM ('pending','sent','delivered','executed','timeout','error','cancelled');
CREATE TABLE public.farms (id uuid PRIMARY KEY, name text);
CREATE TABLE public.equipments (id uuid PRIMARY KEY, farm_id uuid, name text,
  last_outputs_state text, maintenance_mode boolean DEFAULT false);
CREATE TABLE public.commands (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, equipment_id uuid,
  type public.command_type DEFAULT 'manual', status public.command_status DEFAULT 'pending',
  priority int DEFAULT 5, frame text, source_device text, created_by uuid,
  created_at timestamptz DEFAULT now());
CREATE TABLE public.agent_technical_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid,
  equipment_id uuid, kind text, occurred_at timestamptz DEFAULT now(), details jsonb DEFAULT '{}');
INSERT INTO public.farms VALUES ('${FARM}','Sykue');
INSERT INTO public.equipments (id,farm_id,name,last_outputs_state) VALUES
  ('${P12}','${FARM}','POÇO 12 R6','100000'),
  ('${P10}','${FARM}','POÇO 10 R5','100000'),
  ('${P11}','${FARM}','POÇO 11 R06','000000'),
  ('${P06}','${FARM}','POÇO 06 R1/R4','000000');`;

async function mk() {
  const d = await PGlite.create();
  await d.exec(BOOT);
  await d.exec(mig("20260814210000_switching_protection_lock.sql"));
  return d;
}
/** confirmação física: o agente escreve o novo payload de saídas */
const confirm = (d: PGlite, id: string, outs: string) =>
  d.query(`UPDATE public.equipments SET last_outputs_state=$1 WHERE id=$2`, [outs, id]);
const cmd = (d: PGlite, id: string, o: { prio?: number; src?: string } = {}) =>
  d.query(`INSERT INTO public.commands (farm_id,equipment_id,frame,created_by,priority,source_device)
           VALUES ($1,$2,'{1}',$3,$4,$5)`, [FARM, id, ADMIN, o.prio ?? 5, o.src ?? "web"]);
const status = async (d: PGlite, id: string) =>
  (await d.query<any>(`SELECT * FROM public.switching_protection_status($1)`, [id])).rows[0];

let d: PGlite;
beforeEach(async () => { d = await mk(); });

describe("a trava nasce da confirmação física", () => {
  it("1+2. confirmação OFF e ON armam 30s", async () => {
    await confirm(d, P12, "000000");                       // ON → OFF confirmado
    let s = await status(d, P12);
    expect(s.locked).toBe(true);
    expect(s.seconds_remaining).toBeGreaterThan(25);
    expect(s.last_state).toBe(false);

    await d.query(`UPDATE public.equipments SET command_lock_until = now() - interval '1 s' WHERE id=$1`, [P12]);
    await confirm(d, P12, "100000");                       // OFF → ON confirmado
    s = await status(d, P12);
    expect(s.locked).toBe(true);
    expect(s.last_state).toBe(true);
  });

  it("clique/comando pendente NÃO arma a trava", async () => {
    await cmd(d, P11);                                     // só o comando, sem confirmação
    expect((await status(d, P11)).locked).toBe(false);
  });

  it("leitura repetida do mesmo estado não rearma", async () => {
    await confirm(d, P12, "000000");
    const t1 = (await status(d, P12)).last_confirmed_at;
    await confirm(d, P12, "000000");                       // mesmo estado
    expect((await status(d, P12)).last_confirmed_at).toEqual(t1);
  });
});

describe("recusa server-side durante a trava", () => {
  it("3. comando dentro da janela é RECUSADO com mensagem clara", async () => {
    await confirm(d, P12, "000000");
    await expect(cmd(d, P12)).rejects.toThrow(/Aguarde \d+ segundos para novo comando/);
    await expect(cmd(d, P12)).rejects.toThrow(/confirmada às \d\d:\d\d:\d\d/);
  });

  it("8. comando recusado NÃO cria linha em commands", async () => {
    await confirm(d, P12, "000000");
    try { await cmd(d, P12); } catch { /* esperado */ }
    const n = await d.query<any>(`SELECT count(*)::int n FROM public.commands WHERE equipment_id=$1`, [P12]);
    expect(Number(n.rows[0].n)).toBe(0);
  });

  it("pré-checagem devolve a mensagem E registra a recusa na trilha técnica", async () => {
    await confirm(d, P12, "000000");
    const r = await d.query<any>(
      `SELECT * FROM public.check_switching_protection($1,$2,'web')`, [P12, ADMIN]);
    expect(r.rows[0].allowed).toBe(false);
    expect(r.rows[0].seconds_remaining).toBeGreaterThan(0);
    expect(r.rows[0].message).toMatch(/Aguarde \d+ segundos para novo comando/);

    const t = await d.query<any>(
      `SELECT details->>'reason' r, (details->>'seconds_remaining')::int s FROM public.agent_technical_events`);
    expect(t.rows[0].r).toBe("switching_protection_active");
    expect(t.rows[0].s).toBeGreaterThan(0);
    // e a recusa NÃO virou comando nem evento oficial
    const n = await d.query<any>(`SELECT count(*)::int n FROM public.commands`);
    expect(Number(n.rows[0].n)).toBe(0);
  });

  it("pré-checagem libera quando a trava expira", async () => {
    await confirm(d, P12, "000000");
    await d.query(`UPDATE public.equipments SET command_lock_until = now() - interval '1 ms' WHERE id=$1`, [P12]);
    const r = await d.query<any>(`SELECT * FROM public.check_switching_protection($1)`, [P12]);
    expect(r.rows[0].allowed).toBe(true);
  });

  it("4. passados os 30s o comando é ACEITO", async () => {
    await confirm(d, P12, "000000");
    await d.query(`UPDATE public.equipments SET command_lock_until = now() - interval '1 ms' WHERE id=$1`, [P12]);
    await cmd(d, P12);
    const n = await d.query<any>(`SELECT count(*)::int n FROM public.commands WHERE equipment_id=$1`, [P12]);
    expect(Number(n.rows[0].n)).toBe(1);
  });

  it("6. trava do POÇO 12 não bloqueia 10, 11 nem 06", async () => {
    await confirm(d, P12, "000000");
    await cmd(d, P10); await cmd(d, P11); await cmd(d, P06);
    const n = await d.query<any>(
      `SELECT count(*)::int n FROM public.commands WHERE equipment_id <> $1`, [P12]);
    expect(Number(n.rows[0].n)).toBe(3);
    expect((await status(d, P10)).locked).toBe(false);
  });

  it("10. segurança/proteção/emergência continuam prioritárias", async () => {
    await confirm(d, P12, "000000");
    await cmd(d, P12, { prio: 0 });                        // reset/safety
    await cmd(d, P12, { src: "backend-reset:auto" });
    await cmd(d, P12, { src: "forced-shutdown" });
    await cmd(d, P12, { src: "cloud-protective-off" });
    const n = await d.query<any>(`SELECT count(*)::int n FROM public.commands WHERE equipment_id=$1`, [P12]);
    expect(Number(n.rows[0].n)).toBe(4);
  });

  it("polling nunca é bloqueado", async () => {
    await confirm(d, P12, "000000");
    await d.query(`INSERT INTO public.commands (farm_id,equipment_id,type,frame) VALUES ($1,$2,'polling','{0}')`,
      [FARM, P12]);
    const n = await d.query<any>(`SELECT count(*)::int n FROM public.commands WHERE type='polling'`);
    expect(Number(n.rows[0].n)).toBe(1);
  });
});

describe("caso real POÇO 12 R6 e concorrência", () => {
  it("11. OFF → trava → recusa em 5s → liberação → ON, autoria preservada", async () => {
    await confirm(d, P12, "000000");                       // bomba confirma OFF
    expect((await status(d, P12)).locked).toBe(true);

    await expect(cmd(d, P12)).rejects.toThrow(/Aguarde/);   // tentativa em 5s

    await d.query(`UPDATE public.equipments SET command_lock_until = now() - interval '1 ms' WHERE id=$1`, [P12]);
    await cmd(d, P12);                                      // liberado
    await confirm(d, P12, "100000");                        // confirma ON

    const c = await d.query<any>(`SELECT created_by FROM public.commands WHERE equipment_id=$1`, [P12]);
    expect(c.rows).toHaveLength(1);
    expect(c.rows[0].created_by).toBe(ADMIN);               // autoria remota intacta
    const s = await status(d, P12);
    expect(s.locked).toBe(true);                            // nova trava de 30s
    expect(s.last_state).toBe(true);
  });

  it("5. duas requisições simultâneas não passam juntas", async () => {
    await confirm(d, P12, "000000");
    const r = await Promise.allSettled([cmd(d, P12), cmd(d, P12)]);
    expect(r.every((x) => x.status === "rejected")).toBe(true);
    const n = await d.query<any>(`SELECT count(*)::int n FROM public.commands WHERE equipment_id=$1`, [P12]);
    expect(Number(n.rows[0].n)).toBe(0);
  });

  it("9. atuação LOCAL durante a trava reinicia a trava", async () => {
    await confirm(d, P12, "000000");
    const t1 = (await status(d, P12)).last_confirmed_at;
    await confirm(d, P12, "100000");                       // botoeira física
    const s = await status(d, P12);
    expect(s.locked).toBe(true);
    expect(new Date(s.last_confirmed_at).getTime()).toBeGreaterThanOrEqual(new Date(t1).getTime());
    expect(s.last_state).toBe(true);
  });

  it("janela é configurável por fazenda", async () => {
    await d.query(`UPDATE public.farms SET switching_protection_seconds = 90 WHERE id=$1`, [FARM]);
    await confirm(d, P11, "100000");
    expect((await status(d, P11)).seconds_remaining).toBeGreaterThan(80);
  });
});

// ── Espelho no frontend (o servidor continua sendo a fonte de verdade) ───────
describe("frontend espelha a trava", () => {
  const CARD = fs.readFileSync(path.join(REPO, "src/components/dashboard/PumpCard.tsx"), "utf8");
  const HOOK = fs.readFileSync(path.join(REPO, "src/hooks/useDashboardEquipment.ts"), "utf8");
  const TABLE = fs.readFileSync(path.join(REPO, "src/components/dashboard/PumpTable.tsx"), "utf8");

  it("7. hook propaga command_lock_until vindo do Realtime", () => {
    expect(HOOK).toContain("commandLockUntil");
    expect(HOOK).toContain("command_lock_until");
    expect(TABLE).toContain("commandLockUntil?: number;");
  });

  it("card mostra badge com contagem e hora da última confirmação", () => {
    expect(CARD).toContain("Proteção de comutação · {lockSecondsLeft}s");
    expect(CARD).toContain('data-testid="switching-lock"');
    expect(CARD).toContain("lastConfirmedLabel");
  });

  it("controles do poço ficam desabilitados durante a trava", () => {
    expect(CARD).toMatch(/disabled=\{[^}]*switchingLocked/s);
  });

  it("libera sozinho: contagem regressiva por segundo só enquanto travado", () => {
    expect(CARD).toContain("if (!lockUntil || Date.now() >= lockUntil) return;");
    expect(CARD).toContain("setTickNow(Date.now())");
  });

  it("o card NÃO decide o bloqueio — só espelha o valor do servidor", () => {
    // não existe cálculo local de trava a partir de clique/comando
    expect(CARD).toContain("const lockUntil = pump.commandLockUntil ?? 0;");
    expect(CARD).not.toMatch(/setCommandLock|lockUntil\s*=\s*Date\.now\(\)\s*\+/);
  });
});
