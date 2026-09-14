// @vitest-environment node
// V5 — SLOT DE PARTIDA POR ESTADO, não por tempo.
// A V4 liberava o grupo seguinte quando o stagger vencia (60s), mas o safety do
// agente só desarma o relé em 120s. Como o comando é de NÍVEL (1 mantém), numa
// falta de energia os relés acumulavam e partiriam juntos no retorno da rede.
// Aqui o slot só libera com a tentativa RESOLVIDA. Postgres 17 real (pglite).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs"; import path from "node:path";

const REPO = path.resolve(__dirname, "../..");
const MIG = path.join(REPO,
  "supabase/migrations/20260904120000_automation_tick_resilient_idempotent.sql");
const MIG_SQL = fs.readFileSync(MIG, "utf8");

let db: PGlite; let FARM = "";

const SCHEMA = `
  CREATE TYPE public.command_type AS ENUM ('polling','manual','config','server','repeater','diagnostic','service_test','automation');
  CREATE TYPE public.command_status AS ENUM ('pending','sent','delivered','executed','timeout','error','cancelled');
  CREATE TYPE public.equipment_type AS ENUM ('poco','bombeamento','nivel','repetidor');
  CREATE TABLE public.farms (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text,
    timezone text DEFAULT 'America/Sao_Paulo',
    automatic_start_stagger_enabled boolean DEFAULT true,
    automatic_start_stagger_seconds int DEFAULT 60,
    automatic_start_batch_size int DEFAULT 1);
  CREATE TABLE public.equipments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, name text,
    type public.equipment_type DEFAULT 'poco', saida int DEFAULT 1,
    active boolean DEFAULT true, maintenance_mode boolean DEFAULT false,
    last_outputs_state text DEFAULT '000000', last_communication timestamptz);
  CREATE TABLE public.commands (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_id uuid, equipment_id uuid,
    type public.command_type, frame text, source_device text,
    idempotency_key text, status public.command_status DEFAULT 'pending',
    created_at timestamptz DEFAULT now(), responded_at timestamptz);
`;

/** Extrai só a função de contagem da migration — testa o artefato real. */
const FN_SQL = (() => {
  const i = MIG_SQL.indexOf("CREATE OR REPLACE FUNCTION public.count_automatic_start_slots_in_use");
  const j = MIG_SQL.indexOf("$$;", i) + 3;
  return MIG_SQL.slice(i, j);
})();

const frameOn = (payload: string) => `[1314_1_]{${payload}}[1314_ETX_]`;
const slots = async () => Number((await db.query<{ n: number }>(
  `SELECT public.count_automatic_start_slots_in_use($1) AS n`, [FARM])).rows[0].n);

/** Leitura da PLC: define o estado físico e QUANDO ele chegou. */
async function leitura(eq: string, estado: string | null, idade: string) {
  await db.query(
    `UPDATE public.equipments SET last_outputs_state = $2,
       last_communication = now() - $3::interval WHERE id = $1`, [eq, estado, idade]);
}

async function bomba(nome: string, saida: number, estado = "000000") {
  const r = await db.query<{ id: string }>(
    `INSERT INTO public.equipments (farm_id,name,saida,last_outputs_state)
     VALUES ($1,$2,$3,$4) RETURNING id`, [FARM, nome, saida, estado]);
  return r.rows[0].id;
}
/** Tentativa automática de LIGAR, no estado que o agente deixaria. */
async function tentativaOn(eq: string, saida: number, opts: {
  status?: string; responded?: boolean; src?: string; idade?: string;
} = {}) {
  const payload = "000000".split("");
  payload[saida - 1] = "1";
  return db.query(
    `INSERT INTO public.commands (farm_id, equipment_id, type, frame, source_device,
       idempotency_key, status, created_at, responded_at)
     VALUES ($1,$2,'manual',$3,$4,'automation:x:y:on:2026-09-04 10:00',
             $5::public.command_status, now() - $6::interval, $7)`,
    [FARM, eq, frameOn(payload.join("")), opts.src ?? "cloud-automation",
     opts.status ?? "sent", opts.idade ?? "0 seconds",
     opts.responded ? new Date().toISOString() : null]);
}

beforeEach(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(FN_SQL);
  const f = await db.query<{ id: string }>(`INSERT INTO public.farms (name) VALUES ('F') RETURNING id`);
  FARM = f.rows[0].id;
}, 60_000);
afterEach(async () => { await db?.close(); });

describe("1 a 3 e 8. o slot NÃO libera por tempo", () => {
  it("1. tentativa aberta ocupa slot", async () => {
    const p1 = await bomba("P1", 1);
    await tentativaOn(p1, 1);
    expect(await slots()).toBe(1);
  });

  it("2 e 3. aos 60s, 90s e 119s o slot CONTINUA ocupado", async () => {
    const p1 = await bomba("P1", 1);
    await tentativaOn(p1, 1);
    for (const idade of ["60 seconds", "90 seconds", "119 seconds"]) {
      await db.query(`UPDATE public.commands SET created_at = now() - $1::interval`, [idade]);
      expect(await slots(), idade).toBe(1);
    }
  });

  it("8. timeout serial de 13s NÃO libera — a linha segue 'sent'", async () => {
    // main.cjs: "Não marcar falha física aos 8s... O comando segue como `sent`"
    const p1 = await bomba("P1", 1);
    await tentativaOn(p1, 1, { status: "sent", idade: "13 seconds" });
    expect(await slots()).toBe(1);
  });
});

describe("4, 6 e 7. o slot libera por ESTADO conhecido", () => {
  it("4. confirmou ON fisicamente → libera", async () => {
    const p1 = await bomba("P1", 1, "100000");   // bit da saída 1 = ligado
    await tentativaOn(p1, 1);
    expect(await slots()).toBe(0);
  });

  it("4b. RX casou → status executed + responded_at → libera", async () => {
    const p1 = await bomba("P1", 1);
    await tentativaOn(p1, 1, { status: "executed", responded: true });
    expect(await slots()).toBe(0);
  });

  it("6 e 7. safety encerrou (status timeout + responded_at) → libera", async () => {
    const p1 = await bomba("P1", 1);
    await tentativaOn(p1, 1, { status: "timeout", responded: true, idade: "120 seconds" });
    expect(await slots()).toBe(0);
  });

  it("órfão: 'sent' + responded_at NULL, SEM leitura nova, NÃO libera por tempo", async () => {
    // O agente morreu entre o TX e o safety: ninguém desarmou o relé. Nenhuma
    // quantidade de tempo pode transformar isso em slot livre.
    const p1 = await bomba("P1", 1);
    await tentativaOn(p1, 1, { idade: "400 seconds" });
    expect(await slots(), "400s").toBe(1);
    for (const idade of ["1 hour", "6 hours", "24 hours"]) {
      await db.query(`UPDATE public.commands SET created_at = now() - $1::interval`, [idade]);
      expect(await slots(), idade).toBe(1);
    }
  });

  it("órfão: leitura da PLC POSTERIOR ao reforço dizendo '0' libera", async () => {
    // Evidência física de relé desarmado — a única saída do órfão.
    const p1 = await bomba("P1", 1);
    await tentativaOn(p1, 1, { idade: "400 seconds" });
    expect(await slots()).toBe(1);
    await leitura(p1, "000000", "300 seconds");   // 100s DEPOIS do comando
    expect(await slots()).toBe(0);
  });

  it("leitura ANTERIOR ao comando não libera — ela não sabe do comando", async () => {
    const p1 = await bomba("P1", 1);
    await tentativaOn(p1, 1, { idade: "400 seconds" });
    await leitura(p1, "000000", "500 seconds");
    expect(await slots()).toBe(1);
  });

  it("leitura DENTRO da janela de reforço (45s) não libera", async () => {
    // Reforços em 0/15/30/45s: um '0' lido aos 30s pode ser anterior ao TX que pegou.
    const p1 = await bomba("P1", 1);
    await tentativaOn(p1, 1, { idade: "400 seconds" });
    await leitura(p1, "000000", "370 seconds");   // +30s
    expect(await slots(), "+30s").toBe(1);
    await leitura(p1, "000000", "341 seconds");   // +59s
    expect(await slots(), "+59s").toBe(1);
    await leitura(p1, "000000", "339 seconds");   // +61s
    expect(await slots(), "+61s").toBe(0);
  });

  it("sem leitura nenhuma (last_communication NULL) não libera", async () => {
    const p1 = await bomba("P1", 1);
    await tentativaOn(p1, 1, { idade: "400 seconds" });
    await db.query(`UPDATE public.equipments SET last_communication = NULL`);
    expect(await slots()).toBe(1);
  });

  it("estado físico desconhecido não libera, mesmo com leitura fresca", async () => {
    // NULL/lixo em last_outputs_state = não sabemos onde o relé está.
    const p1 = await bomba("P1", 1);
    await tentativaOn(p1, 1, { idade: "400 seconds" });
    for (const est of [null, "", "xxxxxx", "0000000"]) {
      await leitura(p1, est, "100 seconds");
      expect(await slots(), String(est)).toBe(1);
    }
  });

  it("o piso de 60s não pode ser encurtado pelo chamador", async () => {
    const p1 = await bomba("P1", 1);
    await tentativaOn(p1, 1, { idade: "400 seconds" });
    await leitura(p1, "000000", "380 seconds");   // +20s
    const r = await db.query<{ n: number }>(
      `SELECT public.count_automatic_start_slots_in_use($1, 1) AS n`, [FARM]);
    expect(Number(r.rows[0].n)).toBe(1);
  });

  it("nada libera antes dos 120s do safety com a PLC muda", async () => {
    const p1 = await bomba("P1", 1);
    await tentativaOn(p1, 1, { idade: "119 seconds" });
    expect(await slots()).toBe(1);
  });
});

describe("13 a 17. o que NÃO conta como slot", () => {
  it("13. comando de DESLIGAR não ocupa slot", async () => {
    const p1 = await bomba("P1", 1);
    await db.query(
      `INSERT INTO public.commands (farm_id,equipment_id,type,frame,source_device,idempotency_key,status)
       VALUES ($1,$2,'manual',$3,'cloud-automation','automation:x:y:off:d','sent')`,
      [FARM, p1, frameOn("000000")]);
    expect(await slots()).toBe(0);
  });

  it("14. scheduled-shutdown não ocupa slot", async () => {
    const p1 = await bomba("P1", 1);
    await tentativaOn(p1, 1, { src: "scheduled-shutdown" });
    expect(await slots()).toBe(0);
  });

  it("15. manual do operador não ocupa slot", async () => {
    const p1 = await bomba("P1", 1);
    await tentativaOn(p1, 1, { src: "web" });
    expect(await slots()).toBe(0);
  });

  it("16. polling não ocupa slot", async () => {
    const p1 = await bomba("P1", 1);
    await tentativaOn(p1, 1, { src: "cloud-polling" });
    expect(await slots()).toBe(0);
  });

  it("17. peak-hour OCUPA o mesmo slot — teto único", async () => {
    const p1 = await bomba("P1", 1);
    await tentativaOn(p1, 1, { src: "peak-hour" });
    expect(await slots()).toBe(1);
  });

  it("cancelled e error também resolvem a tentativa", async () => {
    const p1 = await bomba("P1", 1);
    for (const st of ["cancelled", "error"]) {
      await db.query(`DELETE FROM public.commands`);
      await tentativaOn(p1, 1, { status: st });
      expect(await slots(), st).toBe(0);
    }
  });
});

describe("9 a 11. batch e isolamento entre fazendas", () => {
  it("9 e 10. o contador soma as tentativas abertas", async () => {
    for (let i = 1; i <= 3; i++) {
      const e = await bomba(`P${i}`, i);
      await tentativaOn(e, i);
      expect(await slots()).toBe(i);
    }
  });

  it("11. outra fazenda tem contagem independente", async () => {
    const p1 = await bomba("P1", 1);
    await tentativaOn(p1, 1);
    const f2 = await db.query<{ id: string }>(`INSERT INTO public.farms (name) VALUES ('F2') RETURNING id`);
    const n = await db.query<{ n: number }>(
      `SELECT public.count_automatic_start_slots_in_use($1) AS n`, [f2.rows[0].id]);
    expect(Number(n.rows[0].n)).toBe(0);
    expect(await slots()).toBe(1);
  });

  it("o bit lido é o da SAÍDA daquela bomba, não qualquer 1 do payload", async () => {
    // payload liga a saída 1; a bomba avaliada é a saída 2 → não é tentativa dela
    const p2 = await bomba("P2", 2);
    await db.query(
      `INSERT INTO public.commands (farm_id,equipment_id,type,frame,source_device,idempotency_key,status)
       VALUES ($1,$2,'manual',$3,'cloud-automation','automation:x:y:on:d','sent')`,
      [FARM, p2, frameOn("100000")]);
    expect(await slots()).toBe(0);
  });
});

describe("contrato da migration", () => {
  const code = MIG_SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

  it("o gate do ON exige SLOT e stagger — nesta ordem", () => {
    expect(code).toContain("v_starts_in_flight := public.count_automatic_start_slots_in_use(v_sched.farm_id)");
    expect(code).toContain("AND v_starts_in_flight < v_max_starts");
    expect(code).toContain("AND v_stagger_ok");
  });

  it("a contagem por JANELA DE TEMPO da V4 foi eliminada", () => {
    // o antigo contava commands com created_at > now() - stagger COMO SLOT
    expect(code).not.toMatch(/SELECT count\(\*\) INTO v_starts_in_flight/);
  });

  it("a contagem NÃO tem nenhuma comparação de idade contra now()", async () => {
    // Trava estrutural: qualquer `created_at ... now() - interval` dentro da
    // função é liberação por tempo puro voltando pela porta dos fundos.
    const corpo = FN_SQL.split("\n").filter(l => !l.trim().startsWith("--")).join("\n");
    expect(corpo).not.toMatch(/created_at\s*>\s*now\s*\(/i);
    expect(corpo).not.toMatch(/now\s*\(\)\s*-\s*make_interval/i);
    // o único make_interval permitido é o offset A PARTIR do created_at do comando
    expect(corpo).toMatch(/last_communication\s*>\s*c\.created_at/);
  });

  it("o peak-hour usa a MESMA função de contagem", () => {
    expect(code).toContain("v_in_flight := public.count_automatic_start_slots_in_use(v_cfg.farm_id)");
  });

  it("o maintenance guard do peak-hour continua intacto", () => {
    expect(MIG_SQL).toContain("MAINTENANCE GUARD");
    expect(MIG_SQL).toContain(`IF COALESCE(v_eq.maintenance_mode, false) = true THEN
          v_skipped_maint := v_skipped_maint + 1;
          CONTINUE;
        END IF;`);
  });

  it("19 e 20. quem falhou vai para o FIM da fila", () => {
    expect(code).toContain("cf.status IN ('timeout','error')");
    expect(code).toContain("v_retry_cooldown_s");
    const ordem = code.slice(code.indexOf("ORDER BY s.farm_id"), code.indexOf("LOOP"));
    expect(ordem).toContain("s.time_on NULLS LAST");
  });

  it("o lock por fazenda foi preservado", () => {
    expect(code).toContain("pg_try_advisory_xact_lock(hashtextextended('auto:' || v_sched.farm_id::text, 0))");
  });

  it("o OFF nunca consulta slot", () => {
    const ramoOff = code.slice(code.indexOf("IF v_fire_off"), code.indexOf("END LOOP"));
    expect(ramoOff).not.toContain("count_automatic_start_slots_in_use");
    expect(ramoOff).not.toContain("v_starts_in_flight");
  });

  it("nenhuma alteração no Agent", () => {
    const agent = fs.readFileSync(path.join(REPO, "electron-agent/main.cjs"), "utf8");
    expect(agent).not.toContain("count_automatic_start_slots_in_use");
    expect(agent).not.toContain("automatic_start_batch_size");
  });
});
