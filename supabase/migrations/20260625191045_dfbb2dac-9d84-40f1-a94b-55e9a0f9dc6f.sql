
-- Augmenta automation_execution_history
ALTER TABLE public.automation_execution_history
  ADD COLUMN IF NOT EXISTS farm_id uuid,
  ADD COLUMN IF NOT EXISTS automation_name text,
  ADD COLUMN IF NOT EXISTS trigger_id uuid,
  ADD COLUMN IF NOT EXISTS expected_states jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS verification_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_aeh_verify_pending
  ON public.automation_execution_history (verification_pending, triggered_at)
  WHERE verification_pending = true;

-- Engine de execução das Automações independentes
CREATE OR REPLACE FUNCTION public.run_automacoes_tick()
RETURNS TABLE(fired integer, actions_enqueued integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_now timestamptz := now();
  v_tz text;
  v_local timestamp;
  v_local_date date;
  v_local_hhmm text;
  v_dow_code text;
  v_aut RECORD;
  v_trig RECORD;
  v_act RECORD;
  v_eq RECORD;
  v_peak RECORD;
  v_peak_start_text text;
  v_target_hhmm text;
  v_offset int;
  v_should_fire boolean;
  v_already_today boolean;
  v_fire_ts timestamptz;
  v_fired int := 0;
  v_actions int := 0;
  v_action_set boolean;
  v_eq_ids uuid[];
  v_results jsonb;
  v_one_result jsonb;
  v_all_ok boolean;
  v_tsnn text;
  v_plc_total int;
  v_payload text;
  v_lora text;
  v_frame text;
  v_radio text;
  v_via_rep boolean;
  v_cmd_id uuid;
  v_currently_running boolean;
  v_turn_on boolean;
  v_hist_id uuid;
  v_expected jsonb;
BEGIN
  -- Itera automações ativas
  FOR v_aut IN
    SELECT a.*, f.timezone
      FROM public.automations a
      JOIN public.farms f ON f.id = a.farm_id
     WHERE a.is_active = true
  LOOP
    v_tz := COALESCE(NULLIF(v_aut.timezone,''), 'America/Sao_Paulo');
    v_local := v_now AT TIME ZONE v_tz;
    v_local_date := v_local::date;
    v_local_hhmm := to_char(v_local, 'HH24:MI');
    v_dow_code := CASE EXTRACT(DOW FROM v_local)::int
      WHEN 0 THEN 'dom' WHEN 1 THEN 'seg' WHEN 2 THEN 'ter'
      WHEN 3 THEN 'qua' WHEN 4 THEN 'qui' WHEN 5 THEN 'sex' WHEN 6 THEN 'sab' END;

    -- Avalia cada trigger
    FOR v_trig IN
      SELECT * FROM public.automation_triggers WHERE automation_id = v_aut.id
    LOOP
      v_should_fire := false;
      v_target_hhmm := NULL;

      IF v_trig.trigger_type = 'time' THEN
        IF v_trig.time_value IS NULL THEN CONTINUE; END IF;
        v_target_hhmm := to_char(v_trig.time_value, 'HH24:MI');
        -- Verifica dia da semana
        IF v_trig.days IS NOT NULL AND jsonb_array_length(v_trig.days) > 0 THEN
          IF NOT (v_trig.days ? v_dow_code) THEN CONTINUE; END IF;
        END IF;
        -- Janela: agora >= alvo, e diff <= 15 min, e ainda não disparou hoje
        IF v_local_hhmm < v_target_hhmm THEN CONTINUE; END IF;
        IF extract(epoch FROM (v_local - (v_local_date || ' ' || v_target_hhmm)::timestamp)) > 15*60 THEN CONTINUE; END IF;
        v_already_today := v_trig.last_executed_at IS NOT NULL
                           AND (v_trig.last_executed_at AT TIME ZONE v_tz)::date = v_local_date;
        IF v_already_today THEN CONTINUE; END IF;
        v_should_fire := true;

      ELSIF v_trig.trigger_type = 'condition' THEN
        IF v_trig.condition_type IS NULL THEN CONTINUE; END IF;
        IF v_trig.condition_type IN ('peak_hours_start','peak_hours_end') THEN
          SELECT * INTO v_peak FROM public.peak_hour_config WHERE farm_id = v_aut.farm_id LIMIT 1;
          IF v_peak.id IS NULL OR v_peak.enabled IS NOT true THEN CONTINUE; END IF;
          v_offset := COALESCE(NULLIF(v_trig.condition_value,'')::int, 5);
          IF v_trig.condition_type = 'peak_hours_start' THEN
            v_peak_start_text := to_char(v_peak.start_time, 'HH24:MI');
          ELSE
            v_peak_start_text := to_char(v_peak.end_time, 'HH24:MI');
          END IF;
          v_target_hhmm := to_char(
            ((v_local_date || ' ' || v_peak_start_text)::timestamp - (v_offset || ' minutes')::interval),
            'HH24:MI'
          );
          IF v_local_hhmm < v_target_hhmm THEN CONTINUE; END IF;
          IF extract(epoch FROM (v_local - (v_local_date || ' ' || v_target_hhmm)::timestamp)) > 15*60 THEN CONTINUE; END IF;
          v_already_today := v_trig.last_executed_at IS NOT NULL
                             AND (v_trig.last_executed_at AT TIME ZONE v_tz)::date = v_local_date;
          IF v_already_today THEN CONTINUE; END IF;
          v_should_fire := true;
        ELSE
          -- level_* não implementado nesta fase
          CONTINUE;
        END IF;

      ELSIF v_trig.trigger_type = 'delay' THEN
        IF v_trig.scheduled_for IS NULL THEN CONTINUE; END IF;
        IF v_trig.last_executed_at IS NOT NULL THEN CONTINUE; END IF;
        IF v_now < v_trig.scheduled_for THEN CONTINUE; END IF;
        IF extract(epoch FROM (v_now - v_trig.scheduled_for)) > 15*60 THEN
          -- expirou
          UPDATE public.automation_triggers SET last_executed_at = v_now WHERE id = v_trig.id;
          INSERT INTO public.automation_execution_history
            (automation_id, trigger_id, farm_id, automation_name, triggered_at, actions_executed, all_success, expected_states)
          VALUES
            (v_aut.id, v_trig.id, v_aut.farm_id, v_aut.name, v_now,
             jsonb_build_array(jsonb_build_object('status','expired','reason','janela de 15 min excedida')),
             false, '[]'::jsonb);
          INSERT INTO public.automation_audit_log
            (automation_id, farm_id, event_type, performed_via, scheduled_time, actual_execution_time, result_details, notes)
          VALUES (v_aut.id, v_aut.farm_id, 'expired', 'automation_engine',
                  to_char(v_trig.scheduled_for, 'YYYY-MM-DD HH24:MI'), v_now,
                  jsonb_build_object('reason','15 min window exceeded'), 'Disparo expirou');
          IF v_aut.type = 'one_time' OR v_trig.execute_once THEN
            UPDATE public.automations SET is_active = false WHERE id = v_aut.id;
          END IF;
          CONTINUE;
        END IF;
        v_target_hhmm := to_char(v_trig.scheduled_for AT TIME ZONE v_tz, 'HH24:MI');
        v_should_fire := true;
      END IF;

      IF NOT v_should_fire THEN CONTINUE; END IF;

      -- Resolve routing por fazenda
      SELECT COALESCE(radio,'R1'), COALESCE(via_repetidor,false)
        INTO v_radio, v_via_rep
        FROM public.rf_routing WHERE farm_id = v_aut.farm_id;
      IF v_radio IS NULL THEN v_radio := 'R1'; END IF;
      IF v_via_rep IS NULL THEN v_via_rep := false; END IF;

      v_fire_ts := v_now;
      v_results := '[]'::jsonb;
      v_expected := '[]'::jsonb;
      v_all_ok := true;
      v_action_set := false;

      -- Itera ações da automação
      FOR v_act IN
        SELECT * FROM public.automation_actions WHERE automation_id = v_aut.id ORDER BY "order" ASC
      LOOP
        v_action_set := true;
        v_turn_on := v_act.action = 'liga';

        -- Resolve equipamentos: vazio = todos da fazenda (poços/bombeamento)
        IF v_act.equipment_ids IS NULL OR jsonb_array_length(v_act.equipment_ids) = 0 THEN
          v_eq_ids := ARRAY(SELECT id FROM public.equipments
                            WHERE farm_id = v_aut.farm_id AND active = true
                              AND type IN ('poco','bombeamento'));
        ELSE
          v_eq_ids := ARRAY(SELECT (jsonb_array_elements_text(v_act.equipment_ids))::uuid);
        END IF;

        FOR v_eq IN
          SELECT e.*, COALESCE(pg.output_count,1) AS plc_total, pg.hw_id AS plc_tsnn
            FROM public.equipments e
            LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
           WHERE e.id = ANY(v_eq_ids) AND e.active = true
        LOOP
          -- Pula manutenção
          IF v_eq.maintenance_mode = true THEN
            v_results := v_results || jsonb_build_array(jsonb_build_object(
              'equipment_id', v_eq.id, 'equipment_name', v_eq.name,
              'action', v_act.action, 'status','skipped','reason','manutencao'));
            v_all_ok := false;
            CONTINUE;
          END IF;
          -- Pula offline (sem heartbeat recente)
          IF v_eq.last_communication IS NULL
             OR v_eq.last_communication < v_now - interval '180 seconds' THEN
            v_results := v_results || jsonb_build_array(jsonb_build_object(
              'equipment_id', v_eq.id, 'equipment_name', v_eq.name,
              'action', v_act.action, 'status','failed','reason','offline'));
            v_all_ok := false;
            CONTINUE;
          END IF;
          -- Pula se já tem comando pendente
          IF v_eq.pending_command_id IS NOT NULL THEN
            v_results := v_results || jsonb_build_array(jsonb_build_object(
              'equipment_id', v_eq.id, 'equipment_name', v_eq.name,
              'action', v_act.action, 'status','skipped','reason','pendente'));
            CONTINUE;
          END IF;
          -- Verifica estado atual
          IF v_eq.last_outputs_state ~ '^[01]{6}$' AND COALESCE(v_eq.saida,1) BETWEEN 1 AND 6 THEN
            v_currently_running := substring(v_eq.last_outputs_state from COALESCE(v_eq.saida,1)::int for 1) = '1';
          ELSIF v_eq.last_outputs_state ~ '^[01]$' THEN
            v_currently_running := v_eq.last_outputs_state = '1';
          ELSE
            v_currently_running := false;
          END IF;
          -- Já está no estado desejado
          IF v_currently_running = v_turn_on THEN
            v_results := v_results || jsonb_build_array(jsonb_build_object(
              'equipment_id', v_eq.id, 'equipment_name', v_eq.name,
              'action', v_act.action, 'status','already','reason','estado_ja_correto'));
            CONTINUE;
          END IF;

          v_tsnn := COALESCE(v_eq.plc_tsnn, substring(v_eq.hw_id from 1 for 4));
          v_plc_total := COALESCE(v_eq.plc_total, 1);
          v_payload := public.renov_combined_payload(v_eq.last_outputs_state, COALESCE(v_eq.saida,1), v_turn_on, v_plc_total);
          v_lora := '[' || v_tsnn || '_1_]{' || v_payload || '}[' || v_tsnn || '_ETX_]' || E'\r';
          v_frame := CASE WHEN v_via_rep THEN 'REP:R3:TX:' || v_radio || ':' || v_lora ELSE v_lora END;

          INSERT INTO public.commands (farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device)
          VALUES (v_aut.farm_id, v_eq.id, v_tsnn, 'manual', 1, v_frame, 120000, 'automacao')
          RETURNING id INTO v_cmd_id;

          UPDATE public.equipments
             SET pending_command_id = v_cmd_id,
                 command_blocked_until = v_now + interval '120 seconds',
                 desired_running = v_turn_on,
                 updated_at = v_now
           WHERE id = v_eq.id AND pending_command_id IS NULL;

          v_actions := v_actions + 1;
          v_results := v_results || jsonb_build_array(jsonb_build_object(
            'equipment_id', v_eq.id, 'equipment_name', v_eq.name,
            'action', v_act.action, 'status','sent','command_id', v_cmd_id));
          v_expected := v_expected || jsonb_build_array(jsonb_build_object(
            'equipment_id', v_eq.id, 'equipment_name', v_eq.name, 'expected_running', v_turn_on));
        END LOOP;
      END LOOP;

      IF NOT v_action_set THEN CONTINUE; END IF;

      v_fired := v_fired + 1;
      UPDATE public.automation_triggers SET last_executed_at = v_fire_ts WHERE id = v_trig.id;

      INSERT INTO public.automation_execution_history
        (automation_id, trigger_id, farm_id, automation_name, triggered_at, actions_executed, all_success, expected_states, verification_pending)
      VALUES
        (v_aut.id, v_trig.id, v_aut.farm_id, v_aut.name, v_fire_ts, v_results, v_all_ok, v_expected,
         (jsonb_array_length(v_expected) > 0))
      RETURNING id INTO v_hist_id;

      INSERT INTO public.automation_audit_log
        (automation_id, farm_id, event_type, performed_via, scheduled_time, actual_execution_time, result_details)
      VALUES (v_aut.id, v_aut.farm_id, 'executed', 'automation_engine',
              v_target_hhmm, v_fire_ts, v_results);

      -- Encadeia notificação WhatsApp via automation_execution_log existente.
      -- Cada equipamento atingido vira uma linha, agrupada pelo notify por scheduled_time/action.
      -- O notify formata pelo automation_name quando details->>'automation_name' está presente.
      FOR v_one_result IN SELECT * FROM jsonb_array_elements(v_results)
      LOOP
        IF (v_one_result->>'status') IN ('sent','failed','skipped','already') THEN
          INSERT INTO public.automation_execution_log
            (schedule_id, equipment_id, farm_id, action, scheduled_time, executed_at, status, origin, details, failure_reason)
          VALUES (
            v_aut.id,
            NULLIF(v_one_result->>'equipment_id','')::uuid,
            v_aut.farm_id,
            v_one_result->>'action',
            v_target_hhmm,
            v_fire_ts,
            CASE WHEN v_one_result->>'status' IN ('sent','already') THEN 'success' ELSE 'failed' END,
            'automacao',
            jsonb_build_object(
              'automation_id', v_aut.id,
              'automation_name', v_aut.name,
              'history_id', v_hist_id,
              'inner_status', v_one_result->>'status',
              'equipment_name', v_one_result->>'equipment_name'),
            v_one_result->>'reason'
          );
        END IF;
      END LOOP;

      -- Encerra automações one_time
      IF v_aut.type = 'one_time' OR v_trig.execute_once THEN
        UPDATE public.automations SET is_active = false WHERE id = v_aut.id;
      END IF;

    END LOOP;
  END LOOP;

  RETURN QUERY SELECT v_fired, v_actions;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.run_automacoes_tick() TO service_role;
