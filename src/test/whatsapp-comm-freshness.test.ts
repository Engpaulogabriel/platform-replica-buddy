// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp — comunicação por FRESHNESS, numa definição só
// ─────────────────────────────────────────────────────────────────────────────
// Duas coisas erradas foram vistas em produção em 21/09/2026 e são cobertas
// aqui.
//
// 1) Classificação divergente da tela, ~18:16 BRT:
//      Sossego     tela: POÇO 04 OFFLINE   WhatsApp: "POÇO 04 — Desligado"
//      Terra Norte tela: 9 cards OFFLINE   WhatsApp: "OFFLINE (1): Poço 09"
//    O dado não divergia — `last_communication` é o mesmo para os dois. A
//    regra divergia: o WhatsApp exigia `communication_status === 'offline'` E
//    30 min de silêncio, e o primeiro termo matava a decisão, porque esse flag
//    é persistido e ninguém o atualiza. No dia, 64 dos 128 equipamentos ativos
//    estavam marcados 'online' e nove não comunicavam havia dias. O Poço 09
//    foi o único acerto porque era um dos três com o flag certo — coincidência.
//    Os 30 min fixos também não correspondiam a configuração nenhuma: as
//    fazendas usam 15, o default do sistema.
//
// 2) Níveis sumindo da visão geral, ~21:27 BRT:
//      "status fazenda sossego" → trazia níveis
//      "status sossego"         → não trazia
//    O portão exigia a palavra literal "fazenda" no texto, embora o código já
//    estivesse dentro de `status_all` — ou seja, a intenção JÁ havia sido
//    resolvida como visão geral. Para o operador as duas frases são a mesma
//    pergunta.
//
// Os testes leem o ARQUIVO REAL da edge function. Não há import possível (é
// Deno), então a garantia é estrutural — mesma abordagem de
// cron-auth-guard.test.ts. Nenhuma mensagem é enviada, nenhum comando criado.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const SRC = "supabase/functions/whatsapp-webhook/index.ts";
const src = readFileSync(SRC, "utf8");

const corpoDe = (assinatura: string): string => {
  const i = src.indexOf(assinatura);
  expect(i).toBeGreaterThan(-1);
  return src.slice(i, src.indexOf("\n}", i) + 2);
};

// ── 1 — uma única definição de "sem comunicação" ───────────────────────────
describe("freshness centralizada", () => {
  it("o helper decide por last_communication, nunca pelo flag persistido", () => {
    const corpo = corpoDe("function semComunicacao(");
    expect(corpo).not.toMatch(/communication_status/);
    expect(corpo).toMatch(/last_communication/);
    expect(corpo).toMatch(/janelaDaFazenda\(timeoutMin\)/);
  });

  it("last_communication nulo ou ausente é OFFLINE, não 'desligado'", () => {
    expect(corpoDe("function semComunicacao(")).toMatch(/if \(!\(ms > 0\)\) return true;/);
  });

  it("as cinco decisões de comunicação passam pelo mesmo helper", () => {
    // 1 definição + 5 consumidores: classificação de bomba, rótulo de
    // listagem, bloqueio de comando, sufixo de não-confirmação e linha de
    // nível. Se este número subir sem um consumidor novo declarado aqui,
    // alguém abriu uma sexta decisão de comunicação fora do helper.
    expect([...src.matchAll(/semComunicacao\(/g)].length).toBe(6);
  });

  it("communication_status não decide mais nada em lugar nenhum", () => {
    const decisorias = src.split("\n")
      .filter((l) => l.includes("communication_status"))
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
      .filter((l) => !/select|selectCols/.test(l));
    expect(decisorias).toEqual([]);
  });

  it("nenhuma regra operacional usa mais 30 minutos fixos", () => {
    // Os 30 min que restam são TTL de aprovação, de código de registro e um
    // cutoff de histórico — nada ligado a comunicação.
    for (const l of src.split("\n").filter((x) => x.includes("30 * 60 * 1000"))) {
      expect(l).toMatch(/TTL|cutoff/i);
    }
  });
});

// ── 2 — a janela é a da fazenda, com o default do sistema ──────────────────
describe("janela de comunicação", () => {
  it("default é 15, igual ao de enqueue_startup_sync_polling", () => {
    expect(src).toMatch(/const DEFAULT_COMM_TIMEOUT_MIN = 15;/);
  });

  it("zero e valores inválidos caem no default, não em janela nula", () => {
    expect(src).toMatch(
      /function janelaDaFazenda[\s\S]*?Number\.isFinite\(n\) && n > 0 \? n : DEFAULT_COMM_TIMEOUT_MIN/,
    );
  });

  it("o valor vem de farms.comm_timeout_minutes", () => {
    expect(src).toMatch(/\.from\("farms"\)\.select\("id, comm_timeout_minutes"\)/);
  });

  it("uma consulta por mensagem, nunca uma por equipamento", () => {
    expect(src).toMatch(/async function timeoutsDasFazendas\(ids: string\[\]\)/);
    expect(src).toMatch(/\.in\("id", unicos\)/);
    expect(src).not.toMatch(/\.map\([^)]*await timeoutsDasFazendas/);
    // 1 definição + 7 call sites, todos FORA de laço por equipamento.
    expect([...src.matchAll(/timeoutsDasFazendas\(/g)].length).toBe(8);
    // o sufixo de não-confirmação reaproveita a janela já carregada para o
    // comando, em vez de consultar uma vez por bomba dentro de polls.push
    expect(src).toMatch(/semComunicacao\(finalEq, __janelaCmd\)/);
  });
});

// ── 3 — classificação preserva o estado físico ─────────────────────────────
describe("classificação de equipamento", () => {
  it("manutenção tem precedência sobre offline", () => {
    const corpo = corpoDe("function computeEqState(");
    expect(corpo.indexOf("else if (isOffline)"))
      .toBeGreaterThan(corpo.indexOf("if (inMaintenance)"));
  });

  it("quem comunica continua classificado pelo estado físico", () => {
    const corpo = corpoDe("function computeEqState(");
    expect(corpo).toMatch(/else if \(eq\.desired_running\) estado = "Ligado/);
    expect(corpo).toMatch(/else estado = "Desligado/);
  });

  it("todos os call sites passam a janela explicitamente", () => {
    const usos = [...src.matchAll(/computeEqState\(([^)]*)\)/g)]
      .map((m) => m[1].trim())
      .filter((a) => a && !a.includes("eq: any"));
    expect(usos.length).toBeGreaterThanOrEqual(3);
    for (const u of usos) expect(u).toMatch(/,/);
  });
});

// ── 4 — níveis na visão geral, sem depender da palavra "fazenda" ───────────
describe("status geral anexa níveis", () => {
  it("o portão não exige mais a palavra 'fazenda'", () => {
    const i = src.indexOf("const shouldAppendLevelsToStatus");
    const corpo = src.slice(i, src.indexOf("})();", i));
    expect(corpo).not.toMatch(/overviewSignal/);
    expect(corpo).toMatch(/return !mentionsLevels && !explicitPumpOnly;/);
  });

  it("pedido explícito de bombas continua sem níveis", () => {
    const i = src.indexOf("const shouldAppendLevelsToStatus");
    const corpo = src.slice(i, src.indexOf("})();", i));
    expect(corpo).toMatch(/explicitPumpOnly = .*bomba\|bombas\|poco\|pocos/);
  });

  it("o portão vive dentro de status_all — a intenção já foi resolvida", () => {
    const iGate = src.indexOf("const shouldAppendLevelsToStatus");
    const iKind = src.lastIndexOf('cmd.kind === "status_all"', iGate);
    expect(iKind).toBeGreaterThan(-1);
    expect(iKind).toBeLessThan(iGate);
  });

  it("consulta específica de nível segue em caminho próprio", () => {
    expect(src).toMatch(/if \(cmd\.kind === "level"\)/);
  });
});

// ── 5 — segurança: comando para equipamento sem comunicação ────────────────
describe("bloqueio de comando", () => {
  it("usa freshness, não o flag persistido", () => {
    expect(src).toMatch(/if \(semComunicacao\(t\.eq, __janelaCmd\)\) \{/);
  });

  it("a janela é carregada uma vez, antes do laço de alvos", () => {
    expect(src.indexOf("const __janelaCmd"))
      .toBeLessThan(src.indexOf("for (const t of validTargets)"));
  });

  it("manutenção continua tendo precedência sobre comunicação", () => {
    expect(src.indexOf("maintenanceTargets.push(t);"))
      .toBeLessThan(src.indexOf("offlineTargets.push(t);"));
  });

  it("a confirmação de comando continua vindo do estado físico", () => {
    // O sucesso é decidido relendo o equipamento; a comunicação entra só como
    // sufixo explicativo numa mensagem de falha.
    expect(src).toMatch(/com sucesso — \$\{hh\}/);
    expect(src).toMatch(/\(sem comunicação\)/);
  });

  it("computeEqState não participa de nenhuma decisão de atuação", () => {
    expect(src).not.toMatch(/computeEqState\([^)]*\)[\s\S]{0,80}enqueue_remote_command/);
  });
});

// ── 6 — níveis: comunicação separada da última medição ─────────────────────
// Até 22/09/2026 a seção de níveis não tinha checagem de comunicação NENHUMA —
// nem a regra antiga do flag. O RESERVATÓRIO 03 da Semear, mudo desde 13/08,
// era renderizado igual aos que haviam lido segundos antes.
describe("níveis", () => {
  it("existe UM renderizador de linha de nível, compartilhado", () => {
    expect(src).toMatch(/function linhasDeNivel\(/);
    // usado nos dois caminhos: status geral e consulta de níveis
    expect([...src.matchAll(/linhasDeNivel\(/g)].length).toBe(3);
  });

  it("a decisão de offline do nível usa o helper central, não uma regra nova", () => {
    const corpo = corpoDe("function linhasDeNivel(");
    expect(corpo).toMatch(/semComunicacao\(e, timeoutMin\)/);
    expect(corpo).not.toMatch(/communication_status/);
    expect(corpo).not.toMatch(/30\s*\*\s*60/);
  });

  it("offline mostra o estado primeiro e preserva a medição como histórico", () => {
    const corpo = corpoDe("function linhasDeNivel(");
    expect(corpo).toMatch(/⚫ \$\{e\.name\} — OFFLINE/);
    expect(corpo).toMatch(/Última medição conhecida: \$\{curStr\} \/ \$\{maxStr\}/);
    expect(corpo).toMatch(/Última leitura: \$\{fmt\(e\.level_last_raw_at\)\}/);
  });

  it("sem leitura alguma não inventa medição", () => {
    expect(corpoDe("function linhasDeNivel(")).toMatch(/Sem leitura disponível\./);
  });

  it("comunicando mantém exatamente o formato anterior", () => {
    const corpo = corpoDe("function linhasDeNivel(");
    expect(corpo).toMatch(/• \$\{e\.name\}: \$\{curStr\} \/ \$\{maxStr\} \(\$\{pctStr\}\)/);
    expect(corpo).toMatch(/\$\{bar\(percent\)\} \$\{pctStr\}/);
  });

  it("as duas consultas de nível trazem last_communication", () => {
    const selects = [...src.matchAll(/\.select\("id[^"]*level_last_raw_at"\)/g)].map((m) => m[0]);
    expect(selects.length).toBe(2);
    for (const sel of selects) expect(sel).toMatch(/last_communication/);
  });

  it("offline não contamina o Resumo de Captação", () => {
    // percent devolvido é null quando offline, então não entra em média nem
    // em taxa de variação por hora.
    expect(corpoDe("function linhasDeNivel(")).toMatch(/offline: true, percent: null/);
    expect(src).toMatch(/if \(r0\.offline\) continue;/);
  });
});
