// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp — classificação de comunicação por FRESHNESS, não por flag
// ─────────────────────────────────────────────────────────────────────────────
// Regressão do que foi visto em produção em 21/09/2026, ~18:16 BRT:
//
//   Sossego     tela: POÇO 04 OFFLINE      WhatsApp: "POÇO 04 — Desligado"
//   Terra Norte tela: 9 cards OFFLINE      WhatsApp: "OFFLINE (1): Poço 09"
//
// A causa não era dado divergente — `last_communication` é o mesmo para os
// dois. Era regra divergente: o WhatsApp exigia
//
//     communication_status === 'offline'  E  silêncio > 30 min
//
// e o primeiro termo matava a decisão, porque `communication_status` é um flag
// persistido que ninguém atualiza. No dia, 64 dos 128 equipamentos ativos
// estavam marcados 'online' e nove deles não comunicavam havia dias. Só o
// Poço 09 tinha o flag correto — por isso foi o único que o WhatsApp acertou,
// e por coincidência, não por regra.
//
// O timeout fixo de 30 min também não correspondia a nada: Sossego, Semear e
// Terra Norte usam 15, que é o default do sistema.
//
// Estes testes leem o ARQUIVO REAL da edge function. Não há import possível
// (é Deno), então a garantia é estrutural — mesma abordagem de
// cron-auth-guard.test.ts. Nenhuma mensagem é enviada, nenhum comando é criado.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const SRC = "supabase/functions/whatsapp-webhook/index.ts";
const src = readFileSync(SRC, "utf8");

/** Corpo de computeEqState, do cabeçalho até o fecho da função. */
function corpoComputeEqState(): string {
  const i = src.indexOf("function computeEqState(");
  expect(i).toBeGreaterThan(-1);
  const fim = src.indexOf("\n}", i);
  return src.slice(i, fim + 2);
}

// ── 1 — o flag persistido saiu da decisão ───────────────────────────────────
describe("communication_status deixou de decidir OFFLINE", () => {
  it("computeEqState não lê mais communication_status", () => {
    expect(corpoComputeEqState()).not.toMatch(/communication_status/);
  });

  it("a condição antiga (flag + 30 min fixos) não existe mais", () => {
    const corpo = corpoComputeEqState();
    expect(corpo).not.toMatch(/commStatus\s*===\s*"offline"/);
    expect(corpo).not.toMatch(/30\s*\*\s*60\s*\*\s*1000/);
  });
});

// ── 2 — a decisão vem de freshness contra a janela da fazenda ───────────────
describe("OFFLINE derivado de last_communication", () => {
  it("usa last_communication e a janela recebida por parâmetro", () => {
    const corpo = corpoComputeEqState();
    expect(corpo).toMatch(/last_communication/);
    expect(corpo).toMatch(/janelaDaFazenda\(timeoutMin\)/);
    expect(corpo).toMatch(/lastCommMs <= 0 \|\| \(Date\.now\(\) - lastCommMs\) >= janelaMs/);
  });

  it("last_communication nulo ou ausente é OFFLINE, não 'desligado'", () => {
    // lastCommMs vale 0 quando o campo é null; a condição `<= 0` cobre isso.
    expect(corpoComputeEqState()).toMatch(/lastCommMs <= 0/);
  });

  it("maintenance_mode mantém precedência sobre offline", () => {
    const corpo = corpoComputeEqState();
    const iManut = corpo.indexOf("if (inMaintenance)");
    const iOff = corpo.indexOf("else if (isOffline)");
    expect(iManut).toBeGreaterThan(-1);
    expect(iOff).toBeGreaterThan(iManut);
  });

  it("quem comunica continua classificado pelo estado físico", () => {
    const corpo = corpoComputeEqState();
    expect(corpo).toMatch(/else if \(eq\.desired_running\) estado = "Ligado/);
    expect(corpo).toMatch(/else estado = "Desligado/);
  });
});

// ── 3 — default do sistema, não um número inventado ─────────────────────────
describe("janela da fazenda", () => {
  it("default é 15, o mesmo de enqueue_startup_sync_polling", () => {
    expect(src).toMatch(/const DEFAULT_COMM_TIMEOUT_MIN = 15;/);
  });

  it("zero e valores inválidos caem no default, não em janela nula", () => {
    expect(src).toMatch(
      /function janelaDaFazenda[\s\S]*?Number\.isFinite\(n\) && n > 0 \? n : DEFAULT_COMM_TIMEOUT_MIN/,
    );
  });

  it("o timeout vem de farms.comm_timeout_minutes", () => {
    expect(src).toMatch(/\.from\("farms"\)\.select\("id, comm_timeout_minutes"\)/);
  });
});

// ── 4 — custo: uma consulta por mensagem, nunca por equipamento ─────────────
describe("carga de leitura", () => {
  it("timeoutsDasFazendas aceita lista e resolve em uma consulta", () => {
    expect(src).toMatch(/async function timeoutsDasFazendas\(ids: string\[\]\)/);
    expect(src).toMatch(/\.in\("id", unicos\)/);
  });

  it("nenhuma chamada a timeoutsDasFazendas dentro de map/for de equipamento", () => {
    // As chamadas ficam antes dos laços; se alguma estivesse dentro de um
    // `.map(` de equipamento, viraria N consultas por mensagem.
    const chamadas = [...src.matchAll(/timeoutsDasFazendas\(/g)].length;
    expect(chamadas).toBe(5); // 1 definição + 4 call sites
    expect(src).not.toMatch(/\.map\([^)]*await timeoutsDasFazendas/);
  });

  it("todos os call sites passam a janela — nenhum usa o default por omissão", () => {
    const usos = [...src.matchAll(/computeEqState\(([^)]*)\)/g)]
      .map((m) => m[1].trim())
      .filter((a) => a && !a.startsWith("\n") && !a.includes("eq: any"));
    expect(usos.length).toBeGreaterThanOrEqual(3);
    for (const u of usos) expect(u).toMatch(/,/); // sempre 2 argumentos
  });
});

// ── 5 — o caminho de COMANDO não foi tocado ────────────────────────────────
describe("confirmação e bloqueio de comando seguem intactos", () => {
  it("o bloqueio por equipamento offline continua lendo communication_status direto", () => {
    // Deliberado: mudar este caminho passaria a RECUSAR comandos que hoje são
    // aceitos. Fica como dívida registrada, separada da classificação.
    expect(src).toMatch(/const commStatus = String\(t\.eq\.communication_status \?\? ""\)/);
  });

  it("a confirmação de comando continua vindo do estado físico, não da comunicação", () => {
    // O sucesso é decidido relendo o equipamento após o comando; a comunicação
    // entra apenas como sufixo explicativo numa mensagem de falha.
    expect(src).toMatch(/com sucesso — \$\{hh\}/);
    expect(src).toMatch(/possivelmente offline/);
  });

  it("computeEqState não participa de nenhuma decisão de atuação", () => {
    // Os consumidores usam só `estado`, `isOffline` e `inMaintenance` para
    // montar texto e filtrar listagem.
    expect(src).not.toMatch(/computeEqState\([^)]*\)[\s\S]{0,80}enqueue_remote_command/);
  });
});
