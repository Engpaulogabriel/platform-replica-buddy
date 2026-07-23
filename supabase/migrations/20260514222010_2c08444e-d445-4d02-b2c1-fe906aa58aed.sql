
-- Adiciona timestamp do último alerta de violação de ponta
ALTER TABLE public.water_balance_state
  ADD COLUMN IF NOT EXISTS last_alert_ponta_at timestamptz;

-- Estende check_water_balance_alerts para detectar bombas na ponta
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
  v_now timestamptz := now() AT TIME ZONE 'America/Bahia';
  v_dow int;
  v_min_of_day int;
  v_is_peak boolean;
  v_active int;
  v_total_kw numeric;
  v_tariff_peak numeric;
  v_tariff_reserved numeric;
  v_extra_per_min numeric;
  v_pump_names text;
BEGIN
  -- Determina se "agora" é horário de ponta (18:00–21:00 seg-sex, sem feriado)
  v_dow := EXTRACT(DOW FROM v_now)::int; -- 0=dom, 6=sab
  v_min_of_day := EXTRACT(HOUR FROM v_now)::int * 60 + EXTRACT(MINUTE FROM v_now)::int;
  v_is_peak := v_dow BETWEEN 1 AND 5
               AND v_min_of_day >= 18 * 60
               AND v_min_of_day < 21 * 60;

  FOR v_farm IN SELECT id FROM farms LOOP
    v_wb := get_water_balance(v_farm.id);
    v_status := v_wb->>'status';
    v_pred := NULLIF(v_wb->>'prediction_hours','')::numeric;
    v_active := COALESCE((v_wb->>'active_pumps')::int, 0);

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

    -- ── ALERTA: Bomba ligada no horário de ponta ──
    IF v_is_peak AND v_active > 0 THEN
      IF v_state.last_alert_ponta_at IS NULL OR now() - v_state.last_alert_ponta_at > interval '60 minutes' THEN
        -- Soma kW e nomes das bombas ligadas
        SELECT
          COALESCE(SUM(power_kw), 0),
          string_agg(name, ', ' ORDER BY name)
        INTO v_total_kw, v_pump_names
        FROM equipments
        WHERE farm_id = v_farm.id
          AND active = true
          AND type IN ('poco','bombeamento')
          AND (
            desired_running = true
            OR (
              saida IS NOT NULL
              AND last_outputs_state IS NOT NULL
              AND length(last_outputs_state) >= saida::int
              AND substr(last_outputs_state, saida::int, 1) = '1'
            )
          );

        SELECT COALESCE(tariff_peak, 1.884), COALESCE(tariff_reserved, 0.3878)
        INTO v_tariff_peak, v_tariff_reserved
        FROM farm_productivity_config WHERE farm_id = v_farm.id;
        v_tariff_peak := COALESCE(v_tariff_peak, 1.884);
        v_tariff_reserved := COALESCE(v_tariff_reserved, 0.3878);

        v_extra_per_min := (COALESCE(v_total_kw, 0) * GREATEST(v_tariff_peak - v_tariff_reserved, 0)) / 60.0;

        INSERT INTO farm_notifications(farm_id, source, source_ref, title, message, severity)
        VALUES (
          v_farm.id, 'water_balance', gen_random_uuid(),
          format('🔴 Bomba ligada no horário de ponta (%s)', v_active),
          format(
            '%s bomba(s) operando: %s. Consumo atual ~%s kW. Custo extra ~R$ %s/min vs tarifa reservada.',
            v_active,
            COALESCE(v_pump_names, '—'),
            round(COALESCE(v_total_kw, 0)::numeric, 0),
            to_char(v_extra_per_min, 'FM999G990D00')
          ),
          'critical'
        );
        UPDATE water_balance_state SET last_alert_ponta_at = now() WHERE farm_id = v_farm.id;
        v_inserted := v_inserted + 1;
      END IF;
    END IF;

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

  RETURN jsonb_build_object('inserted', v_inserted, 'checked_at', now(), 'is_peak', v_is_peak);
END;
$$;
