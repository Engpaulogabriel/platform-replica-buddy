-- ============================================================================
-- MANUTENÇÃO BLOQUEIA QUALQUER LIGAR AUTOMÁTICO — regra global.
-- ----------------------------------------------------------------------------
-- VULNERABILIDADE CORRIGIDA
--   `run_peak_hour_tick()` (20260623215447), no ramo de religamento após o
--   horário de ponta, filtrava apenas `e.active = true`. Não olhava
--   `maintenance_mode`. Cenário real: bomba ligada às 18:00 é desligada pelo
--   tick e guardada em `affected_equipment_ids`; às 19:30 entra em manutenção;
--   às 21:00 o tick RELIGA a bomba em manutenção — comando criado, enviado ao
--   agente, ao rádio e à bomba.
--
--   Os outros dois motores (`run_automation_tick`, `run_automacoes_tick`) já
--   verificavam manutenção. Esta migration NÃO os altera.
--
-- DEFESA EM PROFUNDIDADE
--   Camada 1 — o motor pula a bomba em manutenção, cedo, sem exceção e sem spam.
--   Camada 2 — trigger BEFORE INSERT em `public.commands` recusa qualquer LIGAR
--              automático para equipamento em manutenção. Vale para motores que
--              ainda não existem: como não há RPC central de enfileiramento
--              (cada motor faz INSERT direto), o trigger é o único ponto por
--              onde todos passam obrigatoriamente.
--
-- ESCOPO: só LIGAR automático. DESLIGAR, polling, shutdown_all, OFF protetivo e
-- comando MANUAL autenticado seguem exatamente como hoje.
--
-- Não altera cron, Edge Functions, frontend, schedules, automações nem dados.
-- Sem hardcode de fazenda: a regra é global, baseada em `maintenance_mode`.
-- ============================================================================

-- ── CAMADA 1: o motor do horário de ponta ──────────────────────────────────
-- Redefinição integral da função (o Postgres não permite patch parcial). A
-- ÚNICA diferença em relação a 20260623215447 é o bloco MAINTENANCE GUARD no
-- laço de religamento e o contador que o acompanha.
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
BEGIN
  FOR v_cfg IN
    SELECT p.*, f.timezone
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
      END LOOP;

      UPDATE public.peak_hour_config
         SET last_peak_on_at = v_now,
             affected_equipment_ids = ARRAY[]::uuid[]
       WHERE id = v_cfg.id;
    END IF;
  END LOOP;

  off_enqueued := v_off;
  on_enqueued := v_on;
  RETURN NEXT;
END;
$function$;


-- ── CAMADA 2: trava global no INSERT de comandos ───────────────────────────
-- Mesmo padrão arquitetural de `trg_enforce_switching_protection`
-- (20260814210000): BEFORE INSERT em public.commands, RAISE EXCEPTION.
--
-- COMO IDENTIFICA "LIGAR" — estrutura real do frame, sem heurística de texto:
--   O frame é `[TSNN_1_]{PAYLOAD}[TSNN_ETX_]`, eventualmente prefixado por
--   `REP:R3:TX:Rn:` quando vai por repetidor. PAYLOAD é o bitmask produzido por
--   `renov_combined_payload(estado, saida, liga, total)`, que faz
--   `overlay(estado placing '1'/'0' from saida for 1)` — bit 1-based, da
--   esquerda para a direita, um caractere por saída da PLC.
--   Lemos o bit na posição `saida` DO EQUIPAMENTO ALVO (NEW.equipment_id).
--   '1' → este frame liga ESTA bomba. Qualquer outra coisa → não é assunto
--   nosso, e o comando passa.
--
--   Consequência deliberada: num payload combinado que liga a saída 2 enquanto
--   a saída 1 já estava ligada, só a saída 2 é avaliada. Não bloqueamos frame
--   que não esteja ligando a bomba alvo — inclusive porque o bit da irmã apenas
--   reflete o estado físico que já existe.
--
-- POR QUE `type = 'manual'` E NÃO OUTROS TIPOS:
--   POLLING USA O MESMO `_1_` E CARREGA O ESTADO ATUAL como payload. Um poço
--   ligado produz bit '1' num frame de leitura. Bloquear isso derrubaria a
--   comunicação de qualquer PLC com bomba ligada. Comandos de atuação — dos
--   três motores automáticos e do caminho manual — usam `type = 'manual'`;
--   polling usa `type = 'polling'`. Mesmo recorte do trigger de comutação.
--
-- COMO DISTINGUE AUTOMÁTICO DE MANUAL — `auth.uid() IS NULL`:
--   O caminho manual passa obrigatoriamente por `enqueue_remote_command()`, que
--   exige `auth.uid()` ("AUTORIA VEM DAQUI. Nunca do frontend",
--   20260814260000). Os motores automáticos rodam por pg_cron/service_role, sem
--   usuário autenticado. Este critério é mais robusto que uma lista de
--   `source_device` ('cloud-automation', 'peak-hour', 'automacao'), que um motor
--   novo pode simplesmente não usar — e é justamente o bypass que queremos
--   impossibilitar.
CREATE OR REPLACE FUNCTION public.enforce_maintenance_blocks_auto_on()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_maint  boolean;
  v_saida  int;
  v_name   text;
  v_payload text;
  v_bit    text;
BEGIN
  IF NEW.equipment_id IS NULL THEN RETURN NEW; END IF;

  -- Só comandos de ATUAÇÃO. Polling/config/diagnóstico não mudam relé.
  IF NEW.type <> 'manual'::public.command_type THEN RETURN NEW; END IF;

  -- Comando de operador autenticado: comportamento preservado nesta tarefa.
  IF auth.uid() IS NOT NULL THEN RETURN NEW; END IF;

  SELECT e.maintenance_mode, COALESCE(e.saida, 1), e.name
    INTO v_maint, v_saida, v_name
    FROM public.equipments e WHERE e.id = NEW.equipment_id;

  IF NOT COALESCE(v_maint, false) THEN RETURN NEW; END IF;

  -- Payload entre chaves. Tolera o prefixo REP:R3:TX:Rn: do repetidor.
  v_payload := substring(COALESCE(NEW.frame, '') from '\{([01]{1,6})\}');
  IF v_payload IS NULL THEN RETURN NEW; END IF;   -- não é frame de atuação

  IF v_saida < 1 OR v_saida > length(v_payload) THEN RETURN NEW; END IF;
  v_bit := substring(v_payload from v_saida for 1);

  IF v_bit <> '1' THEN RETURN NEW; END IF;        -- desligar, ou não é esta bomba

  RAISE EXCEPTION USING
    ERRCODE = 'check_violation',
    MESSAGE = 'Comando automático de ligar bloqueado: equipamento em manutenção',
    DETAIL  = format('equipment_id=%s nome=%s saida=%s source_device=%s',
                     NEW.equipment_id, COALESCE(v_name,'?'), v_saida,
                     COALESCE(NEW.source_device,'-')),
    HINT    = 'Retire o equipamento do modo manutenção para permitir automação.';
END; $$;

DROP TRIGGER IF EXISTS trg_enforce_maintenance_blocks_auto_on ON public.commands;
CREATE TRIGGER trg_enforce_maintenance_blocks_auto_on
BEFORE INSERT ON public.commands
FOR EACH ROW EXECUTE FUNCTION public.enforce_maintenance_blocks_auto_on();

-- ============================================================================
-- VALIDAÇÃO
--   -- 1) o trigger existe:
--   SELECT tgname, tgenabled FROM pg_trigger
--    WHERE tgrelid = 'public.commands'::regclass AND NOT tgisinternal;
--
--   -- 2) o guard entrou no peak-hour:
--   SELECT prosrc LIKE '%MAINTENANCE GUARD%' AS tem_guard
--     FROM pg_proc WHERE proname = 'run_peak_hour_tick';
--
--   -- 3) bombas em manutenção hoje:
--   SELECT f.name, e.name, e.maintenance_mode FROM public.equipments e
--     JOIN public.farms f ON f.id = e.farm_id WHERE e.maintenance_mode = true;
--
-- ROLLBACK (volta ao estado anterior, REABRINDO a vulnerabilidade):
--   DROP TRIGGER IF EXISTS trg_enforce_maintenance_blocks_auto_on ON public.commands;
--   DROP FUNCTION IF EXISTS public.enforce_maintenance_blocks_auto_on();
--   -- e reaplicar run_peak_hour_tick de 20260623215447.
-- ============================================================================
