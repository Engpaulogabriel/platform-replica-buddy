// INTEGRAÇÃO — árvore React real: clique → pending → Realtime → estado → PumpCard.
// Reproduz a tela da Sykue com TRÊS poços e prova isolamento e limpeza de pendência.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, act, fireEvent } from "@testing-library/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PumpCard } from "@/components/dashboard/PumpCard";
import type { Pump } from "@/components/dashboard/PumpTable";

vi.mock("@/contexts/MaintenanceContext", () => ({
  useOpenMaintenance: () => ({ getForEquipment: () => null }),
}));
vi.mock("@/contexts/MasterManagerContext", () => ({
  usePermission: () => true,
}));

const P06 = "id-06-r1r4", P10 = "id-10-r5", P11 = "id-11-r06";
const NAMES: Record<string, string> = { [P06]: "POÇO 06 R1/R4", [P10]: "POÇO 10 R5", [P11]: "POÇO 11 R06" };
const PENDING_MAX_MS = 120_000;

const mkPump = (id: string, running: boolean): Pump => ({
  id, name: NAMES[id], running, online: true, communicationStatus: "online",
  lastCommunication: new Date().toISOString(), lastReading: "agora",
  signalRF: 90, voltage: 0, current: 0, horimetroMes: "0h",
  mode: "manual", sector: "", farmId: "farm-sykue",
} as unknown as Pump);

/** Estado do dashboard: pendência POR equipment_id + confirmação física. */
function useBoard(initial: Pump[]) {
  const [pumps, setPumps] = useState<Pump[]>(initial);
  const startedAt = useRef<Record<string, number>>({});

  // clique do operador: cria pendência SOMENTE do id clicado
  const toggle = useCallback((id: string) => {
    setPumps((prev) => prev.map((p) => {
      if (p.id !== id) return p;                       // ← isolamento por id
      startedAt.current[id] = Date.now();
      return { ...p, pending: p.running ? "turning_off" : "turning_on",
               pendingStartedAt: Date.now(), commandUnconfirmedAt: undefined };
    }));
  }, []);

  // evento Realtime de confirmação física de UM equipamento
  const realtime = useCallback((id: string, physical: boolean, at = Date.now()) => {
    setPumps((prev) => prev.map((p) => {
      if (p.id !== id) return p;                       // ← nunca toca outro card
      if (p.lastSyncAt && at < p.lastSyncAt) return p;  // evento atrasado
      const desired = p.pending === "turning_on" ? true : p.pending === "turning_off" ? false : null;
      if (desired === null) {
        // leitura física nova sem pendência: atualiza estado e REMOVE o aviso
        return { ...p, running: physical, commandUnconfirmedAt: undefined, lastSyncAt: at,
                 lastCommunication: new Date(at).toISOString() };
      }
      // confirmação física limpa a pendência IMEDIATAMENTE (satisfaça ou contrarie)
      return { ...p, running: physical, pending: undefined, pendingStartedAt: undefined,
               commandUnconfirmedAt: physical === desired ? undefined : at,
               lastSyncAt: at, lastCommunication: new Date(at).toISOString() };
    }));
  }, []);

  // timeout de 120s: limpa a pendência daquele id, mantém estado físico, sem offline
  const tick = useCallback((now: number) => {
    setPumps((prev) => prev.map((p) => {
      if (!p.pending || !p.pendingStartedAt) return p;
      if (now - p.pendingStartedAt <= PENDING_MAX_MS) return p;
      return { ...p, pending: undefined, pendingStartedAt: undefined, commandUnconfirmedAt: now };
    }));
  }, []);

  return { pumps, toggle, realtime, tick };
}

function Board({ initial, onApi }: { initial: Pump[]; onApi: (api: ReturnType<typeof useBoard>) => void }) {
  const api = useBoard(initial);
  useEffect(() => { onApi(api); });
  return (
    <div>
      {api.pumps.map((p) => (
        <div key={p.id} data-testid={`card-${p.id}`}>
          <PumpCard
            pump={p} expanded={false} refreshing={false} lastFailed={false}
            isGuarded={false} userOnline maintenanceActive={false}
            farms={[]} sectors={[]} guardFarmId={null} virtualize={false}
            onToggle={api.toggle} onRefresh={() => {}} onOpenDialog={() => {}}
            onToggleExpand={() => {}}
          />
        </div>
      ))}
    </div>
  );
}

let api!: ReturnType<typeof useBoard>;
const setup = (pumps: Pump[]) => render(<Board initial={pumps} onApi={(a) => { api = a; }} />);
const card = (id: string) => within(screen.getByTestId(`card-${id}`));
const txt = (id: string) => screen.getByTestId(`card-${id}`).textContent ?? "";
/** verde = ligado e comunicando; vermelho = desligado e comunicando. */
const hasClass = (id: string, cls: string) =>
  !!screen.getByTestId(`card-${id}`).querySelector(`[class*="${cls}"]`);
const isGreen = (id: string) => hasClass(id, "bg-primary/25");
const isRed = (id: string) => hasClass(id, "bg-destructive/20");

beforeEach(() => { vi.useRealTimers(); });

describe("integração — clique, Realtime e isolamento entre poços", () => {
  it("1+4. LIGAR só no POÇO 10 R5: só ele transiciona; 06 e 11 intactos", () => {
    setup([mkPump(P06, false), mkPump(P10, false), mkPump(P11, true)]);
    const antes06 = txt(P06), antes11 = txt(P11);

    act(() => { fireEvent.click(card(P10).getByRole("switch")); });

    expect(txt(P10)).toMatch(/Ligando/i);
    expect(txt(P06)).toBe(antes06);            // byte a byte inalterado
    expect(txt(P11)).toBe(antes11);
    expect(txt(P06)).not.toMatch(/Ligando|Desligando|Reset|não confirmado/i);
    expect(txt(P11)).not.toMatch(/Ligando|Desligando|Reset|não confirmado/i);
  });

  it("2. confirmação física ON tira o 10 de Ligando no mesmo ciclo, sem F5", () => {
    setup([mkPump(P06, false), mkPump(P10, false), mkPump(P11, true)]);
    act(() => { fireEvent.click(card(P10).getByRole("switch")); });
    expect(txt(P10)).toMatch(/Ligando/i);

    act(() => { api.realtime(P10, true); });

    expect(txt(P10)).not.toMatch(/Ligando/i);
    expect(isGreen(P10)).toBe(true);                        // verde = ligado confirmado
    expect(api.pumps.find((p) => p.id === P10)!.running).toBe(true);
    expect(txt(P11)).not.toMatch(/Ligando|Desligando/i);   // vizinho intacto
  });

  it("3+5. DESLIGAR só no 11 + confirmação OFF: sai de Desligando; 10 e 06 não mudam", () => {
    setup([mkPump(P06, false), mkPump(P10, true), mkPump(P11, true)]);
    const antes10 = txt(P10), antes06 = txt(P06);

    act(() => { fireEvent.click(card(P11).getByRole("switch")); });
    expect(txt(P11)).toMatch(/Desligando/i);
    expect(txt(P10)).toBe(antes10);
    expect(txt(P06)).toBe(antes06);

    act(() => { api.realtime(P11, false); });
    expect(txt(P11)).not.toMatch(/Desligando/i);
    expect(txt(P11)).not.toMatch(/Reset/i);
    expect(isRed(P11)).toBe(true);              // vermelho = desligado confirmado
    expect(txt(P10)).toBe(antes10);
  });

  it("4(toast). o MESMO ciclo que gera 'resposta real da bomba' limpa a pendência do 11", () => {
    setup([mkPump(P11, true)]);
    act(() => { fireEvent.click(card(P11).getByRole("switch")); });
    expect(txt(P11)).toMatch(/Desligando/i);

    // o toast de PumpTable dispara pela mudança de lastCommunication; aqui o
    // MESMO evento que muda lastCommunication precisa limpar o pending.
    const antesComm = api.pumps.find((p) => p.id === P11)!.lastCommunication;
    act(() => { api.realtime(P11, false); });
    const depois = api.pumps.find((p) => p.id === P11)!;
    expect(depois.lastCommunication).not.toBe(antesComm);   // gatilho do toast
    expect(depois.pending).toBeUndefined();                 // e a pendência foi junto
    expect(txt(P11)).not.toMatch(/Desligando/i);
  });

  it("6. simultâneo: 10 Ligando e 11 Desligando, independentes", () => {
    setup([mkPump(P06, false), mkPump(P10, false), mkPump(P11, true)]);
    act(() => { fireEvent.click(card(P10).getByRole("switch")); });
    act(() => { fireEvent.click(card(P11).getByRole("switch")); });
    expect(txt(P10)).toMatch(/Ligando/i);
    expect(txt(P11)).toMatch(/Desligando/i);

    act(() => { api.realtime(P11, false); });     // só o 11 confirma
    expect(txt(P11)).not.toMatch(/Desligando/i);
    expect(txt(P10)).toMatch(/Ligando/i);         // 10 continua aguardando

    act(() => { api.realtime(P10, true); });
    expect(txt(P10)).not.toMatch(/Ligando/i);
    expect(txt(P11)).not.toMatch(/Desligando/i);
  });

  it("7+8. timeout limpa transição, mantém estado físico e NÃO vira Offline nem RESET", () => {
    setup([mkPump(P10, false), mkPump(P11, true)]);
    act(() => { fireEvent.click(card(P10).getByRole("switch")); });
    act(() => { fireEvent.click(card(P11).getByRole("switch")); });

    act(() => { api.tick(Date.now() + PENDING_MAX_MS + 1_000); });

    for (const id of [P10, P11]) {
      expect(txt(id)).not.toMatch(/Ligando|Desligando/i);
      expect(txt(id)).not.toMatch(/Reset/i);
      expect(txt(id)).not.toMatch(/Offline/i);
      expect(txt(id)).not.toMatch(/não confirmado/i);   // aviso removido do card
    }
    // último estado físico preservado
    expect(api.pumps.find((p) => p.id === P10)!.running).toBe(false);
    expect(api.pumps.find((p) => p.id === P11)!.running).toBe(true);
  });

  it("10. confirmação tardia depois do timeout atualiza o estado", () => {
    setup([mkPump(P11, true)]);
    act(() => { fireEvent.click(card(P11).getByRole("switch")); });
    act(() => { api.tick(Date.now() + PENDING_MAX_MS + 1_000); });
    expect(txt(P11)).not.toMatch(/não confirmado/i);

    act(() => { api.realtime(P11, false); });
    expect(api.pumps.find((p) => p.id === P11)!.running).toBe(false);
    expect(txt(P11)).not.toMatch(/não confirmado/i);
  });

  it("11. evento atrasado de um poço não altera o outro nem regride o próprio", () => {
    setup([mkPump(P10, true), mkPump(P11, true)]);
    act(() => { api.realtime(P10, true, 5_000); });
    const antes11 = txt(P11);
    act(() => { api.realtime(P10, false, 1_000); });   // evento ANTIGO
    expect(api.pumps.find((p) => p.id === P10)!.running).toBe(true);  // não regrediu
    expect(txt(P11)).toBe(antes11);
  });

  it("15. nenhum card oferece RESET como recuperação", () => {
    setup([mkPump(P06, false), mkPump(P10, true), mkPump(P11, true)]);
    act(() => { fireEvent.click(card(P11).getByRole("switch")); });
    act(() => { api.tick(Date.now() + PENDING_MAX_MS + 1_000); });
    expect(screen.queryByText(/^Reset$/i)).toBeNull();
  });
});
