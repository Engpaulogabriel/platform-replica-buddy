// ─────────────────────────────────────────────────────────────────────────────
// Desligamento Forçado — roteamento por fazenda
// ─────────────────────────────────────────────────────────────────────────────
// A flag forced_shutdown_enabled é lida pelo Agent no backend da PRÓPRIA
// fazenda. Se a tela ler/gravar no backend errado, ela afirma "Ativo" enquanto
// o Agent enxerga false — e a bomba em modo LOCAL deixa de ser desligável.
// Nenhum I/O real: garantias estruturais sobre o código-fonte + roteamento puro.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";

const PEROLA = "1014a8ab-b02a-47c7-90fc-1646d52a991e";
const SOSSEGO = "3e45b5ac-856e-4d29-b3b8-4dd71f86140d";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { __id: "OLD" } }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ __id: "NEW" }) }));

import {
  assertOperationalClient,
  tryGetSupabaseForFarm,
  setNewBackendAuthReady,
  BackendRoutingError,
} from "@/lib/supabaseRouter";

const SRC = readFileSync("src/components/ForcedShutdownAdmin.tsx", "utf8");
const idOf = (c: unknown) => (c as { __id: string }).__id;

beforeEach(() => setNewBackendAuthReady(true));

describe("roteamento da tela de desligamento forçado", () => {
  it("o componente não importa mais o singleton OLD", () => {
    expect(SRC).not.toMatch(/from "@\/integrations\/supabase\/client"/);
  });

  it("nenhum acesso farm-scoped sobrou no singleton", () => {
    // Qualquer `supabase.from(...)` solto seria leak para o backend antigo.
    expect(SRC).not.toMatch(/\bsupabase\s*\n?\s*\.(from|rpc|functions)/);
  });

  it("a leitura da contagem passa pelo router", () => {
    expect(SRC).toMatch(/tryGetSupabaseForFarm\(farmId\)/);
    expect(SRC).toMatch(/await db\s*\n?\s*\.from\("equipments"\)\s*\n?\s*\.select/);
  });

  it("a gravação do toggle é fail-closed", () => {
    expect(SRC).toMatch(/assertOperationalClient\(farmId\)/);
    expect(SRC).toMatch(/await db\s*\n?\s*\.from\("equipments"\)\s*\n?\s*\.update\(\{ forced_shutdown_enabled/);
  });

  it("a releitura após gravar usa o MESMO cliente do UPDATE", () => {
    // read-after-write no backend em que a escrita ocorreu, não em outro.
    expect(SRC).toMatch(/await load\(farmId, db\)/);
  });

  it("falha de leitura zera a contagem em vez de manter número antigo", () => {
    expect(SRC).toMatch(/setCounts\(\{ total: 0, enabled: 0 \}\);\s*\n\s*setUnavailable/);
  });
});

describe("destino efetivo por fazenda", () => {
  it("Pérola → NEW, demais → OLD (leitura e escrita)", () => {
    expect(idOf(assertOperationalClient(PEROLA))).toBe("NEW");
    expect(idOf(assertOperationalClient(SOSSEGO))).toBe("OLD");
    const p = tryGetSupabaseForFarm(PEROLA);
    const s = tryGetSupabaseForFarm(SOSSEGO);
    expect(p.client && idOf(p.client)).toBe("NEW");
    expect(s.client && idOf(s.client)).toBe("OLD");
  });

  it("sem sessão no NEW, a Pérola recusa a gravação e não cai para OLD", () => {
    setNewBackendAuthReady(false);
    expect(() => assertOperationalClient(PEROLA)).toThrow(BackendRoutingError);
    // as demais fazendas seguem operando normalmente
    expect(idOf(assertOperationalClient(SOSSEGO))).toBe("OLD");
  });
});
