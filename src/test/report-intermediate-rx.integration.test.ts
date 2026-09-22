// @vitest-environment node
// ─────────────────────────────────────────────────────────────────────────────
// Resposta intermediária não é ação
// ─────────────────────────────────────────────────────────────────────────────
// Regra do protocolo: com um comando em voo, o PLC pode responder com o estado
// que a bomba AINDA tem. Isso não é um evento operacional — é "ainda não
// chegou". O relatório deve registrar a confirmação (a transição para o alvo)
// e a transição espontânea real, nada entre as duas.
//
// Postgres real, funções reais das migrations, gatilhos com os nomes reais.

import { describe, it, expect } from "vitest";
import {
  bancoDaCadeia, aplicarCorrecaoP0, semear, telemetria, linhasDoRelatorio, UUID,
} from "./helpers/reportChainDb";

const ON = "100000", OFF = "000000";
const frameOn  = "[3031_1_]{100000}[3031_ETX_]\r";
const frameOff = "[3031_1_]{000000}[3031_ETX_]\r";

async function preparar(estadoInicial: string) {
  const db = await bancoDaCadeia();
  await aplicarCorrecaoP0(db);
  await semear(db);
  if (estadoInicial !== OFF) {
    await db.query(`UPDATE public.equipments SET last_outputs_state=$1,
                      last_confirmed_state=1 WHERE id=$2`, [estadoInicial, UUID.poco]);
    await db.query(`DELETE FROM public.automation_log`);
  }
  return db;
}

async function comandar(db: any, frame: string, src = "web") {
  await db.query(
    `INSERT INTO public.commands (farm_id, equipment_id, type, frame, source_device, created_by, created_at)
     VALUES ($1,$2,'manual',$3,$4,$5, now())`,
    [UUID.fazenda, UUID.poco, frame, src, UUID.yuri]);
  await db.query(`UPDATE public.equipments SET desired_running=$1 WHERE id=$2`,
    [frame.includes("{1"), UUID.poco]);
}

const acoes = (linhas: any[]) => linhas.map((l) => `${l.action}/${l.origin}`);

// ── TESTE A — LIGAR ────────────────────────────────────────────────────────
describe("TESTE A — ligar", () => {
  it("RX intermediário 0 não gera evento; só a confirmação 1 vira linha", async () => {
    const db = await preparar(OFF);
    await comandar(db, frameOn);
    await telemetria(db, OFF);   // intermediário: ainda desligada
    await telemetria(db, ON);    // confirmação física

    const linhas = await linhasDoRelatorio(db);
    expect(acoes(linhas)).toEqual(["turn_on/remote"]);
    expect(linhas[0].actor_label).toBe("Yuri");
  });
});

// ── TESTE B — DESLIGAR ─────────────────────────────────────────────────────
describe("TESTE B — desligar", () => {
  it("RX intermediário 1 não gera evento; só a confirmação 0 vira linha", async () => {
    const db = await preparar(ON);
    await comandar(db, frameOff);
    await telemetria(db, ON);    // intermediário: ainda ligada
    await telemetria(db, OFF);   // confirmação física

    const linhas = await linhasDoRelatorio(db);
    expect(acoes(linhas)).toEqual(["turn_off/remote"]);
    expect(linhas[0].actor_label).toBe("Yuri");
  });
});

// ── TESTE C — vários intermediários ────────────────────────────────────────
describe("TESTE C — vários RX intermediários", () => {
  it("0,0,0,1 com alvo 1 → exatamente uma linha Ligada", async () => {
    const db = await preparar(OFF);
    await comandar(db, frameOn);
    for (const rx of [OFF, OFF, OFF, ON]) await telemetria(db, rx);

    expect(acoes(await linhasDoRelatorio(db))).toEqual(["turn_on/remote"]);
  });
});

// ── TESTE D — comando que não confirmou ────────────────────────────────────
describe("TESTE D — comando não confirmado", () => {
  it("alvo 1 que nunca chega não vira nem Ligada nem Desligada", async () => {
    const db = await preparar(OFF);
    await comandar(db, frameOn);
    await telemetria(db, OFF);
    await telemetria(db, OFF);
    await db.query(`UPDATE public.commands SET status='error',
                      responded_at=now() WHERE equipment_id=$1`, [UUID.poco]);

    expect(await linhasDoRelatorio(db)).toHaveLength(0);
  });

  it("o TX 0 de segurança sem confirmação também não é acionamento", async () => {
    // Assinatura real da Sossego/POÇO 04: 13 linhas "Desligada / Local" em uma
    // noite, todas de 'backend-reset:turn_on_timeout', com command_status
    // 'error' e "TX 0 de seguranca sem confirmacao apos 60s" no próprio
    // details — e mesmo assim result='success' na linha do log.
    // Condição REAL: o eco do comando já tinha marcado a bomba como ligada,
    // então o TX 0 de segurança parece mudança de estado. Num banco limpo a
    // linha seria descartada como repetição e o teste passaria por engano.
    const db = await preparar(ON);
    await db.query(`
      INSERT INTO public.automation_log
        (farm_id, equipment_id, equipment_name, occurred_at, origin, action, result,
         source_device, details)
      VALUES ($1,$2,'POÇO 04', now(), 'system','turn_off','success',
              'backend-reset:turn_on_timeout',
              jsonb_build_object('systemic', true, 'command_status','error',
                                 'error_message','TX 0 de seguranca sem confirmacao apos 60s'))`,
      [UUID.fazenda, UUID.poco]);

    expect(await linhasDoRelatorio(db)).toHaveLength(0);
  });
});

// ── TESTE E — transição realmente local ────────────────────────────────────
describe("TESTE E — transição espontânea sem comando", () => {
  it("sem comando correlacionável vira uma linha Local / Acionamento local", async () => {
    const db = await bancoDaCadeia(); await aplicarCorrecaoP0(db);
    await semear(db, { origem: "local" });   // a telemetria declarou local
    await telemetria(db, ON);

    const linhas = await linhasDoRelatorio(db);
    expect(acoes(linhas)).toEqual(["turn_on/local"]);
    expect(linhas[0].actor_label).toBe("Acionamento local");
  });
});

// ── o caso que realmente aconteceu na Sossego ──────────────────────────────
describe("eco do comando seguido do estado real", () => {
  it("ACK 1 e depois RX 0 com alvo 1 não pode virar 'Desligada'", async () => {
    // POÇO 02 da Sossego, 16/09: 09:14:39 Ligada/Automático e 09:14:41
    // Desligada/Local — dois segundos. Bomba nenhuma liga e desliga em 2s.
    const db = await preparar(OFF);
    await comandar(db, frameOn, "cloud-automation");
    await telemetria(db, ON);    // eco/ACK do comando
    await telemetria(db, OFF);   // estado real: ainda não partiu
    await telemetria(db, ON);    // partiu de verdade

    const linhas = await linhasDoRelatorio(db);
    expect(acoes(linhas)).toEqual(["turn_on/remote"]);
    expect(acoes(linhas)).not.toContain("turn_off/local");
  });
});
