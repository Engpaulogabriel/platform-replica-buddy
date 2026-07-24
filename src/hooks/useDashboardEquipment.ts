// ─────────────────────────────────────────────────────────────────────────────
// useDashboardEquipment — fonte única de Pumps/Reservoirs para o Dashboard
// ─────────────────────────────────────────────────────────────────────────────
// - Lê equipamentos reais da nuvem via useCadastrosCloud (filtrados por farm)
// - Reage a updates em tempo real recebidos pelo hook de cadastros
// - Calcula status de comunicação por last_communication (online/instável/offline)
// - Deriva ligado/desligado pelo último payload real de telemetria (last_outputs_state)
// - Não usa Math.random() para status/saídas
//
// IMPORTANTE: ids são UUIDs (string), nunca number.

import { useEffect, useMemo, useRef, useState } from "react";
import { useCadastrosCloud, type CloudEquipamento } from "@/hooks/useCadastrosCloud";
import type { Pump } from "@/components/dashboard/PumpTable";
import type { Reservoir } from "@/components/dashboard/ReservoirGauges";
import { buildCommandHistory, buildStatusHistory, logEvent, useAutomationLog, type AutomationLogEntry } from "@/lib/automationLog";
import { supabase } from "@/integrations/supabase/client";
import { notify } from "@/lib/notify";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";
import { enqueueResetPumpCommand } from "@/lib/commandQueue";
import { calibrateLevel } from "@/lib/levelCalibration";
import { getSystemTimingConfig } from "@/lib/systemTimers";
import { usePendingManualCommands, type PendingManualCommand } from "@/hooks/usePendingManualCommands";

// Janela em que um comando manual em andamento força "Ligando…/Desligando…"
// no card, ignorando last_confirmed_state (que o Electron pode escrever com
// leituras intermediárias durante o reforço).
// v3.25.21: 90s → 5min. O "Ligando" é dirigido pelo STATUS do comando (pending/sent,
// via usePendingManualCommands + Realtime): sai quando o agente muda para
// executed/timeout/cancelled. Esta janela é só o teto de segurança.
const MANUAL_PENDING_WINDOW_MS = 300_000;


// Janela de classificação de comunicação por equipamento:
//   • 1 saída no PLC          → 15 min
//   • >1 saídas no mesmo PLC  → 20 min (Boosters e similares)
// Sem `last_communication` → não marca OFFLINE (evita falsos positivos).
// Página web e WhatsApp seguem EXATAMENTE a mesma regra.
const OFFLINE_MIN_SINGLE = 15;
const OFFLINE_MIN_MULTI = 20;
const STATUS_REFRESH_MS = 30_000;
// Estados "Ligando…/Desligando…" aguardam a janela física completa antes de
// qualquer falha definitiva. Resposta antiga em 8s NÃO é falha.
// v3.25.21: 120s → 5min. Não corta mais o "Ligando" prematuramente (o safety do
// agente agora é 120s; o comando só vira terminal depois). Este é o FALLBACK de
// segurança: se o comando ficou pending/sent além de 5min (agente pode ter
// crashado), o card passa a exibir ERRO em vez de ficar preso em "Ligando".
const PENDING_MAX_MS = 300_000;

export type EquipmentCommunicationStatus = "online" | "unstable" | "offline";

const offlineWindowMs = (outputsInPlc: number | null | undefined): number =>
  ((outputsInPlc ?? 1) > 1 ? OFFLINE_MIN_MULTI : OFFLINE_MIN_SINGLE) * 60_000;

export const getEquipmentCommunicationStatus = (
  lastComm: string | null | undefined,
  outputsInPlc?: number | null,
): EquipmentCommunicationStatus => {
  if (!lastComm) return "online";
  const t = new Date(lastComm).getTime();
  if (Number.isNaN(t)) return "online";

  const diff = Date.now() - t;
  if (diff < offlineWindowMs(outputsInPlc)) return "online";
  return "offline";
};



// v3.11.x — Status de comunicação compartilhado por TSNN.
// Toda RX em qualquer saída prova que o PLC está vivo. Portanto, dois
// equipamentos do mesmo plc_group_id devem mostrar o MESMO status de
// comunicação: usamos o MAIS RECENTE `last_communication` entre todos os
// equipamentos do grupo. Isso evita que o Booster 02 (que raramente atua)
// apareça offline enquanto o Booster 01 do mesmo TSNN está respondendo.
export const buildTsnnLastCommMap = (
  equipments: CloudEquipamento[],
): Map<string, string> => {
  const map = new Map<string, string>();
  for (const e of equipments) {
    if (!e.plc_group_id || !e.last_communication) continue;
    const cur = map.get(e.plc_group_id);
    if (!cur || new Date(e.last_communication).getTime() > new Date(cur).getTime()) {
      map.set(e.plc_group_id, e.last_communication);
    }
  }
  return map;
};

const effectiveLastComm = (
  e: CloudEquipamento,
  tsnnMap: Map<string, string>,
): string | null | undefined => {
  if (!e.plc_group_id) return e.last_communication;
  const shared = tsnnMap.get(e.plc_group_id);
  const own = e.last_communication;
  if (!shared) return own;
  if (!own) return shared;
  return new Date(shared).getTime() > new Date(own).getTime() ? shared : own;
};

// Conta saídas por plc_group_id — usado para decidir a janela de OFFLINE
// (15 min single-output / 20 min multi-output).
export const buildPlcOutputsCountMap = (
  equipments: CloudEquipamento[],
  plcs?: Array<{ id: string; output_count?: number | null }>,
): Map<string, number> => {
  const map = new Map<string, number>();
  const knownPlcIds = new Set<string>();
  for (const plc of plcs ?? []) {
    map.set(plc.id, Math.max(1, Number(plc.output_count ?? 1)));
    knownPlcIds.add(plc.id);
  }

  // Fallback para cadastros antigos sem output_count: usa a quantidade de
  // equipamentos ativos no grupo. Se output_count existe, ele prevalece.
  for (const e of equipments) {
    if (!e.plc_group_id) continue;
    if (knownPlcIds.has(e.plc_group_id)) continue;
    map.set(e.plc_group_id, (map.get(e.plc_group_id) ?? 0) + 1);
  }
  return map;
};

const outputsForEquip = (
  e: CloudEquipamento,
  plcCount: Map<string, number>,
): number => (e.plc_group_id ? (plcCount.get(e.plc_group_id) ?? 1) : 1);

// Reservatórios (sensores de nível) usam EXATAMENTE a mesma regra dos demais
// equipamentos — não há mais threshold curto específico para nível.
export const getReservoirCommunicationStatus = getEquipmentCommunicationStatus;


const formatTimestamp = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getFullYear()).slice(-2)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
};

export const isEquipmentOnline = (lastComm: string | null | undefined): boolean => {
  return getEquipmentCommunicationStatus(lastComm) !== "offline";
};

export const formatLastSeen = (lastComm: string | null | undefined): string => {
  if (!lastComm) return "nunca";
  const ms = Date.now() - new Date(lastComm).getTime();
  if (Number.isNaN(ms) || ms < 0) return "—";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h}h`;
  return `há ${Math.floor(h / 24)}d`;
};

const getRunningFromOutputs = (e: CloudEquipamento): boolean => {
  const payload = e.last_outputs_state ?? "";
  const saidaIndex = (e.saida ?? 1) - 1;
  // Payload curto (poço, 1 dígito): "1" = ligado, "0" = desligado
  if (payload.length === 1) return payload === "1";
  // Payload normal (PLC, 6 dígitos): verifica posição da saída
  if (!/^[01]{1,6}$/.test(payload)) return false;
  if (saidaIndex < 0 || saidaIndex >= payload.length) return false;
  return payload[saidaIndex] === "1";
};

const signalBarsToPercent = (bars: number | null | undefined): number => {
  if (!bars || bars <= 0) return 0;
  if (bars >= 4) return 100;
  if (bars === 3) return 75;
  if (bars === 2) return 50;
  return 25;
};

const buildPumpFromCloud = (
  e: CloudEquipamento,
  log: AutomationLogEntry[],
  tsnnMap: Map<string, string>,
  plcCount: Map<string, number>,
): Pump => {
  const effComm = effectiveLastComm(e, tsnnMap);
  const communicationStatus = getEquipmentCommunicationStatus(effComm, outputsForEquip(e, plcCount));
  const isReachable = communicationStatus !== "offline";

  const isRunning = getRunningFromOutputs(e);
  const name = e.name.toUpperCase();
  const cmdHist = buildCommandHistory(e.id, name, log, 3);
  const stHist = buildStatusHistory(e.id, name, log, 3);

  return {
    id: e.id,
    hwId: e.hw_id,
    rfRadio: (e as { rf_radio?: "R1" | "R2" | "R3" | null }).rf_radio ?? null,
    rfViaRep: (e as { rf_via_rep?: boolean | null }).rf_via_rep ?? null,
    name,
    online: isReachable,
    communicationStatus,
    running: isRunning,
    horimetroMes: "—",
    hasFlow: false,
    lat: e.latitude != null ? Number(e.latitude) : undefined,
    lng: e.longitude != null ? Number(e.longitude) : undefined,
    mode: "manual",
    signalRF: isReachable ? signalBarsToPercent(e.last_signal_bars) : 0,
    voltage: 0,
    current: 0,
    lastCommand: cmdHist[0]
      ? { action: cmdHist[0].action, time: cmdHist[0].time, result: cmdHist[0].result }
      : { action: "Ligar remoto", time: "—", result: "success" as const },
    lastReading: formatTimestamp(e.last_communication),
    lastCommunication: e.last_communication,
    commandHistory: cmdHist,
    statusHistory: stHist,
    actuationOrigin: (e as { last_actuation_origin?: "remote" | "local" | "whatsapp" | null }).last_actuation_origin ?? null,
    localAckAt: (e as { local_ack_at?: string | null }).local_ack_at ?? null,
  };
};

const buildReservoirFromCloud = (
  e: CloudEquipamento,
  plcCount: Map<string, number>,
): Reservoir => {
  const communicationAt = e.last_communication ?? e.level_last_raw_at;
  const communicationStatus = getReservoirCommunicationStatus(communicationAt, outputsForEquip(e, plcCount));
  const isReachable = communicationStatus !== "offline";

  const lvlMaxNum = Number(e.level_max_meters);
  const maxHNum = Number(e.max_height);
  const maxRef = Number.isFinite(lvlMaxNum) && lvlMaxNum > 0
    ? lvlMaxNum
    : (Number.isFinite(maxHNum) && maxHNum > 0 ? maxHNum : 4.0);

  const cal = calibrateLevel({
    raw: e.level_last_raw,
    cal_digital: e.level_cal_digital,
    cal_meters: e.level_cal_meters,
    max_meters: e.level_max_meters,
    max_height: e.max_height,
  });

  return {
    id: e.id,
    name: e.name,
    percent: cal.percent !== null ? Math.round(cal.percent) : 0,
    level: cal.meters !== null ? cal.meters.toFixed(2) : (cal.percent !== null ? "—" : "—"),
    maxLevel: `${maxRef}m`,
    alarm: false,
    signalRF: isReachable ? signalBarsToPercent(e.last_signal_bars) : 0,
    lastReading: formatTimestamp(communicationAt),
    online: isReachable,
  };
};

export interface UseDashboardEquipmentResult {
  pumps: Pump[];
  reservoirs: Reservoir[];
  setPumps: React.Dispatch<React.SetStateAction<Pump[]>>;
  setReservoirs: React.Dispatch<React.SetStateAction<Reservoir[]>>;
  loading: boolean;
  /** snapshots brutos da nuvem (para diagrama de fluxo, popovers) */
  cloudEquipments: CloudEquipamento[];
}

export function useDashboardEquipment(): UseDashboardEquipmentResult {
  const cloud = useCadastrosCloud();
  const farmId = useDefaultFarmId();
  const pendingManualByEq = usePendingManualCommands(farmId);
  const logEntries = useAutomationLog((s) => s.entries);

  // Bombas que já dispararam o RPC de timeout (evita chamar 2x para a mesma transição)
  const localTimeoutFiredRef = useRef<Set<string>>(new Set());
  // Última transição registrada como Local (evita logs duplicados quando a nuvem
  // republica o mesmo `last_actuation_origin = local` em polls subsequentes).
  // Map: equipmentId -> "running:lastCommunicationISO"
  const lastLocalLoggedRef = useRef<Map<string, string>>(new Map());

  const [pumps, setPumps] = useState<Pump[]>([]);
  const [reservoirs, setReservoirs] = useState<Reservoir[]>([]);
  // Mapa equipment_id → horas no mês corrente (atualizado a cada 60s)
  const [horimetroMap, setHorimetroMap] = useState<Record<string, number>>({});

  const cloudPumps = useMemo(
    () => cloud.equipments.filter((e) => e.type === "poco" || e.type === "bombeamento"),
    [cloud.equipments],
  );
  const cloudReservoirs = useMemo(
    () => cloud.equipments.filter((e) => e.type === "nivel"),
    [cloud.equipments],
  );

  // Carrega horímetro do mês corrente para todas as bombas (batch via SQL)
  useEffect(() => {
    if (!farmId || cloudPumps.length === 0) return;
    let cancelled = false;
    const load = async () => {
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const { data } = await supabase.rpc("get_horimetro_daily", {
        _farm_id: farmId,
        _from: monthStart.toISOString(),
        _to: new Date().toISOString(),
      });
      if (cancelled || !data) return;
      const map: Record<string, number> = {};
      for (const r of data as Array<{ equipment_id: string; hours: number }>) {
        map[r.equipment_id] = (map[r.equipment_id] ?? 0) + Number(r.hours);
      }
      setHorimetroMap(map);
    };
    void load();
    const id = setInterval(load, 300_000); // 5 min — horímetro mensal não muda rápido
    return () => { cancelled = true; clearInterval(id); };
  }, [farmId, cloudPumps.length]);

  useEffect(() => {
    const localTimeoutsFromCloud: { equipmentId: string; name: string }[] = [];
    const tsnnMap = buildTsnnLastCommMap(cloud.equipments);
    const plcCount = buildPlcOutputsCountMap(cloud.equipments, cloud.plcs);

    setPumps((prev) => {
      const prevById = new Map(prev.map((p) => [p.id, p]));
      return cloudPumps.map((e) => {
        const communicationStatus = getEquipmentCommunicationStatus(effectiveLastComm(e, tsnnMap), outputsForEquip(e, plcCount));
        const online = communicationStatus !== "offline";

        const old = prevById.get(e.id);
        const cloudRunning = getRunningFromOutputs(e);

        // ─────────────────────────────────────────────────────────────
        // REGRA ÚNICA — REALIDADE FÍSICA VENCE INTENÇÃO
        // ─────────────────────────────────────────────────────────────
        // `last_outputs_state` SÓ muda quando o agente Electron recebe um
        // frame RX REAL da bomba. Portanto, se o RX já bate com o estado
        // desejado, a bomba está fisicamente nesse estado — ignora o
        // pending_command_id e qualquer pending local imediatamente.
        //
        // Só mostra "Ligando…/Desligando…" quando há um comando em curso
        // E a realidade física AINDA NÃO alcançou o desejo.
        let pending = old?.pending;
        let running = cloudRunning;

        const localPending = pending === "turning_on" || pending === "turning_off" || pending === "resetting";
        // Comando manual ativo na tabela `commands` (pending/sent, <90s) —
        // enquanto existir, tratamos o card como "Ligando…/Desligando…" e
        // IGNORAMOS last_outputs_state intermediário do Electron.
        const manualCmd = pendingManualByEq.get(e.id);
        const manualCmdFresh =
          !!manualCmd && Date.now() - new Date(manualCmd.createdAt).getTime() < MANUAL_PENDING_WINDOW_MS;
        const hasAnyPending = localPending || !!e.pending_command_id || manualCmdFresh;


        if (hasAnyPending) {
          // Determina o estado desejado:
          // 1) Pending local explícito (turning_on/off/resetting) tem prioridade.
          // 2) Senão usa `desired_running` do banco (cross-user).
          let desiredRunning: boolean | null = null;
          if (pending === "turning_on") desiredRunning = true;
          else if (pending === "turning_off" || pending === "resetting") desiredRunning = false;
          else if (typeof e.desired_running === "boolean") desiredRunning = e.desired_running;

          if (desiredRunning === null) {
            if (manualCmdFresh && (old?.pending === "turning_on" || old?.pending === "turning_off")) {
              // Preserva a transição enquanto o comando manual está vivo.
              pending = old.pending;
              running = old.running;
            } else {
              // Sem intenção clara → realidade física manda.
              pending = undefined;
              running = cloudRunning;
            }

          } else if (cloudRunning === desiredRunning && !manualCmdFresh) {
            // ✅ Realidade física JÁ alcançou o desejo → libera de imediato.
            // Exceção: se existe comando manual fresh na tabela `commands`
            // (pending/sent, <90s), NÃO liberamos — o Electron pode estar
            // no meio do reforço e escrevendo last_outputs_state=0
            // intermediário. Só liberamos quando o comando sair da fila
            // (executed/cancelled/timeout) OU a janela de 90s expirar.
            pending = undefined;
            running = cloudRunning;
          } else {
            // Ainda não alcançou (ou tem manual fresh mandando manter transição).
            // Se não tinha pending local, deriva da intenção.
            if (!localPending) {
              pending = desiredRunning ? "turning_on" : "turning_off";
            }
            running = old?.running ?? cloudRunning;


            // Timeout duro de 120s para pending local não-reset
            if (localPending && pending !== "resetting") {
              const startedAt = old?.pendingStartedAt ?? 0;
              const elapsed = startedAt ? Date.now() - startedAt : Infinity;
              if (elapsed > PENDING_MAX_MS) {
                if (
                  pending === "turning_on" &&
                  !cloudRunning &&
                  !localTimeoutFiredRef.current.has(e.id)
                ) {
                  localTimeoutsFromCloud.push({
                    equipmentId: e.id,
                    name: old?.name ?? e.name.toUpperCase(),
                  });
                  localTimeoutFiredRef.current.add(e.id);
                  setTimeout(() => localTimeoutFiredRef.current.delete(e.id), 35_000);
                }
                // v3.25.21: além de 5min pending/sent → ERRO (agente pode ter
                // crashado), em vez de silenciosamente voltar a "Desligado".
                pending = "error";
                running = cloudRunning;
              }
            }
          }
        }
        // Sem pending → realidade física é a verdade absoluta (running = cloudRunning).



        const horimetroHoras = horimetroMap[e.id];
        const horimetroLabel = horimetroHoras != null ? `${horimetroHoras.toFixed(1)}h` : "—";

        if (old) {
          return {
            ...old,
            hwId: e.hw_id,
            rfRadio: (e as { rf_radio?: "R1" | "R2" | "R3" | null }).rf_radio ?? null,
            rfViaRep: (e as { rf_via_rep?: boolean | null }).rf_via_rep ?? null,
            name: e.name.toUpperCase(),
            lat: e.latitude != null ? Number(e.latitude) : undefined,
            lng: e.longitude != null ? Number(e.longitude) : undefined,
            online,
            communicationStatus,
            running,
            pending,
            pendingStartedAt: pending
              ? (old?.pendingStartedAt ?? Date.now())
              : undefined,
            // limpa lastUserConfirmedAt assim que a nuvem confirmar (passamos a confiar nela)
            lastUserConfirmedAt:
              old.lastUserConfirmedAt &&
              e.last_communication &&
              new Date(e.last_communication).getTime() > old.lastUserConfirmedAt
                ? undefined
                : old.lastUserConfirmedAt,
            actuationOrigin: (e.last_actuation_origin as "remote" | "local" | "whatsapp" | null) ?? null,
            localAckAt: (e as { local_ack_at?: string | null }).local_ack_at ?? null,
            commandBlockedUntil: e.command_blocked_until ?? null,
            lastCommunication: e.last_communication,
            lastReading: formatTimestamp(e.last_communication),
            signalRF: online ? signalBarsToPercent(e.last_signal_bars) : 0,
            voltage: 0,
            current: 0,
            horimetroMes: horimetroLabel,
          };
        }
        return { ...buildPumpFromCloud(e, logEntries, tsnnMap, plcCount), horimetroMes: horimetroLabel };
      });
    });

    for (const lt of localTimeoutsFromCloud) {
      void enqueueResetPumpCommand({ equipmentId: lt.equipmentId })
        .then(() => {
          notify.warn("Equipamentos", `${lt.name}: não ligou em 120s — enviado comando 0 para desligar o relé`);
        })
        .catch((error) => {
          console.error("[enqueueResetPumpCommand:cloud-timeout]", error);
          notify.fail("Equipamentos", `${lt.name}: falhou ao enviar comando 0 automático`);
        });
    }
  }, [cloudPumps, cloud.equipments, cloud.plcs, horimetroMap, logEntries, pendingManualByEq]);

  useEffect(() => {
    const tick = () => {
      const tsnnMap = buildTsnnLastCommMap(cloud.equipments);
      const plcCount = buildPlcOutputsCountMap(cloud.equipments, cloud.plcs);
      // Coleta bombas que estouraram 120s sem confirmação para disparar RPC
      const localTimeouts: { equipmentId: string; farmId: string; name: string; running: boolean; pending: "turning_on" | "turning_off" | "resetting" }[] = [];
      // Coleta transições detectadas como Local pela nuvem (sem timeout local)
      const localFromCloud: { equipmentId: string; name: string; running: boolean; ts: string }[] = [];

      setPumps((prev) => {
        let changed = false;
        const next = prev.map((p) => {
          const cloudEq = cloudPumps.find((e) => e.id === p.id);
          if (!cloudEq) return p;
          const communicationStatus = getEquipmentCommunicationStatus(effectiveLastComm(cloudEq, tsnnMap), outputsForEquip(cloudEq, plcCount));
          const online = communicationStatus !== "offline";

          const cloudRunning = getRunningFromOutputs(cloudEq);

          // REGRA ÚNICA — REALIDADE FÍSICA VENCE INTENÇÃO (mesma do useEffect).
          let pending = p.pending;
          let running = cloudRunning;

          const localPending = pending === "turning_on" || pending === "turning_off" || pending === "resetting";
          const manualCmd = pendingManualByEq.get(p.id);
          const manualCmdFresh =
            !!manualCmd && Date.now() - new Date(manualCmd.createdAt).getTime() < MANUAL_PENDING_WINDOW_MS;
          const hasAnyPending = localPending || !!cloudEq.pending_command_id || manualCmdFresh;

          if (hasAnyPending) {
            let desiredRunning: boolean | null = null;
            if (pending === "turning_on") desiredRunning = true;
            else if (pending === "turning_off" || pending === "resetting") desiredRunning = false;
            else if (typeof cloudEq.desired_running === "boolean") desiredRunning = cloudEq.desired_running;

            if (desiredRunning === null) {
              if (manualCmdFresh && (p.pending === "turning_on" || p.pending === "turning_off")) {
                pending = p.pending;
                running = p.running;
              } else {
                pending = undefined;
                running = cloudRunning;
              }
            } else if (cloudRunning === desiredRunning && !manualCmdFresh) {
              // ✅ Realidade física já alcançou o desejo → libera de imediato.
              // Enquanto houver comando manual fresh (<90s), NÃO liberamos —
              // last_confirmed_state pode ser leitura intermediária do reforço.
              pending = undefined;
              running = cloudRunning;
            } else {

              if (!localPending) {
                pending = desiredRunning ? "turning_on" : "turning_off";
              }
              running = p.running;

              if (localPending && pending !== "resetting") {
                const startedAt = p.pendingStartedAt ?? 0;
                const elapsed = startedAt ? Date.now() - startedAt : Infinity;
                if (elapsed > PENDING_MAX_MS) {
                  if (
                    pending === "turning_on" &&
                    !cloudRunning &&
                    !localTimeoutFiredRef.current.has(p.id)
                  ) {
                    localTimeouts.push({
                      equipmentId: p.id,
                      farmId: cloudEq.farm_id,
                      name: p.name,
                      running: cloudRunning,
                      pending,
                    });
                    localTimeoutFiredRef.current.add(p.id);
                    setTimeout(() => localTimeoutFiredRef.current.delete(p.id), 35_000);
                  }
                  // v3.25.21: além de 5min pending/sent → ERRO (agente pode ter
                  // crashado), em vez de silenciosamente voltar a "Desligado".
                  pending = "error";
                  running = cloudRunning;
                }
              }
            }
          }


          // limpa lastUserConfirmedAt quando a nuvem confirmar
          const lastCommMs = cloudEq.last_communication
            ? new Date(cloudEq.last_communication).getTime()
            : 0;
          const nextConfirmedAt =
            p.lastUserConfirmedAt && lastCommMs > p.lastUserConfirmedAt
              ? undefined
              : p.lastUserConfirmedAt;

          const newActuationOrigin =
            (cloudEq.last_actuation_origin as "remote" | "local" | "whatsapp" | null) ?? null;

          // Detecta acionamento Local recém-confirmado pela nuvem (sem timeout local
          // ter disparado). Caso típico: a RPC apply_pump_telemetry marcou origin=local
          // quando a bomba mudou de estado sem comando remoto correlato.
          if (
            newActuationOrigin === "local" &&
            cloudEq.last_communication &&
            !(pending === "turning_on" || pending === "turning_off" || pending === "resetting")
          ) {
            const sig = `${cloudRunning ? "1" : "0"}:${cloudEq.last_communication}`;
            const prevSig = lastLocalLoggedRef.current.get(p.id);
            const stateChanged = p.running !== cloudRunning || p.actuationOrigin !== "local";
            if (prevSig !== sig && stateChanged) {
              lastLocalLoggedRef.current.set(p.id, sig);
              localFromCloud.push({
                equipmentId: p.id,
                name: p.name,
                running: cloudRunning,
                ts: cloudEq.last_communication,
              });
            }
          }

          const newSignalRF = online ? signalBarsToPercent(cloudEq.last_signal_bars) : 0;
          const newCommandBlockedUntil = cloudEq.command_blocked_until ?? null;
          const newLastReading = formatTimestamp(cloudEq.last_communication);
          const newLocalAckAt = (cloudEq as { local_ack_at?: string | null }).local_ack_at ?? null;

          // PERFORMANCE: se nada mudou, devolve o mesmo objeto — evita que
          // PumpTable/WaterBalanceCard/IndicatorsMiniSummary re-renderizem
          // a cada 5s sem motivo. Re-render só ocorre em mudança real.
          const samePendingStart = pending
            ? (p.pendingStartedAt ?? Date.now()) === (p.pendingStartedAt ?? Date.now())
            : p.pendingStartedAt === undefined;
          if (
            p.online === online &&
            p.communicationStatus === communicationStatus &&
            p.running === running &&
            p.pending === pending &&
            samePendingStart &&
            p.lastUserConfirmedAt === nextConfirmedAt &&
            p.actuationOrigin === newActuationOrigin &&
            p.commandBlockedUntil === newCommandBlockedUntil &&
            p.lastCommunication === cloudEq.last_communication &&
            p.lastReading === newLastReading &&
            p.signalRF === newSignalRF &&
            p.localAckAt === newLocalAckAt
          ) {
            return p;
          }

          changed = true;
          return {
            ...p,
            online,
            communicationStatus,
            running,
            pending,
            pendingStartedAt: pending
              ? (p.pendingStartedAt ?? Date.now())
              : undefined,
            lastUserConfirmedAt: nextConfirmedAt,
            actuationOrigin: newActuationOrigin,
            commandBlockedUntil: newCommandBlockedUntil,
            lastCommunication: cloudEq.last_communication,
            lastReading: newLastReading,
            signalRF: newSignalRF,
            voltage: 0,
            current: 0,
            localAckAt: newLocalAckAt,
          };
        });
        return changed ? next : prev;
      });

      // Dispara RPC + notificação + LOG para cada bomba que falhou em obedecer
      for (const lt of localTimeouts) {
        if (lt.pending === "turning_on") {
          void enqueueResetPumpCommand({ equipmentId: lt.equipmentId })
            .then(() => {
              notify.warn("Equipamentos", `${lt.name}: não ligou em 120s — enviado comando 0 para desligar o relé`);
            })
            .catch((error) => {
              console.error("[enqueueResetPumpCommand:auto-timeout]", error);
              notify.fail("Equipamentos", `${lt.name}: falhou ao enviar comando 0 automático`);
            });
          continue;
        }

        // Registra no automation_log como acionamento LOCAL detectado
        // (bomba não obedeceu comando remoto → alguém acionou no painel físico).
        // Sem usuário: não há como saber quem foi (origin "Manual" = local no DB).
        logEvent({
          equipmentId: lt.equipmentId,
          pump: lt.name,
          action: lt.running ? "Ligada" : "Desligada",
          origin: "Manual",
          user: "",
          result: "success",
        });
        // Marca também o ref de "já registrado" para evitar duplicação quando a
        // RPC mark_pump_local_actuation propagar last_actuation_origin=local na
        // próxima leitura da nuvem.
        const cloudEq = cloudPumps.find((e) => e.id === lt.equipmentId);
        if (cloudEq?.last_communication) {
          lastLocalLoggedRef.current.set(
            lt.equipmentId,
            `${lt.running ? "1" : "0"}:${cloudEq.last_communication}`,
          );
        }

        void supabase
          .rpc("mark_pump_local_actuation", {
            _equipment_id: lt.equipmentId,
            _farm_id: lt.farmId,
          })
          .then(({ error }) => {
            if (error) {
              console.error("[mark_pump_local_actuation]", error);
            } else {
              notify.warn("Equipamentos", `${lt.name}: não obedeceu o comando — acionamento local detectado (bloqueado 30s)`);
            }
          });
      }

      // Registra no log toda transição que a nuvem confirmou como Local
      // (acionamento físico no painel detectado pela RPC apply_pump_telemetry).
      for (const lc of localFromCloud) {
        logEvent({
          equipmentId: lc.equipmentId,
          pump: lc.name,
          action: lc.running ? "Ligada" : "Desligada",
          origin: "Manual", // = local no DB
          user: "", // acionamento físico no painel: usuário desconhecido
          result: "success",
        });
        notify.warn("Equipamentos", `${lc.name}: ${lc.running ? "ligada" : "desligada"} localmente no painel físico`);
      }
    };

    tick();
    // Tick adaptativo: 15s em mobile/tablet (iPad), 5s em desktop.
    // Reduz carga do processador no iPad sem prejudicar UX —
    // Realtime ainda atualiza imediato; este tick só re-avalia pending/offline.
    const isMobile = typeof window !== "undefined" && window.innerWidth < 1024;
    const tickMs = isMobile ? 15_000 : 5_000;
    const intervalId = setInterval(tick, tickMs);
    return () => clearInterval(intervalId);
  }, [cloudPumps, cloud.equipments, cloud.plcs, pendingManualByEq]);

  // Tick a cada 5–15s para reavaliar offline mesmo sem novo realtime
  const [reservoirTick, setReservoirTick] = useState(0);
  useEffect(() => {
    const isMobile = typeof window !== "undefined" && window.innerWidth < 1024;
    const tickMs = isMobile ? 15_000 : 5_000;
    const id = setInterval(() => setReservoirTick((n) => n + 1), tickMs);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const plcCount = buildPlcOutputsCountMap(cloud.equipments, cloud.plcs);
    setReservoirs((prev) => {
      const prevById = new Map(prev.map((r) => [r.id, r]));
      let changed = false;
      const next = cloudReservoirs.map((e) => {
        const communicationAt = e.last_communication ?? e.level_last_raw_at;
        const communicationStatus = getReservoirCommunicationStatus(communicationAt, outputsForEquip(e, plcCount));
        const online = communicationStatus !== "offline";

        const old = prevById.get(e.id);
        const lvlMaxNum = Number(e.level_max_meters);
        const maxHNum = Number(e.max_height);
        const maxRef = Number.isFinite(lvlMaxNum) && lvlMaxNum > 0
          ? lvlMaxNum
          : (Number.isFinite(maxHNum) && maxHNum > 0 ? maxHNum : 4.0);
        const cal = calibrateLevel({
          raw: e.level_last_raw,
          cal_digital: e.level_cal_digital,
          cal_meters: e.level_cal_meters,
          max_meters: e.level_max_meters,
          max_height: e.max_height,
        });
        const level = cal.meters !== null ? cal.meters.toFixed(2) : "—";
        const percent = cal.percent !== null ? Math.round(cal.percent) : 0;
        const signalRF = online ? signalBarsToPercent(e.last_signal_bars) : 0;
        const lastReading = formatTimestamp(communicationAt);
        const maxLevel = `${maxRef}m`;

        if (old) {
          // Idempotência: se nada mudou, mantém referência (evita re-render).
          if (
            old.name === e.name &&
            old.percent === percent &&
            old.level === level &&
            old.maxLevel === maxLevel &&
            old.signalRF === signalRF &&
            old.lastReading === lastReading &&
            old.online === online
          ) {
            return old;
          }
          changed = true;
          return { ...old, name: e.name, percent, level, maxLevel, signalRF, lastReading, online };
        }
        changed = true;
        return buildReservoirFromCloud(e, plcCount);
      });
      if (!changed && next.length === prev.length) return prev;
      return next;
    });
  }, [cloudReservoirs, reservoirTick, cloud.equipments]);

  useEffect(() => {
    setPumps((prev) =>
      prev.map((p) => {
        const cmdHist = buildCommandHistory(p.id, p.name, logEntries, 3);
        const stHist = buildStatusHistory(p.id, p.name, logEntries, 3);
        return {
          ...p,
          commandHistory: cmdHist,
          statusHistory: stHist,
          lastCommand: cmdHist[0]
            ? { action: cmdHist[0].action, time: cmdHist[0].time, result: cmdHist[0].result }
            : p.lastCommand,
        };
      }),
    );
  }, [logEntries]);

  // ─── Vazão/Consumo ────────────────────────────────────────────────
  // Enriquece cada Pump com hasFlow/flowRate/dailyConsumption a partir do
  // equipamento tipo 'vazao' que compartilha o mesmo plc_group_id.
  // O totalizador vem do PLC via N2 (m³), gravado por apply_flow_telemetry.
  // Consumo do mês corrente por equipment_id (soma de daily_consumption).
  const [monthByEq, setMonthByEq] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    if (!farmId) return;
    let cancelled = false;
    const load = async () => {
      const today = new Date();
      const first = new Date(today.getFullYear(), today.getMonth(), 1);
      const iso = first.toISOString().slice(0, 10);
      const { data } = await supabase
        .from("daily_consumption")
        .select("equipment_id,total_m3")
        .eq("farm_id", farmId)
        .gte("date", iso);
      if (cancelled) return;
      const map = new Map<string, number>();
      for (const r of (data ?? []) as { equipment_id: string; total_m3: number | null }[]) {
        map.set(r.equipment_id, (map.get(r.equipment_id) ?? 0) + Number(r.total_m3 ?? 0));
      }
      setMonthByEq(map);
    };
    void load();
    const id = window.setInterval(load, 60_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [farmId]);

  useEffect(() => {
    const flowByPlc = new Map<string, { accum: number; daily: number }>();
    for (const e of cloud.equipments) {
      if (e.type !== "vazao" || !e.plc_group_id) continue;
      const accum = Number(e.flow_accum_m3 ?? 0);
      const start = Number(e.flow_daily_start_m3 ?? accum);
      flowByPlc.set(e.plc_group_id, { accum, daily: Math.max(0, accum - start) });
    }
    setPumps((prev) => {
      let changed = false;
      const next = prev.map((p) => {
        const cloudEq = cloud.equipments.find((e) => e.id === p.id);
        const plcId = cloudEq?.plc_group_id ?? null;
        const flow = plcId ? flowByPlc.get(plcId) : undefined;
        const hasFlow = !!flow;
        const flowRate = flow ? `${flow.accum.toLocaleString("pt-BR")} m³` : undefined;
        const dailyConsumption = flow ? `${flow.daily.toLocaleString("pt-BR")} m³` : undefined;

        // Modo Vazão/Consumo direto no equipamento (poço/bomba).
        const vazaoMode = (cloudEq?.vazao_mode ?? "off") as "off" | "estimated" | "real";
        let vazaoAtualM3h = 0;
        if (vazaoMode === "real") {
          vazaoAtualM3h = Number(cloudEq?.flow_rate_m3h ?? 0);
        } else if (vazaoMode === "estimated") {
          vazaoAtualM3h = p.running ? Number(cloudEq?.vazao_cadastrada_m3h ?? 0) : 0;
        }
        const consumoMesM3FromDaily = monthByEq.get(p.id) ?? 0;
        const flowTotalM3 = Number(cloudEq?.flow_total_m3 ?? 0);
        // Consumo do mês = soma dos daily_consumption fechados no mês
        // (cada reset gera uma linha) + o parcial pós-último-reset (flow_total_m3).
        const consumoMesM3 = vazaoMode === "real"
          ? consumoMesM3FromDaily + flowTotalM3
          : consumoMesM3FromDaily;

        if (
          p.hasFlow === hasFlow &&
          p.flowRate === flowRate &&
          p.dailyConsumption === dailyConsumption &&
          p.vazaoMode === vazaoMode &&
          p.vazaoAtualM3h === vazaoAtualM3h &&
          p.consumoMesM3 === consumoMesM3 &&
          p.flowTotalM3 === flowTotalM3
        ) return p;
        changed = true;
        return { ...p, hasFlow, flowRate, dailyConsumption, vazaoMode, vazaoAtualM3h, consumoMesM3, flowTotalM3 };
      });
      return changed ? next : prev;
    });
  }, [cloud.equipments, setPumps, monthByEq]);


  return {
    pumps,
    reservoirs,
    setPumps,
    setReservoirs,
    loading: cloud.loading,
    cloudEquipments: cloud.equipments,
  };
}
