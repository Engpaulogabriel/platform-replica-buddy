-- ============================================================================
-- MODO AUTOMÁTICO: evento pendente + idempotência + catch-up limitado.
-- ----------------------------------------------------------------------------
-- INCIDENTE (04/09, SOSSEGO, 21:02–21:06)
--   `automation_engine.enabled = false` para a fazenda. Como
--   `run_automation_tick` faz INNER JOIN com `automation_engine ... enabled=true`,
--   os 8 schedules não foram sequer lidos: nenhum comando, nenhum
--   `automation_execution_log`, nenhum rastro. Esse gate NÃO muda aqui — ele
--   está correto; o que faltava era o dado. (O UPDATE da SOSSEGO é separado.)
--
-- O QUE ESTA MIGRATION CORRIGE — a fragilidade que o incidente expôs:
--
--   1. JANELA DE 2 MINUTOS → VALIDADE DE EVENTO
--      Antes: `v_now_min < v_on_min + 2`. Qualquer indisponibilidade de dois
--      minutos (cron atrasado, Edge fora, pending, bloqueio, conflito com o
--      peak-hour) perdia o horário PARA O DIA INTEIRO, em silêncio.
--      Agora a pergunta é "existe evento de hoje cujo horário já chegou e ainda
--      não foi consumido?". O LIGAR vale até o DESLIGAR do próprio schedule —
--      limite natural do produto: recuperar um ON de 08:00 às 08:04 faz
--      sentido; às 12:10, com time_off 12:00, não faz. Sem time_off, teto de
--      Não há teto de tempo: o LIGAR vale enquanto durar a janela e o DESLIGAR
--      vale enquanto o desired for 'off'.
--
--   2. BLOQUEIO TEMPORÁRIO NÃO CONSOME MAIS O EVENTO
--      `pending_command_id` / `command_blocked_until` faziam o motor sair sem
--      fazer nada e sem registrar. Agora o evento fica DEFERIDO: não marca
--      `last_*_executed_at`, é tentado de novo nos ticks seguintes dentro da
--      validade, e grava UMA linha de auditoria por evento/dia.
--
--   3. IDEMPOTÊNCIA
--      `commands.idempotency_key` = `automation:<schedule>:<equip>:<on|off>:<data>`.
--      Dois ticks concorrentes colidem no índice único e apenas um comando
--      nasce. Reforçado por `pg_try_advisory_xact_lock` no início da função.
--
--   4. PEAK-HOUR
--      Se a bomba já está no estado desejado (o peak-hour religou às 21:00), o
--      evento é consumido como `already_running`, sem segundo comando. Se ainda
--      está bloqueada, o evento é DEFERIDO, não perdido.
--
-- MANUTENÇÃO: regra inalterada e absoluta — `maintenance_mode=true` impede o
-- LIGAR automático, consome o evento do dia (sem catch-up ao sair da
-- manutenção) e permite o DESLIGAR. O bloco é o mesmo de antes.
--
-- AUDITORIA × NOTIFICAÇÃO: as linhas de deferimento entram com
-- `status='skipped'`, que o `whatsapp-automation-notify` NÃO lê (ele busca
-- apenas 'success','expired','failed'). Zero risco de spam.
--
-- ESCOPO: só `run_automation_tick` e a coluna de idempotência. Não toca
-- scheduled-shutdown, peak-hour, WhatsApp, schedules, horários, SEMEAR nem
-- qualquer dado de fazenda.
-- ============================================================================

-- ── Idempotência: a coluna NÃO existe em produção ──────────────────────────
-- `20260814260000_remote_command_authorship_chain.sql` a criaria, mas nunca foi
-- aplicada (confere: `commands` em types.ts, gerado do banco vivo, não tem
-- `idempotency_key`). Criada aqui de forma idempotente; se aquela migration for
-- aplicada depois, os IF NOT EXISTS convivem sem conflito.
ALTER TABLE public.commands
  ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS uq_commands_idempotency
  ON public.commands (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ── PARTIDA ESCALONADA: configuração por fazenda ───────────────────────────
-- Recuperação coletiva (energia, rádio, bridge, agente, reboot) pode deixar
-- várias bombas com desired=ON e physical=OFF ao mesmo tempo. Mandar todos os
-- LIGAR juntos causa pico de corrente, ultrapassagem de demanda e novo
-- desligamento geral. A partida é serializada POR FAZENDA.
--
-- O DEFAULT DE 60s NÃO É ARBITRÁRIO — é o mesmo tempo que a arquitetura já
-- usa como "este comando já teve sua chance":
--   • `enqueue_turn_on_timeout_resets` encerra um ON não confirmado em 60s
--     (20260504225803…sql:42), liberando pending e marcando desired_running=false;
--   • o polling do agente roda a cada 10s (main.cjs:164), então a confirmação
--     física de uma partida bem-sucedida chega bem antes disso;
--   • `command_blocked_until` é de 120s, mas é POR EQUIPAMENTO — não serializa
--     entre bombas diferentes, por isso precisa desta trava de fazenda.
-- Em 60s, portanto, ou a bomba confirmou, ou o timeout já foi encerrado de
-- forma conhecida. É o menor intervalo que satisfaz "confirmação OU timeout"
-- sem inventar número novo. Bombas maiores podem exigir 90–180s: por isso é
-- configurável por fazenda, e ajustável pela interface depois.
-- GRUPO, não "uma por vez": quantas bombas podem partir juntas depende da
-- infraestrutura elétrica, da demanda contratada e da potência dos motores —
-- é decisão de cada fazenda, não do código.
--
-- DEFAULTS: batch_size = 1 e stagger = 60s. Escolhi o mais conservador de
-- propósito, para que uma fazenda nova nunca parta em grupo antes de alguém
-- decidir que ela aguenta. NÃO derivo o batch da quantidade de bombas: 12
-- bombas pequenas num ramal reforçado toleram mais partidas simultâneas que 4
-- motores grandes num ramal fraco. A sugestão por porte (≤5 → 1; 6–15 → 2 ou 3;
-- 16+ → 3 ou 4) fica como orientação para a interface, NÃO como regra automática.
ALTER TABLE public.farms
  ADD COLUMN IF NOT EXISTS automatic_start_stagger_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS automatic_start_stagger_seconds int NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS automatic_start_batch_size int NOT NULL DEFAULT 1;

COMMENT ON COLUMN public.farms.automatic_start_stagger_enabled IS
  'Modo Automático: partida escalonada ligada/desligada para esta fazenda.';
COMMENT ON COLUMN public.farms.automatic_start_stagger_seconds IS
  'Modo Automático: intervalo mínimo entre GRUPOS de partida da mesma fazenda.';
-- Marcador da TENTATIVA REAL de partida. A UI conta os 15 min a partir daqui —
-- de quando o motor efetivamente comandou, NÃO de quando a bomba entrou na
-- fila. Quem espera a vez nunca fica vermelho.
ALTER TABLE public.equipments
  ADD COLUMN IF NOT EXISTS automatic_on_attempt_since timestamptz;
COMMENT ON COLUMN public.equipments.automatic_on_attempt_since IS
  'Modo Automático: início da tentativa de partida ainda não confirmada. NULL = sem tentativa.';

COMMENT ON COLUMN public.farms.automatic_start_batch_size IS
  'Modo Automático: bombas por grupo de partida. 1 = uma por vez. Configurável por fazenda.';


-- ── O CORAÇÃO DO MODO AUTOMÁTICO ───────────────────────────────────────────
-- `automatic_desired_state` responde a ÚNICA pergunta que importa:
--   "QUAL DEVERIA SER O ESTADO DESTA BOMBA AGORA?"
--
-- Não é "houve um evento de ligar que posso recuperar por X minutos". Não há
-- CATCHUP_MAX_MIN: enquanto estivermos DENTRO da janela ON, o desired é ON, e o
-- reconciliador continua responsável — voltando a energia às 03:00 de uma
-- janela 23:00→17:00, a bomba religa, mesmo 4 horas depois do time_on.
--
-- JANELA QUE ATRAVESSA A MEIA-NOITE: o ciclo pertence ao dia em que COMEÇA.
-- Com 23:00→17:00 e segunda marcada, o ciclo vai de segunda 23:00 a terça
-- 17:00 — e às 03:00 de terça a checagem olha o dow de SEGUNDA (`_dow_prev`).
--
-- Retorna: 'on', 'off' ou NULL (schedule não governa este instante).
CREATE OR REPLACE FUNCTION public.automatic_desired_state(
  _time_on text, _time_off text, _days text[], _mode text,
  _now_min int, _dow_today text, _dow_prev text
) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  v_on  int;
  v_off int;
  v_hoje boolean;
  v_ontem boolean;
BEGIN
  IF _time_on  ~ '^\d{2}:\d{2}' THEN
    v_on := (split_part(_time_on,':',1))::int * 60 + (split_part(_time_on,':',2))::int;
  END IF;
  IF _time_off ~ '^\d{2}:\d{2}' THEN
    v_off := (split_part(_time_off,':',1))::int * 60 + (split_part(_time_off,':',2))::int;
  END IF;

  v_hoje  := _dow_today = ANY(COALESCE(_days, '{}'));
  v_ontem := _dow_prev  = ANY(COALESCE(_days, '{}'));

  -- Sem horário de ligar: o schedule só desliga.
  IF v_on IS NULL THEN
    IF v_off IS NOT NULL AND v_hoje AND _now_min >= v_off THEN RETURN 'off'; END IF;
    RETURN NULL;
  END IF;

  -- Sem horário de desligar: vale do time_on até o fim do dia local.
  IF v_off IS NULL THEN
    IF v_hoje AND _now_min >= v_on THEN RETURN 'on'; END IF;
    RETURN NULL;
  END IF;

  IF v_on < v_off THEN
    -- Janela comum, dentro do mesmo dia: 08:00 → 17:00.
    IF NOT v_hoje THEN RETURN NULL; END IF;
    IF _now_min >= v_on AND _now_min < v_off THEN RETURN 'on'; END IF;
    IF _now_min >= v_off THEN RETURN 'off'; END IF;
    RETURN NULL;                       -- antes do time_on: não governa
  ELSE
    -- Janela que atravessa a meia-noite: 23:00 → 17:00 (do dia seguinte).
    IF v_hoje AND _now_min >= v_on THEN RETURN 'on'; END IF;   -- ciclo começou hoje
    IF v_ontem AND _now_min < v_off THEN RETURN 'on'; END IF;  -- ciclo começou ontem
    IF v_ontem AND _now_min >= v_off THEN RETURN 'off'; END IF;
    RETURN NULL;
  END IF;
END; $$;

COMMENT ON FUNCTION public.automatic_desired_state(text,text,text[],text,int,text,text) IS
  'Modo Automático: estado desejado AGORA. Sem catch-up por tempo — vale a janela.';


-- ── SLOT DE PARTIDA AUTOMÁTICA — controle por ESTADO, não por tempo ────────
-- Conta as TENTATIVAS AUTOMÁTICAS DE LIGAR ainda NÃO RESOLVIDAS da fazenda.
--
-- POR QUE EXISTE
--   A V4 limitava grupos por tempo (`created_at > now() - stagger`). Como o
--   safety do agente só desarma o relé em 120s e o stagger padrão é 60s, a
--   segunda bomba podia receber `1` enquanto a primeira ainda estava com o relé
--   possivelmente MANTIDO em 1 (o comando é de nível, não pulso). Numa falta de
--   energia — com PLC e rádio vivos no solar e os motores parados — isso
--   acumulava relés armados, e todos partiriam juntos no retorno da rede.
--
-- O ESTADO É DERIVADO, sem coluna nova. O contrato dos dados vem do agente:
--   • TIMEOUT SERIAL (~13s): NÃO marca a linha. `main.cjs` é explícito —
--     "Não marcar falha física aos 8s... O comando segue como `sent`" — e ARMA
--     o safety. Logo, `status='sent'` + `responded_at IS NULL` = tentativa
--     AINDA ABERTA. O slot continua ocupado. (Requisito: 13s não libera slot.)
--   • SAFETY (120s): marca `status='timeout'` + `responded_at`. Só então o relé
--     foi desarmado por TX inverso. Tentativa RESOLVIDA → libera.
--   • CONFIRMAÇÃO: RX casando marca `status='executed'` + `responded_at`.
--     Tentativa RESOLVIDA → libera.
--   • PLC responde OFF (motor não partiu): o reforço segue até o safety fechar
--     em 120s, caindo no caso acima.
--
-- COMANDO ÓRFÃO: se o agente morrer entre o TX e o safety, o timer de 120s vive
-- só no processo e morre junto. A linha fica 'sent' para sempre — `cleanup_stale_data`
-- só apaga status terminal, nunca 'sent'. Um teto de TEMPO resolveria isso, e era
-- o que a versão anterior fazia: aos 300s a linha saía da contagem mesmo em
-- 'sent'/responded_at NULL, sem ninguém ter desarmado nada. Isso é exatamente o
-- relé potencialmente armado que esta V5 existe para impedir — só que 300s depois.
--
-- TEMPO NÃO LIBERA NADA. A única saída do comando órfão é EVIDÊNCIA FÍSICA:
-- uma leitura da PLC POSTERIOR ao último reforço (45s) dizendo que o bit da saída
-- está em '0'. Aí o relé comprovadamente não está armado e o slot cai.
--
-- Sem leitura nova, o slot fica preso — e esse é o lado seguro: com o agente mudo
-- nenhuma partida sairia mesmo, então travar a fila não custa irrigação; destravar
-- no escuro custa um banco de relés armado. Quando o agente volta, o polling volta
-- com ele e a evidência chega em um ciclo.
DROP FUNCTION IF EXISTS public.count_automatic_start_slots_in_use(uuid, int);

CREATE OR REPLACE FUNCTION public.count_automatic_start_slots_in_use(
  _farm_id uuid, _settle_seconds int DEFAULT 60
) RETURNS int
-- VOLATILE, não STABLE: o laço insere as partidas dentro da MESMA transação e a
-- contagem precisa enxergá-las. Com STABLE o Postgres reusa o snapshot do início
-- do statement, a contagem ficaria sempre 0 e o batch nunca fecharia.
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*)::int
    FROM public.commands c
    JOIN public.equipments e ON e.id = c.equipment_id
    -- bit FÍSICO da saída, uma vez só: '1' ligado, '0' desligado, '' desconhecido.
    CROSS JOIN LATERAL (
      SELECT COALESCE(CASE
        WHEN e.last_outputs_state ~ '^[01]{6}$' AND COALESCE(e.saida,1) BETWEEN 1 AND 6
          THEN substring(e.last_outputs_state from COALESCE(e.saida,1) for 1)
        WHEN e.last_outputs_state ~ '^[01]$' THEN e.last_outputs_state
      END, '') AS bit_fisico
    ) fx
   WHERE c.farm_id = _farm_id
     -- ESTA LINHA CONTA UM SLOT: só partida AUTOMÁTICA. Manual do operador,
     -- polling e scheduled-shutdown ficam de fora por construção.
     AND c.source_device IN ('cloud-automation', 'peak-hour')
     -- ESTA LINHA CONTA UM SLOT: só LIGAR. O bit da saída do equipamento no
     -- payload precisa ser '1'. Um OFF nunca ocupa slot.
     -- O payload tem o TAMANHO DA PLC (output_count), não 6. `renov_combined_payload`
     -- já faz `v_pos := LEAST(v_n, saida)`; replicamos o mesmo clamp, senão numa
     -- PLC de 1 saída o bit da bomba de `saida=2` cairia fora da string.
     AND substring(
           substring(COALESCE(c.frame,'') from '\{([01]{1,6})\}')
           from GREATEST(1, LEAST(
             length(COALESCE(substring(COALESCE(c.frame,'') from '\{([01]{1,6})\}'), '')),
             COALESCE(e.saida, 1)))
           for 1) = '1'
     -- ESTA LINHA LIBERA O SLOT: qualquer estado terminal resolve a tentativa.
     -- 'sent'/'pending' = ainda aberta (inclui o timeout serial de 13s, que
     -- main.cjs deixa deliberadamente em 'sent' e resolve no safety de 120s).
     AND c.status IN ('pending', 'sent')
     AND c.responded_at IS NULL
     -- ESTA LINHA LIBERA O SLOT: a bomba já está fisicamente LIGADA — a partida
     -- terminou, o slot cumpriu seu papel.
     AND fx.bit_fisico <> '1'
     -- ESTA LINHA LIBERA O SLOT, e é a ÚNICA saída do comando órfão: a PLC falou
     -- DEPOIS do último reforço e disse '0'. Relé desarmado, comprovado.
     -- Note o que NÃO libera: leitura anterior ao comando (não sabe do comando),
     -- leitura dentro da janela de reforço (pode ser anterior ao TX que pegou),
     -- e ausência de leitura (bit_fisico = '', desconhecido).
     -- Todos os operandos são booleanos não-nulos de propósito: um NULL aqui
     -- viraria NOT NULL = NULL e o Postgres descartaria a linha, liberando o slot
     -- pelo motivo errado.
     AND NOT (
           fx.bit_fisico = '0'
       AND e.last_communication IS NOT NULL
       AND e.last_communication > c.created_at
             + make_interval(secs => GREATEST(COALESCE(_settle_seconds, 60), 60))
     );
$$;

COMMENT ON FUNCTION public.count_automatic_start_slots_in_use(uuid,int) IS
  'Partidas automáticas de LIGAR ainda não resolvidas da fazenda. Slot libera por ESTADO (resolução, ON confirmado, ou leitura física OFF pós-reforço) — NUNCA por tempo decorrido.';

CREATE OR REPLACE FUNCTION public.run_automation_tick()
 RETURNS TABLE(enqueued_count integer, schedules_evaluated integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_enqueued int := 0;
  v_evaluated int := 0;
  v_sched RECORD;
  v_now timestamptz := now();
  v_local_now timestamp;
  v_today date;
  v_timezone text;
  v_dow_idx int;
  v_dow_key_pt text;
  v_dow_key_en text;
  v_dow_keys_pt text[] := ARRAY['dom','seg','ter','qua','qui','sex','sab'];
  v_dow_keys_en text[] := ARRAY['sun','mon','tue','wed','thu','fri','sat'];
  v_holiday_mmdd text;
  v_now_min int;
  v_on_min int;
  v_off_min int;
  v_currently_running boolean;
  v_holiday_cfg RECORD;
  v_effective_on text;
  v_effective_off text;
  v_tsnn text;
  v_plc_total int;
  v_frame text;
  v_lora text;
  v_payload text;
  v_radio text;
  v_via_rep boolean;
  v_new_cmd_id uuid;
  v_today_in_days boolean;
  v_fire_on boolean;
  v_fire_off boolean;
  v_last_on_local date;
  v_last_off_local date;
  v_holidays text[] := ARRAY['01-01','04-21','05-01','09-07','10-12','11-02','11-15','12-25'];
  -- Fim da janela de VALIDADE de cada evento (não mais uma janela de disparo).
  v_desired   text;
  v_dow_prev_en text;
  v_idem      text;
  v_defer     text;
  v_stagger   int;
  v_max_starts int;
  v_starts_in_flight int;
  v_stagger_ok boolean;
  -- Cooldown de RETENTATIVA: quem falhou não retoma o slot imediatamente. Vale
  -- como desempate de ORDEM (vai para o fim), não como bloqueio — se for a
  -- única candidata, ela tenta de novo. 300s = o mesmo backstop do slot.
  v_retry_cooldown_s constant int := 300;
BEGIN
  PERFORM public.enqueue_turn_on_timeout_resets(NULL);
  DELETE FROM public.automation_fired WHERE fired_at < now() - interval '2 days';

  FOR v_sched IN
    SELECT s.*, e.farm_id AS eq_farm, e.hw_id, e.saida, e.last_outputs_state,
           e.pending_command_id, e.command_blocked_until,
           e.plc_group_id, e.type AS eq_type, e.maintenance_mode AS eq_maint, f.timezone,
           COALESCE(pg.output_count, 1) AS plc_total,
           pg.hw_id AS plc_tsnn,
           COALESCE(f.automatic_start_stagger_seconds, 60) AS stagger_s,
           COALESCE(f.automatic_start_batch_size, 1) AS batch_size,
           COALESCE(f.automatic_start_stagger_enabled, true) AS stagger_on,
           e.name AS eq_name
    FROM public.automation_schedules s
    JOIN public.equipments e ON e.id = s.equipment_id
    JOIN public.farms f ON f.id = s.farm_id
    JOIN public.automation_engine ae ON ae.farm_id = s.farm_id AND ae.enabled = true
    LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
    WHERE s.active = true AND e.active = true AND e.type IN ('poco','bombeamento')
    -- ORDEM DETERMINÍSTICA da fila: horário programado mais antigo primeiro,
    -- depois a saída na PLC, depois o id. Sem isso, dois ticks poderiam
    -- escolher bombas diferentes como "a primeira". Um campo de prioridade por
    -- equipamento entraria aqui, à frente de `e.saida`, sem mexer no resto.
    -- ORDEM DA FILA, determinística e JUSTA:
    --   1º) quem NÃO falhou recentemente — uma bomba cuja tentativa acabou de
    --       ser encerrada vai para o FIM, para não retomar o mesmo slot e
    --       causar starvation nas que ainda não tiveram vez;
    --   2º) horário programado mais antigo;
    --   3º) saída na PLC e id como desempate.
    -- Um campo `start_priority` por equipamento entraria entre (1) e (2).
    ORDER BY s.farm_id,
             (EXISTS (SELECT 1 FROM public.commands cf
                       WHERE cf.equipment_id = s.equipment_id
                         AND cf.source_device IN ('cloud-automation','peak-hour')
                         AND cf.idempotency_key LIKE '%:on:%'
                         AND cf.status IN ('timeout','error')
                         AND cf.responded_at > v_now - make_interval(secs => v_retry_cooldown_s))),
             s.time_on NULLS LAST, e.saida NULLS LAST, e.id
  LOOP
    -- TRAVA POR FAZENDA (não global): dois ticks simultâneos não podem dar
    -- partida em duas bombas da MESMA fazenda. Fazendas diferentes seguem em
    -- paralelo — uma nunca espera a outra. `pg_try_advisory_xact_lock` é
    -- reentrante na mesma sessão, então os demais schedules desta fazenda
    -- reaproveitam a trava dentro do mesmo tick.
    IF NOT pg_try_advisory_xact_lock(hashtextextended('auto:' || v_sched.farm_id::text, 0)) THEN
      CONTINUE;
    END IF;

    v_evaluated := v_evaluated + 1;
    v_stagger    := GREATEST(0, COALESCE(v_sched.stagger_s, 60));
    -- Escalonamento desligado → teto efetivamente infinito para esta fazenda.
    v_max_starts := CASE WHEN COALESCE(v_sched.stagger_on, true)
                         THEN GREATEST(1, COALESCE(v_sched.batch_size, 1))
                         ELSE 2147483647 END;
    v_timezone := COALESCE(NULLIF(v_sched.timezone, ''), 'America/Sao_Paulo');
    v_local_now := v_now AT TIME ZONE v_timezone;
    v_today := v_local_now::date;
    v_dow_idx := EXTRACT(DOW FROM v_local_now)::int;
    v_dow_key_pt := v_dow_keys_pt[v_dow_idx + 1];
    v_dow_key_en := v_dow_keys_en[v_dow_idx + 1];
    v_dow_prev_en := v_dow_keys_en[((v_dow_idx + 6) % 7) + 1];
    v_holiday_mmdd := to_char(v_local_now, 'MM-DD');
    v_now_min := EXTRACT(HOUR FROM v_local_now)::int * 60 + EXTRACT(MINUTE FROM v_local_now)::int;

    v_effective_on := v_sched.time_on;
    v_effective_off := v_sched.time_off;

    IF v_holiday_mmdd = ANY(v_holidays) THEN
      SELECT * INTO v_holiday_cfg FROM public.automation_holiday_configs
      WHERE farm_id = v_sched.farm_id AND equipment_id = v_sched.equipment_id LIMIT 1;
      IF FOUND AND v_holiday_cfg.enabled THEN
        IF v_holiday_cfg.mode = 'free-demand' THEN CONTINUE; END IF;
        IF v_holiday_cfg.mode = 'special-schedule' THEN
          v_effective_on := COALESCE(v_holiday_cfg.special_time_on, v_effective_on);
          v_effective_off := COALESCE(v_holiday_cfg.special_time_off, v_effective_off);
        END IF;
      END IF;
    END IF;

    v_today_in_days := v_dow_key_pt = ANY(v_sched.days) OR v_dow_key_en = ANY(v_sched.days);
    IF NOT v_today_in_days THEN CONTINUE; END IF;

    v_on_min := NULL;
    v_off_min := NULL;
    IF v_effective_on ~ '^\d{2}:\d{2}' THEN
      v_on_min := (split_part(v_effective_on,':',1))::int * 60 + (split_part(v_effective_on,':',2))::int;
    END IF;
    IF v_effective_off ~ '^\d{2}:\d{2}' THEN
      v_off_min := (split_part(v_effective_off,':',1))::int * 60 + (split_part(v_effective_off,':',2))::int;
    END IF;

    v_last_on_local := CASE WHEN v_sched.last_on_executed_at IS NULL THEN NULL
                            ELSE (v_sched.last_on_executed_at AT TIME ZONE v_timezone)::date END;
    v_last_off_local := CASE WHEN v_sched.last_off_executed_at IS NULL THEN NULL
                             ELSE (v_sched.last_off_executed_at AT TIME ZONE v_timezone)::date END;

    -- ── ESTADO DESEJADO AGORA (sem catch-up por tempo) ──────────────────
    v_desired := public.automatic_desired_state(
      v_effective_on, v_effective_off, v_sched.days, v_sched.mode,
      v_now_min, v_dow_key_en, v_dow_prev_en);

    -- O motor é RESPONSÁVEL pelo estado enquanto o desired existir. Não há
    -- "evento consumido": se o desired é ON e a bomba está OFF, ele religa —
    -- tenha passado 1 minuto ou 4 horas do time_on.
    v_fire_on  := v_sched.mode <> 'off-only' AND v_desired = 'on';
    v_fire_off := v_sched.mode <> 'on-only'  AND v_desired = 'off';

    IF NOT v_fire_on AND NOT v_fire_off THEN CONTINUE; END IF;

    -- MAINTENANCE GUARD: skip ON when equipment is locked.
    IF v_fire_on AND COALESCE(v_sched.eq_maint, false) = true THEN
      -- MANUTENÇÃO VENCE A PROGRAMAÇÃO, mas NÃO consome o desired.
      -- Antes marcávamos `last_on_executed_at`, o que abandonava o ON para
      -- sempre. Agora, ao remover a manutenção ainda dentro da janela, o
      -- desired continua ON e a bomba volta à reconciliação — que é o
      -- comportamento correto: quem manda é o estado, não o evento.
      INSERT INTO public.automation_execution_log
        (schedule_id, equipment_id, farm_id, action, scheduled_time, executed_at, status, origin, details)
      SELECT v_sched.id, v_sched.equipment_id, v_sched.farm_id, 'liga', v_effective_on, v_now, 'skipped', 'automatico',
             jsonb_build_object('reason','maintenance')
       WHERE NOT EXISTS (
         SELECT 1 FROM public.automation_execution_log l
          WHERE l.schedule_id = v_sched.id AND l.action = 'liga' AND l.status = 'skipped'
            AND (l.details->>'reason') = 'maintenance'
            AND (l.executed_at AT TIME ZONE v_timezone)::date = v_today);
      v_fire_on := false;
    END IF;

    IF v_sched.last_outputs_state ~ '^[01]{6}$' AND COALESCE(v_sched.saida,1) BETWEEN 1 AND 6 THEN
      v_currently_running := substring(v_sched.last_outputs_state from COALESCE(v_sched.saida,1)::int for 1) = '1';
    ELSIF v_sched.last_outputs_state ~ '^[01]$' THEN
      v_currently_running := v_sched.last_outputs_state = '1';
    ELSE
      v_currently_running := false;
    END IF;

    v_tsnn := COALESCE(v_sched.plc_tsnn, substring(v_sched.hw_id from 1 for 4));
    v_plc_total := COALESCE(v_sched.plc_total, 1);

    SELECT COALESCE(radio, 'R1'), COALESCE(via_repetidor, false)
      INTO v_radio, v_via_rep
    FROM public.rf_routing WHERE farm_id = v_sched.farm_id;
    IF v_radio IS NULL THEN v_radio := 'R1'; END IF;
    IF v_via_rep IS NULL THEN v_via_rep := false; END IF;

    -- ── PARTIDA ESCALONADA ───────────────────────────────────────────────
    -- Conta as partidas automáticas em voo NESTA fazenda. Uma partida ocupa o
    -- slot enquanto não vencer o stagger: em 60s (default) ou a bomba já
    -- confirmou fisicamente, ou `enqueue_turn_on_timeout_resets` já encerrou o
    -- comando. Isso satisfaz "esperar confirmação OU timeout conhecido" sem
    -- máquina de estados extra — e garante que a fila NUNCA trave: passado o
    -- stagger, a próxima bomba anda mesmo que a anterior tenha falhado.
    -- ── SLOT POR ESTADO (V5) ─────────────────────────────────────────────
    -- Antes: contava comandos criados dentro da janela de stagger — tempo.
    -- Agora: conta tentativas AINDA NÃO RESOLVIDAS — estado. O tempo deixou de
    -- proteger contra relé armado; quem protege é o estado da tentativa.
    v_starts_in_flight := 0;
    IF v_fire_on AND v_currently_running = false THEN
      v_starts_in_flight := public.count_automatic_start_slots_in_use(v_sched.farm_id);
    END IF;

    -- STAGGER: agora é gate ADICIONAL, aplicado DEPOIS do slot — nunca no
    -- lugar dele. Nunca mais "passaram 60s, então libero mesmo com a anterior
    -- ainda STARTING".
    v_stagger_ok := true;
    IF v_fire_on AND v_currently_running = false
       AND COALESCE(v_sched.stagger_on, true) AND v_stagger > 0 THEN
      SELECT NOT EXISTS (
        SELECT 1 FROM public.commands c2
         WHERE c2.farm_id = v_sched.farm_id
           AND c2.source_device IN ('cloud-automation', 'peak-hour')
           AND c2.idempotency_key LIKE '%:on:%'
           -- `< v_now` exclui as partidas criadas NESTE MESMO tick: o stagger
           -- separa GRUPOS, não bombas dentro do mesmo grupo. Sem isto, com
           -- batch=3 só a primeira bomba sairia.
           AND c2.created_at < v_now
           AND c2.created_at > v_now - make_interval(secs => v_stagger)
      ) INTO v_stagger_ok;
    END IF;

    IF v_fire_on
       AND v_currently_running = false
       AND v_sched.pending_command_id IS NULL
       AND (v_sched.command_blocked_until IS NULL OR v_sched.command_blocked_until <= v_now)
       AND v_starts_in_flight < v_max_starts
       AND v_stagger_ok
    THEN
      -- IDEMPOTÊNCIA: um evento lógico (schedule + equipamento + ação + dia
      -- local) produz NO MÁXIMO um comando. Dois ticks concorrentes colidem no
      -- índice único e o segundo não insere.
      v_idem := 'automation:' || v_sched.id || ':' || v_sched.equipment_id
                -- Bucket de MINUTO, não de dia: dois ticks no mesmo minuto
                -- colidem (é o que queremos), mas o minuto seguinte pode
                -- tentar de novo. Com bucket diário, uma partida falha
                -- bloquearia a bomba pelo resto do dia.
                || ':on:' || to_char(v_local_now, 'YYYY-MM-DD HH24:MI');

      v_payload := public.renov_combined_payload(v_sched.last_outputs_state, COALESCE(v_sched.saida, 1), true, v_plc_total);
      v_lora := '[' || v_tsnn || '_1_]{' || v_payload || '}[' || v_tsnn || '_ETX_]' || E'\r';
      v_frame := CASE WHEN v_via_rep THEN 'REP:R3:TX:' || v_radio || ':' || v_lora ELSE v_lora END;

      INSERT INTO public.commands (farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device, idempotency_key)
      VALUES (v_sched.farm_id, v_sched.equipment_id, v_tsnn, 'manual', 1, v_frame, 120000, 'cloud-automation', v_idem)
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
      RETURNING id INTO v_new_cmd_id;

      IF v_new_cmd_id IS NOT NULL THEN
        UPDATE public.equipments
        SET pending_command_id = v_new_cmd_id,
            command_blocked_until = v_now + interval '120 seconds',
            desired_running = true,
            automatic_on_attempt_since = COALESCE(automatic_on_attempt_since, v_now),
            last_actuation_origin = 'automatico',
            updated_at = v_now
        WHERE id = v_sched.equipment_id AND pending_command_id IS NULL;

        UPDATE public.automation_schedules SET last_on_executed_at = v_now WHERE id = v_sched.id;

        INSERT INTO public.automation_execution_log
          (schedule_id, equipment_id, farm_id, action, scheduled_time, executed_at, status, origin, details)
        VALUES (v_sched.id, v_sched.equipment_id, v_sched.farm_id, 'liga', v_effective_on, v_now, 'success', 'automatico',
                jsonb_build_object('command_id', v_new_cmd_id, 'idempotency_key', v_idem,
                                   'late_minutes', v_now_min - v_on_min));

        v_enqueued := v_enqueued + 1;
      ELSE
        -- Outro tick já criou este evento. Consome sem duplicar.
        UPDATE public.automation_schedules SET last_on_executed_at = v_now WHERE id = v_sched.id;
      END IF;

    ELSIF v_fire_on AND v_currently_running = true THEN
      -- Já está no estado desejado (inclusive quando o peak-hour ligou antes).
      -- Evento CONSUMIDO, sem novo comando.
      -- Confirmada: limpa o marcador para o AUTO sair do vermelho sozinho.
      UPDATE public.equipments SET automatic_on_attempt_since = NULL
       WHERE id = v_sched.equipment_id AND automatic_on_attempt_since IS NOT NULL;
      UPDATE public.automation_schedules SET last_on_executed_at = v_now WHERE id = v_sched.id;
      -- UMA linha por dia: com estado desejado este ramo roda a cada tick.
      INSERT INTO public.automation_execution_log
        (schedule_id, equipment_id, farm_id, action, scheduled_time, executed_at, status, origin, details)
      SELECT v_sched.id, v_sched.equipment_id, v_sched.farm_id, 'liga', v_effective_on, v_now, 'skipped', 'automatico',
             jsonb_build_object('reason','already_running')
       WHERE NOT EXISTS (
         SELECT 1 FROM public.automation_execution_log l
          WHERE l.schedule_id = v_sched.id AND l.action = 'liga' AND l.status = 'skipped'
            AND (l.details->>'reason') = 'already_running'
            AND (l.executed_at AT TIME ZONE v_timezone)::date = v_today);

    ELSIF v_fire_on THEN
      -- BLOQUEIO TEMPORÁRIO (pending_command / command_blocked_until).
      -- NÃO consome o evento: ele continua válido e será tentado de novo nos
      -- próximos ticks, enquanto estiver dentro da validade. Era exatamente
      -- aqui que o motor saía sem fazer nada e sem deixar rastro.
      v_defer := CASE
                   WHEN v_sched.pending_command_id IS NOT NULL THEN 'pending_command'
                   WHEN v_sched.command_blocked_until IS NOT NULL
                        AND v_sched.command_blocked_until > v_now THEN 'command_blocked'
                   -- Aguardando vaga na fila de partida da fazenda. NÃO é
                   -- falha: a bomba deve aparecer como "AUTO · Aguardando
                   -- partida", nunca em vermelho.
                   ELSE 'waiting_start_slot' END;
      -- UMA linha de auditoria por evento/dia — sem spam a cada minuto.
      -- status='skipped' NÃO é lido pelo notificador de WhatsApp, que busca
      -- apenas ('success','expired','failed'): auditoria técnica separada de
      -- notificação operacional.
      IF NOT EXISTS (
        SELECT 1 FROM public.automation_execution_log l
         WHERE l.schedule_id = v_sched.id AND l.action = 'liga'
           AND l.status = 'skipped' AND (l.details->>'reason') = v_defer
           AND (l.executed_at AT TIME ZONE v_timezone)::date = v_today
      ) THEN
        INSERT INTO public.automation_execution_log
          (schedule_id, equipment_id, farm_id, action, scheduled_time, executed_at, status, origin, details)
        VALUES (v_sched.id, v_sched.equipment_id, v_sched.farm_id, 'liga', v_effective_on, v_now, 'skipped', 'automatico',
                jsonb_build_object('reason', v_defer, 'deferred', true,
                                   'desired', v_desired,
                                   'starts_in_flight', v_starts_in_flight,
                                   'batch_size', v_max_starts,
                                   'stagger_seconds', v_stagger));
      END IF;
    END IF;

    IF v_fire_off
       AND v_currently_running = true
       AND v_sched.pending_command_id IS NULL
       AND (v_sched.command_blocked_until IS NULL OR v_sched.command_blocked_until <= v_now)
    THEN
      -- IDEMPOTÊNCIA: um evento lógico (schedule + equipamento + ação + dia
      -- local) produz NO MÁXIMO um comando. Dois ticks concorrentes colidem no
      -- índice único e o segundo não insere.
      v_idem := 'automation:' || v_sched.id || ':' || v_sched.equipment_id
                || ':off:' || to_char(v_local_now, 'YYYY-MM-DD HH24:MI');

      v_payload := public.renov_combined_payload(v_sched.last_outputs_state, COALESCE(v_sched.saida, 1), false, v_plc_total);
      v_lora := '[' || v_tsnn || '_1_]{' || v_payload || '}[' || v_tsnn || '_ETX_]' || E'\r';
      v_frame := CASE WHEN v_via_rep THEN 'REP:R3:TX:' || v_radio || ':' || v_lora ELSE v_lora END;

      INSERT INTO public.commands (farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device, idempotency_key)
      VALUES (v_sched.farm_id, v_sched.equipment_id, v_tsnn, 'manual', 1, v_frame, 120000, 'cloud-automation', v_idem)
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
      RETURNING id INTO v_new_cmd_id;

      IF v_new_cmd_id IS NOT NULL THEN
        UPDATE public.equipments
        SET pending_command_id = v_new_cmd_id,
            command_blocked_until = v_now + interval '120 seconds',
            desired_running = false,
            last_actuation_origin = 'automatico',
            updated_at = v_now
        WHERE id = v_sched.equipment_id AND pending_command_id IS NULL;

        UPDATE public.automation_schedules SET last_off_executed_at = v_now WHERE id = v_sched.id;

        INSERT INTO public.automation_execution_log
          (schedule_id, equipment_id, farm_id, action, scheduled_time, executed_at, status, origin, details)
        VALUES (v_sched.id, v_sched.equipment_id, v_sched.farm_id, 'desliga', v_effective_off, v_now, 'success', 'automatico',
                jsonb_build_object('command_id', v_new_cmd_id, 'idempotency_key', v_idem,
                                   'late_minutes', v_now_min - v_off_min));

        v_enqueued := v_enqueued + 1;
      ELSE
        -- Outro tick já criou este evento. Consome sem duplicar.
        UPDATE public.automation_schedules SET last_off_executed_at = v_now WHERE id = v_sched.id;
      END IF;

    ELSIF v_fire_off AND v_currently_running = false THEN
      -- Já está no estado desejado (inclusive quando o peak-hour ligou antes).
      -- Evento CONSUMIDO, sem novo comando.
      UPDATE public.automation_schedules SET last_off_executed_at = v_now WHERE id = v_sched.id;
      INSERT INTO public.automation_execution_log
        (schedule_id, equipment_id, farm_id, action, scheduled_time, executed_at, status, origin, details)
      SELECT v_sched.id, v_sched.equipment_id, v_sched.farm_id, 'desliga', v_effective_off, v_now, 'skipped', 'automatico',
             jsonb_build_object('reason','already_stopped')
       WHERE NOT EXISTS (
         SELECT 1 FROM public.automation_execution_log l
          WHERE l.schedule_id = v_sched.id AND l.action = 'desliga' AND l.status = 'skipped'
            AND (l.details->>'reason') = 'already_stopped'
            AND (l.executed_at AT TIME ZONE v_timezone)::date = v_today);

    ELSIF v_fire_off THEN
      -- BLOQUEIO TEMPORÁRIO (pending_command / command_blocked_until).
      -- NÃO consome o evento: ele continua válido e será tentado de novo nos
      -- próximos ticks, enquanto estiver dentro da validade. Era exatamente
      -- aqui que o motor saía sem fazer nada e sem deixar rastro.
      v_defer := CASE WHEN v_sched.pending_command_id IS NOT NULL
                      THEN 'pending_command' ELSE 'command_blocked' END;
      -- UMA linha de auditoria por evento/dia — sem spam a cada minuto.
      -- status='skipped' NÃO é lido pelo notificador de WhatsApp, que busca
      -- apenas ('success','expired','failed'): auditoria técnica separada de
      -- notificação operacional.
      IF NOT EXISTS (
        SELECT 1 FROM public.automation_execution_log l
         WHERE l.schedule_id = v_sched.id AND l.action = 'desliga'
           AND l.status = 'skipped' AND (l.details->>'reason') = v_defer
           AND (l.executed_at AT TIME ZONE v_timezone)::date = v_today
      ) THEN
        INSERT INTO public.automation_execution_log
          (schedule_id, equipment_id, farm_id, action, scheduled_time, executed_at, status, origin, details)
        VALUES (v_sched.id, v_sched.equipment_id, v_sched.farm_id, 'desliga', v_effective_off, v_now, 'skipped', 'automatico',
                jsonb_build_object('reason', v_defer, 'deferred', true));
      END IF;
    END IF;

  END LOOP;

  enqueued_count := v_enqueued;
  schedules_evaluated := v_evaluated;
  RETURN NEXT;
END;
$function$;


-- ============================================================================
-- PEAK-HOUR: MESMO TETO DE PARTIDA AUTOMÁTICA
-- ----------------------------------------------------------------------------
-- Base: a versão VIGENTE de `run_peak_hour_tick`, de
-- `20260902120000_maintenance_blocks_automatic_turn_on.sql` — a que já contém a
-- trava de manutenção. Ela foi lida integralmente e reproduzida aqui; o
-- MAINTENANCE GUARD está PRESERVADO palavra por palavra (há teste de
-- não-regressão que falha se ele sumir).
--
-- ÚNICA adição: o religamento pós-ponta passa a consultar o mesmo
-- `automatic_start_batch_size` / `automatic_start_stagger_seconds` da fazenda.
-- Quem não couber no grupo permanece em `affected_equipment_ids` e religa no
-- ciclo seguinte — nada se perde, nada parte junto. Enquanto sobrar fila,
-- `last_peak_on_at` não é marcado, então o tick seguinte continua o grupo.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.run_peak_hour_tick()
RETURNS TABLE(off_enqueued integer, on_enqueued integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cfg RECORD;
  v_eq RECORD;
  v_now timestamptz := now();
  v_tz text;
  v_local timestamp;
  v_local_date date;
  v_hhmm text;
  v_start text;
  v_end text;
  v_in_window boolean;
  v_should_off boolean;
  v_should_on boolean;
  v_off int := 0;
  v_on int := 0;
  v_currently_running boolean;
  v_tsnn text;
  v_plc_total int;
  v_payload text;
  v_lora text;
  v_frame text;
  v_radio text;
  v_via_rep boolean;
  v_new_cmd_id uuid;
  v_affected uuid[];
  v_skipped_maint int := 0;
  v_stagger int;
  v_batch   int;
  v_in_flight int;
  v_started_now int := 0;
BEGIN
  FOR v_cfg IN
    SELECT p.*, f.timezone,
           COALESCE(f.automatic_start_stagger_seconds, 60) AS stagger_s,
           CASE WHEN COALESCE(f.automatic_start_stagger_enabled, true)
                THEN GREATEST(1, COALESCE(f.automatic_start_batch_size, 1))
                ELSE 2147483647 END AS batch_size
      FROM public.peak_hour_config p
      JOIN public.farms f ON f.id = p.farm_id
     WHERE p.enabled = true
  LOOP
    v_tz := COALESCE(NULLIF(v_cfg.timezone,''), 'America/Sao_Paulo');
    v_local := v_now AT TIME ZONE v_tz;
    v_local_date := v_local::date;
    v_hhmm := to_char(v_local, 'HH24:MI');
    v_start := to_char(v_cfg.start_time, 'HH24:MI');
    v_end := to_char(v_cfg.end_time, 'HH24:MI');

    -- Should fire OFF? local time has just crossed start_time, and not yet acted today
    v_should_off := (v_hhmm >= v_start AND v_hhmm < v_end)
                    AND (v_cfg.last_peak_off_at IS NULL
                         OR (v_cfg.last_peak_off_at AT TIME ZONE v_tz)::date < v_local_date);

    -- Should fire ON? local time has crossed end_time, auto_restart, and not yet acted today
    v_should_on := v_cfg.auto_restart
                   AND v_hhmm >= v_end
                   AND (v_cfg.last_peak_on_at IS NULL
                        OR (v_cfg.last_peak_on_at AT TIME ZONE v_tz)::date < v_local_date)
                   AND v_cfg.last_peak_off_at IS NOT NULL
                   AND (v_cfg.last_peak_off_at AT TIME ZONE v_tz)::date = v_local_date;

    IF NOT v_should_off AND NOT v_should_on THEN
      CONTINUE;
    END IF;

    -- Resolve RF routing
    SELECT COALESCE(radio,'R1'), COALESCE(via_repetidor,false)
      INTO v_radio, v_via_rep
      FROM public.rf_routing WHERE farm_id = v_cfg.farm_id;
    IF v_radio IS NULL THEN v_radio := 'R1'; END IF;
    IF v_via_rep IS NULL THEN v_via_rep := false; END IF;

    IF v_should_off THEN
      v_affected := ARRAY[]::uuid[];
      FOR v_eq IN
        SELECT e.*, COALESCE(pg.output_count,1) AS plc_total, pg.hw_id AS plc_tsnn
          FROM public.equipments e
          LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
         WHERE e.farm_id = v_cfg.farm_id
           AND e.active = true
           AND e.type IN ('poco','bombeamento')
           AND NOT (e.id = ANY(COALESCE(v_cfg.excluded_equipment_ids, ARRAY[]::uuid[])))
      LOOP
        IF v_eq.last_outputs_state ~ '^[01]{6}$' AND COALESCE(v_eq.saida,1) BETWEEN 1 AND 6 THEN
          v_currently_running := substring(v_eq.last_outputs_state from COALESCE(v_eq.saida,1)::int for 1) = '1';
        ELSIF v_eq.last_outputs_state ~ '^[01]$' THEN
          v_currently_running := v_eq.last_outputs_state = '1';
        ELSE
          v_currently_running := false;
        END IF;

        IF NOT v_currently_running THEN CONTINUE; END IF;
        IF v_eq.pending_command_id IS NOT NULL THEN CONTINUE; END IF;
        IF v_eq.command_blocked_until IS NOT NULL AND v_eq.command_blocked_until > v_now THEN CONTINUE; END IF;

        v_tsnn := COALESCE(v_eq.plc_tsnn, substring(v_eq.hw_id from 1 for 4));
        v_plc_total := COALESCE(v_eq.plc_total, 1);
        v_payload := public.renov_combined_payload(v_eq.last_outputs_state, COALESCE(v_eq.saida,1), false, v_plc_total);
        v_lora := '[' || v_tsnn || '_1_]{' || v_payload || '}[' || v_tsnn || '_ETX_]' || E'\r';
        v_frame := CASE WHEN v_via_rep THEN 'REP:R3:TX:' || v_radio || ':' || v_lora ELSE v_lora END;

        INSERT INTO public.commands (farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device)
        VALUES (v_cfg.farm_id, v_eq.id, v_tsnn, 'manual', 1, v_frame, 120000, 'peak-hour')
        RETURNING id INTO v_new_cmd_id;

        UPDATE public.equipments
           SET pending_command_id = v_new_cmd_id,
               command_blocked_until = v_now + interval '120 seconds',
               desired_running = false,
               updated_at = v_now
         WHERE id = v_eq.id AND pending_command_id IS NULL;

        v_affected := array_append(v_affected, v_eq.id);
        v_off := v_off + 1;
      END LOOP;

      UPDATE public.peak_hour_config
         SET last_peak_off_at = v_now,
             affected_equipment_ids = v_affected
       WHERE id = v_cfg.id;
    END IF;

    IF v_should_on THEN
      v_affected := ARRAY[]::uuid[];   -- quem não couber no grupo fica para o próximo
      -- TETO ÚNICO DE PARTIDA AUTOMÁTICA POR FAZENDA. O mesmo
      -- `automatic_start_batch_size` que governa o reconciliador do Modo
      -- Automático governa também o religamento pós-ponta: não existem dois
      -- tetos. Sem isto, o peak-hour podia soltar 10 partidas sozinho enquanto
      -- o reconciliador respeitava o limite — somando corrente sem que nenhum
      -- dos dois soubesse do outro.
      v_stagger := GREATEST(0, COALESCE(v_cfg.stagger_s, 60));
      v_batch   := GREATEST(1, COALESCE(v_cfg.batch_size, 1));
      -- MESMO contador por ESTADO do reconciliador. Um único teto por fazenda:
      -- se o AUTO já tem `batch_size` tentativas abertas, o peak-hour espera.
      v_in_flight := public.count_automatic_start_slots_in_use(v_cfg.farm_id);
      v_started_now := 0;

      FOR v_eq IN
        SELECT e.*, COALESCE(pg.output_count,1) AS plc_total, pg.hw_id AS plc_tsnn
          FROM public.equipments e
          LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
         WHERE e.id = ANY(COALESCE(v_cfg.affected_equipment_ids, ARRAY[]::uuid[]))
           AND e.active = true
      LOOP
        -- MAINTENANCE GUARD (Camada 1). Bomba em manutenção NUNCA religa.
        -- CONSUMIDO, não adiado: não entra em v_still_pending, então quando a
        -- manutenção sair não há religamento tardio (mesma política de
        -- run_automation_tick, que marca last_on_executed_at ao pular).
        IF COALESCE(v_eq.maintenance_mode, false) = true THEN
          v_skipped_maint := v_skipped_maint + 1;
          CONTINUE;
        END IF;
        IF v_eq.last_outputs_state ~ '^[01]{6}$' AND COALESCE(v_eq.saida,1) BETWEEN 1 AND 6 THEN
          v_currently_running := substring(v_eq.last_outputs_state from COALESCE(v_eq.saida,1)::int for 1) = '1';
        ELSIF v_eq.last_outputs_state ~ '^[01]$' THEN
          v_currently_running := v_eq.last_outputs_state = '1';
        ELSE
          v_currently_running := false;
        END IF;

        IF v_currently_running THEN CONTINUE; END IF;
        IF v_eq.pending_command_id IS NOT NULL THEN CONTINUE; END IF;
        IF v_eq.command_blocked_until IS NOT NULL AND v_eq.command_blocked_until > v_now THEN CONTINUE; END IF;

        -- Teto de partidas: as que ainda não couberam permanecem em
        -- `affected_equipment_ids` e são religadas no próximo ciclo, dentro do
        -- grupo seguinte. Nada é perdido, nada parte junto.
        IF (v_in_flight + v_started_now) >= v_batch THEN
          v_affected := array_append(v_affected, v_eq.id);
          CONTINUE;
        END IF;

        v_tsnn := COALESCE(v_eq.plc_tsnn, substring(v_eq.hw_id from 1 for 4));
        v_plc_total := COALESCE(v_eq.plc_total, 1);
        v_payload := public.renov_combined_payload(v_eq.last_outputs_state, COALESCE(v_eq.saida,1), true, v_plc_total);
        v_lora := '[' || v_tsnn || '_1_]{' || v_payload || '}[' || v_tsnn || '_ETX_]' || E'\r';
        v_frame := CASE WHEN v_via_rep THEN 'REP:R3:TX:' || v_radio || ':' || v_lora ELSE v_lora END;

        INSERT INTO public.commands (farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device)
        VALUES (v_cfg.farm_id, v_eq.id, v_tsnn, 'manual', 1, v_frame, 120000, 'peak-hour')
        RETURNING id INTO v_new_cmd_id;

        UPDATE public.equipments
           SET pending_command_id = v_new_cmd_id,
               command_blocked_until = v_now + interval '120 seconds',
               desired_running = true,
               updated_at = v_now
         WHERE id = v_eq.id AND pending_command_id IS NULL;

        v_on := v_on + 1;
        v_started_now := v_started_now + 1;
      END LOOP;

      -- Só encerra o ciclo quando NÃO sobrou ninguém na fila. Se sobrou, o
      -- `last_peak_on_at` NÃO é marcado e o próximo tick continua o grupo
      -- seguinte — o religamento pós-ponta vira escalonado, não simultâneo.
      IF array_length(v_affected, 1) IS NULL THEN
        UPDATE public.peak_hour_config
           SET last_peak_on_at = v_now, affected_equipment_ids = ARRAY[]::uuid[]
         WHERE id = v_cfg.id;
      ELSE
        UPDATE public.peak_hour_config
           SET affected_equipment_ids = v_affected
         WHERE id = v_cfg.id;
      END IF;
    END IF;
  END LOOP;

  off_enqueued := v_off;
  on_enqueued := v_on;
  RETURN NEXT;
END;
$function$;

