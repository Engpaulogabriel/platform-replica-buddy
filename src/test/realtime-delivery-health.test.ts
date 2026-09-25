// @vitest-environment node
// SUBSCRIBED não é prova de entrega — testes da máquina de saúde do Realtime.
//
//   npx vitest run src/test/realtime-delivery-health.test.ts
//
// O defeito real: com a publicação `supabase_realtime` VAZIA no NEW (medido em
// 25/09/2026), o canal conecta e nunca entrega. O hook desligava a rede de
// segurança no SUBSCRIBED e a tela ficava sem Realtime E sem fallback.
import { describe, it, expect } from "vitest";
import {
  initialDeliveryState,
  onChannelStatus,
  onChannelEvent,
  onRealtimeUnavailable,
  uiHealth,
  type DeliveryState,
} from "@/lib/realtimeDeliveryHealth";

const MAX = 4; // MAX_RECONNECT_BEFORE_DEGRADED do hook

describe("rede de segurança só desliga com prova de entrega", () => {
  it("SUBSCRIBED sozinho NÃO desliga a rede — era o defeito", () => {
    const s = onChannelStatus(initialDeliveryState(), "SUBSCRIBED", MAX);
    expect(s.subscribed).toBe(true);
    expect(s.deliveryProven).toBe(false);
    expect(s.safetyNet).toBe(true);        // ← o ponto
    expect(s.health).toBe("probation");
  });

  it("o primeiro EVENTO desliga a rede", () => {
    let s = onChannelStatus(initialDeliveryState(), "SUBSCRIBED", MAX);
    s = onChannelEvent(s);
    expect(s.deliveryProven).toBe(true);
    expect(s.safetyNet).toBe(false);
    expect(s.health).toBe("connected");
  });

  it("canal mudo: conectado por tempo indeterminado, rede SEMPRE ligada", () => {
    // Exatamente o cenário da publicação vazia. Nenhum evento chega nunca.
    let s = onChannelStatus(initialDeliveryState(), "SUBSCRIBED", MAX);
    for (let i = 0; i < 50; i++) {
      s = onChannelStatus(s, "SUBSCRIBED", MAX); // reinscrições/resubscribes
      expect(s.safetyNet).toBe(true);
      expect(s.deliveryProven).toBe(false);
    }
  });

  it("evento é idempotente — não reabre a rede nem reseta nada", () => {
    let s = onChannelEvent(onChannelStatus(initialDeliveryState(), "SUBSCRIBED", MAX));
    const antes: DeliveryState = { ...s };
    s = onChannelEvent(s);
    s = onChannelEvent(s);
    expect(s).toEqual(antes);
  });
});

describe("queda de canal", () => {
  it("erro liga a rede e conta tentativa; no teto vira degradado", () => {
    let s = onChannelEvent(onChannelStatus(initialDeliveryState(), "SUBSCRIBED", MAX));
    expect(s.safetyNet).toBe(false);

    for (const [i, status] of ["CHANNEL_ERROR", "TIMED_OUT", "CLOSED", "CHANNEL_ERROR"].entries()) {
      s = onChannelStatus(s, status, MAX);
      expect(s.safetyNet).toBe(true);
      expect(s.reconnectAttempts).toBe(i + 1);
      expect(s.health).toBe(i + 1 >= MAX ? "degraded" : "reconnecting");
    }
  });

  it("a prova de entrega NÃO sobrevive a uma queda", () => {
    // Canal novo, bindings podem ter mudado: a prova antiga não vale.
    let s = onChannelEvent(onChannelStatus(initialDeliveryState(), "SUBSCRIBED", MAX));
    s = onChannelStatus(s, "CLOSED", MAX);
    expect(s.deliveryProven).toBe(false);
    s = onChannelStatus(s, "SUBSCRIBED", MAX);
    expect(s.deliveryProven).toBe(false);
    expect(s.safetyNet).toBe(true);
  });

  it("reconexão bem-sucedida zera o contador de tentativas", () => {
    let s = initialDeliveryState();
    s = onChannelStatus(s, "CHANNEL_ERROR", MAX);
    s = onChannelStatus(s, "CHANNEL_ERROR", MAX);
    expect(s.reconnectAttempts).toBe(2);
    s = onChannelStatus(s, "SUBSCRIBED", MAX);
    expect(s.reconnectAttempts).toBe(0);
  });

  it("status desconhecido não afirma entrega e mantém a rede", () => {
    let s = onChannelStatus(initialDeliveryState(), "JOINING", MAX);
    expect(s.safetyNet).toBe(true);
    // Mas depois de provada a entrega, um status estranho não reabre a rede.
    s = onChannelEvent(onChannelStatus(initialDeliveryState(), "SUBSCRIBED", MAX));
    s = onChannelStatus(s, "JOINING", MAX);
    expect(s.safetyNet).toBe(false);
  });
});

describe("fazenda sem Realtime utilizável", () => {
  it("declara degradado SEM ligar a rede — quem atualiza é o poller dedicado", () => {
    const s = onRealtimeUnavailable();
    expect(s.health).toBe("degraded");
    expect(s.safetyNet).toBe(false);   // não duplica requisição no mesmo backend
    expect(s.deliveryProven).toBe(false);
  });
});

describe("rótulo da UI", () => {
  it("PROBATION aparece como 'reconnecting', nunca como 'connected'", () => {
    // Dizer "connected" sem prova de fluxo era o que escondia o defeito.
    expect(uiHealth(onChannelStatus(initialDeliveryState(), "SUBSCRIBED", MAX))).toBe("reconnecting");
  });

  it("os três valores da UI são cobertos e nada escapa do tipo", () => {
    const provado = onChannelEvent(onChannelStatus(initialDeliveryState(), "SUBSCRIBED", MAX));
    expect(uiHealth(provado)).toBe("connected");
    expect(uiHealth(onRealtimeUnavailable())).toBe("degraded");
    let s = initialDeliveryState();
    for (let i = 0; i < MAX; i++) s = onChannelStatus(s, "CHANNEL_ERROR", MAX);
    expect(uiHealth(s)).toBe("degraded");
    expect(uiHealth(initialDeliveryState())).toBe("reconnecting");
  });
});

describe("invariante de carga", () => {
  it("com Realtime saudável a rede fica desligada — sem polling extra", () => {
    let s = onChannelEvent(onChannelStatus(initialDeliveryState(), "SUBSCRIBED", MAX));
    // Vários eventos seguidos (operação normal): a rede continua desligada.
    for (let i = 0; i < 100; i++) s = onChannelEvent(s);
    expect(s.safetyNet).toBe(false);
  });

  it("INVARIANTE: rede desligada ⟹ entrega provada OU fazenda sem Realtime", () => {
    // A regra que impede o defeito de voltar por qualquer caminho: ninguém
    // desliga a rede de segurança sem prova, exceto a fazenda que tem poller
    // próprio. Varredura de todas as sequências curtas de transição.
    const estados: DeliveryState[] = [initialDeliveryState(), onRealtimeUnavailable()];
    const STATUSES = ["SUBSCRIBED", "CHANNEL_ERROR", "TIMED_OUT", "CLOSED", "JOINING"];
    for (const a of STATUSES) {
      for (const b of STATUSES) {
        for (const comEvento of [false, true]) {
          let s = onChannelStatus(initialDeliveryState(), a, MAX);
          estados.push(s);
          if (comEvento) { s = onChannelEvent(s); estados.push(s); }
          s = onChannelStatus(s, b, MAX);
          estados.push(s);
        }
      }
    }
    expect(estados.length).toBeGreaterThan(80);
    for (const e of estados) {
      if (!e.safetyNet) {
        expect(e.deliveryProven || !e.realtimeUsable).toBe(true);
      }
    }
  });

  it("estado inicial: sem prova ⇒ rede LIGADA", () => {
    // Era o furo que este próprio teste encontrou: ao montar, a rede vinha
    // desligada sem nenhuma prova de entrega.
    const s = initialDeliveryState();
    expect(s.deliveryProven).toBe(false);
    expect(s.safetyNet).toBe(true);
  });
});
