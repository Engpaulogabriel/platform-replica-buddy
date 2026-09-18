// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp — Edge Functions farm-scoped seguem o backend da fazenda
// ─────────────────────────────────────────────────────────────────────────────
// Uma Edge Function invocada no projeto errado NÃO dá erro: ela responde 200
// usando os operadores e permissões congelados no cutover. A mensagem sai — para
// a lista errada. Por isso estes testes olham para ONDE a chamada vai, não se
// ela "funcionou".
//
// Nenhuma mensagem real é enviada: os clientes são dublês.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const PEROLA = "1014a8ab-b02a-47c7-90fc-1646d52a991e";
const SOSSEGO = "3e45b5ac-856e-4d29-b3b8-4dd71f86140d";

/** Registra cada invoke: {backend, fn}. Nenhuma rede. */
// `vi.hoisted` porque `vi.mock` sobe para o topo do arquivo e não enxergaria
// variáveis declaradas normalmente aqui.
const { invocacoes, fakeClient } = vi.hoisted(() => {
  const invocacoes: Array<{ backend: string; fn: string }> = [];
  const fakeClient = (backend: string) => ({
    __id: backend,
    functions: {
      invoke: async (fn: string) => {
        invocacoes.push({ backend, fn });
        return { data: { ok: true }, error: null };
      },
    },
    auth: { getSession: async () => ({ data: { session: null } }) },
  });
  return { invocacoes, fakeClient };
});

vi.mock("@/integrations/supabase/client", () => ({ supabase: fakeClient("OLD") }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => fakeClient("NEW") }));

import { notifyWhatsAppImmediate, invokeWhatsAppNotificationDiagnostic } from "@/lib/whatsappNotify";
import { setNewBackendAuthReady, backendEndpointForFarm } from "@/lib/supabaseRouter";
import { MIGRATED_FARMS, isFarmMigrated } from "@/lib/migrationRegistry";

const src = (p: string) => readFileSync(p, "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !/\.test\.|\/test\//.test(p)) out.push(p);
  }
  return out;
}

/** Edge Functions que operam sobre UMA fazenda. */
const FARM_SCOPED_FNS = ["whatsapp-automation-notify", "whatsapp-broadcast", "whatsapp-alerts"];

beforeEach(() => {
  invocacoes.length = 0;
  setNewBackendAuthReady(true);
});

// ── 1 — farmId obrigatório ──────────────────────────────────────────────────
describe("assinatura", () => {
  it("notifyWhatsAppImmediate recebe farmId como primeiro parâmetro", () => {
    const code = src("src/lib/whatsappNotify.ts");
    expect(code).toMatch(/export async function notifyWhatsAppImmediate\(\s*\n\s*farmId: string \| null \| undefined,/);
    expect(code).toMatch(/export async function invokeWhatsAppNotificationDiagnostic\(\s*\n\s*farmId: string \| null \| undefined,/);
  });

  it("sem fazenda identificada, nada é invocado", async () => {
    const r = await notifyWhatsAppImmediate(null, "alert", {});
    expect(invocacoes).toEqual([]);
    expect((r as { ok: boolean }).ok).toBe(false);
    expect((r as { via: string }).via).toBe("blocked");
  });
});

// ── 2, 3, 5, 6 — destino por fazenda ────────────────────────────────────────
describe("whatsapp-automation-notify", () => {
  it("Pérola invoca no backend NOVO", async () => {
    await notifyWhatsAppImmediate(PEROLA, "mode_change", { farm_id: PEROLA });
    expect(invocacoes).toEqual([{ backend: "NEW", fn: "whatsapp-automation-notify" }]);
  });

  it("fazenda não migrada invoca no backend ANTIGO", async () => {
    await notifyWhatsAppImmediate(SOSSEGO, "mode_change", { farm_id: SOSSEGO });
    expect(invocacoes).toEqual([{ backend: "OLD", fn: "whatsapp-automation-notify" }]);
  });

  it("o diagnóstico segue a mesma rota", async () => {
    await invokeWhatsAppNotificationDiagnostic(PEROLA, { farm_id: PEROLA });
    expect(invocacoes.map((i) => i.backend)).toEqual(["NEW"]);
  });
});

// ── 4 — fail-closed, sem cair para o antigo ─────────────────────────────────
describe("fail-closed", () => {
  it("Pérola sem sessão no NOVO não invoca nada — e jamais o ANTIGO", async () => {
    setNewBackendAuthReady(false);
    const r = await notifyWhatsAppImmediate(PEROLA, "operator_approved", { farm_id: PEROLA });
    expect(invocacoes).toEqual([]);
    expect((r as { ok: boolean }).ok).toBe(false);
    expect((r as { via: string }).via).toBe("blocked");
  });

  it("e as outras fazendas continuam funcionando normalmente", async () => {
    setNewBackendAuthReady(false);
    await notifyWhatsAppImmediate(SOSSEGO, "operator_approved", { farm_id: SOSSEGO });
    expect(invocacoes).toEqual([{ backend: "OLD", fn: "whatsapp-automation-notify" }]);
  });

  it("o fallback por fetch usa o endpoint da própria fazenda", () => {
    const code = src("src/lib/whatsappNotify.ts");
    expect(code).toMatch(/const endpoint = backendEndpointForFarm\(farmId\);/);
    expect(code).toMatch(/if \(!endpoint\) return \{ ok: false, status: 0, raw: "backend da fazenda indisponível" \};/);
    // e não as variáveis fixas do projeto antigo
    expect(code).not.toMatch(/VITE_SUPABASE_URL/);
    expect(code).not.toMatch(/VITE_SUPABASE_PUBLISHABLE_KEY/);
  });

  it("backendEndpointForFarm separa os dois projetos", () => {
    const p = backendEndpointForFarm(PEROLA);
    const s = backendEndpointForFarm(SOSSEGO);
    expect(p === null || p.url !== s?.url).toBe(true);
  });
});

// ── 7, 8, 9, 10 — broadcast ─────────────────────────────────────────────────
describe("whatsapp-broadcast", () => {
  const B = src("src/components/integracoes/WhatsAppBroadcastCard.tsx");

  it("Pérola é bloqueada ANTES de qualquer invoke", () => {
    expect(B).toMatch(/if \(target === "farm" && isFarmMigrated\(farmId\)\) \{/);
    // o bloqueio vem antes do setBusy/invoke
    const bloqueio = B.indexOf("isFarmMigrated(farmId)");
    const invoke = B.indexOf('functions.invoke("whatsapp-broadcast"');
    expect(bloqueio).toBeGreaterThan(0);
    expect(bloqueio).toBeLessThan(invoke);
  });

  it("o bloqueio é explícito e diz o motivo — não é 404 silencioso", () => {
    expect(B).toMatch(/Broadcast indisponível/);
    expect(B).toMatch(/ainda não está publicado/);
  });

  it("não tenta o backend novo nem cai para o antigo", () => {
    expect(isFarmMigrated(PEROLA)).toBe(true);
    // segue existindo UM único invoke, no caminho das fazendas não migradas
    expect((B.match(/functions\.invoke\("whatsapp-broadcast"/g) ?? []).length).toBe(1);
  });

  it("alvo 'todas as fazendas' avisa que as migradas ficam fora", () => {
    expect(B).toMatch(/const migratedOutOfReach = target !== "farm" && MIGRATED_FARMS\.size > 0;/);
    expect(B).toMatch(/não são alcançadas/);
  });

  it("fazendas não migradas continuam enviando pelo antigo", () => {
    expect(B).toMatch(/supabase\.functions\.invoke\("whatsapp-broadcast"/);
    expect(isFarmMigrated(SOSSEGO)).toBe(false);
  });
});

// ── 11 — whatsapp-alerts ────────────────────────────────────────────────────
describe("whatsapp-alerts", () => {
  it("não é invocada pelo frontend — é acionada por cron no servidor", () => {
    const chamadas = walk("src").filter((f) => /functions\.invoke\(\s*["`]whatsapp-alerts/.test(src(f)));
    expect(chamadas).toEqual([]);
  });
});

// ── 12 — varredura ──────────────────────────────────────────────────────────
describe("varredura de src/", () => {
  it("nenhuma Edge Function farm-scoped é invocada pelo singleton antigo", () => {
    const leaks: string[] = [];
    for (const file of walk("src")) {
      const code = src(file);
      for (const fn of FARM_SCOPED_FNS) {
        const re = new RegExp(`\\bsupabase\\s*\\n?\\s*\\.functions\\.invoke\\(\\s*["\`]${fn}["\`]`);
        if (!re.test(code)) continue;
        // whatsapp-broadcast é o caminho das fazendas NÃO migradas, guardado por
        // bloqueio explícito no mesmo arquivo — não é vazamento.
        if (fn === "whatsapp-broadcast" && code.includes("isFarmMigrated(farmId)")) continue;
        leaks.push(`${file}: ${fn}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it("o helper de notificação não importa mais o singleton", () => {
    expect(src("src/lib/whatsappNotify.ts")).not.toMatch(/from "@\/integrations\/supabase\/client"/);
  });
});

// ── 13 ──────────────────────────────────────────────────────────────────────
describe("invariantes", () => {
  it("MIGRATED_FARMS continua contendo somente a Pérola", () => {
    expect([...MIGRATED_FARMS]).toEqual([PEROLA]);
  });
});
