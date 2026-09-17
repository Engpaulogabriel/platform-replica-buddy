// @vitest-environment node
// A confirmação física prova o ESTADO, nunca a ORIGEM.
// A classificação usa a MESMA cadeia do Relatório: (A) comando da automação,
// (B) janela de scheduled_automations, (C) comando remoto, (D) local.
// `targeted` é evidência complementar de forced — nunca prova principal.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs"; import path from "node:path";
const REPO = path.resolve(__dirname, "../..");
const mig = (f: string) => fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");

const F1="aaaa1111-0000-0000-0000-000000000001";   // Semear
const F2="aaaa2222-0000-0000-0000-000000000002";   // outra fazenda
const E1="bbbb1111-0000-0000-0000-000000000001";   // POÇO 12 R6
const E2="bbbb2222-0000-0000-0000-000000000002";   // POÇO 11 R4
const E3="bbbb3333-0000-0000-0000-000000000003";   // POÇO 20 (outra fazenda)
const AUT="dddd0000-0000-0000-0000-00000000000d";

const BOOT=`
CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT NULL::uuid $fn$;
CREATE TYPE public.command_type AS ENUM ('manual','polling','reset','automation','config');
CREATE TABLE public.farms (id uuid PRIMARY KEY, name text);
CREATE TABLE public.equipments (id uuid PRIMARY KEY, farm_id uuid, name text,
  last_outputs_state text, last_actuation_origin text, last_changed_by text,
  updated_at timestamptz DEFAULT now());
CREATE TABLE public.commands (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, equipment_id uuid,
  type public.command_type DEFAULT 'manual', frame text, source_device text,
  created_at timestamptz DEFAULT now());
CREATE TABLE public.scheduled_automations (id uuid PRIMARY KEY, farm_id uuid, name text,
  time_brt text, days_of_week text[], max_retries int DEFAULT 3, retry_interval_min int DEFAULT 5,
  is_active boolean DEFAULT true);
CREATE TABLE public.scheduled_shutdowns (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), automation_id uuid,
  farm_id uuid, run_date date, targeted jsonb, last_attempt_at timestamptz,
  updated_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now());
CREATE TABLE public.automation_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid,
  equipment_id uuid, origin text, actor_label text, occurred_at timestamptz);
INSERT INTO public.farms VALUES ('${F1}','Semear'),('${F2}','Sykue');
INSERT INTO public.equipments (id,farm_id,name,last_outputs_state,last_actuation_origin,last_changed_by) VALUES
  ('${E1}','${F1}','POÇO 12 R6','{1}','remote','Desligamento 17h Semear'),
  ('${E2}','${F1}','POÇO 11 R4','{1}','remote','Desligamento 17h Semear'),
  ('${E3}','${F2}','POÇO 20',   '{1}','remote',NULL);
-- a regra real: 17:00 BRT, dias úteis, 3 tentativas de 5 min
INSERT INTO public.scheduled_automations (id,farm_id,name,time_brt,days_of_week)
VALUES ('${AUT}','${F1}','Desligamento 17h Semear','17:00',
        ARRAY['mon','tue','wed','thu','fri','sat','sun']);`;

async function mk(){ const d=await PGlite.create(); await d.exec(BOOT);
  await d.exec(mig("20260814270000_actuation_origin_canonical.sql")); return d; }

/** Caminho A: o comando que a automação cria para CADA bomba atuada. */
const comandoDaAutomacao = (d:PGlite,eq:string,forced=false,quando='now()') =>
  d.query(`INSERT INTO public.commands (farm_id,equipment_id,type,source_device,created_at)
           VALUES ($1,$2,'reset',$3,${quando})`,
          [F1,eq,`backend-reset:scheduled_shutdown_a1${forced?'_forced':''}`]);

/** A execução do dia, com targeted podendo estar VAZIO ou incompleto. */
const execucao = (d:PGlite,targeted:unknown[]) =>
  d.query(`INSERT INTO public.scheduled_shutdowns (automation_id,farm_id,run_date,targeted,last_attempt_at)
           VALUES ($1,$2,current_date,$3::jsonb,now())`,[AUT,F1,JSON.stringify(targeted)]);

const comandoRemoto = (d:PGlite,eq:string,liga:boolean,farm=F1) =>
  d.query(`INSERT INTO public.commands (farm_id,equipment_id,type,frame) VALUES ($1,$2,'manual',$3)`,
          [farm,eq,liga?'AA{1}BB':'AA{0}BB']);

/** o agente confirma fisicamente e tenta marcar como local */
const agenteConfirma = (d:PGlite,eq:string,estado:string) =>
  d.query(`UPDATE public.equipments SET last_outputs_state=$2, last_actuation_origin='local' WHERE id=$1`,
          [eq,estado]);

/** Simula dado LEGADO: contaminado antes desta migration existir, portanto
 *  gravado sem passar pelo trigger. */
const contaminarLegado = async (d:PGlite,ids:string[]) => {
  await d.query(`ALTER TABLE public.equipments DISABLE TRIGGER trg_canonicalize_actuation_origin`);
  await d.query(`UPDATE public.equipments SET last_actuation_origin='local',
                 last_outputs_state='{0}', updated_at=now() WHERE id = ANY($1::uuid[])`,[ids]);
  await d.query(`ALTER TABLE public.equipments ENABLE TRIGGER trg_canonicalize_actuation_origin`);
};

const eq = async (d:PGlite,id:string) => (await d.query<any>(
  `SELECT last_actuation_origin o, last_actuation_rule r FROM public.equipments WHERE id=$1`,[id])).rows[0];

/** força o relógio da janela: coloca a regra na hora atual */
const regraAgora = (d:PGlite) =>
  d.query(`UPDATE public.scheduled_automations SET time_brt =
             to_char((now() AT TIME ZONE 'America/Bahia'), 'HH24:MI')`);
/** tira a regra da janela (3h atrás) */
const regraFora = (d:PGlite) =>
  d.query(`UPDATE public.scheduled_automations SET time_brt =
             to_char((now() AT TIME ZONE 'America/Bahia') - interval '3 hours', 'HH24:MI')`);

let d:PGlite; beforeEach(async()=>{ d=await mk(); await regraFora(d); });

// ── CAMINHO A ──────────────────────────────────────────────────────────────
describe("caminho A — comando gerado pela automação, por equipamento", () => {
  it("1. 17h → confirmação física OFF → 'auto' com o nome da regra", async () => {
    await comandoDaAutomacao(d,E1);
    await agenteConfirma(d,E1,'{0}');
    const r=await eq(d,E1);
    expect(r.o).toBe('auto');
    expect(r.r).toBe('Desligamento 17h Semear');
  });

  it("vale para bomba NÃO forçada — não só as forced", async () => {
    await comandoDaAutomacao(d,E1,false);     // 'normal', sem _forced
    await agenteConfirma(d,E1,'{0}');
    expect((await eq(d,E1)).o).toBe('auto');
  });

  it("4. TX físico depois da automação NÃO rebaixa 'auto' para 'local'", async () => {
    await comandoDaAutomacao(d,E1);
    await agenteConfirma(d,E1,'{0}');
    await agenteConfirma(d,E1,'{0}');
    expect((await eq(d,E1)).o).toBe('auto');
  });

  it("comando da automação de OUTRO poço não serve", async () => {
    await comandoDaAutomacao(d,E2);
    await agenteConfirma(d,E1,'{0}');
    expect((await eq(d,E1)).o).toBe('local');
  });

  it("comando antigo (fora da janela) não serve", async () => {
    await comandoDaAutomacao(d,E1,false,"now() - interval '40 minutes'");
    await agenteConfirma(d,E1,'{0}');
    expect((await eq(d,E1)).o).toBe('local');
  });
});

// ── CAMINHO B — o que salva o 13/08 ────────────────────────────────────────
describe("caminho B — janela de scheduled_automations, sem depender de comando", () => {
  it("CASO 13/08: targeted VAZIO e mesmo assim todos saem de 'local'", async () => {
    await regraAgora(d);
    await execucao(d, []);                       // targeted = [] , como no 13/08
    await agenteConfirma(d,E1,'{0}');
    await agenteConfirma(d,E2,'{0}');
    for (const e of [E1,E2]) {
      const r=await eq(d,e);
      expect(r.o, 'nenhum poço pode ficar Local').toBe('auto');
      expect(r.r).toBe('Desligamento 17h Semear');
    }
  });

  it("CASO 14/08: targeted só com o POÇO 11 forced — o 12 também sai de 'local'", async () => {
    await regraAgora(d);
    await execucao(d, [{ id: E2, name: 'POÇO 11 R4', action: 'forced' }]);
    await agenteConfirma(d,E1,'{0}');            // não está em targeted
    await agenteConfirma(d,E2,'{0}');            // está, como forced
    expect((await eq(d,E1)).o).toBe('auto');
    expect((await eq(d,E2)).o).toBe('auto');
  });

  it("funciona SEM nenhuma linha em scheduled_shutdowns", async () => {
    await regraAgora(d);
    await agenteConfirma(d,E1,'{0}');
    expect((await eq(d,E1)).o).toBe('auto');
  });

  it("fora da janela de horário, continua Local", async () => {
    await regraFora(d);
    await execucao(d, []);
    await agenteConfirma(d,E1,'{0}');
    expect((await eq(d,E1)).o).toBe('local');
  });

  it("regra inativa não classifica", async () => {
    await regraAgora(d);
    await d.query(`UPDATE public.scheduled_automations SET is_active=false`);
    await agenteConfirma(d,E1,'{0}');
    expect((await eq(d,E1)).o).toBe('local');
  });

  it("dia da semana fora da regra não classifica", async () => {
    await regraAgora(d);
    await d.query(`UPDATE public.scheduled_automations SET days_of_week =
      ARRAY[(ARRAY['sun','mon','tue','wed','thu','fri','sat'])[
        ((extract(dow from (now() AT TIME ZONE 'America/Bahia'))::int + 3) % 7) + 1]]`);
    await agenteConfirma(d,E1,'{0}');
    expect((await eq(d,E1)).o).toBe('local');
  });

  it("regra de OUTRA fazenda não contamina esta", async () => {
    await regraAgora(d);
    await agenteConfirma(d,E3,'{0}');            // E3 é da Sykue, sem regra
    expect((await eq(d,E3)).o).toBe('local');
  });

  it("LIGAR nunca é atribuído ao desligamento programado", async () => {
    await regraAgora(d);
    await agenteConfirma(d,E1,'{1}');
    expect((await eq(d,E1)).o).toBe('local');
  });
});

// ── targeted é só evidência complementar ───────────────────────────────────
describe("targeted NÃO é prova principal", () => {
  it("estar em targeted como forced não é o que decide — a regra é", async () => {
    await regraFora(d);                          // sem janela
    await execucao(d, [{ id: E1, name: 'POÇO 12 R6', action: 'forced' }]);
    await agenteConfirma(d,E1,'{0}');
    expect((await eq(d,E1)).o, 'targeted sozinho não pode classificar').toBe('local');
  });

  it("quando há prova real, o flag forced é reportado como complemento", async () => {
    await regraAgora(d);
    await execucao(d, [{ id: E1, name: 'POÇO 12 R6', action: 'forced' }]);
    const c=(await d.query<any>(
      `SELECT * FROM public.classify_actuation_origin($1,$2,false,now())`,[E1,F1])).rows[0];
    expect(c.origin).toBe('auto');
    expect(c.forced).toBe(true);
    expect(c.evidence).toBe('time_window');
  });

  it("targeted em formato inesperado não quebra a classificação", async () => {
    await regraAgora(d);
    await d.query(`INSERT INTO public.scheduled_shutdowns (automation_id,farm_id,run_date,targeted,last_attempt_at)
                   VALUES ($1,$2,current_date,'{"nao":"array"}'::jsonb,now())`,[AUT,F1]);
    await agenteConfirma(d,E1,'{0}');
    expect((await eq(d,E1)).o).toBe('auto');
  });
});

// ── CAMINHO C ──────────────────────────────────────────────────────────────
describe("caminho C — comando remoto não vira Local", () => {
  it("2. comando remoto → confirmação física → 'remote'", async () => {
    await comandoRemoto(d,E1,false);
    await agenteConfirma(d,E1,'{0}');
    expect((await eq(d,E1)).o).toBe('remote');
  });

  it("5. TX físico depois do comando remoto NÃO rebaixa para 'local'", async () => {
    await comandoRemoto(d,E1,false);
    await agenteConfirma(d,E1,'{0}');
    await agenteConfirma(d,E1,'{0}');
    expect((await eq(d,E1)).o).toBe('remote');
  });

  it("comando de sentido oposto não explica", async () => {
    await comandoRemoto(d,E1,true);
    await agenteConfirma(d,E1,'{0}');
    expect((await eq(d,E1)).o).toBe('local');
  });

  it("automação tem precedência sobre comando remoto na mesma janela", async () => {
    await regraAgora(d);
    await comandoRemoto(d,E1,false);
    await comandoDaAutomacao(d,E1);
    await agenteConfirma(d,E1,'{0}');
    expect((await eq(d,E1)).o).toBe('auto');
  });
});

// ── CAMINHO D ──────────────────────────────────────────────────────────────
describe("caminho D — atuação local real continua Local", () => {
  it("3. TX espontâneo sem comando nem automação → 'local'", async () => {
    await agenteConfirma(d,E1,'{0}');
    const r=await eq(d,E1);
    expect(r.o).toBe('local');
    expect(r.r).toBeNull();
  });

  it("6. ligar na botoeira continua Local", async () => {
    await d.query(`UPDATE public.equipments SET last_outputs_state='{0}' WHERE id=$1`,[E1]);
    await agenteConfirma(d,E1,'{1}');
    expect((await eq(d,E1)).o).toBe('local');
  });

  it("origem já classificada (whatsapp) não é reescrita", async () => {
    await d.query(`UPDATE public.equipments SET last_actuation_origin='whatsapp', last_outputs_state='{0}' WHERE id=$1`,[E1]);
    expect((await eq(d,E1)).o).toBe('whatsapp');
  });
});

// ── Nada além da origem é tocado ───────────────────────────────────────────
describe("7. o Relatório de Automação não é alterado", () => {
  it("nenhuma linha muda, nem pelo trigger nem pela correção histórica", async () => {
    await d.query(`INSERT INTO public.automation_log (farm_id,equipment_id,origin,actor_label,occurred_at)
                   VALUES ($1,$2,'auto','Desligamento 17h Semear',now())`,[F1,E1]);
    const antes=(await d.query<any>(`SELECT * FROM public.automation_log ORDER BY id`)).rows;
    await regraAgora(d);
    await agenteConfirma(d,E1,'{0}');
    await d.query(`SELECT * FROM public.fix_contaminated_local_origin(24)`);
    const depois=(await d.query<any>(`SELECT * FROM public.automation_log ORDER BY id`)).rows;
    expect(depois).toEqual(antes);
  });

  it("o estado físico gravado é sempre preservado", async () => {
    await regraAgora(d);
    await agenteConfirma(d,E1,'{0}');
    expect((await d.query<any>(
      `SELECT last_outputs_state s FROM public.equipments WHERE id=$1`,[E1])).rows[0].s).toBe('{0}');
  });
});

describe("correção dos registros já contaminados", () => {
  it("corrige pelos dois caminhos e reporta a evidência usada", async () => {
    await regraAgora(d);
    await contaminarLegado(d,[E1,E2]);
    await comandoDaAutomacao(d,E1);              // E1 pelo caminho A
    const r=(await d.query<any>(
      `SELECT * FROM public.fix_contaminated_local_origin(24) ORDER BY equipamento`)).rows;
    expect(r).toHaveLength(2);                   // E2 entra pelo caminho B
    expect(r.map((x:any)=>x.evidencia).sort())
      .toEqual(['command_scheduled_shutdown','time_window']);
    expect((await eq(d,E1)).o).toBe('auto');
    expect((await eq(d,E2)).o).toBe('auto');
  });

  it("não converte comando humano real em automação", async () => {
    await regraFora(d);
    await contaminarLegado(d,[E1]);
    await comandoRemoto(d,E1,false);
    const r=(await d.query<any>(`SELECT * FROM public.fix_contaminated_local_origin(24)`)).rows;
    expect(r).toHaveLength(0);
    expect((await eq(d,E1)).o).toBe('local');
  });

  it("poço de outra fazenda não é afetado", async () => {
    await regraAgora(d);
    await contaminarLegado(d,[E3]);
    const r=(await d.query<any>(`SELECT * FROM public.fix_contaminated_local_origin(24)`)).rows;
    expect(r).toHaveLength(0);
  });
});
