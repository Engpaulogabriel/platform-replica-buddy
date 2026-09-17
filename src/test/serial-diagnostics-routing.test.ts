// ─────────────────────────────────────────────────────────────────────────────
// Diagnóstico serial — roteamento por fazenda e honestidade do log
// ─────────────────────────────────────────────────────────────────────────────
// Nenhum I/O real: garantias estruturais sobre o código-fonte + roteamento puro.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";

const PEROLA = "1014a8ab-b02a-47c7-90fc-1646d52a991e";
const SOSSEGO = "3e45b5ac-856e-4d29-b3b8-4dd71f86140d";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { __id: "OLD" } }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ __id: "NEW" }) }));

import { assertOperationalClient, getSupabaseForFarm, setNewBackendAuthReady, BackendRoutingError }
  from "@/lib/supabaseRouter";

const SRC = readFileSync("src/components/platform/PlatformSerialTerminal.tsx", "utf8");
const idOf = (c: unknown) => (c as { __id: string }).__id;

beforeEach(() => setNewBackendAuthReady(true));

describe("roteamento do diagnóstico serial", () => {
  it("Pérola → NEW, demais fazendas → OLD", () => {
    expect(idOf(assertOperationalClient(PEROLA))).toBe("NEW");
    expect(idOf(assertOperationalClient(SOSSEGO))).toBe("OLD");
    expect(idOf(getSupabaseForFarm(PEROLA))).toBe("NEW");
    expect(idOf(getSupabaseForFarm(SOSSEGO))).toBe("OLD");
  });

  it("sem sessão no backend novo, Pérola falha fechada e não cai para OLD", () => {
    setNewBackendAuthReady(false);
    expect(() => assertOperationalClient(PEROLA)).toThrow(BackendRoutingError);
    expect(idOf(assertOperationalClient(SOSSEGO))).toBe("OLD"); // outras seguem normais
  });

  it("o componente não usa o singleton em operação farm-scoped", () => {
    // Sobram apenas os acessos à lista GLOBAL de fazendas da plataforma.
    const usos = SRC.match(/\bsupabase\s*\n?\s*\.(from|rpc|functions)/g) ?? [];
    expect(usos.length).toBeLessThanOrEqual(2);
    expect(SRC).not.toMatch(/supabase\s*\n?\s*\.from\(\s*"agent_commands"/);
    expect(SRC).not.toMatch(/supabase\s*\n?\s*\.from\(\s*"equipments"/);
  });

  it("serial_terminal e serial_sniff resolvem o cliente e o capturam", () => {
    expect((SRC.match(/assertOperationalClient\(farmId\)/g) ?? []).length).toBe(2);
    expect(SRC).toMatch(/getSupabaseForFarm\(id\)[\s\S]{0,80}\.from\("equipments"\)/);
    // INSERT e polling usam o MESMO objeto capturado
    expect(SRC).toMatch(/await db\s*\n?\s*\.from\("agent_commands"\)/);
  });
});

describe("honestidade do log", () => {
  it("não existe TX antes de qualquer I/O", () => {
    // O push("tx", label) do clique foi removido; TX só a partir do que o agente devolve.
    expect(SRC).not.toMatch(/push\("tx",\s*label\)/);
  });

  it("TX só aparece com o frame que o agente declarou ter enviado", () => {
    expect(SRC).toMatch(/if \(d\?\.sent\) push\("tx", d\.sent\)/);
    const txPushes = SRC.match(/push\("tx",/g) ?? [];
    expect(txPushes.length).toBe(1);
  });

  it("enfileiramento é rotulado como enfileiramento, não como transmissão", () => {
    expect(SRC).toMatch(/CMD enfileirado/);
  });

  it("RX continua vindo de responses reais do agente", () => {
    expect(SRC).toMatch(/d\.responses\.forEach\(\(r: string\) => push\("rx", r\)\)/);
    expect(SRC).toMatch(/d\?\.frames|d\.frames/); // sniff: frames reais
  });

  it("timeout não infere causa não comprovada", () => {
    expect(SRC).not.toMatch(/agente offline ou serial ocupada/);
    expect(SRC).toMatch(/TIMEOUT - comando .* sem resposta em 30s/);
  });

  it("falha de INSERT não gera TX nem inicia polling", () => {
    // O bloco de erro retorna antes do laço de polling.
    expect(SRC).toMatch(/Falha ao enfileirar[\s\S]{0,120}return;/);
  });
});
