-- ─────────────────────────────────────────────────────────────────────────────
-- Indicador de Balanço Hídrico (Parte 1 + Alertas)
--
-- RPC get_water_balance(farm_id) → retorna estado da captação cruzando o
-- histórico level_history (últimos 30 min) com bombas de captação ligadas.
--
-- Função check_water_balance_alerts() → varre todas fazendas e insere
-- notificações em farm_notifications (com dedup por source/source_ref) quando
-- a captação fica insuficiente, sem captação ou prevê esvaziamento crítico.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_water_balance(_farm_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_active_pumps int := 0;
  v_total_pumps  int := 0;
  v_avg_rate     numeric;            -- %/min (média entre sensores)
  v_avg_level    numeric;            -- % atual médio
  v_status       text;
  v_prediction_h numeric;
  v_sensors_with_data int := 0;
BEGIN
  -- Bombas de captação (poco/bombeamento), apenas ativas
  SELECT
    count(*) FILTER (WHERE desired_running = true),
    count(*)
  INTO v_active_pumps, v_total_pumps
  FROM equipments
  WHERE farm_id = _farm_id
    AND active = true
    AND type IN ('poco','bombeamento');

  -- Para cada sensor de nível ativo: pega leitura mais recente (últimos 5 min)
  -- e leitura "âncora" (~25-35 min atrás), calcula taxa em %/min.
  WITH sensors AS (
    SELECT id FROM equipments
    WHERE farm_id = _farm_id AND active = true AND type = 'nivel'
  ),
  recent AS (
    SELECT DISTINCT ON (s.id)
      s.id AS equipment_id,
      lh.percent::numeric AS percent_now,
      lh.read_at AS now_at
    FROM sensors s
    JOIN level_history lh ON lh.equipment_id = s.id
    WHERE lh.read_at >= now() - interval '5 minutes'
      AND lh.percent IS NOT NULL
    ORDER BY s.id, lh.read_at DESC
  ),
  anchor AS (
    SELECT DISTINCT ON (s.id)
      s.id AS equipment_id,
      lh.percent::numeric AS percent_then,
      lh.read_at AS then_at
    FROM sensors s
    JOIN level_history lh ON lh.equipment_id = s.id
    WHERE lh.read_at <= now() - interval '25 minutes'
      AND lh.read_at >= now() - interval '90 minutes'
      AND lh.percent IS NOT NULL
    ORDER BY s.id, lh.read_at DESC
  ),
  per_sensor AS (
    SELECT
      r.equipment_id,
      r.percent_now,
      (r.percent_now - a.percent_then)
        / NULLIF(EXTRACT(EPOCH FROM (r.now_at - a.then_at)) / 60.0, 0) AS rate_per_min
    FROM recent r
    JOIN anchor a USING (equipment_id)
  )
  SELECT
    avg(rate_per_min),
    avg(percent_now),
    count(*)
  INTO v_avg_rate, v_avg_level, v_sensors_with_data
  FROM per_sensor;

  -- Classificação
  IF v_sensors_with_data = 0 OR v_avg_rate IS NULL THEN
    v_status := 'sem_dados';
  ELSIF v_avg_rate > 0.05 THEN              -- subindo > 0.05%/min (~3%/h)
    v_status := 'positiva';
  ELSIF v_avg_rate >= -0.05 THEN
    v_status := 'equilibrada';
  ELSIF v_active_pumps > 0 THEN
    v_status := 'insuficiente';
  ELSE
    v_status := 'sem_captacao';
  END IF;

  -- Previsão: horas até esvaziar (apenas quando está caindo)
  IF v_avg_rate IS NOT NULL AND v_avg_rate < -0.01 AND v_avg_level IS NOT NULL THEN
    v_prediction_h := v_avg_level / abs(v_avg_rate * 60);
  END IF;

  RETURN jsonb_build_object(
    'status', v_status,
    'rate_per_min', round(coalesce(v_avg_rate, 0)::numeric, 3),
    'rate_per_hour', round(coalesce(v_avg_rate * 60, 0)::numeric, 2),
    'avg_level_percent', CASE WHEN v_avg_level IS NULL THEN NULL ELSE round(v_avg_level, 1) END,
    'active_pumps', v_active_pumps,
    'total_pumps', v_total_pumps,
    'sensors_with_data', v_sensors_with_data,
    'prediction_hours', CASE WHEN v_prediction_h IS NULL THEN NULL ELSE round(v_prediction_h, 1) END,
    'calculated_at', now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_water_balance(uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Tabela auxiliar pra rastrear desde quando cada fazenda está em status ruim
-- (necessário pras regras "30 min consecutivos" / "15 min consecutivos").
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.water_balance_state (
  farm_id uuid PRIMARY KEY,
  status text NOT NULL,
  status_since timestamptz NOT NULL DEFAULT now(),
  prediction_hours numeric,
  last_alert_insuficiente_at timestamptz,
  last_alert_sem_captacao_at timestamptz,
  last_alert_critico_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.water_balance_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wbs_select_members ON public.water_balance_state;
CREATE POLICY wbs_select_members ON public.water_balance_state
  FOR SELECT TO authenticated
  USING (has_farm_access(auth.uid(), farm_id) OR is_platform_staff(auth.uid()));

-- ─────────────────────────────────────────────────────────────────────────────
-- check_water_balance_alerts() — chamada pelo automation-tick (cron 1min).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.check_water_balance_alerts()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_farm record;
  v_wb jsonb;
  v_status text;
  v_pred numeric;
  v_state record;
  v_minutes_in_status numeric;
  v_inserted int := 0;
BEGIN
  FOR v_farm IN SELECT id FROM farms LOOP
    v_wb := get_water_balance(v_farm.id);
    v_status := v_wb->>'status';
    v_pred := NULLIF(v_wb->>'prediction_hours','')::numeric;

    -- Upsert state, resetando o "since" quando o status muda
    SELECT * INTO v_state FROM water_balance_state WHERE farm_id = v_farm.id;
    IF v_state IS NULL THEN
      INSERT INTO water_balance_state(farm_id, status, prediction_hours)
      VALUES (v_farm.id, v_status, v_pred);
      v_state := (SELECT s FROM water_balance_state s WHERE farm_id = v_farm.id);
    ELSIF v_state.status <> v_status THEN
      UPDATE water_balance_state
        SET status = v_status, status_since = now(), prediction_hours = v_pred, updated_at = now()
       WHERE farm_id = v_farm.id;
      v_state.status := v_status; v_state.status_since := now(); v_state.prediction_hours := v_pred;
    ELSE
      UPDATE water_balance_state
        SET prediction_hours = v_pred, updated_at = now()
       WHERE farm_id = v_farm.id;
    END IF;

    v_minutes_in_status := EXTRACT(EPOCH FROM (now() - v_state.status_since)) / 60.0;

    -- Reservatório crítico: previsão < 2h (e está caindo) — dispara a cada 60min
    IF v_pred IS NOT NULL AND v_pred < 2 AND v_status IN ('insuficiente','sem_captacao') THEN
      IF v_state.last_alert_critico_at IS NULL OR now() - v_state.last_alert_critico_at > interval '60 minutes' THEN
        INSERT INTO farm_notifications(farm_id, source, source_ref, title, message, severity)
        VALUES (
          v_farm.id, 'water_balance', gen_random_uuid(),
          'Reservatório crítico',
          format('Esvazia em ~%s h no ritmo atual. Ação necessária.', round(v_pred, 1)),
          'critical'
        );
        UPDATE water_balance_state SET last_alert_critico_at = now() WHERE farm_id = v_farm.id;
        v_inserted := v_inserted + 1;
      END IF;
    END IF;

    -- Captação insuficiente: status há >=30min — re-dispara a cada 60min
    IF v_status = 'insuficiente' AND v_minutes_in_status >= 30 THEN
      IF v_state.last_alert_insuficiente_at IS NULL OR now() - v_state.last_alert_insuficiente_at > interval '60 minutes' THEN
        INSERT INTO farm_notifications(farm_id, source, source_ref, title, message, severity)
        VALUES (
          v_farm.id, 'water_balance', gen_random_uuid(),
          'Captação insuficiente',
          'Consumo está maior que a captação há mais de 30 min. Considere ligar mais bombas.',
          'warning'
        );
        UPDATE water_balance_state SET last_alert_insuficiente_at = now() WHERE farm_id = v_farm.id;
        v_inserted := v_inserted + 1;
      END IF;
    END IF;

    -- Sem captação: status há >=15min — re-dispara a cada 60min
    IF v_status = 'sem_captacao' AND v_minutes_in_status >= 15 THEN
      IF v_state.last_alert_sem_captacao_at IS NULL OR now() - v_state.last_alert_sem_captacao_at > interval '60 minutes' THEN
        INSERT INTO farm_notifications(farm_id, source, source_ref, title, message, severity)
        VALUES (
          v_farm.id, 'water_balance', gen_random_uuid(),
          'Sem captação',
          'Todas as bombas de captação estão desligadas e o nível está caindo.',
          'warning'
        );
        UPDATE water_balance_state SET last_alert_sem_captacao_at = now() WHERE farm_id = v_farm.id;
        v_inserted := v_inserted + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('inserted', v_inserted, 'checked_at', now());
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_water_balance_alerts() TO authenticated, service_role;