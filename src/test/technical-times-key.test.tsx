// @vitest-environment jsdom
// Chave "Exibir tempos técnicos nos cards": DESLIGADA por padrão para todos,
// inclusive platform_admin. Ligada, vale só para admin/técnico.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import type { Pump } from "@/components/dashboard/PumpTable";

vi.mock("@/contexts/MaintenanceContext", () => ({ useOpenMaintenance: () => ({ getForEquipment: () => null }) }));
vi.mock("@/contexts/MasterManagerContext", () => ({ usePermission: () => true }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));

// ── Banco falso ────────────────────────────────────────────────────────────
const db = { admin: false, support: false, pref: false };
const rpcCalls: Array<{ fn: string; args: unknown }> = [];
/** guarda o callback do Realtime para simular mudança sem F5 */
let realtimeCb: ((p: { new?: { show_technical_times?: boolean } }) => void) | null = null;

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({
        data: (table === "platform_admins" && db.admin) || (table === "platform_support" && db.support)
          ? { user_id: "u1" } : null,
        error: null }) }) }),
    }),
    rpc: async (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      if (fn === "get_technical_display_pref") {
        // falha fechada no servidor: não-staff sempre recebe false
        return { data: (db.admin || db.support) ? db.pref : false, error: null };
      }
      if (fn === "set_technical_display_pref") {
        if (!db.admin && !db.support) return { data: null, error: { message: "sem permissão" } };
        db.pref = (args as { _show: boolean })._show;
        return { data: db.pref, error: null };
      }
      return { data: null, error: null };
    },
  },
}));

vi.mock("@/lib/realtimeKillSwitch", () => ({
  getRealtimeChannel: () => ({
    on: (_e: string, _f: unknown, cb: (p: { new?: { show_technical_times?: boolean } }) => void) => {
      realtimeCb = cb; return { subscribe: () => ({}) };
    },
  }),
  removeRealtimeChannel: async () => {},
}));

const { PumpCard } = await import("@/components/dashboard/PumpCard");
const { TechnicalTelemetryProvider } = await import("@/hooks/useTechnicalTelemetry");
const { TechnicalDisplaySettings } = await import("@/components/tecnico/TechnicalDisplaySettings");

const pump = (): Pump => ({
  id: "p1", name: "POÇO 12 R6", running: true, online: true,
  communicationStatus: "online",
  lastCommunication: new Date(Date.now() - 7 * 60_000).toISOString(),
  signalRF: 72, mode: "manual", sector: "", farmId: "f",
} as unknown as Pump);

async function drawCard() {
  document.body.innerHTML = "";
  const r = render(
    <TechnicalTelemetryProvider>
      <PumpCard
        pump={pump()} expanded refreshing={false} lastFailed={false}
        isGuarded={false} userOnline maintenanceActive={false}
        farms={[]} sectors={[]} guardFarmId={null} virtualize={false}
        onToggle={() => {}} onRefresh={() => {}} onOpenDialog={() => {}} onToggleExpand={() => {}}
      />
    </TechnicalTelemetryProvider>);
  await waitFor(() => expect(rpcCalls.some(c => c.fn === "get_technical_display_pref")).toBe(true));
  return r;
}

const badge = () => screen.queryByTestId("technical-comm-age");
function surface(): string {
  const attrs: string[] = [];
  document.body.querySelectorAll("*").forEach((el) => {
    for (const a of ["title", "aria-label"]) {
      const v = el.getAttribute(a); if (v) attrs.push(v);
    }
  });
  return `${document.body.textContent ?? ""}\n${attrs.join("\n")}`;
}

beforeEach(() => { db.admin = false; db.support = false; db.pref = false;
                   rpcCalls.length = 0; realtimeCb = null; });

describe("padrão: DESLIGADO para todos", () => {
  it("platform_admin sem a chave NÃO vê tempo", async () => {
    db.admin = true;
    await drawCard();
    await waitFor(() => expect(badge()).toBeNull());
    expect(surface()).not.toMatch(/\b\d+\s*min\b/i);
    expect(surface()).not.toMatch(/\bhá\s+\d+/i);
  });

  it("técnico sem a chave NÃO vê tempo", async () => {
    db.support = true;
    await drawCard();
    await waitFor(() => expect(badge()).toBeNull());
  });

  it("usuário comum sem a chave NÃO vê tempo", async () => {
    await drawCard();
    expect(badge()).toBeNull();
  });
});

describe("chave LIGADA", () => {
  it("platform_admin passa a ver o tempo", async () => {
    db.admin = true; db.pref = true;
    await drawCard();
    await waitFor(() => expect(badge()).not.toBeNull());
    expect(badge()!.textContent).toMatch(/\d+min/);
  });

  it("técnico passa a ver o tempo", async () => {
    db.support = true; db.pref = true;
    await drawCard();
    await waitFor(() => expect(badge()).not.toBeNull());
  });

  it("usuário NÃO técnico continua sem ver, mesmo com a chave ligada", async () => {
    db.pref = true;                    // linha ligada, mas sem papel técnico
    await drawCard();
    expect(badge()).toBeNull();
    expect(surface()).not.toMatch(/\b\d+\s*min\b/i);
  });
});

describe("atualização sem F5", () => {
  it("ligar pelo Realtime faz o tempo aparecer sem recarregar", async () => {
    db.admin = true;
    await drawCard();
    await waitFor(() => expect(badge()).toBeNull());
    await act(async () => { realtimeCb?.({ new: { show_technical_times: true } }); });
    await waitFor(() => expect(badge()).not.toBeNull());
  });

  it("desligar pelo Realtime faz o tempo sumir sem recarregar", async () => {
    db.admin = true; db.pref = true;
    await drawCard();
    await waitFor(() => expect(badge()).not.toBeNull());
    await act(async () => { realtimeCb?.({ new: { show_technical_times: false } }); });
    await waitFor(() => expect(badge()).toBeNull());
  });
});

describe("a tela da chave", () => {
  const drawSettings = async () => {
    document.body.innerHTML = "";
    render(<TechnicalTelemetryProvider><TechnicalDisplaySettings /></TechnicalTelemetryProvider>);
    await waitFor(() => expect(rpcCalls.some(c => c.fn === "get_technical_display_pref")).toBe(true));
  };

  it("não existe para usuário não técnico", async () => {
    await drawSettings();
    await waitFor(() => expect(screen.queryByTestId("technical-display-settings")).toBeNull());
  });

  it("aparece para admin, desligada, com o texto exigido", async () => {
    db.admin = true;
    await drawSettings();
    await waitFor(() => expect(screen.queryByTestId("technical-display-settings")).not.toBeNull());
    expect(document.body.textContent).toContain("Exibir tempos técnicos nos cards");
    expect(document.querySelector('[role="switch"]')?.getAttribute("data-state")).toBe("unchecked");
  });

  it("persiste ao ligar: grava no servidor e reflete na tela", async () => {
    db.admin = true;
    await drawSettings();
    await waitFor(() => expect(screen.queryByTestId("technical-display-settings")).not.toBeNull());
    await act(async () => { (document.querySelector('[role="switch"]') as HTMLElement).click(); });
    await waitFor(() =>
      expect(rpcCalls.some(c => c.fn === "set_technical_display_pref")).toBe(true));
    expect(db.pref).toBe(true);        // persistiu
    await waitFor(() =>
      expect(document.querySelector('[role="switch"]')?.getAttribute("data-state")).toBe("checked"));
  });

  it("o valor persistido é relido na montagem seguinte", async () => {
    db.admin = true; db.pref = true;
    await drawSettings();
    await waitFor(() =>
      expect(document.querySelector('[role="switch"]')?.getAttribute("data-state")).toBe("checked"));
  });
});

describe("nada operacional mudou", () => {
  it("o card mantém nome, estado e controle com a chave desligada", async () => {
    db.admin = true;
    await drawCard();
    expect(document.body.textContent).toContain("POÇO 12 R6");
    expect(document.querySelector('[role="switch"]')).not.toBeNull();
  });

  it("o card não indica em lugar nenhum que a chave existe", async () => {
    db.admin = true;
    await drawCard();
    expect(surface()).not.toMatch(/exibir tempos/i);
    expect(surface()).not.toMatch(/tempos t[ée]cnicos/i);
  });
});
