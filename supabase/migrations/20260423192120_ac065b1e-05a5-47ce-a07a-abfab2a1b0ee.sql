-- ─────────────────────────────────────────────────────────────────────────────
-- Motor de automação na nuvem
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) automation_schedules: programações de bombas
CREATE TABLE IF NOT EXISTS public.automation_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  equipment_id uuid NOT NULL REFERENCES public.equipments(id) ON DELETE CASCADE,
  active boolean NOT NULL DEFAULT true,
  mode text NOT NULL DEFAULT 'both' CHECK (mode IN ('both','on-only','off-only')),
  days text[] NOT NULL DEFAULT '{}',
  time_on text NOT NULL,
  time_off text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);

CREATE INDEX IF NOT EXISTS automation_schedules_farm_eq_idx
  ON public.automation_schedules(farm_id, equipment_id);

CREATE INDEX IF NOT EXISTS automation_schedules_active_idx
  ON public.automation_schedules(farm_id) WHERE active;

ALTER TABLE public.automation_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY automation_schedules_select_members
  ON public.automation_schedules FOR SELECT
  TO authenticated
  USING (public.has_farm_access(auth.uid(), farm_id));

CREATE POLICY automation_schedules_insert_writers
  ON public.automation_schedules FOR INSERT
  TO authenticated
  WITH CHECK (public.can_write_farm(auth.uid(), farm_id));

CREATE POLICY automation_schedules_update_writers
  ON public.automation_schedules FOR UPDATE
  TO authenticated
  USING (public.can_write_farm(auth.uid(), farm_id))
  WITH CHECK (public.can_write_farm(auth.uid(), farm_id));

CREATE POLICY automation_schedules_delete_writers
  ON public.automation_schedules FOR DELETE
  TO authenticated
  USING (public.can_write_farm(auth.uid(), farm_id));

CREATE TRIGGER automation_schedules_touch
  BEFORE UPDATE ON public.automation_schedules
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 2) automation_holiday_configs
CREATE TABLE IF NOT EXISTS public.automation_holiday_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  equipment_id uuid NOT NULL REFERENCES public.equipments(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  mode text NOT NULL DEFAULT 'free-demand' CHECK (mode IN ('free-demand','special-schedule')),
  special_time_on text NOT NULL DEFAULT '06:00',
  special_time_off text NOT NULL DEFAULT '22:00',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (farm_id, equipment_id)
);

ALTER TABLE public.automation_holiday_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY automation_holiday_select
  ON public.automation_holiday_configs FOR SELECT
  TO authenticated USING (public.has_farm_access(auth.uid(), farm_id));

CREATE POLICY automation_holiday_insert
  ON public.automation_holiday_configs FOR INSERT
  TO authenticated WITH CHECK (public.can_write_farm(auth.uid(), farm_id));

CREATE POLICY automation_holiday_update
  ON public.automation_holiday_configs FOR UPDATE
  TO authenticated
  USING (public.can_write_farm(auth.uid(), farm_id))
  WITH CHECK (public.can_write_farm(auth.uid(), farm_id));

CREATE POLICY automation_holiday_delete
  ON public.automation_holiday_configs FOR DELETE
  TO authenticated USING (public.can_write_farm(auth.uid(), farm_id));

CREATE TRIGGER automation_holiday_touch
  BEFORE UPDATE ON public.automation_holiday_configs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 3) automation_engine: 1 linha por fazenda (flag global)
CREATE TABLE IF NOT EXISTS public.automation_engine (
  farm_id uuid PRIMARY KEY REFERENCES public.farms(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.automation_engine ENABLE ROW LEVEL SECURITY;

CREATE POLICY automation_engine_select
  ON public.automation_engine FOR SELECT
  TO authenticated USING (public.has_farm_access(auth.uid(), farm_id));

CREATE POLICY automation_engine_upsert_writers
  ON public.automation_engine FOR INSERT
  TO authenticated WITH CHECK (public.can_write_farm(auth.uid(), farm_id));

CREATE POLICY automation_engine_update_writers
  ON public.automation_engine FOR UPDATE
  TO authenticated
  USING (public.can_write_farm(auth.uid(), farm_id))
  WITH CHECK (public.can_write_farm(auth.uid(), farm_id));

CREATE TRIGGER automation_engine_touch
  BEFORE UPDATE ON public.automation_engine
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 4) automation_fired: dedup de disparos (para não enfileirar 2 vezes no mesmo minuto)
CREATE TABLE IF NOT EXISTS public.automation_fired (
  schedule_id uuid NOT NULL REFERENCES public.automation_schedules(id) ON DELETE CASCADE,
  fired_key text NOT NULL,
  fired_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (schedule_id, fired_key)
);

CREATE INDEX IF NOT EXISTS automation_fired_at_idx
  ON public.automation_fired(fired_at);

ALTER TABLE public.automation_fired ENABLE ROW LEVEL SECURITY;

-- Apenas leitura para membros (escrita feita pela função SECURITY DEFINER)
CREATE POLICY automation_fired_select
  ON public.automation_fired FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.automation_schedules s
    WHERE s.id = schedule_id AND public.has_farm_access(auth.uid(), s.farm_id)
  ));

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) Função run_automation_tick: percorre todas as programações ativas e
--    enfileira comandos manuais conforme janela horária. Chamada pela edge
--    function (pg_cron a cada minuto) com a service role.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.run_automation_tick()
RETURNS TABLE(enqueued_count int, schedules_evaluated int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enqueued int := 0;
  v_evaluated int := 0;
  v_sched RECORD;
  v_now timestamptz := now();
  v_dow_idx int;
  v_dow_key text;
  v_dow_keys text[] := ARRAY['dom','seg','ter','qua','qui','sex','sab'];
  v_holiday_mmdd text;
  v_today_key text;
  v_hhmm text;
  v_minute_key text;
  v_now_min int;
  v_on_min int;
  v_off_min int;
  v_inside_window boolean;
  v_eq RECORD;
  v_currently_running boolean;
  v_holiday_cfg RECORD;
  v_effective_on text;
  v_effective_off text;
  v_skip_day_check boolean;
  v_engine_on boolean;
  v_tsnn text;
  v_frame text;
  v_radio text := 'R1';
  v_lora text;
  v_payload text;
  v_holidays text[] := ARRAY[
    '01-01','04-21','05-01','09-07','10-12','11-02','11-15','12-25'
  ];
BEGIN
  -- Limpa fired antigos (>2 dias)
  DELETE FROM public.automation_fired WHERE fired_at < now() - interval '2 days';

  v_dow_idx := EXTRACT(DOW FROM v_now)::int; -- 0=dom..6=sab
  v_dow_key := v_dow_keys[v_dow_idx + 1];
  v_holiday_mmdd := to_char(v_now, 'MM-DD');
  v_today_key := to_char(v_now, 'YYYY-MM-DD');
  v_hhmm := to_char(v_now, 'HH24:MI');
  v_now_min := EXTRACT(HOUR FROM v_now)::int * 60 + EXTRACT(MINUTE FROM v_now)::int;

  FOR v_sched IN
    SELECT s.*, e.farm_id AS eq_farm, e.hw_id, e.saida, e.last_outputs_state,
           e.pending_command_id, e.last_actuation_origin, e.command_blocked_until,
           e.plc_group_id, e.type AS eq_type
    FROM public.automation_schedules s
    JOIN public.equipments e ON e.id = s.equipment_id
    WHERE s.active = true
      AND e.active = true
      AND e.type IN ('poco','bombeamento')
  LOOP
    v_evaluated := v_evaluated + 1;

    -- Motor ligado para a fazenda?
    SELECT COALESCE((SELECT enabled FROM public.automation_engine WHERE farm_id = v_sched.farm_id), true)
      INTO v_engine_on;
    IF NOT v_engine_on THEN CONTINUE; END IF;

    v_effective_on := v_sched.time_on;
    v_effective_off := v_sched.time_off;
    v_skip_day_check := false;

    -- Feriado nacional?
    IF v_holiday_mmdd = ANY(v_holidays) THEN
      SELECT * INTO v_holiday_cfg
      FROM public.automation_holiday_configs
      WHERE farm_id = v_sched.farm_id AND equipment_id = v_sched.equipment_id
      LIMIT 1;

      IF FOUND AND v_holiday_cfg.enabled THEN
        IF v_holiday_cfg.mode = 'free-demand' THEN
          CONTINUE; -- ignora programação no feriado
        ELSIF v_holiday_cfg.mode = 'special-schedule' THEN
          v_effective_on := v_holiday_cfg.special_time_on;
          v_effective_off := v_holiday_cfg.special_time_off;
          v_skip_day_check := true;
        END IF;
      END IF;
    END IF;

    -- Dia da semana
    IF NOT v_skip_day_check AND NOT (v_dow_key = ANY(v_sched.days)) THEN
      CONTINUE;
    END IF;

    -- Calcula janela
    v_on_min := (split_part(v_effective_on, ':', 1))::int * 60 + (split_part(v_effective_on, ':', 2))::int;
    v_off_min := (split_part(v_effective_off, ':', 1))::int * 60 + (split_part(v_effective_off, ':', 2))::int;

    IF v_on_min <= v_off_min THEN
      v_inside_window := v_now_min >= v_on_min AND v_now_min < v_off_min;
    ELSE
      v_inside_window := v_now_min >= v_on_min OR v_now_min < v_off_min;
    END IF;

    -- Estado atual da bomba
    IF v_sched.last_outputs_state ~ '^[01]{6}$' AND COALESCE(v_sched.saida,1) BETWEEN 1 AND 6 THEN
      v_currently_running := substring(v_sched.last_outputs_state from COALESCE(v_sched.saida,1)::int for 1) = '1';
    ELSIF v_sched.last_outputs_state ~ '^[01]$' THEN
      v_currently_running := v_sched.last_outputs_state = '1';
    ELSE
      v_currently_running := false;
    END IF;

    -- ── ON: dentro da janela, sem comando pendente, bomba desligada ──
    IF v_sched.mode <> 'off-only' AND v_inside_window
       AND v_sched.pending_command_id IS NULL
       AND v_currently_running = false
       AND COALESCE(v_sched.last_actuation_origin, 'remote') <> 'local'
       AND (v_sched.command_blocked_until IS NULL OR v_sched.command_blocked_until <= v_now)
    THEN
      v_minute_key := v_today_key || '|on@' || v_hhmm;
      INSERT INTO public.automation_fired(schedule_id, fired_key)
      VALUES (v_sched.id, v_minute_key)
      ON CONFLICT DO NOTHING;

      IF FOUND THEN
        -- Resolve TSNN
        IF v_sched.plc_group_id IS NOT NULL THEN
          SELECT hw_id INTO v_tsnn FROM public.plc_groups WHERE id = v_sched.plc_group_id;
          v_tsnn := COALESCE(v_tsnn, substring(v_sched.hw_id from 1 for 4));
        ELSE
          v_tsnn := substring(v_sched.hw_id from 1 for 4);
        END IF;

        v_payload := '1';
        v_lora := '[' || v_tsnn || '_1_]{' || v_payload || '}[' || v_tsnn || '_ETX_]' || E'\r';
        v_frame := v_lora;

        INSERT INTO public.commands (
          farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device
        ) VALUES (
          v_sched.farm_id, v_sched.equipment_id, v_tsnn,
          'manual', 1, v_frame, 600000, 'cloud-automation'
        );
        v_enqueued := v_enqueued + 1;
      END IF;
    END IF;

    -- ── OFF: exatamente no horário programado de desligar ──
    IF v_sched.mode <> 'on-only' AND v_hhmm = v_effective_off
       AND v_sched.pending_command_id IS NULL
       AND v_currently_running = true
    THEN
      v_minute_key := v_today_key || '|off@' || v_hhmm;
      INSERT INTO public.automation_fired(schedule_id, fired_key)
      VALUES (v_sched.id, v_minute_key)
      ON CONFLICT DO NOTHING;

      IF FOUND THEN
        IF v_sched.plc_group_id IS NOT NULL THEN
          SELECT hw_id INTO v_tsnn FROM public.plc_groups WHERE id = v_sched.plc_group_id;
          v_tsnn := COALESCE(v_tsnn, substring(v_sched.hw_id from 1 for 4));
        ELSE
          v_tsnn := substring(v_sched.hw_id from 1 for 4);
        END IF;

        v_payload := '0';
        v_lora := '[' || v_tsnn || '_1_]{' || v_payload || '}[' || v_tsnn || '_ETX_]' || E'\r';
        v_frame := v_lora;

        INSERT INTO public.commands (
          farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device
        ) VALUES (
          v_sched.farm_id, v_sched.equipment_id, v_tsnn,
          'manual', 1, v_frame, 600000, 'cloud-automation'
        );
        v_enqueued := v_enqueued + 1;
      END IF;
    END IF;
  END LOOP;

  enqueued_count := v_enqueued;
  schedules_evaluated := v_evaluated;
  RETURN NEXT;
END;
$$;

-- Habilita extensões necessárias para o cron
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;