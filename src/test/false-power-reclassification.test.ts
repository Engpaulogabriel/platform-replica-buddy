// @vitest-environment node
// A limpeza histórica usa o MESMO critério do writer novo: ≥4 BOMBAS DISTINTAS
// que desligaram sozinhas em 60s. Sem prova → backup + DELETE. Com prova →
// intocado. Outras categorias → jamais tocadas. Roda em Postgres real (pglite).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs"; import path from "node:path";

let db: PGlite; let FARM = "";

const MIGRATION = path.resolve(__dirname,
  "../../supabase/migrations/20260816040000_reclassify_false_power_alerts.sql");

/** Schema mínimo — igual ao de produção conferido em types.ts. */
const SCHEMA = `
  CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TYPE public.event_origin AS ENUM ('remote','local','auto','reading','system');
  CREATE TYPE public.event_action AS ENUM ('turn_on','turn_off','status_read','mode_change','reset','polling','pump_on','pump_off');
  CREATE TYPE public.event_result AS ENUM ('success','fail','pending','timeout');
  CREATE TYPE public.command_type AS ENUM ('polling','manual','config','server','repeater','diagnostic','service_test','automation');
  CREATE TYPE public.command_status AS ENUM ('pending','sent','executed','timeout','cancelled');
  CREATE TABLE public.farms (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
  CREATE TABLE public.farm_notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid NOT NULL,
    kind text NOT NULL DEFAULT 'failure', severity text NOT NULL DEFAULT 'info',
    title text NOT NULL, message text NOT NULL, source text, source_ref uuid,
    equipment_id uuid, resolved_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now());
  -- automation_log SEM noise_reason, exatamente como em produção.
  CREATE TABLE public.automation_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, equipment_id uuid,
    equipment_name text, occurred_at timestamptz, origin public.event_origin,
    action public.event_action, result public.event_result);
  CREATE TABLE public.site_health (farm_id uuid, agent_status text,
    com_connected boolean, last_error text, last_heartbeat timestamptz);
  CREATE TABLE public.commands (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    farm_id uuid, equipment_id uuid, type public.command_type,
    status public.command_status, source_device text, created_at timestamptz);
`;

/** Alerta de energia da regra antiga. */
async function alerta(offsetMin: number): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO public.farm_notifications (farm_id, kind, severity, title, message, source, source_ref, created_at)
     VALUES ($1,'failure','critical','Possível falta de energia',
             '5 equipamentos perderam comunicação simultaneamente','falta_energia',
             gen_random_uuid(), now() - make_interval(mins => $2)) RETURNING id`,
    [FARM, offsetMin]);
  return r.rows[0].id;
}

/** N bombas distintas desligando de 5 em 5s, perto do horário do alerta. */
async function desligamentos(n: number, offsetMin: number,
                             origin = "reading", action = "turn_off") {
  for (let i = 0; i < n; i++) {
    await db.query(
      `INSERT INTO public.automation_log
         (farm_id, equipment_id, equipment_name, occurred_at, origin, action, result)
       VALUES ($1, gen_random_uuid(), $2,
               now() - make_interval(mins => $3) + make_interval(secs => $4),
               $5::public.event_origin, $6::public.event_action, 'success')`,
      [FARM, `BOMBA ${i}`, offsetMin, i * 5, origin, action]);
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(fs.readFileSync(MIGRATION, "utf8"));
  const f = await db.query<{ id: string }>(
    `INSERT INTO public.farms (name) VALUES ('Fazenda Teste') RETURNING id`);
  FARM = f.rows[0].id;
}, 60_000);

afterAll(async () => { await db?.close(); });

describe("a migration aplica em um schema igual ao de produção", () => {
  it("não depende de automation_log.noise_reason (coluna inexistente em produção)", () => {
    expect(fs.readFileSync(MIGRATION, "utf8")).not.toMatch(/l\d?\.noise_reason/);
  });

  it("não depende de farm_notifications.details (coluna inexistente em produção)", async () => {
    const r = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name='farm_notifications' AND column_name='details'`);
    expect(r.rows[0].n).toBe(0);   // provou que aplicou sem a coluna
  });
});

describe("diagnóstico — separa falso de legítimo", () => {
  it("alerta sem nenhuma transição → sem prova", async () => {
    await alerta(60);
    const r = await db.query<{ tem_prova: boolean; bombas_na_janela: string }>(
      `SELECT tem_prova, bombas_na_janela FROM public.false_power_alerts(168)`);
    expect(r.rows[0].tem_prova).toBe(false);
    expect(Number(r.rows[0].bombas_na_janela)).toBe(0);
  });

  it("3 bombas não bastam; 4 fecham a prova", async () => {
    await db.exec(`DELETE FROM public.farm_notifications; DELETE FROM public.automation_log;`);
    await alerta(30); await desligamentos(3, 30);
    let r = await db.query<{ tem_prova: boolean }>(
      `SELECT tem_prova FROM public.false_power_alerts(168)`);
    expect(r.rows[0].tem_prova).toBe(false);

    await desligamentos(1, 30);
    r = await db.query(`SELECT tem_prova FROM public.false_power_alerts(168)`);
    expect(r.rows[0].tem_prova).toBe(true);
  });

  it("4 desligamentos REMOTOS (intencionais) não são prova", async () => {
    await db.exec(`DELETE FROM public.farm_notifications; DELETE FROM public.automation_log;`);
    await alerta(30); await desligamentos(4, 30, "remote");
    const r = await db.query<{ tem_prova: boolean; bombas_na_janela: string }>(
      `SELECT tem_prova, bombas_na_janela FROM public.false_power_alerts(168)`);
    expect(Number(r.rows[0].bombas_na_janela)).toBe(0);
    expect(r.rows[0].tem_prova).toBe(false);
  });

  it("4 desligamentos por AUTOMAÇÃO/programado não são prova", async () => {
    await db.exec(`DELETE FROM public.farm_notifications; DELETE FROM public.automation_log;`);
    await alerta(30); await desligamentos(4, 30, "auto");
    const r = await db.query<{ tem_prova: boolean }>(
      `SELECT tem_prova FROM public.false_power_alerts(168)`);
    expect(r.rows[0].tem_prova).toBe(false);
  });

  it("a rota pump_off/system também conta como espontânea", async () => {
    await db.exec(`DELETE FROM public.farm_notifications; DELETE FROM public.automation_log;`);
    await alerta(30); await desligamentos(4, 30, "system", "pump_off");
    const r = await db.query<{ tem_prova: boolean }>(
      `SELECT tem_prova FROM public.false_power_alerts(168)`);
    expect(r.rows[0].tem_prova).toBe(true);
  });

  it("4 desligamentos espalhados NÃO formam padrão (1 a cada 5 min)", async () => {
    await db.exec(`DELETE FROM public.farm_notifications; DELETE FROM public.automation_log;`);
    await alerta(30);
    // 5 min entre cada um: nenhuma janela de 60s pega mais de uma bomba.
    for (let i = 0; i < 4; i++) {
      await db.query(
        `INSERT INTO public.automation_log (farm_id, equipment_id, equipment_name, occurred_at, origin, action, result)
         VALUES ($1, gen_random_uuid(), 'B', now() - make_interval(mins => $2), 'reading','turn_off','success')`,
        [FARM, 24 + i * 5]);   // 24, 29, 34, 39 min atrás
    }
    const r = await db.query<{ tem_prova: boolean; bombas_na_janela: string }>(
      `SELECT tem_prova, bombas_na_janela FROM public.false_power_alerts(168)`);
    expect(Number(r.rows[0].bombas_na_janela)).toBe(1);
    expect(r.rows[0].tem_prova).toBe(false);
  });

  it("a MESMA bomba desligando 4x não são 4 bombas", async () => {
    await db.exec(`DELETE FROM public.farm_notifications; DELETE FROM public.automation_log;`);
    await alerta(30);
    const eq = (await db.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0].id;
    for (let i = 0; i < 4; i++) {
      await db.query(
        `INSERT INTO public.automation_log (farm_id, equipment_id, equipment_name, occurred_at, origin, action, result)
         VALUES ($1, $2, 'UNICA', now() - make_interval(mins => 30) + make_interval(secs => $3), 'reading','turn_off','success')`,
        [FARM, eq, i * 5]);
    }
    const r = await db.query<{ tem_prova: boolean; bombas_na_janela: string }>(
      `SELECT tem_prova, bombas_na_janela FROM public.false_power_alerts(168)`);
    expect(Number(r.rows[0].bombas_na_janela)).toBe(1);
    expect(r.rows[0].tem_prova).toBe(false);
  });
});

describe("limpeza — remove o falso, preserva o legítimo, não toca no resto", () => {
  beforeAll(async () => {
    await db.exec(`DELETE FROM public.farm_notifications;
                   DELETE FROM public.automation_log;
                   DELETE FROM public.farm_notifications_purged;`);
    // 3 alertas de energia FALSOS
    await alerta(10); await alerta(20); await alerta(40);
    // 1 alerta de energia LEGÍTIMO, com 4 bombas espontâneas em 15s
    await alerta(90); await desligamentos(4, 90);
    // Outras categorias que NÃO podem ser tocadas
    for (const [src, kind, title] of [
      ["offline_alert", "failure", "POÇO 03 sem comunicação"],
      ["safety_timer_fired", "failure", "POÇO 07 — Falha de ativação"],
      ["bridge_offline", "failure", "Bridge serial indisponível"],
      ["peak_hour_start", "system", "Horário de ponta iniciado (18h)"],
      ["automatico_nao_obedecido", "failure", "Modo automático não obedecido"],
      ["clone_guard", "failure", "Agente bloqueado"],
    ] as const) {
      await db.query(
        `INSERT INTO public.farm_notifications (farm_id, kind, severity, title, message, source, source_ref)
         VALUES ($1,$2,'critical',$3,'m',$4, gen_random_uuid())`,
        [FARM, kind, title, src]);
    }
  });

  it("o resumo conta certo antes de mexer em nada", async () => {
    const r = await db.query<{ total: string; com_prova: string; sem_prova: string;
                               outros_alertas_intocados: string }>(
      `SELECT * FROM public.false_power_alerts_summary(168)`);
    expect(Number(r.rows[0].total)).toBe(4);
    expect(Number(r.rows[0].com_prova)).toBe(1);
    expect(Number(r.rows[0].sem_prova)).toBe(3);
    expect(Number(r.rows[0].outros_alertas_intocados)).toBe(6);
  });

  it("remove exatamente os 3 falsos e preserva o legítimo", async () => {
    const r = await db.query<{ removidos: string; preservados: string; outros_intocados: string }>(
      `SELECT * FROM public.purge_false_power_alerts(168)`);
    expect(Number(r.rows[0].removidos)).toBe(3);
    expect(Number(r.rows[0].preservados)).toBe(1);
    expect(Number(r.rows[0].outros_intocados)).toBe(6);

    const rest = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM public.farm_notifications WHERE source='falta_energia'`);
    expect(Number(rest.rows[0].n)).toBe(1);
  });

  it("as outras seis categorias continuam todas lá", async () => {
    const r = await db.query<{ source: string }>(
      `SELECT source FROM public.farm_notifications
        WHERE source IS DISTINCT FROM 'falta_energia' ORDER BY source`);
    expect(r.rows.map((x) => x.source)).toEqual([
      "automatico_nao_obedecido", "bridge_offline", "clone_guard",
      "offline_alert", "peak_hour_start", "safety_timer_fired",
    ]);
  });

  it("nada foi apagado sem backup, com a evidência que justificou", async () => {
    const r = await db.query<{ n: string; reason: string; bombas: number }>(
      `SELECT count(*) AS n, min(purge_reason) AS reason,
              min((evidencia->>'bombas_distintas_em_60s')::int) AS bombas
         FROM public.farm_notifications_purged`);
    expect(Number(r.rows[0].n)).toBe(3);
    expect(r.rows[0].reason).toBe("regra_antiga_sem_transicao_fisica");
    expect(r.rows[0].bombas).toBe(0);
  });

  it("é idempotente — rodar de novo não remove mais nada", async () => {
    const r = await db.query<{ removidos: string; preservados: string }>(
      `SELECT * FROM public.purge_false_power_alerts(168)`);
    expect(Number(r.rows[0].removidos)).toBe(0);
    expect(Number(r.rows[0].preservados)).toBe(1);
  });

  it("é reversível — o rollback devolve os três", async () => {
    const n = await db.query<{ restore_purged_power_alerts: string }>(
      `SELECT public.restore_purged_power_alerts()`);
    expect(Number(n.rows[0].restore_purged_power_alerts)).toBe(3);
    const rest = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM public.farm_notifications WHERE source='falta_energia'`);
    expect(Number(rest.rows[0].n)).toBe(4);
    // e limpa de novo, para não deixar estado sujo
    await db.query(`SELECT * FROM public.purge_false_power_alerts(168)`);
  });
});
