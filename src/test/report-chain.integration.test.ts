// @vitest-environment node
// ─────────────────────────────────────────────────────────────────────────────
// Relatório de Automação — a cadeia de classificação, executada de verdade
// ─────────────────────────────────────────────────────────────────────────────
// Postgres real (PGlite), corpos de função extraídos das migrations sem edição,
// gatilhos armados com os nomes reais. Cada caso empurra uma transição física
// e lê o que o relatório leria. Nenhuma decisão sob teste é simulada.

import { describe, it, expect } from "vitest";
import {
  bancoDaCadeia, aplicarCorrecaoP0, semear, telemetria, linhasDoRelatorio, UUID,
} from "./helpers/reportChainDb";

const LIGADO = "100000";     // saída 1 ligada
const DESLIGADO = "000000";
const frameOn  = "[3031_1_]{100000}[3031_ETX_]\r";
const frameOff = "[3031_1_]{000000}[3031_ETX_]\r";

async function comando(db: any, opts: {
  src: string | null; createdBy: string | null; frame: string; tipo?: string;
}) {
  await db.query(
    `INSERT INTO public.commands (farm_id, equipment_id, type, frame, source_device, created_by, created_at)
     VALUES ($1,$2,$3::public.command_type,$4,$5,$6, now())`,
    [UUID.fazenda, UUID.poco, opts.tipo ?? "manual", opts.frame, opts.src, opts.createdBy]);
}

describe("CASO A — WhatsApp com operador vinculado", () => {
  it("origem WhatsApp e autor Yuri, vindos do source_device", async () => {
    const db = await bancoDaCadeia(); await aplicarCorrecaoP0(db); await semear(db);
    await comando(db, { src: `whatsapp:Yuri|5577999608294`, createdBy: UUID.yuri, frame: frameOn });
    await telemetria(db, LIGADO);

    const [linha] = await linhasDoRelatorio(db);
    expect(linha.action).toBe("turn_on");
    expect(linha.origin).toBe("whatsapp");
    expect(linha.actor_label).toBe("Yuri");
    expect(linha.fonte).toBe("whatsapp_source_device");
  });
});

describe("CASO B — created_by histórico aponta para outra pessoa", () => {
  it("source_device prova o Yuri e vence o created_by errado", async () => {
    const db = await bancoDaCadeia(); await aplicarCorrecaoP0(db); await semear(db);
    // exatamente o dado que produziu "Remoto / Admin Renov" na Semear
    await comando(db, { src: `whatsapp:Yuri|5577999608294`, createdBy: UUID.admin, frame: frameOn });
    await telemetria(db, LIGADO);

    const [linha] = await linhasDoRelatorio(db);
    expect(linha.origin).toBe("whatsapp");
    expect(linha.actor_label).toBe("Yuri");
    expect(linha.actor_label).not.toBe("Admin Renov");
  });

  it("e a v10 fazia o contrário: Remoto + Admin Renov", async () => {
    const db = await bancoDaCadeia(); await semear(db);   // SEM a correção
    await comando(db, { src: `whatsapp:Yuri|5577999608294`, createdBy: UUID.admin, frame: frameOn });
    await telemetria(db, LIGADO);

    const [linha] = await linhasDoRelatorio(db);
    expect(linha.origin).toBe("remote");
    expect(linha.actor_label).toBe("Admin Renov");
  });
});

describe("CASO A2 — WhatsApp sem vínculo auth (created_by nulo)", () => {
  it("o relatório mostra WhatsApp / Yuri mesmo sem user_id", async () => {
    const db = await bancoDaCadeia(); await aplicarCorrecaoP0(db); await semear(db);
    await comando(db, { src: "whatsapp:Yuri Seibert|5577999604782", createdBy: null, frame: frameOn });
    await telemetria(db, LIGADO);

    const [linha] = await linhasDoRelatorio(db);
    expect(linha.origin).toBe("whatsapp");
    expect(linha.actor_label).toBe("Yuri Seibert");
    expect(linha.user_id).toBeNull();
    expect(linha.fonte).toBe("whatsapp_source_device");
  });

  it("telefone sozinho no source_device não vai para a tela como nome", async () => {
    const db = await bancoDaCadeia(); await aplicarCorrecaoP0(db); await semear(db);
    await comando(db, { src: "whatsapp:5577999604782", createdBy: null, frame: frameOn });
    await telemetria(db, LIGADO);

    const [linha] = await linhasDoRelatorio(db);
    expect(linha.origin).toBe("whatsapp");
    expect(linha.actor_label === null || !/\d{6}/.test(linha.actor_label)).toBe(true);
  });
});

describe("CASO C — transição sem correlação nenhuma", () => {
  it("não diz 'Acionamento local': diz origem não identificada, sem autor", async () => {
    const db = await bancoDaCadeia(); await aplicarCorrecaoP0(db); await semear(db);
    await telemetria(db, LIGADO);            // nenhum comando, nenhuma automação

    const [linha] = await linhasDoRelatorio(db);
    expect(linha.action).toBe("turn_on");
    expect(linha.origin).toBe("system");
    expect(linha.fonte).toBe("unidentified");
    expect(linha.actor_label === null || /sistema/i.test(linha.actor_label)).toBe(true);
    expect(linha.actor_label).not.toBe("Acionamento local");
    expect(linha.user_id).toBeNull();
  });

  it("com evidência de local (telemetria declarou), continua Local", async () => {
    const db = await bancoDaCadeia(); await aplicarCorrecaoP0(db);
    await semear(db, { origem: "local" });
    await telemetria(db, LIGADO);

    const [linha] = await linhasDoRelatorio(db);
    expect(linha.origin).toBe("local");
    expect(linha.actor_label).toBe("Acionamento local");
    expect(linha.fonte).toBe("local_declared");
  });

  it("a v10 chamava a transição sem prova de 'Acionamento local'", async () => {
    const db = await bancoDaCadeia(); await semear(db);   // SEM a correção
    await telemetria(db, LIGADO);
    const [linha] = await linhasDoRelatorio(db);
    expect(linha.origin).toBe("local");
    expect(linha.actor_label).toBe("Acionamento local");
  });
});

describe("CASO D — comando remoto pelo painel", () => {
  it("Remoto com o nome real do usuário", async () => {
    const db = await bancoDaCadeia(); await aplicarCorrecaoP0(db); await semear(db);
    await comando(db, { src: "web", createdBy: UUID.yuri, frame: frameOn });
    await telemetria(db, LIGADO);

    const [linha] = await linhasDoRelatorio(db);
    expect(linha.origin).toBe("remote");
    expect(linha.actor_label).toBe("Yuri");
    expect(linha.user_id).toBe(UUID.yuri);
  });
});

describe("CASO E — automação correlacionada", () => {
  it("desligamento programado continua Automação, com o nome da regra", async () => {
    const db = await bancoDaCadeia(); await aplicarCorrecaoP0(db);
    await semear(db);
    await db.query(`UPDATE public.equipments SET last_outputs_state=$1, last_confirmed_state=1,
                      last_changed_by='Desligamento 17h' WHERE id=$2`, [LIGADO, UUID.poco]);
    await db.query(`DELETE FROM public.automation_log`);
    await comando(db, { src: "backend-reset:scheduled_shutdown:17h", createdBy: null, frame: frameOff });
    await telemetria(db, DESLIGADO);

    const [linha] = await linhasDoRelatorio(db);
    expect(linha.action).toBe("turn_off");
    expect(linha.origin).toBe("auto");
    expect(linha.actor_label).toBe("Desligamento 17h");
  });
});

describe("CASO F — RX repetido", () => {
  it("OFF → OFF não cria evento nenhum", async () => {
    const db = await bancoDaCadeia(); await aplicarCorrecaoP0(db); await semear(db);
    await telemetria(db, DESLIGADO);
    await db.query(`UPDATE public.equipments SET last_communication = now() WHERE id=$1`, [UUID.poco]);
    await telemetria(db, DESLIGADO);

    expect(await linhasDoRelatorio(db)).toHaveLength(0);
  });
});

describe("intenção do comando vem do bit da saída, não de regex", () => {
  const casos: Array<[string, number, string | null]> = [
    ["[3031_1_]{100000}[3031_ETX_]", 1, "turn_on"],
    ["[3031_1_]{000000}[3031_ETX_]", 1, "turn_off"],
    ["[3031_1_]{100000}[3031_ETX_]", 2, "turn_off"],   // outra saída, mesmo frame
    ["[3031_1_]{010000}[3031_ETX_]", 2, "turn_on"],
    ["[3031_1_]{000001}[3031_ETX_]", 6, "turn_on"],
    ["[3031_1_]{1}[3031_ETX_]",      1, "turn_on"],    // PLC de uma saída
    ["[3031_1_]{0}[3031_ETX_]",      1, "turn_off"],
    ["REP:R3:TX:R2:[3031_1_]{100000}[3031_ETX_]", 1, "turn_on"],  // via repetidor
    ["[3031_1_]{100000}[3031_ETX_]", 9, null],         // saída fora do payload
    ["[3031_ETX_]",                  1, null],         // sem payload: não inventa
  ];
  it("classifica cada frame real", async () => {
    const db = await bancoDaCadeia(); await aplicarCorrecaoP0(db);
    for (const [frame, saida, esperado] of casos) {
      const r = await db.query<any>(
        `SELECT public.command_intent_from_frame($1,$2) AS intent`, [frame, saida]);
      expect(`${frame}|saida${saida} → ${r.rows[0].intent}`)
        .toBe(`${frame}|saida${saida} → ${esperado}`);
    }
  });

  it("a regex antiga errava justamente o LIGAR de 6 saídas", async () => {
    const db = await bancoDaCadeia();
    const r = await db.query<any>(
      `SELECT CASE WHEN $1 ~ '\\{0*1\\}' THEN 'turn_on' ELSE 'turn_off' END AS antigo`,
      ["[3031_1_]{100000}[3031_ETX_]"]);
    expect(r.rows[0].antigo).toBe("turn_off");   // o bug, reproduzido
  });
});

// ── a classificação não toca o caminho físico ──────────────────────────────
describe("a correção é só de auditoria", () => {
  it("classificar não cria comando, não mexe em desired_running nem no bitfield", async () => {
    const db = await bancoDaCadeia(); await aplicarCorrecaoP0(db); await semear(db);
    await comando(db, { src: "whatsapp:Yuri|5577999608294", createdBy: UUID.yuri, frame: frameOn });

    const antes = (await db.query<any>(
      `SELECT count(*)::int AS n FROM public.commands`)).rows[0].n;
    await telemetria(db, LIGADO);              // dispara toda a cadeia

    const depois = await db.query<any>(`
      SELECT (SELECT count(*)::int FROM public.commands) AS cmds,
             (SELECT desired_running FROM public.equipments WHERE id='${UUID.poco}') AS desired,
             (SELECT last_outputs_state FROM public.equipments WHERE id='${UUID.poco}') AS bits`);
    expect(depois.rows[0].cmds).toBe(antes);   // nenhum comando nasceu da classificação
    expect(depois.rows[0].desired).toBe(false); // ninguém mexeu na intenção
    expect(depois.rows[0].bits).toBe(LIGADO);   // só a telemetria escreveu

    // e o evento foi classificado
    const [linha] = await linhasDoRelatorio(db);
    expect(linha.origin).toBe("whatsapp");
  });
});
