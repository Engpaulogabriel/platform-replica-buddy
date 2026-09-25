// ─────────────────────────────────────────────────────────────────────────────
// useCadastrosCloud — fonte única para PLCs / Setores / Equipamentos na nuvem
// ─────────────────────────────────────────────────────────────────────────────
// - Carrega dados do farm padrão do usuário
// - Realtime: re-fetch leve em qualquer mudança nas 3 tabelas
// - CRUDs com fila offline (apenas owner/admin podem mutar)
// - Validações: hw_id único por farm, saída disponível por PLC
//
// IDs SÃO UUIDs nativos. Não há mais conversão para number.

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
// DUAL-BACKEND: dados da fazenda seguem o backend do farmId. Resolução de
// fazenda e permissões (profiles/user_roles) continuam no ANTIGO, onde vive a sessão.
import { getSupabaseForFarm } from "@/lib/supabaseRouter";
import { isFarmMigrated } from "@/lib/migrationRegistry";
// BYPASS EXPLÍCITO do kill switch global: o dashboard de bombas PRECISA de
// Realtime real em `public.equipments` — é onde apply_pump_telemetry grava
// last_outputs_state a cada RX físico. Os demais módulos seguem bloqueados.
import { getRealtimeChannel, removeRealtimeChannel, isRealtimeAvailableForFarm } from "@/lib/realtimeKillSwitch";
import {
  initialDeliveryState, onChannelStatus, onChannelEvent, onRealtimeUnavailable, uiHealth,
  type DeliveryState,
} from "@/lib/realtimeDeliveryHealth";
import { useAuth } from "@/contexts/AuthContext";
import { notifyRegistry } from "@/lib/notify";
import { enqueue, isOnline } from "@/lib/offlineQueue";
import { buildEquipHwId } from "@/lib/cadastrosCloud";

// ───────── Tipos públicos ─────────
export interface CloudPlc {
  id: string;
  farm_id: string;
  name: string;
  hw_id: string;     // 4 chars hex (ex: "1A2B")
  /** Total de saídas físicas da PLC (1 ou 6). Default 1. Define o tamanho do payload TX. */
  output_count: number;
}

export type EquipTipo = "poco" | "bombeamento" | "nivel" | "repetidor" | "vazao";
export type FonteTipo = "rio" | "riacho" | "canal" | "piscina" | "poco" | "reservatorio";

export interface CloudEquipamento {
  id: string;
  farm_id: string;
  name: string;
  type: EquipTipo;
  hw_id: string;             // <plcHex><saida 2 dígitos>
  saida: number;             // 1-6
  plc_group_id: string | null;
  sector_id: string | null;
  latitude: number | null;
  longitude: number | null;
  horas_pico: string | null;
  max_horas_dia: number | null;
  demanda_kw: number | null;
  power_kw: number | null;
  estimated_flow_m3h: number | null;
  vazao_mode?: "off" | "estimated" | "real" | null;
  vazao_cadastrada_m3h?: number | null;
  vazao_m3_por_pulso?: number | null;
  flow_total_m3?: number | null;
  flow_rate_m3h?: number | null;
  max_height: number | null;
  alarm_low: number | null;
  alarm_high: number | null;
  fonte_tipo: FonteTipo | null;
  fonte_id: string | null;
  alimenta_id: string | null;
  active: boolean;
  /** Se true (default), entra no cálculo de eficiência do ciclo noturno. */
  participates_night_cycle?: boolean;
  /** Se true, desligar pela plataforma uma bomba ligada localmente executa a sequência {1}→espera RX→10s→{0} (uma vez) em vez de {0} direto. Default false. */
  forced_shutdown_enabled?: boolean;
  last_communication: string | null;
  last_outputs_state: string | null;
  last_signal_bars: number | null;
  /** Origem da última mudança de estado: 'remote' (plataforma) ou 'local' (chave física). */
  last_actuation_origin: string | null;
  /** Timestamp em que o operador deu dismiss no badge LOCAL (double-click). Badge só reaparece se houver novo acionamento local após esse horário. */
  local_ack_at?: string | null;
  /** Bomba bloqueada para novos comandos até este timestamp (após detecção de acionamento local). */
  command_blocked_until: string | null;
  /** Comando manual em andamento (UUID). null = idle. */
  pending_command_id: string | null;
  /** Estado desejado pela última intenção (true=ligar, false=desligar). Sincronizado pelo worker. */
  desired_running?: boolean | null;
  /** Modo Automático: início da tentativa de partida ainda não confirmada. */
  automatic_on_attempt_since?: string | null;
  polling_interval_seconds?: number;
  /** Intervalo esperado de telemetria (min). Padrão 10. Boosters = 25. Usado para calcular a janela offline (telemetry_interval + 5 min). */
  telemetry_interval?: number | null;

  /** Override por equipamento do rádio do Servidor (R1/R2/R3). null = usa global da fazenda. */
  rf_radio?: "R1" | "R2" | "R3" | null;
  /** Override por equipamento de via repetidor. null = usa global da fazenda. */
  rf_via_rep?: boolean | null;
  // ── Calibração de nível (tipo "nivel") — modelo 1 ponto ──
  level_last_raw?: number | null;
  level_last_raw_at?: string | null;
  /** Valor digital de referência da calibração (ex: 1008). */
  level_cal_digital?: number | null;
  /** Metros correspondentes ao valor digital de referência (ex: 1.61). */
  level_cal_meters?: number | null;
  /** Nível máximo do reservatório em metros (representa 100%). */
  level_max_meters?: number | null;
  level_sensor_index?: number | null;
  // ── Vazão/Consumo (tipo "vazao") — totalizador em m³ vindo do PLC via N2 ──
  flow_accum_m3?: number | null;
  flow_accum_at?: string | null;
  flow_daily_start_m3?: number | null;
  flow_daily_start_at?: string | null;
}

export interface CloudSector {
  id: string;
  farm_id: string;
  name: string;
}

interface State {
  loading: boolean;
  error: string | null;
  farmId: string | null;
  isAdmin: boolean;
  plcs: CloudPlc[];
  equipments: CloudEquipamento[];
  sectors: CloudSector[];
  lastSyncAt: number | null;
  realtimeConnected: boolean;
  /** Saúde da assinatura para o indicador técnico (não afeta bomba alguma):
   *  connected = recebendo; reconnecting = caiu e está tentando;
   *  degraded = não foi possível restabelecer após várias tentativas. */
  realtimeHealth: "connected" | "reconnecting" | "degraded";
  /** Horário da última leitura FÍSICA aplicada (mudança em equipments). */
  lastPhysicalReadAt: number | null;
}

const MAX_SAIDAS = 6;

// Intervalo do polling da fazenda migrada. Mantido em 15 s — o mesmo valor já
// destinado a essas fazendas; o que muda é ele passar a ser realmente periódico
// e preso ao ciclo de vida da fazenda ativa.
const MIGRATED_POLL_MS = 15_000;

// Lista explícita de colunas do equipments — evita .select("*") que traz
// campos não usados pelo cliente (firmware_version, created_at, updated_at,
// last_polling_at, safety_expired_at, runtime_checkpoint_at, power_cv,
// communication_status). Reduz payload do polling/refresh em ~17% e fixa
// o contrato do tipo CloudEquipamento.
const EQUIP_COLS =
  "id,farm_id,name,type,hw_id,saida,plc_group_id,sector_id,latitude,longitude," +
  "horas_pico,max_horas_dia,demanda_kw,power_kw,estimated_flow_m3h,max_height," +
  "vazao_mode,vazao_cadastrada_m3h,vazao_m3_por_pulso,flow_total_m3,flow_rate_m3h," +
  "alarm_low,alarm_high,fonte_tipo,fonte_id,alimenta_id,active," +
  "last_communication,last_outputs_state,last_signal_bars,last_actuation_origin," +
  "local_ack_at,command_blocked_until,pending_command_id,desired_running," +
  "automatic_on_attempt_since," +
  "polling_interval_seconds,rf_radio,rf_via_rep,forced_shutdown_enabled," +
  "level_last_raw,level_last_raw_at,level_cal_digital,level_cal_meters," +
  "level_max_meters,level_sensor_index," +
  "flow_accum_m3,flow_accum_at,flow_daily_start_m3,flow_daily_start_at";

// ───────── Helpers ─────────
const upper4 = (s: string) => s.trim().toUpperCase().padStart(4, "0").slice(-4);


export function useCadastrosCloud() {
  const { user } = useAuth();
  const [state, setState] = useState<State>({
    loading: true,
    error: null,
    farmId: null,
    isAdmin: false,
    plcs: [],
    equipments: [],
    sectors: [],
    lastSyncAt: null,
    realtimeConnected: false,
    realtimeHealth: "reconnecting",
    lastPhysicalReadAt: null,
  });

  const farmIdRef = useRef<string | null>(null);
  const reloadDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadAll = useCallback(async (farmId: string) => {
    // Cliente resolvido UMA VEZ a partir do farmId desta carga.
    const client = getSupabaseForFarm(farmId);
    const [plcsRes, equipsRes, sectorsRes] = await Promise.all([
      client.from("plc_groups").select("id,farm_id,name,hw_id,output_count").eq("farm_id", farmId).order("name"),
      client.from("equipments").select(EQUIP_COLS).eq("farm_id", farmId).order("name"),
      client.from("sectors").select("id,farm_id,name").eq("farm_id", farmId).order("name"),

    ]);
    if (plcsRes.error) throw new Error(`plcs: ${plcsRes.error.message}`);
    if (equipsRes.error) throw new Error(`equips: ${equipsRes.error.message}`);
    if (sectorsRes.error) throw new Error(`sectors: ${sectorsRes.error.message}`);

    const plcs = (plcsRes.data ?? []) as unknown as CloudPlc[];
    const equipments = (equipsRes.data ?? []) as unknown as CloudEquipamento[];
    const sectors = (sectorsRes.data ?? []) as unknown as CloudSector[];


    return { plcs, equipments, sectors };
  }, []);

  const refresh = useCallback(async () => {
    const farmId = farmIdRef.current;
    if (!farmId) return;
    try {
      const data = await loadAll(farmId);
      setState((s) => ({ ...s, ...data, loading: false, error: null, lastSyncAt: Date.now() }));
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }));
    }
  }, [loadAll]);

  const scheduleReload = useCallback(() => {
    if (reloadDebounceRef.current) clearTimeout(reloadDebounceRef.current);
    reloadDebounceRef.current = setTimeout(() => { void refresh(); }, 250);
  }, [refresh]);

  // NOTA: os listeners de visibilitychange/focus/online que existiam AQUI foram
  // consolidados no efeito de boot abaixo (visibilityHandler). Aquele conjunto só
  // chamava refresh(); o consolidado também RE-INSCREVE o canal quando ele não
  // está `joined` — que é o caso do Safari com a aba suspensa, em que o socket
  // morre sem emitir CLOSED. Manter os dois causava refresh duplicado a cada
  // retorno de aba.

  // Boot: pega farm + role + dados + assina realtime (com reconexão automática + poller fallback)
  useEffect(() => {
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let broadcastChannel: ReturnType<typeof supabase.channel> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let visibilityHandler: (() => void) | null = null;
    let reconnectAttempts = 0;

    const handleEquipmentChange = (payload: any) => {
      noteRealtimeEvent();
      const evt = payload?.eventType;
      if (evt === "UPDATE" && payload?.new?.id) {
        const next = payload.new as CloudEquipamento;
        // [DIAG-REALTIME] mede latência do evento Realtime de equipments
        try {
          const commitTs = (payload as { commit_timestamp?: string }).commit_timestamp;
          const commitMs = commitTs ? new Date(commitTs).getTime() : null;
          const nowMs = Date.now();
          // eslint-disable-next-line no-console
          console.log("[REALTIME] equipment update", {
            at: nowMs,
            id: next.id,
            last_outputs_state: (next as { last_outputs_state?: string }).last_outputs_state,
            commit_timestamp: commitTs,
            latency_ms: commitMs ? nowMs - commitMs : null,
          });
        } catch { /* ignore */ }
        setState((s) => {
          const idx = s.equipments.findIndex((e) => e.id === next.id);
          if (idx === -1) { scheduleReload(); return s; }
          const merged = { ...s.equipments[idx], ...next };
          const arr = s.equipments.slice();
          arr[idx] = merged;
          return { ...s, equipments: arr, lastSyncAt: Date.now(), lastPhysicalReadAt: Date.now() };
        });
      } else {
        scheduleReload();
      }
    };

    // Após esta quantidade de tentativas sem sucesso, o indicador passa a
    // "Dados podem estar atrasados" e entra a rede de segurança abaixo.
    const MAX_RECONNECT_BEFORE_DEGRADED = 4;
    // Teto de tentativas. Sem ele, um canal que responde CLOSED imediatamente
    // (foi o caso do kill switch global) gera reinscrição em laço para sempre.
    const MAX_RECONNECT_ATTEMPTS = 8;

    // REDE DE SEGURANÇA — só existe enquanto o canal está DEGRADADO.
    // Não é polling do caminho normal: com Realtime saudável ela nunca liga.
    // Sem isto, canal morto = ZERO atualização até F5 — exatamente o que
    // aconteceu quando o kill switch estava ativo e o poller foi removido.
    let degradedTimer: ReturnType<typeof setInterval> | null = null;
    const stopDegradedSafetyNet = () => {
      if (degradedTimer) { clearInterval(degradedTimer); degradedTimer = null; }
    };
    const startDegradedSafetyNet = () => {
      if (degradedTimer || cancelled) return;
      degradedTimer = setInterval(() => {
        if (cancelled) return;
        if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
        void refresh();
      }, 30_000);
    };

    // ── v3.26.3: SUBSCRIBED NÃO É PROVA DE ENTREGA ─────────────────────────
    // Antes, `if (ok) stopDegradedSafetyNet()` desligava a rede no primeiro
    // SUBSCRIBED. Com a publicação `supabase_realtime` vazia no NEW (medido em
    // 25/09/2026) o canal conecta e nunca entrega — a tela ficava sem Realtime
    // E sem rede, atualizando só ao voltar o foco da aba.
    // Agora quem decide é lib/realtimeDeliveryHealth (puro, testado): a rede só
    // desliga depois de UM EVENTO REAL.
    let delivery: DeliveryState = initialDeliveryState();
    const applyDelivery = (next: DeliveryState) => {
      delivery = next;
      if (next.safetyNet) startDegradedSafetyNet(); else stopDegradedSafetyNet();
      const health = uiHealth(next);
      setState((s) => (s.realtimeConnected === next.deliveryProven && s.realtimeHealth === health
        ? s
        : { ...s, realtimeConnected: next.deliveryProven, realtimeHealth: health }));
    };
    /** Todo handler de evento passa por aqui — é a prova de que o canal entrega. */
    const noteRealtimeEvent = () => { applyDelivery(onChannelEvent(delivery)); };
    /** Cadastro (plc_groups/sectors): evento real + refetch. */
    const onCadastroChange = () => { noteRealtimeEvent(); scheduleReload(); };
    applyDelivery(delivery);

    const subscribePostgresChanges = (farmId: string) => {
      if (cancelled) return;
      if (channel) { try { void removeRealtimeChannel(channel); } catch { /* ignore */ } channel = null; }
      // Fazenda migrada: não existe Realtime utilizável (o projeto novo não
      // publica tabelas e o canal do projeto antigo não representa esta
      // fazenda). Declarar "degradado" é a verdade — e evita que a tela
      // acredite estar recebendo eventos. Quem atualiza aqui é o polling
      // dedicado abaixo; por isso NÃO ligamos também a rede de segurança,
      // que duplicaria requisições no mesmo backend.
      if (!isRealtimeAvailableForFarm(farmId)) {
        applyDelivery(onRealtimeUnavailable());
        return;
      }
      const ch = getRealtimeChannel(`cadastros-${farmId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, undefined, farmId)
        // Cada tabela é um binding próprio. Só `equipments` está publicada em
        // supabase_realtime (migration 20260925030000) — plc_groups e sectors
        // continuam aqui porque são cadastro e o handler é um refetch; se um dia
        // forem publicadas, passam a chegar sem nenhuma mudança de código.
        .on("postgres_changes", { event: "*", schema: "public", table: "plc_groups", filter: `farm_id=eq.${farmId}` }, onCadastroChange)
        .on("postgres_changes", { event: "*", schema: "public", table: "equipments", filter: `farm_id=eq.${farmId}` }, handleEquipmentChange)
        .on("postgres_changes", { event: "*", schema: "public", table: "sectors", filter: `farm_id=eq.${farmId}` }, onCadastroChange)
        .subscribe((status) => {
          if (cancelled) { try { void removeRealtimeChannel(ch); } catch { /* ignore */ } return; }
          const ok = status === "SUBSCRIBED";
          // A decisão de rede/saúde é do módulo puro: SUBSCRIBED entra em
          // PROBATION (rede LIGADA) e só um evento real leva a CONNECTED.
          applyDelivery(onChannelStatus(delivery, status, MAX_RECONNECT_BEFORE_DEGRADED));
          if (ok) {
            reconnectAttempts = 0;
            // Sincroniza estado pós-reconexão. A rede de segurança NÃO é
            // desligada aqui — conexão não é prova de entrega.
            void refresh();
          } else if (status === "TIMED_OUT" || status === "CHANNEL_ERROR" || status === "CLOSED") {
            // Reconexão com backoff exponencial: 2s, 4s, 8s, 16s, máx 30s
            const delay = Math.min(2000 * Math.pow(2, reconnectAttempts), 30_000);
            reconnectAttempts += 1;
            if (import.meta.env.DEV) {
              console.warn(`[useCadastrosCloud] realtime ${status} — reconectando em ${delay}ms (tentativa ${reconnectAttempts})`);
            }
            void refresh();
            if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
              // Desiste de reinscrever em laço; a rede de segurança e o retorno
              // de aba continuam atualizando a tela.
              return;
            }
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(() => {
              if (!cancelled) subscribePostgresChanges(farmId);
            }, delay);
          }
        });
      channel = ch;
      // Race: se o cleanup rodou DURANTE o setup acima, ele capturou channel=null
      // e não removeu este canal. Remove agora para não vazar nem segurar slot Realtime.
      if (cancelled) { try { void removeRealtimeChannel(ch); } catch { /* ignore */ } channel = null; }
    };

    const boot = async () => {
      if (!user) {
        setState({ loading: false, error: null, farmId: null, isAdmin: false, plcs: [], equipments: [], sectors: [], lastSyncAt: null, realtimeConnected: false, realtimeHealth: "reconnecting", lastPhysicalReadAt: null });
        return;
      }
      try {
        const { data: prof, error: pErr } = await supabase
          .from("profiles").select("default_farm_id").eq("id", user.id).maybeSingle();
        if (pErr) throw new Error(pErr.message);

        const sessionFarmId = sessionStorage.getItem("impersonate_farm_id") ?? sessionStorage.getItem("demo_farm_id");
        let farmId = sessionFarmId ?? prof?.default_farm_id ?? localStorage.getItem(`last_farm:${user.id}`) ?? null;

        if (!farmId) {
          const { data: roles, error: roleErr } = await supabase
            .from("user_roles")
            .select("farm_id, created_at")
            .eq("user_id", user.id)
            .order("created_at", { ascending: true })
            .limit(1);

          if (roleErr) throw new Error(roleErr.message);
          farmId = roles?.[0]?.farm_id ?? null;

          if (farmId) {
            await supabase.from("profiles").update({ default_farm_id: farmId }).eq("id", user.id);
          }
        }

        if (!farmId) {
          const { data: isPlatformAdmin } = await supabase.rpc("is_platform_admin", { _user_id: user.id });
          if (isPlatformAdmin) {
            const { data: farms } = await supabase
              .from("farms")
              .select("id")
              .order("name", { ascending: true })
              .limit(1);
            farmId = farms?.[0]?.id ?? null;
          }
        }

        if (!farmId) {
          farmIdRef.current = null;
          if (!cancelled) {
            setState({ loading: false, error: "no_default_farm", farmId: null, isAdmin: false, plcs: [], equipments: [], sectors: [], lastSyncAt: null, realtimeConnected: false, realtimeHealth: "reconnecting", lastPhysicalReadAt: null });
          }
          return;
        }

        const [{ data: isFarmAdmin }, { data: roleRow }] = await Promise.all([
          supabase.rpc("is_farm_admin", { _user_id: user.id, _farm_id: farmId }),
          supabase
            .from("user_roles")
            .select("role")
            .eq("user_id", user.id)
            .eq("farm_id", farmId)
            .maybeSingle(),
        ]);
        const isAdmin = !!isFarmAdmin || roleRow?.role === "owner" || roleRow?.role === "admin" || roleRow?.role === "supervisor";

        farmIdRef.current = farmId;

        const data = await loadAll(farmId);
        if (cancelled) return;
        setState({ loading: false, error: null, farmId, isAdmin, ...data, lastSyncAt: Date.now(), realtimeConnected: false, realtimeHealth: "reconnecting", lastPhysicalReadAt: null });

        try {
          if (cancelled) return;
          subscribePostgresChanges(farmId);

          // Canal Broadcast paralelo (WebSocket direto, sem passar pelo banco).
          if (cancelled) return;
          // Também pelo bypass: este canal entrega estado de equipamento por
          // broadcast (sem passar pelo banco) e alimenta os mesmos cards.
          const bch = getRealtimeChannel(`farm-${farmId}`, undefined, farmId)
            .on("broadcast", { event: "equipment_state" }, (msg: any) => {
              if (cancelled) return;
              const p = msg?.payload;
              if (!p?.equipment_id) return;
              setState((s) => {
                const idx = s.equipments.findIndex((e) => e.id === p.equipment_id);
                if (idx === -1) return s;
                const arr = s.equipments.slice();
                arr[idx] = {
                  ...arr[idx],
                  last_outputs_state: p.outputs ?? arr[idx].last_outputs_state,
                  last_communication: p.timestamp ?? arr[idx].last_communication,
                };
                return { ...s, equipments: arr, lastSyncAt: Date.now(), lastPhysicalReadAt: Date.now() };
              });
            })
            .subscribe();
          broadcastChannel = bch;
          if (cancelled) { try { void removeRealtimeChannel(bch); } catch { /* ignore */ } broadcastChannel = null; }

          // ── Safari/aba em segundo plano ───────────────────────────────────
          // O WebSocket costuma ser suspenso quando a aba sai de foco; ao voltar,
          // eventos perdidos NÃO chegam sozinhos — era isso que obrigava o F5.
          // Ao retornar: reconcilia UMA vez a fazenda ativa e, se o canal não
          // estiver conectado, reinscreve. Sem reload e sem polling.
          let lastWake = 0;
          visibilityHandler = () => {
            if (cancelled) return;
            if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
            const now = Date.now();
            if (now - lastWake < 1_000) return;   // coalescing: visibility + focus juntos
            lastWake = now;
            void refresh();                        // reconciliação única da fazenda ativa
            const st = (channel as { state?: string } | null)?.state;
            if (st !== "joined") {
              reconnectAttempts = 0;              // volta da aba = nova chance
              subscribePostgresChanges(farmId);   // sem duplicar canal
            }
          };
          if (typeof document !== "undefined") {
            document.addEventListener("visibilitychange", visibilityHandler);
            window.addEventListener("focus", visibilityHandler);
            window.addEventListener("online", visibilityHandler);
          }

          // POLLING DE REDE REMOVIDO. Antes havia um setInterval de 60s chamando
          // refresh() — polling contínuo de API. A recuperação agora é por EVENTO:
          // reconexão do canal (SUBSCRIBED), retorno da aba (visibilitychange/
          // focus), volta da internet (online) e timeout de um comando específico.
        } catch (subErr) {
          console.warn("[useCadastrosCloud] realtime subscribe falhou:", subErr);
        }
      } catch (e) {
        if (!cancelled) setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }));
      }
    };
    // NOTA: o polling da fazenda migrada NÃO vive aqui. Ele é um efeito próprio,
    // ancorado em state.farmId (ver MIGRATED_POLL_MS abaixo) — o timer antigo
    // era um one-shot 3s após a montagem e simplesmente não nascia quando o
    // farmId ainda não havia sido resolvido nesse instante.

    void boot();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      stopDegradedSafetyNet();
      if (visibilityHandler && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", visibilityHandler);
        window.removeEventListener("focus", visibilityHandler);
        window.removeEventListener("online", visibilityHandler);
      }
      if (channel) { try { void removeRealtimeChannel(channel); } catch { /* ignore */ } }
      if (broadcastChannel) { try { void removeRealtimeChannel(broadcastChannel); } catch { /* ignore */ } }
      if (reloadDebounceRef.current) clearTimeout(reloadDebounceRef.current);
    };
  }, [user, loadAll, scheduleReload, refresh]);

  // ───────────────────────────────────────────────────────────────────────────
  // POLLING DA FAZENDA MIGRADA — única fonte periódica enquanto o backend novo
  // não tiver publication de Realtime.
  // ───────────────────────────────────────────────────────────────────────────
  // Ancorado em `state.farmId`: nasce quando existe uma fazenda migrada ativa,
  // é recriado ao TROCAR de fazenda e é destruído na desmontagem. Um efeito só,
  // um timer só — o React garante a limpeza antes de rodar de novo, então não
  // há timers duplicados. `refresh()` resolve o cliente pelo farm_id, logo os
  // dados vêm do backend da própria fazenda, nunca do antigo.
  //
  // Pausa com a aba em segundo plano; o retorno de foco já dispara um refresh
  // próprio (mecanismo ADICIONAL, não a fonte principal).
  useEffect(() => {
    const fid = state.farmId;
    if (!fid || !isFarmMigrated(fid)) return;
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      void refresh();
    }, MIGRATED_POLL_MS);
    return () => clearInterval(id);
  }, [state.farmId, refresh]);

  // ───────── Validações ─────────
  const guardAdmin = (): boolean => {
    if (!state.isAdmin) {
      notifyRegistry.error("Cadastros", "apenas administradores podem editar.");
      return false;
    }
    return true;
  };

  const guardFarm = (): string | null => {
    if (!state.farmId) {
      notifyRegistry.error("Cadastros", "fazenda padrão não definida.");
      return null;
    }
    return state.farmId;
  };

  const usedSaidas = useCallback(
    (plcGroupId: string, excludeEquipId?: string) =>
      state.equipments
        .filter((e) => e.plc_group_id === plcGroupId && e.id !== excludeEquipId && e.saida != null)
        .map((e) => e.saida as number),
    [state.equipments],
  );

  const availableSaidas = useCallback(
    (plcGroupId: string, excludeEquipId?: string) => {
      const used = usedSaidas(plcGroupId, excludeEquipId);
      return Array.from({ length: MAX_SAIDAS }, (_, i) => i + 1).filter((s) => !used.includes(s));
    },
    [usedSaidas],
  );

  // ───────── PLCs ─────────
  const createPlc = async (input: { name: string; hw_id: string; output_count?: number }) => {
    if (!guardAdmin()) return null;
    const farmId = guardFarm();
    if (!farmId) return null;
    const hw = upper4(input.hw_id);
    if (!/^[0-9A-F]{4}$/.test(hw)) { notifyRegistry.error("PLC", "ID hex deve ter 4 caracteres (0-9, A-F)."); return null; }
    if (state.plcs.some((p) => p.hw_id === hw)) { notifyRegistry.error("PLC", `já existe PLC com ID ${hw}.`); return null; }

    const payload = { farm_id: farmId, name: input.name.trim(), hw_id: hw, output_count: input.output_count === 6 ? 6 : 1 };

    if (!isOnline()) {
      enqueue({ table: "plc_groups", op: "insert", payload });
      notifyRegistry.queuedOffline(`PLC "${payload.name}"`);
      return null;
    }
    const { data, error } = await getSupabaseForFarm(farmIdRef.current).from("plc_groups").insert(payload).select("*").single();
    if (error) { notifyRegistry.error("PLC", `falha ao criar — ${error.message}`); return null; }
    notifyRegistry.created("PLC", payload.name);
    return data as CloudPlc;
  };

  const updatePlc = async (id: string, patch: Partial<{ name: string; hw_id: string; output_count: number }>) => {
    if (!guardAdmin()) return false;
    const next: { name?: string; hw_id?: string; output_count?: number } = {};
    if (patch.name !== undefined) next.name = patch.name.trim();
    if (patch.hw_id !== undefined) {
      const hw = upper4(patch.hw_id);
      if (!/^[0-9A-F]{4}$/.test(hw)) { notifyRegistry.error("PLC", "ID hex deve ter 4 caracteres."); return false; }
      if (state.plcs.some((p) => p.hw_id === hw && p.id !== id)) { notifyRegistry.error("PLC", `já existe PLC com ID ${hw}.`); return false; }
      next.hw_id = hw;
    }
    if (patch.output_count !== undefined) next.output_count = patch.output_count === 6 ? 6 : 1;
    const current = state.plcs.find((p) => p.id === id);
    const label = next.name ?? current?.name ?? id;
    if (!isOnline()) {
      enqueue({ table: "plc_groups", op: "update", payload: next, matchId: id });
      notifyRegistry.queuedOffline(`PLC "${label}"`);
      return true;
    }
    const { error } = await getSupabaseForFarm(farmIdRef.current).from("plc_groups").update(next).eq("id", id);
    if (error) { notifyRegistry.error("PLC", error.message); return false; }
    notifyRegistry.updated("PLC", label);
    return true;
  };

  const deletePlc = async (id: string) => {
    if (!guardAdmin()) return false;
    if (state.equipments.some((e) => e.plc_group_id === id)) {
      notifyRegistry.error("PLC", "remova os equipamentos vinculados antes de excluir.");
      return false;
    }
    const current = state.plcs.find((p) => p.id === id);
    const label = current?.name ?? id;
    if (!isOnline()) {
      enqueue({ table: "plc_groups", op: "delete", payload: {}, matchId: id });
      notifyRegistry.queuedOffline(`Exclusão de PLC "${label}"`);
      return true;
    }
    const { error } = await getSupabaseForFarm(farmIdRef.current).from("plc_groups").delete().eq("id", id);
    if (error) { notifyRegistry.error("PLC", error.message); return false; }
    notifyRegistry.removed("PLC", label);
    return true;
  };

  // ───────── Equipamentos ─────────
  type EquipInput = {
    name: string;
    type: EquipTipo;
    plc_group_id: string;
    saida: number | null;
    sector_id?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    horas_pico?: string | null;
    max_horas_dia?: number | null;
    demanda_kw?: number | null;
    power_kw?: number | null;
    estimated_flow_m3h?: number | null;
    vazao_mode?: "off" | "estimated" | "real";
    vazao_cadastrada_m3h?: number | null;
    vazao_m3_por_pulso?: number | null;
    max_height?: number | null;
    alarm_low?: number | null;
    alarm_high?: number | null;
    fonte_tipo?: FonteTipo | null;
    fonte_id?: string | null;
    alimenta_id?: string | null;
    output_count?: number;
    participates_night_cycle?: boolean;
    forced_shutdown_enabled?: boolean;
  };

  const syncPlcOutputCount = async (plcGroupId: string, type: EquipTipo, outputCount?: number) => {
    const next = type === "bombeamento" ? (outputCount === 6 ? 6 : 1) : 1;
    const { error } = await getSupabaseForFarm(farmIdRef.current).from("plc_groups").update({ output_count: next }).eq("id", plcGroupId);
    if (error) throw new Error(error.message);
  };

  const buildEquipPayload = (farmId: string, input: EquipInput) => {
    const plc = state.plcs.find((p) => p.id === input.plc_group_id);
    const plcHex = plc ? plc.hw_id : "0000";
    return {
      farm_id: farmId,
      name: input.name.trim(),
      type: input.type,
      plc_group_id: input.plc_group_id,
      saida: input.saida,
      hw_id: buildEquipHwId(plcHex, input.saida),
      sector_id: input.sector_id ?? null,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      horas_pico: input.horas_pico ?? null,
      max_horas_dia: input.max_horas_dia ?? null,
      demanda_kw: input.demanda_kw ?? null,
      power_kw: input.power_kw ?? null,
      estimated_flow_m3h: input.estimated_flow_m3h ?? null,
      vazao_mode: input.vazao_mode ?? "off",
      vazao_cadastrada_m3h: input.vazao_cadastrada_m3h ?? 0,
      vazao_m3_por_pulso: input.vazao_m3_por_pulso ?? 1,
      max_height: input.max_height ?? null,
      alarm_low: input.alarm_low ?? null,
      alarm_high: input.alarm_high ?? null,
      fonte_tipo: input.fonte_tipo ?? null,
      fonte_id: input.fonte_id ?? null,
      alimenta_id: input.alimenta_id ?? null,
      active: true,
      participates_night_cycle: input.participates_night_cycle ?? true,
      forced_shutdown_enabled: input.forced_shutdown_enabled ?? false,
    };
  };

  const createEquip = async (input: EquipInput) => {
    if (!guardAdmin()) return null;
    const farmId = guardFarm();
    if (!farmId) return null;
    if (input.saida != null && !availableSaidas(input.plc_group_id).includes(input.saida)) {
      notifyRegistry.error("Equipamento", `saída ${input.saida} já está em uso neste PLC.`);
      return null;
    }
    const payload = buildEquipPayload(farmId, input);

    if (!isOnline()) {
      enqueue({ table: "equipments", op: "insert", payload });
      notifyRegistry.queuedOffline(`Equipamento "${payload.name}"`);
      return null;
    }
    await syncPlcOutputCount(input.plc_group_id, input.type, input.output_count);
    const { data, error } = await getSupabaseForFarm(farmIdRef.current).from("equipments").insert(payload as never).select("*").single();
    if (error) { notifyRegistry.error("Equipamento", error.message); return null; }
    notifyRegistry.created("Equipamento", payload.name);
    return data as CloudEquipamento;
  };

  const updateEquip = async (id: string, input: Partial<EquipInput>) => {
    if (!guardAdmin()) return false;
    const farmId = guardFarm();
    if (!farmId) return false;

    // Se mudar PLC ou saída, valida disponibilidade e recalcula hw_id
    const current = state.equipments.find((e) => e.id === id);
    if (!current) { notifyRegistry.error("Equipamento", "não encontrado."); return false; }

    const newPlcId = input.plc_group_id ?? current.plc_group_id;
    const newSaida = input.saida !== undefined ? input.saida : (current.saida ?? null);
    if (input.plc_group_id !== undefined || input.saida !== undefined) {
      if (newPlcId && newSaida != null && !availableSaidas(newPlcId, id).includes(newSaida)) {
        notifyRegistry.error("Equipamento", `saída ${newSaida} já está em uso neste PLC.`);
        return false;
      }
    }

    const patch: Partial<CloudEquipamento> & { hw_id?: string } = {};
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.type !== undefined) patch.type = input.type;
    if (input.plc_group_id !== undefined) patch.plc_group_id = input.plc_group_id;
    if (input.saida !== undefined) patch.saida = input.saida;
    if (input.plc_group_id !== undefined || input.saida !== undefined) {
      const plc = state.plcs.find((p) => p.id === newPlcId);
      const plcHex = plc ? plc.hw_id : "0000";
      patch.hw_id = buildEquipHwId(plcHex, newSaida);
    }
    if (input.sector_id !== undefined) patch.sector_id = input.sector_id;
    if (input.latitude !== undefined) patch.latitude = input.latitude;
    if (input.longitude !== undefined) patch.longitude = input.longitude;
    if (input.horas_pico !== undefined) patch.horas_pico = input.horas_pico;
    if (input.max_horas_dia !== undefined) patch.max_horas_dia = input.max_horas_dia;
    if (input.demanda_kw !== undefined) patch.demanda_kw = input.demanda_kw;
    if (input.power_kw !== undefined) patch.power_kw = input.power_kw;
    if (input.estimated_flow_m3h !== undefined) patch.estimated_flow_m3h = input.estimated_flow_m3h;
    if (input.vazao_mode !== undefined) (patch as Record<string, unknown>).vazao_mode = input.vazao_mode;
    if (input.vazao_cadastrada_m3h !== undefined) (patch as Record<string, unknown>).vazao_cadastrada_m3h = input.vazao_cadastrada_m3h;
    if (input.vazao_m3_por_pulso !== undefined) (patch as Record<string, unknown>).vazao_m3_por_pulso = input.vazao_m3_por_pulso;
    if (input.max_height !== undefined) patch.max_height = input.max_height;
    if (input.alarm_low !== undefined) patch.alarm_low = input.alarm_low;
    if (input.alarm_high !== undefined) patch.alarm_high = input.alarm_high;
    if (input.fonte_tipo !== undefined) patch.fonte_tipo = input.fonte_tipo;
    if (input.fonte_id !== undefined) (patch as Record<string, unknown>).fonte_id = input.fonte_id;
    if (input.alimenta_id !== undefined) patch.alimenta_id = input.alimenta_id;
    if (input.participates_night_cycle !== undefined) patch.participates_night_cycle = input.participates_night_cycle;
    if (input.forced_shutdown_enabled !== undefined) patch.forced_shutdown_enabled = input.forced_shutdown_enabled;

    const label = patch.name ?? current.name;
    if (!isOnline()) {
      enqueue({ table: "equipments", op: "update", payload: patch, matchId: id });
      notifyRegistry.queuedOffline(`Equipamento "${label}"`);
      return true;
    }
    await syncPlcOutputCount(newPlcId!, input.type ?? current.type, input.output_count);
    const { error } = await getSupabaseForFarm(farmIdRef.current).from("equipments").update(patch as never).eq("id", id);
    if (error) { notifyRegistry.error("Equipamento", error.message); return false; }
    notifyRegistry.updated("Equipamento", label);
    return true;
  };

  const deleteEquip = async (id: string) => {
    if (!guardAdmin()) return false;
    const current = state.equipments.find((e) => e.id === id);
    const label = current?.name ?? id;
    if (!isOnline()) {
      enqueue({ table: "equipments", op: "delete", payload: {}, matchId: id });
      notifyRegistry.queuedOffline(`Exclusão de equipamento "${label}"`);
      return true;
    }
    const { error } = await getSupabaseForFarm(farmIdRef.current).from("equipments").delete().eq("id", id);
    if (error) { notifyRegistry.error("Equipamento", error.message); return false; }
    notifyRegistry.removed("Equipamento", label);
    return true;
  };

  // ───────── Setores ─────────
  const createSector = async (name: string) => {
    if (!guardAdmin()) return null;
    const farmId = guardFarm();
    if (!farmId) return null;
    const trimmed = name.trim();
    const payload = { farm_id: farmId, name: trimmed };
    if (!isOnline()) { enqueue({ table: "sectors", op: "insert", payload }); notifyRegistry.queuedOffline(`Setor "${trimmed}"`); return null; }
    const { data, error } = await getSupabaseForFarm(farmIdRef.current).from("sectors").insert(payload).select("*").single();
    if (error) { notifyRegistry.error("Setor", error.message); return null; }
    notifyRegistry.created("Setor", trimmed);
    return data as CloudSector;
  };

  const updateSector = async (id: string, name: string) => {
    if (!guardAdmin()) return false;
    const trimmed = name.trim();
    const patch = { name: trimmed };
    if (!isOnline()) { enqueue({ table: "sectors", op: "update", payload: patch, matchId: id }); notifyRegistry.queuedOffline(`Setor "${trimmed}"`); return true; }
    const { error } = await getSupabaseForFarm(farmIdRef.current).from("sectors").update(patch).eq("id", id);
    if (error) { notifyRegistry.error("Setor", error.message); return false; }
    notifyRegistry.updated("Setor", trimmed);
    return true;
  };

  const deleteSector = async (id: string) => {
    if (!guardAdmin()) return false;
    const current = state.sectors.find((s) => s.id === id);
    const label = current?.name ?? id;
    if (!isOnline()) { enqueue({ table: "sectors", op: "delete", payload: {}, matchId: id }); notifyRegistry.queuedOffline(`Exclusão de setor "${label}"`); return true; }
    const { error } = await getSupabaseForFarm(farmIdRef.current).from("sectors").delete().eq("id", id);
    if (error) { notifyRegistry.error("Setor", error.message); return false; }
    notifyRegistry.removed("Setor", label);
    return true;
  };

  return {
    ...state,
    refresh,
    availableSaidas,
    usedSaidas,
    createPlc, updatePlc, deletePlc,
    createEquip, updateEquip, deleteEquip,
    createSector, updateSector, deleteSector,
  };
}
