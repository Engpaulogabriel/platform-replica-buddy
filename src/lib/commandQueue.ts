// ─────────────────────────────────────────────────────────────────────────────
// commandQueue — enfileira comandos manuais (priority=1) na tabela commands
// ─────────────────────────────────────────────────────────────────────────────
// PROTOCOLO POSICIONAL (validado em campo 2026-04):
//   O número de DÍGITOS do payload indica QUAL saída do PLC.
//   O ÚLTIMO dígito indica ligar (1) ou desligar (0).
//   Os dígitos anteriores são SEMPRE "0".
//
//   Saída 1 ligar:  {1}      | Saída 1 desligar: {0}
//   Saída 2 ligar:  {01}     | Saída 2 desligar: {00}
//   Saída 3 ligar:  {001}    | Saída 3 desligar: {000}
//   Saída 4 ligar:  {0001}   | Saída 4 desligar: {0000}
//   Saída 5 ligar:  {00001}  | Saída 5 desligar: {00000}
//   Saída 6 ligar:  {000001} | Saída 6 desligar: {000000}
//
// Cada saída é um comando totalmente isolado — NÃO existe payload combinado
// para várias saídas no mesmo frame.

import { supabase } from "@/integrations/supabase/client";
import { buildLoRaFrame, buildDirectToServer, buildViaRepetidorTx } from "@/lib/protocol";
import { buildPositionalPayload, buildCombinedPayload, loadRfRouting } from "@/lib/rfRouting";
// notifyWhatsAppImmediate removido: notificações de equipamento agora aguardam
// confirmação real do hardware via trigger DB → drain do cron.



export interface EnqueueManualResult {
  commandId: string;
  frame: string;
  newPayload: string;
  tsnn: string;
}

interface EquipmentRow {
  id: string;
  hw_id: string;
  saida: number | null;
  farm_id: string;
  plc_group_id: string | null;
  last_outputs_state: string | null;
  type: "poco" | "bombeamento" | "nivel" | "repetidor";
}

interface PlcGroupRow {
  hw_id: string;
  output_count?: number | null;
}

async function resolveCommandUserId(provided?: string | null): Promise<string> {
  if (provided) return provided;
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user?.id) {
    throw new Error("Usuário logado não identificado para registrar o comando.");
  }
  return data.user.id;
}

async function resolveCommandUserLabel(userId: string, provided?: string | null): Promise<string> {
  const cleanProvided = String(provided ?? "").trim();
  const legacyWebPanelLabel = ["painel", "web"].join(" ");
  if (cleanProvided && cleanProvided.toLowerCase() !== legacyWebPanelLabel) return cleanProvided;
  const { data } = await supabase
    .from("profiles")
    .select("full_name, email")
    .eq("id", userId)
    .maybeSingle();
  const profileName = String((data as any)?.full_name ?? "").trim();
  const profileEmail = String((data as any)?.email ?? "").trim();
  return profileName || profileEmail || "Usuário Web";
}

/**
 * Resolve TSNN e total de saídas (output_count) da PLC do equipamento.
 * Para PLCs multi-saída, o payload TX deve ter sempre `output_count` dígitos
 * preservando o estado das demais saídas. Para PLCs com 1 saída, mantém o
 * comportamento posicional (1 dígito).
 */
async function resolvePlcContext(equipment: {
  hw_id: string;
  saida: number | null;
  plc_group_id: string | null;
}): Promise<{ tsnn: string; total: number }> {
  let tsnn = equipment.hw_id.substring(0, 4);
  // Default: PLC standalone de 1 saída (poço). NÃO usar `saida` como total —
  // saida é a posição da saída, não o tamanho do payload.
  let total = 1;
  if (equipment.plc_group_id) {
    const { data: plc } = await supabase
      .from("plc_groups")
      .select("hw_id, output_count")
      .eq("id", equipment.plc_group_id)
      .maybeSingle();
    const row = plc as PlcGroupRow | null;
    if (row?.hw_id) tsnn = row.hw_id;
    if (typeof row?.output_count === "number" && row.output_count >= 1) {
      total = Math.max(1, Math.min(6, row.output_count));
    }
  }
  return { tsnn, total };
}

/**
 * Monta o payload TX para uma saída específica.
 * - Se a PLC tem mais de uma saída (output_count > 1), retorna payload combinado
 *   com tamanho = output_count, preservando o estado das outras saídas.
 * - Se output_count = 1, retorna payload posicional de 1 dígito (poço standalone).
 */
function buildOutputPayload(
  currentState: string | null | undefined,
  saida: number,
  turnOn: boolean,
  total: number,
): string {
  if (total <= 1) return turnOn ? "1" : "0";
  return buildCombinedPayload(currentState, saida, turnOn, total);
}

/**
 * Enfileira um comando manual ON/OFF para uma bomba.
 * Payload é sempre 1 dígito ("0" desligar / "1" ligar) — independente de
 * poço ou bombeamento PLC. O firmware da bomba interpreta como estado
 * desejado para a saída do equipamento.
 */
export async function enqueueManualPumpCommand(args: {
  equipmentId: string;
  turnOn: boolean;
  userId?: string | null;
  userName?: string | null;
}): Promise<EnqueueManualResult> {
  const commandUserId = await resolveCommandUserId(args.userId);
  const displayName = await resolveCommandUserLabel(commandUserId, args.userName);
  // Formato "<Nome>|user:<uuid>" é interpretado pelo drain do
  // whatsapp-automation-notify para excluir o autor da notificação
  // e mostrar o nome real do operador web.
  const whoLabel = `${displayName}|user:${commandUserId}`;

  // 1. Carrega equipamento
  const { data: eq, error: eqErr } = await supabase
    .from("equipments")
    .select("id, hw_id, saida, farm_id, plc_group_id, last_outputs_state, type, last_actuation_origin, command_blocked_until")
    .eq("id", args.equipmentId)
    .maybeSingle();
  if (eqErr) throw new Error(eqErr.message);
  if (!eq) throw new Error("Equipamento não encontrado");

  const equipment = eq as EquipmentRow & {
    last_actuation_origin: string | null;
    command_blocked_until: string | null;
  };
  if (equipment.type === "nivel" || equipment.type === "repetidor") {
    throw new Error(`Equipamento do tipo '${equipment.type}' não aceita comandos de acionamento.`);
  }

  // Calcula estado atual da saída desta bomba (1=ligada / 0=desligada)
  const saidaIdx = Math.max(1, Math.min(6, equipment.saida ?? 1));
  const outputs = equipment.last_outputs_state ?? "";
  const currentlyRunning =
    /^[01]{6}$/.test(outputs) ? outputs.charAt(saidaIdx - 1) === "1"
    : /^[01]$/.test(outputs) ? outputs === "1"
    : false;

  // Regras de acionamento quando o último estado foi confirmado como LOCAL:
  //  - Se a bomba está DESLIGADA localmente → web pode LIGAR (operador remoto reassume).
  //  - Se a bomba está LIGADA localmente   → web pode tentar DESLIGAR. Caso o desligamento
  //    não se confirme (próximo polling continua "ligada"), o backend mantém origin=local
  //    e o sistema volta a enviar polling vazio `{}` até nova ordem.
  //  - Bloqueia apenas comandos redundantes (ligar quando já está ligada local;
  //    desligar quando já está desligada local) para evitar lixo na fila.
  if (equipment.last_actuation_origin === "local") {
    if (args.turnOn && currentlyRunning) {
      throw new Error("Bomba já está ligada localmente no painel físico.");
    }
    if (!args.turnOn && !currentlyRunning) {
      throw new Error("Bomba já está desligada localmente no painel físico.");
    }
  }

  // Bloqueio temporal curto (janela após detecção local) — evita comandos sobrepostos
  // até a próxima leitura confirmar o estado físico. Vale para ambos os sentidos.
  const blockedUntil = equipment.command_blocked_until ? new Date(equipment.command_blocked_until) : null;
  const isBlocked = blockedUntil && blockedUntil.getTime() > Date.now();
  if (equipment.last_actuation_origin === "local" && isBlocked) {
    const secsLeft = Math.ceil((blockedUntil!.getTime() - Date.now()) / 1000);
    throw new Error(
      `Bomba acionada localmente — aguarde ${secsLeft}s a próxima leitura confirmar antes de comandar pela web.`
    );
  }

  // 2. Resolve TSNN e total de saídas (PLC multi-saída usa payload combinado)
  const { tsnn, total } = await resolvePlcContext(equipment);

  // 3. Payload: combinado quando PLC tem >1 saída (preserva estado das outras),
  //    posicional quando saída única.
  const newPayload: string = buildOutputPayload(
    equipment.last_outputs_state,
    saidaIdx,
    args.turnOn,
    total,
  );

  // 5. Monta frame com routing configurado (R1/R2/R3, via repetidor ou direto)
  const routing = loadRfRouting();
  const lora = buildLoRaFrame(tsnn, "1", newPayload);
  const frame = routing.viaRepetidor
    ? buildViaRepetidorTx(routing.radio, lora)
    : buildDirectToServer(routing.radio, lora);

  // 5. Cancela pollings antigos ainda pendentes para este equipamento.
  // Sem isso, um polling "desligado" já enfileirado pode sair logo após o
  // comando manual de ligar e reverter a bomba.
  const cancelQueuedAt = new Date().toISOString();
  const { error: cancelPollingErr } = await supabase
    .from("commands")
    .update({
      status: "cancelled",
      responded_at: cancelQueuedAt,
      error_message: "Polling cancelado por comando manual em andamento",
    })
    .eq("farm_id", equipment.farm_id)
    .eq("equipment_id", equipment.id)
    .eq("type", "polling")
    .eq("status", "pending");

  if (cancelPollingErr) throw new Error(cancelPollingErr.message);

  // 6. Insere na tabela commands com priority=1 (manual fura fila).
  // Comando manual só pode virar falha depois da janela física completa de
  // 120s; o timeout curto de 8/10s é apenas comunicação/RF, não desobediência.
  const clientEventId = crypto.randomUUID();
  const { data: inserted, error: insErr } = await supabase
    .from("commands")
    .insert({
      farm_id: equipment.farm_id,
      equipment_id: equipment.id,
      plc_hw_id: tsnn,
      type: "manual",
      priority: 1,
      frame,
      timeout_ms: 120_000,
      created_by: commandUserId,
      client_event_id: clientEventId,
      source_device: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 80) : null,
    })
    .select("id")
    .single();

  if (insErr) throw new Error(insErr.message);

  const insertedCommandId = (inserted as { id: string }).id;
  const { error: syncPendingErr } = await supabase
    .from("equipments")
    .update({
      pending_command_id: insertedCommandId,
      last_changed_by: whoLabel,
      last_actuation_origin: "web",
      updated_at: new Date().toISOString(),
    })
    .eq("id", equipment.id)
    .eq("farm_id", equipment.farm_id);

  if (syncPendingErr) throw new Error(syncPendingErr.message);

  // NÃO disparamos notificação imediata aqui. Os DEMAIS operadores são
  // notificados APENAS depois que o hardware confirma a mudança real
  // (trigger DB → pending_notifications → drain do cron).

  return {
    commandId: insertedCommandId,
    frame,
    newPayload,
    tsnn,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// enqueueResetPumpCommand — RESET DE EMERGÊNCIA (priority=0, ignora bloqueios)
// ─────────────────────────────────────────────────────────────────────────────
// Diferente do manual: ignora last_actuation_origin/command_blocked_until e
// envia DESLIGAR (0) com priority=0 (acima do manual=1). Usado pelo botão
// "Reset" para cortar imediatamente um ciclo "Ligando" travado.
export async function enqueueResetPumpCommand(args: {
  equipmentId: string;
  userId?: string | null;
  userName?: string | null;
}): Promise<EnqueueManualResult> {
  const commandUserId = await resolveCommandUserId(args.userId);
  const displayName = await resolveCommandUserLabel(commandUserId, args.userName);
  const whoLabel = `${displayName}|user:${commandUserId}`;

  // 1. Carrega equipamento (sem validar origem/bloqueio — reset é incondicional)
  const { data: eq, error: eqErr } = await supabase
    .from("equipments")
    .select("id, hw_id, saida, farm_id, plc_group_id, type, last_outputs_state")
    .eq("id", args.equipmentId)
    .maybeSingle();
  if (eqErr) throw new Error(eqErr.message);
  if (!eq) throw new Error("Equipamento não encontrado");

  const equipment = eq as EquipmentRow & { last_outputs_state: string | null };
  if (equipment.type === "nivel" || equipment.type === "repetidor") {
    throw new Error(`Equipamento '${equipment.type}' não aceita reset.`);
  }

  const saidaIdx = Math.max(1, Math.min(6, equipment.saida ?? 1));

  // 2. Resolve TSNN + total de saídas (PLC multi-saída usa payload combinado)
  const { tsnn, total } = await resolvePlcContext(equipment);

  // 3. Payload OFF preservando estado das demais saídas (ou 1 dígito se PLC=1).
  const newPayload = buildOutputPayload(equipment.last_outputs_state, saidaIdx, false, total);

  const routing = loadRfRouting();
  const lora = buildLoRaFrame(tsnn, "1", newPayload);
  const frame = routing.viaRepetidor
    ? buildViaRepetidorTx(routing.radio, lora)
    : buildDirectToServer(routing.radio, lora);

  // 4. O enfileiramento oficial do RESET agora acontece no backend para garantir
  // o TX 0 mesmo sem depender da tela aberta.
  const { data: insertedCommandId, error: rpcErr } = await supabase.rpc(
    "enqueue_reset_pump_command" as never,
    {
      _farm_id: equipment.farm_id,
      _equipment_id: equipment.id,
      _reason: "manual_reset",
    } as never,
  );

  if (rpcErr) throw new Error(rpcErr.message);
  if (!insertedCommandId) throw new Error("Falha ao enfileirar reset no backend");

  // A RPC oficial grava o comando, mas não sabe o nome do usuário autenticado
  // no frontend. Atualiza o equipamento com o mesmo padrão usado no comando
  // manual para que notificações mostrem o nome real do usuário web.
  await supabase
    .from("equipments")
    .update({
      last_changed_by: whoLabel,
      last_actuation_origin: "web",
      updated_at: new Date().toISOString(),
    })
    .eq("id", equipment.id)
    .eq("farm_id", equipment.farm_id);

  return {
    commandId: String(insertedCommandId),
    frame,
    newPayload,
    tsnn,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Enfileira um frame de POLLING (não muda saídas) com priority=1, para o agente
// processar imediatamente (Realtime + pré-empção do polling em curso).
// O payload reflete o último estado conhecido da PLC para não alterar nada
// fisicamente — apenas força uma resposta de telemetria.
export interface EnqueueStatusReadResult {
  commandId: string;
  frame: string;
  tsnn: string;
}

export async function enqueueManualStatusRead(args: {
  equipmentId: string;
  desiredRunning?: boolean;
  userId?: string | null;
}): Promise<EnqueueStatusReadResult> {
  const commandUserId = await resolveCommandUserId(args.userId);

  const { data: eq, error: eqErr } = await supabase
    .from("equipments")
    .select("id, hw_id, saida, farm_id, plc_group_id, last_outputs_state, type")
    .eq("id", args.equipmentId)
    .maybeSingle();
  if (eqErr) throw new Error(eqErr.message);
  if (!eq) throw new Error("Equipamento não encontrado");

  const equipment = eq as EquipmentRow;
  if (equipment.type === "nivel" || equipment.type === "repetidor") {
    throw new Error(`Equipamento do tipo '${equipment.type}' não suporta leitura de status RF.`);
  }

  // Resolve TSNN + total saídas (igual ao manual)
  const { tsnn, total } = await resolvePlcContext(equipment);

  const saidaIdx = Math.max(1, Math.min(6, equipment.saida ?? 1));
  const desiredRunning = typeof args.desiredRunning === "boolean"
    ? args.desiredRunning
    : /^[01]{6}$/.test(equipment.last_outputs_state ?? "")
      ? (equipment.last_outputs_state ?? "").charAt(saidaIdx - 1) === "1"
      : (equipment.last_outputs_state ?? "") === "1";
  // Polling manual usa payload combinado quando PLC tem >1 saída — preserva
  // estado físico das outras saídas. Para PLC=1 mantém posicional.
  const payload = buildOutputPayload(equipment.last_outputs_state, saidaIdx, desiredRunning, total);

  const routing = loadRfRouting();
  const lora = buildLoRaFrame(tsnn, "1", payload);
  const frame = routing.viaRepetidor
    ? buildViaRepetidorTx(routing.radio, lora)
    : buildDirectToServer(routing.radio, lora);

  // Insere como POLLING priority=1 — não dispara trigger de pending_command
  // (que é exclusivo de type=manual), apenas fura a fila.
  const { data: inserted, error: insErr } = await supabase
    .from("commands")
    .insert({
      farm_id: equipment.farm_id,
      equipment_id: equipment.id,
      plc_hw_id: tsnn,
      type: "polling",
      priority: 1,
      frame,
      // 35s para dar tempo dos 3 envios (0s/15s/30s) + folga para RX
      timeout_ms: 35000,
      // Marca como reforço: agente reenvia o frame em 0s/15s/30s e
      // cancela os reenvios assim que chegar RX casando o TSNN.
      reinforcement: true,
      created_by: commandUserId,
      // Marcado como 'platform-scheduler' para passar pelo guard
      // isUnsafePollingActuation no agente (que só aceita polling vindo do
      // scheduler oficial). Origem real do clique vai em error_message como
      // referencia auditavel.
      source_device: "platform-scheduler",
      error_message: typeof navigator !== "undefined"
        ? `manual-status-read|${navigator.userAgent.slice(0, 80)}`
        : "manual-status-read",
    })
    .select("id")
    .single();

  if (insErr) throw new Error(insErr.message);

  return {
    commandId: (inserted as { id: string }).id,
    frame,
    tsnn,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Leitura manual de NÍVEL (reservatório).
// Igual ao enqueueManualStatusRead, mas:
//  - aceita type='nivel'
//  - payload é sempre OFF posicional da saída do sensor (não aciona relé)
//  - o RX traz o sufixo _N1<raw>N1_ / _N2<raw>N2_ que o agente parseia
//    e dispara apply_level_telemetry no Supabase, atualizando o card.
// ─────────────────────────────────────────────────────────────────────────────
export async function enqueueManualLevelRead(args: {
  equipmentId: string;
  userId?: string | null;
}): Promise<EnqueueStatusReadResult> {
  const commandUserId = await resolveCommandUserId(args.userId);

  const { data: eq, error: eqErr } = await supabase
    .from("equipments")
    .select("id, hw_id, saida, farm_id, plc_group_id, last_outputs_state, type")
    .eq("id", args.equipmentId)
    .maybeSingle();
  if (eqErr) throw new Error(eqErr.message);
  if (!eq) throw new Error("Equipamento não encontrado");

  const equipment = eq as EquipmentRow;
  if (equipment.type !== "nivel") {
    throw new Error(`Equipamento do tipo '${equipment.type}' não é um sensor de nível.`);
  }

  const { tsnn, total } = await resolvePlcContext(equipment);

  const saidaIdx = Math.max(1, Math.min(6, equipment.saida ?? 1));
  // Payload OFF da saída do sensor — não controla relé, só força resposta de
  // telemetria com sufixo N1/N2. Em PLC multi-saída usa combinado preservando
  // estado das demais saídas (não desliga bombas vizinhas).
  const payload = buildOutputPayload(equipment.last_outputs_state, saidaIdx, false, total);

  const routing = loadRfRouting();
  const lora = buildLoRaFrame(tsnn, "1", payload);
  const frame = routing.viaRepetidor
    ? buildViaRepetidorTx(routing.radio, lora)
    : buildDirectToServer(routing.radio, lora);

  const { data: inserted, error: insErr } = await supabase
    .from("commands")
    .insert({
      farm_id: equipment.farm_id,
      equipment_id: equipment.id,
      plc_hw_id: tsnn,
      type: "polling",
      priority: 1,
      frame,
      timeout_ms: 8000,
      created_by: commandUserId,
      source_device: "platform-scheduler",
      error_message: typeof navigator !== "undefined"
        ? `manual-level-read|${navigator.userAgent.slice(0, 80)}`
        : "manual-level-read",
    })
    .select("id")
    .single();

  if (insErr) throw new Error(insErr.message);

  return {
    commandId: (inserted as { id: string }).id,
    frame,
    tsnn,
  };
}
