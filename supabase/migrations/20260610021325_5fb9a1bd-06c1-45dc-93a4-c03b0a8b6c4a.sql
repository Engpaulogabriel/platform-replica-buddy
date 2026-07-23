
-- 1) Limpar lixo existente
DELETE FROM farm_notifications WHERE title ILIKE '%Captação insuficiente%';

-- Deduplicar "Bomba ligada no horário de ponta": manter só o mais recente por (farm_id, data local)
DELETE FROM farm_notifications a
USING farm_notifications b
WHERE a.title ILIKE '%horário de ponta%'
  AND b.title ILIKE '%horário de ponta%'
  AND a.farm_id = b.farm_id
  AND date(a.created_at AT TIME ZONE 'America/Bahia') = date(b.created_at AT TIME ZONE 'America/Bahia')
  AND a.created_at < b.created_at;

-- Conforme pedido: remove qualquer alerta de ponta vinculado a equipamento offline
DELETE FROM farm_notifications
WHERE title ILIKE '%horário de ponta%'
  AND equipment_id IN (SELECT id FROM equipments WHERE communication_status = 'offline');

-- 2) Refaz a função: sem "Captação insuficiente"; ponta dedup por (farm, data) + filtra offline
CREATE OR REPLACE FUNCTION public.check_water_balance_alerts()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_date_key text;
  v_peak_exists boolean;
BEGIN
  v_dow := EXTRACT(DOW FROM v_now)::int;
  v_min_of_day := EXTRACT(HOUR FROM v_now)::int * 60 + EXTRACT(MINUTE FROM v_now)::int;
  v_is_peak := v_dow BETWEEN 1 AND 5
               AND v_min_of_day >= 18 * 60
               AND v_min_of_day < 21 * 60;
  v_date_key := to_char((now() AT TIME ZONE 'America/Bahia')::date, 'YYYY-MM-DD');

  FOR v_farm IN SELECT id FROM farms LOOP
    v_wb := get_water_balance(v_farm.id);
    v_status := v_wb->>'status';
    v_pred := NULLIF(v_wb->>'prediction_hours','')::numeric;

    -- Conta bombas ligadas IGNORANDO offline
    SELECT COUNT(*) INTO v_active
    FROM equipments
    WHERE farm_id = v_farm.id
      AND active = true
      AND type IN ('poco','bombeamento')
      AND communication_status <> 'offline'
      AND saida IS NOT NULL
      AND last_outputs_state IS NOT NULL
      AND length(last_outputs_state) >= saida::int
      AND substr(last_outputs_state, saida::int, 1) = '1';

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

    -- ── ALERTA: Bomba ligada no horário de ponta ── (1x por ponta/dia/fazenda)
    IF v_is_peak AND v_active > 0 THEN
      SELECT EXISTS(
        SELECT 1 FROM farm_notifications
        WHERE farm_id = v_farm.id
          AND source = 'water_balance'
          AND title ILIKE '%horário de ponta%'
          AND date(created_at AT TIME ZONE 'America/Bahia') = v_date_key::date
      ) INTO v_peak_exists;

      IF NOT v_peak_exists THEN
        SELECT
          COALESCE(SUM(power_kw), 0),
          string_agg(name, ', ' ORDER BY name)
        INTO v_total_kw, v_pump_names
        FROM equipments
        WHERE farm_id = v_farm.id
          AND active = true
          AND type IN ('poco','bombeamento')
          AND communication_status <> 'offline'
          AND saida IS NOT NULL
          AND last_outputs_state IS NOT NULL
          AND length(last_outputs_state) >= saida::int
          AND substr(last_outputs_state, saida::int, 1) = '1';

        SELECT COALESCE(tariff_peak, 1.884), COALESCE(tariff_reserved, 0.3878)
        INTO v_tariff_peak, v_tariff_reserved
        FROM farm_productivity_config WHERE farm_id = v_farm.id;
        v_tariff_peak := COALESCE(v_tariff_peak, 1.884);
        v_tariff_reserved := COALESCE(v_tariff_reserved, 0.3878);
        v_extra_per_min := (COALESCE(v_total_kw, 0) * GREATEST(v_tariff_peak - v_tariff_reserved, 0)) / 60.0;

        INSERT INTO farm_notifications(farm_id, source, source_ref, title, message, severity)
        VALUES (
          v_farm.id, 'water_balance',
          md5('peak_hour_' || v_farm.id::text || '_' || v_date_key)::uuid,
          format('🔴 Bomba ligada no horário de ponta (%s)', v_active),
          format(
            '%s bomba(s) operando: %s. Consumo atual ~%s kW. Custo extra ~R$ %s/min vs tarifa reservada.',
            v_active, COALESCE(v_pump_names, '—'),
            round(COALESCE(v_total_kw, 0)::numeric, 0),
            to_char(v_extra_per_min, 'FM999G990D00')
          ),
          'critical'
        )
        ON CONFLICT DO NOTHING;
        UPDATE water_balance_state SET last_alert_ponta_at = now() WHERE farm_id = v_farm.id;
        v_inserted := v_inserted + 1;
      END IF;
    END IF;

    -- Reservatório crítico (mantido)
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

    -- REMOVIDO: alerta "Captação insuficiente" (já está no card do Dashboard)

    -- "Sem captação" mantido (situação distinta: zero captação por ≥15min)
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
$function$;
