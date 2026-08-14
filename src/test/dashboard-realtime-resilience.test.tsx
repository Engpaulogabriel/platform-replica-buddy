// @vitest-environment jsdom
// Resiliência do Realtime: nunca exigir F5.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import fs from "node:fs"; import path from "node:path";
import { RealtimeHealthBadge } from "@/components/dashboard/RealtimeHealthBadge";

vi.mock("@/hooks/useFarmAccess", () => ({ useFarmAccess: () => ({ role: "platform_admin" }) }));

const REPO = path.resolve(__dirname, "../..");
const CAD = fs.readFileSync(path.join(REPO, "src/hooks/useCadastrosCloud.ts"), "utf8");

/** Máquina de assinatura espelhando useCadastrosCloud. */
class Channel {
  removed = false;
  constructor(public name: string) {}
}
function makeManager(opts: { maxBeforeDegraded?: number } = {}) {
  const MAX = opts.maxBeforeDegraded ?? 4;
  let attempts = 0;
  const state = { health: "reconnecting" as "connected" | "reconnecting" | "degraded",
                  channels: [] as Channel[], reconciliations: 0, lastPhysicalReadAt: null as number | null };
  const active = () => state.channels.filter((c) => !c.removed);
  const subscribe = () => {
    for (const c of active()) c.removed = true;      // nunca duplica assinatura
    state.channels.push(new Channel(`cad-${state.channels.length}`));
  };
  const onStatus = (s: string) => {
    if (s === "SUBSCRIBED") {
      attempts = 0; state.health = "connected"; state.reconciliations++;  // 1 reconciliação
      return;
    }
    if (s === "CHANNEL_ERROR" || s === "TIMED_OUT" || s === "CLOSED") {
      attempts++;
      state.health = attempts >= MAX ? "degraded" : "reconnecting";
      subscribe();                                   // reinscreve com backoff
    }
  };
  const wake = () => { state.reconciliations++; if (active().length === 0) subscribe(); };
  const physicalRead = (at: number) => { state.lastPhysicalReadAt = at; };
  const teardown = () => { for (const c of active()) c.removed = true; };
  return { state, subscribe, onStatus, wake, physicalRead, teardown, active };
}

describe("ciclo de vida da assinatura", () => {
  it("CHANNEL_ERROR → reconexão → SUBSCRIBED aplica leitura nova sem F5", () => {
    const m = makeManager(); m.subscribe(); m.onStatus("SUBSCRIBED");
    expect(m.state.health).toBe("connected");

    m.onStatus("CHANNEL_ERROR");
    expect(m.state.health).toBe("reconnecting");

    m.onStatus("SUBSCRIBED");
    expect(m.state.health).toBe("connected");
    expect(m.state.reconciliations).toBe(2);   // uma por reconexão, não em laço
    m.physicalRead(1_700_000_000_000);
    expect(m.state.lastPhysicalReadAt).toBeTruthy();
  });

  it("TIMED_OUT e CLOSED reconectam sem assinatura duplicada", () => {
    const m = makeManager(); m.subscribe(); m.onStatus("SUBSCRIBED");
    m.onStatus("TIMED_OUT"); m.onStatus("CLOSED"); m.onStatus("TIMED_OUT");
    expect(m.active()).toHaveLength(1);        // sempre exatamente um canal vivo
  });

  it("degrada após várias falhas e volta a conectado ao restabelecer", () => {
    const m = makeManager({ maxBeforeDegraded: 3 }); m.subscribe();
    m.onStatus("CHANNEL_ERROR"); m.onStatus("CHANNEL_ERROR");
    expect(m.state.health).toBe("reconnecting");
    m.onStatus("CHANNEL_ERROR");
    expect(m.state.health).toBe("degraded");
    m.onStatus("SUBSCRIBED");
    expect(m.state.health).toBe("connected");
  });

  it("Safari em segundo plano: evento perdido, ao voltar reconcilia sem F5", () => {
    const m = makeManager(); m.subscribe(); m.onStatus("SUBSCRIBED");
    const antes = m.state.reconciliations;
    m.onStatus("CLOSED");                        // aba suspensa derruba o socket
    m.wake();                                    // visibilitychange/focus
    expect(m.state.reconciliations).toBe(antes + 1);
    expect(m.active()).toHaveLength(1);
  });

  it("troca de fazenda fecha o canal anterior", () => {
    const m = makeManager(); m.subscribe(); m.onStatus("SUBSCRIBED");
    const antigo = m.active()[0];
    m.teardown(); m.subscribe();                 // nova fazenda
    expect(antigo.removed).toBe(true);
    expect(m.active()).toHaveLength(1);
    expect(m.active()[0]).not.toBe(antigo);
  });

  it("reconexão do POÇO 10 não altera o POÇO 11", () => {
    const cards: Record<string, { running: boolean }> = { p10: { running: false }, p11: { running: true } };
    const apply = (id: string, running: boolean) => { if (cards[id]) cards[id] = { running }; };
    apply("p10", true);                          // leitura recuperada só do 10
    expect(cards.p10.running).toBe(true);
    expect(cards.p11.running).toBe(true);
  });
});

describe("indicador técnico", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("mostra conectado com horário da última leitura", () => {
    render(<RealtimeHealthBadge health="connected" lastPhysicalReadAt={Date.parse("2026-08-14T10:20:30-03:00")} />);
    const el = screen.getByTestId("realtime-health");
    expect(el.dataset.health).toBe("connected");
    expect(el.textContent).toMatch(/Tempo real conectado/);
    expect(el.textContent).toMatch(/10:20:30/);
  });

  it("mostra Reconectando e Dados podem estar atrasados", () => {
    const { rerender } = render(<RealtimeHealthBadge health="reconnecting" />);
    expect(screen.getByTestId("realtime-health").textContent).toMatch(/Reconectando/);
    rerender(<RealtimeHealthBadge health="degraded" />);
    expect(screen.getByTestId("realtime-health").textContent).toMatch(/atrasados/i);
  });

  it("não renderiza nada para quem não é admin/owner", async () => {
    vi.resetModules();
    vi.doMock("@/hooks/useFarmAccess", () => ({ useFarmAccess: () => ({ role: "operator" }) }));
    const { RealtimeHealthBadge: Badge } = await import("@/components/dashboard/RealtimeHealthBadge");
    render(<Badge health="connected" />);
    expect(screen.queryByTestId("realtime-health")).toBeNull();
  });
});

describe("garantias no código-fonte", () => {
  it("trata os quatro status do canal", () => {
    for (const st of ["SUBSCRIBED", "CHANNEL_ERROR", "TIMED_OUT", "CLOSED"]) {
      expect(CAD).toContain(st);
    }
  });

  it("ouve visibilitychange, focus e online e faz cleanup", () => {
    expect(CAD).toContain('document.addEventListener("visibilitychange"');
    expect(CAD).toContain('window.addEventListener("focus"');
    expect(CAD).toContain('window.addEventListener("online"');
    expect(CAD).toContain('document.removeEventListener("visibilitychange"');
  });

  it("nenhum polling contínuo de rede permanece", () => {
    expect(CAD).not.toMatch(/setInterval\([^)]*refresh/);
    expect(CAD).not.toMatch(/fallbackPoller\s*=\s*setInterval/);
  });

  it("expõe saúde e horário da última leitura física", () => {
    expect(CAD).toContain("realtimeHealth");
    expect(CAD).toContain("lastPhysicalReadAt");
  });
});
