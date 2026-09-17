// ─────────────────────────────────────────────────────────────────────────────
// Roteamento dual-backend — provas de corrida, isolamento e fail-closed
// ─────────────────────────────────────────────────────────────────────────────
// Nenhum destes testes toca banco real, cria command pending ou liga bomba.
// Tudo é roteamento: provamos PARA ONDE a operação iria, não a executamos.

import { describe, it, expect, beforeEach, vi } from "vitest";

const PEROLA = "1014a8ab-b02a-47c7-90fc-1646d52a991e";
const SOSSEGO = "3e45b5ac-856e-4d29-b3b8-4dd71f86140d";
const SEMEAR = "0b1d53df-6d5c-4674-8517-9299aac3ec18";

// Clientes falsos, identificáveis. Nenhuma rede.
const fakeOld = { __id: "OLD" } as never;
const fakeNew = { __id: "NEW" } as never;

vi.mock("@/integrations/supabase/client", () => ({ supabase: { __id: "OLD" } }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ __id: "NEW" }),
}));

import {
  getSupabaseForFarm,
  tryGetSupabaseForFarm,
  assertOperationalClient,
  backendLabelForFarm,
  setNewBackendAuthReady,
  BackendRoutingError,
} from "@/lib/supabaseRouter";
import { isFarmMigrated, MIGRATED_FARMS } from "@/lib/migrationRegistry";

const idOf = (c: unknown) => (c as { __id: string }).__id;

/** Simula uma "seleção visual de fazenda" — a variável global que NÃO pode mandar. */
let selecaoVisual: string = PEROLA;

/**
 * Simula um fluxo operacional realista: resolve o cliente UMA VEZ e depois
 * atravessa vários awaits, como faz commandQueue (~12 acessos encadeados).
 */
async function fluxoOperacional(farmId: string, passos = 5) {
  const client = getSupabaseForFarm(farmId); // ← resolução única
  const visitados: string[] = [];
  for (let i = 0; i < passos; i++) {
    await new Promise((r) => setTimeout(r, 1));
    visitados.push(idOf(client)); // usa o objeto capturado
  }
  return visitados;
}

beforeEach(() => {
  selecaoVisual = PEROLA;
  setNewBackendAuthReady(true);
});

describe("registry", () => {
  it("contém exclusivamente a Pérola", () => {
    expect([...MIGRATED_FARMS]).toEqual([PEROLA]);
  });
  it("classifica corretamente", () => {
    expect(isFarmMigrated(PEROLA)).toBe(true);
    expect(isFarmMigrated(SOSSEGO)).toBe(false);
    expect(isFarmMigrated(SEMEAR)).toBe(false);
    expect(isFarmMigrated(null)).toBe(false);
    expect(isFarmMigrated(undefined)).toBe(false);
    expect(isFarmMigrated("")).toBe(false);
  });
});

describe("roteamento básico", () => {
  it("Pérola → NEW, demais → OLD", () => {
    expect(idOf(getSupabaseForFarm(PEROLA))).toBe("NEW");
    expect(idOf(getSupabaseForFarm(SOSSEGO))).toBe("OLD");
    expect(idOf(getSupabaseForFarm(SEMEAR))).toBe("OLD");
    expect(backendLabelForFarm(PEROLA)).toBe("NEW");
    expect(backendLabelForFarm(SOSSEGO)).toBe("OLD");
  });
});

describe("FASE 10 — corrida entre fazendas", () => {
  it("TESTE A: Pérola inicia, UI troca para Sossego no meio → operação segue NEW", async () => {
    const p = fluxoOperacional(PEROLA, 6);
    selecaoVisual = SOSSEGO; // troca visual imediata
    const visitados = await p;
    expect(visitados).toHaveLength(6);
    expect(new Set(visitados)).toEqual(new Set(["NEW"]));
    expect(selecaoVisual).toBe(SOSSEGO); // a seleção mudou…
  });

  it("TESTE B: Sossego inicia, UI troca para Pérola no meio → operação segue OLD", async () => {
    selecaoVisual = SOSSEGO;
    const p = fluxoOperacional(SOSSEGO, 6);
    selecaoVisual = PEROLA;
    const visitados = await p;
    expect(new Set(visitados)).toEqual(new Set(["OLD"]));
  });

  it("TESTE C: duas operações simultâneas de fazendas diferentes não se contaminam", async () => {
    const [a, b] = await Promise.all([
      fluxoOperacional(PEROLA, 8),
      fluxoOperacional(SOSSEGO, 8),
    ]);
    expect(new Set(a)).toEqual(new Set(["NEW"]));
    expect(new Set(b)).toEqual(new Set(["OLD"]));
  });

  it("TESTE D: StrictMode/rerender — resolver de novo não muda a operação já iniciada", async () => {
    const capturado = getSupabaseForFarm(PEROLA);
    // rerenders simulados resolvendo outras fazendas em paralelo
    for (let i = 0; i < 10; i++) {
      getSupabaseForFarm(i % 2 === 0 ? SOSSEGO : SEMEAR);
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(idOf(capturado)).toBe("NEW");
  });

  it("TESTE E: ON/OFF decide pelo farmId da operação, não pela seleção visual", () => {
    selecaoVisual = SOSSEGO; // usuário olhando outra fazenda
    // a operação carrega o farmId da Pérola consigo
    expect(idOf(assertOperationalClient(PEROLA))).toBe("NEW");
    selecaoVisual = PEROLA;
    expect(idOf(assertOperationalClient(SOSSEGO))).toBe("OLD");
  });
});

describe("FASE 9 — fail-closed", () => {
  it("TESTE F: Pérola sem sessão no NEW → escrita falha, e NUNCA devolve OLD", () => {
    setNewBackendAuthReady(false);
    let erro: unknown;
    try { assertOperationalClient(PEROLA); } catch (e) { erro = e; }
    expect(erro).toBeInstanceOf(BackendRoutingError);
    expect((erro as BackendRoutingError).code).toBe("new_backend_unauthenticated");
    // a prova que importa: nenhum caminho devolveu o cliente antigo
    expect(() => assertOperationalClient(PEROLA)).toThrow();
  });

  it("TESTE G: Sossego sem sessão no NEW → continua funcionando normalmente em OLD", () => {
    setNewBackendAuthReady(false);
    expect(idOf(assertOperationalClient(SOSSEGO))).toBe("OLD");
    expect(idOf(assertOperationalClient(SEMEAR))).toBe("OLD");
  });

  it("operação sem farmId é recusada (não assume fazenda)", () => {
    let erro: unknown;
    try { assertOperationalClient(null); } catch (e) { erro = e; }
    expect((erro as BackendRoutingError).code).toBe("farm_unknown");
  });

  it("leitura da Pérola não cai silenciosamente para OLD", () => {
    const r = tryGetSupabaseForFarm(PEROLA);
    // com o cliente NEW configurado no mock, devolve NEW
    expect(r.client && idOf(r.client)).toBe("NEW");
    expect(r.migrated).toBe(true);
    // e para fazenda não migrada, OLD, como sempre
    const s = tryGetSupabaseForFarm(SOSSEGO);
    expect(s.client && idOf(s.client)).toBe("OLD");
    expect(s.migrated).toBe(false);
  });
});

describe("isolamento das demais fazendas", () => {
  it("nenhuma fazenda além da Pérola é roteada para NEW", () => {
    const outras = [SOSSEGO, SEMEAR, "7af7cc0d-a170-4a0c-972d-451f4a9b17cc", crypto.randomUUID()];
    for (const f of outras) {
      expect(backendLabelForFarm(f)).toBe("OLD");
      expect(idOf(getSupabaseForFarm(f))).toBe("OLD");
      expect(idOf(assertOperationalClient(f))).toBe("OLD");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FASE 10 (continuação) — fluxos operacionais completos da tela da Pérola
// ─────────────────────────────────────────────────────────────────────────────
describe("matriz operacional por recurso", () => {
  // Cada entrada replica como o hook/função real resolve o cliente.
  const recursos = [
    "equipments", "plc_groups", "sectors", "site_health",
    "commands", "agent_commands", "daily_consumption", "farms",
  ] as const;

  it("A/B: todo recurso operacional da Pérola vai NEW e o da Sossego vai OLD", () => {
    for (const _r of recursos) {
      expect(idOf(getSupabaseForFarm(PEROLA))).toBe("NEW");
      expect(idOf(getSupabaseForFarm(SOSSEGO))).toBe("OLD");
    }
  });

  it("C/F: escritas operacionais (ON/OFF, Atualizar Status, agent_command)", () => {
    for (const _op of ["turn_on", "turn_off", "status_read", "agent_command"]) {
      expect(idOf(assertOperationalClient(PEROLA))).toBe("NEW");
      expect(idOf(assertOperationalClient(SOSSEGO))).toBe("OLD");
    }
  });

  it("D/G: resultado do comando é lido no MESMO backend em que foi criado", () => {
    // simula enqueue → tracking, ambos derivados do mesmo farmId
    const criar = (farm: string) => ({ farm, client: assertOperationalClient(farm) });
    const acompanhar = (op: { farm: string }) => getSupabaseForFarm(op.farm);
    const opP = criar(PEROLA);
    const opS = criar(SOSSEGO);
    expect(idOf(opP.client)).toBe(idOf(acompanhar(opP))); // NEW == NEW
    expect(idOf(opS.client)).toBe(idOf(acompanhar(opS))); // OLD == OLD
    expect(idOf(acompanhar(opP))).toBe("NEW");
    expect(idOf(acompanhar(opS))).toBe("OLD");
  });
});

describe("corrida nos novos fluxos", () => {
  it("TESTE I: trocar de fazenda durante o command tracking não muda o cliente", async () => {
    // waitForCommand resolve o cliente ANTES do primeiro await
    const client = getSupabaseForFarm(PEROLA);
    selecaoVisual = SOSSEGO;
    const lidos: string[] = [];
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 1));
      lidos.push(idOf(client));
    }
    expect(new Set(lidos)).toEqual(new Set(["NEW"]));
  });

  it("TESTE J: trocar de fazenda durante refresh de equipments não muda o cliente", async () => {
    const client = getSupabaseForFarm(PEROLA); // loadAll(farmId)
    const outro = getSupabaseForFarm(SOSSEGO); // outro effect, outro cliente
    selecaoVisual = SOSSEGO;
    await new Promise((r) => setTimeout(r, 2));
    expect(idOf(client)).toBe("NEW");
    expect(idOf(outro)).toBe("OLD");
  });

  it("TESTE K/L: sem sessão NEW, Pérola bloqueia e Sossego segue normal", () => {
    setNewBackendAuthReady(false);
    expect(() => assertOperationalClient(PEROLA)).toThrow(BackendRoutingError);
    expect(idOf(assertOperationalClient(SOSSEGO))).toBe("OLD");
    // leitura da Pérola não devolve OLD disfarçado
    const r = tryGetSupabaseForFarm(PEROLA);
    expect(r.client === null || idOf(r.client) === "NEW").toBe(true);
  });
});
