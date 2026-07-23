-- Tabela de sessões de funcionamento (horímetro real)
CREATE TABLE IF NOT EXISTS public.pump_runtime (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL,
  equipment_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  duration_seconds integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pump_runtime_farm_started_idx
  ON public.pump_runtime(farm_id, started_at DESC);
CREATE INDEX IF NOT EXISTS pump_runtime_equipment_started_idx
  ON public.pump_runtime(equipment_id, started_at DESC);
-- Garante apenas uma sessão aberta por equipamento
CREATE UNIQUE INDEX IF NOT EXISTS pump_runtime_open_unique
  ON public.pump_runtime(equipment_id) WHERE ended_at IS NULL;

ALTER TABLE public.pump_runtime ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pump_runtime_select_members"
  ON public.pump_runtime FOR SELECT TO authenticated
  USING (public.has_farm_access(auth.uid(), farm_id));

CREATE POLICY "pump_runtime_insert_writers"
  ON public.pump_runtime FOR INSERT TO authenticated
  WITH CHECK (public.can_write_farm(auth.uid(), farm_id));

CREATE POLICY "pump_runtime_update_writers"
  ON public.pump_runtime FOR UPDATE TO authenticated
  USING (public.can_write_farm(auth.uid(), farm_id))
  WITH CHECK (public.can_write_farm(auth.uid(), farm_id));

-- Trigger: ao mudar last_outputs_state da bomba, abre/fecha sessão
CREATE OR REPLACE FUNCTION public.track_pump_runtime()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_saida_idx int;
  v_old_running boolean;
  v_new_running boolean;
  v_open_id uuid;
  v_open_started timestamptz;
BEGIN
  IF NEW.type NOT IN ('poco', 'bombeamento') THEN
    RETURN NEW;
  END IF;

  v_saida_idx := COALESCE(NEW.saida, 1);

  -- Estado anterior
  IF OLD.last_outputs_state ~ '^[01]{6}$' AND v_saida_idx BETWEEN 1 AND 6 THEN
    v_old_running := substring(OLD.last_outputs_state from v_saida_idx for 1) = '1';
  ELSIF OLD.last_outputs_state ~ '^[01]$' THEN
    v_old_running := OLD.last_outputs_state = '1';
  ELSE
    v_old_running := false;
  END IF;

  -- Estado novo
  IF NEW.last_outputs_state ~ '^[01]{6}$' AND v_saida_idx BETWEEN 1 AND 6 THEN
    v_new_running := substring(NEW.last_outputs_state from v_saida_idx for 1) = '1';
  ELSIF NEW.last_outputs_state ~ '^[01]$' THEN
    v_new_running := NEW.last_outputs_state = '1';
  ELSE
    v_new_running := false;
  END IF;

  -- Sem mudança de estado → nada a fazer
  IF v_old_running IS NOT DISTINCT FROM v_new_running THEN
    RETURN NEW;
  END IF;

  IF v_new_running THEN
    -- Ligou: abre nova sessão (se já não houver aberta)
    INSERT INTO public.pump_runtime (farm_id, equipment_id, started_at)
    VALUES (NEW.farm_id, NEW.id, COALESCE(NEW.last_communication, now()))
    ON CONFLICT (equipment_id) WHERE ended_at IS NULL DO NOTHING;
  ELSE
    -- Desligou: fecha sessão aberta (se houver)
    SELECT id, started_at INTO v_open_id, v_open_started
    FROM public.pump_runtime
    WHERE equipment_id = NEW.id AND ended_at IS NULL
    ORDER BY started_at DESC
    LIMIT 1;

    IF v_open_id IS NOT NULL THEN
      UPDATE public.pump_runtime
      SET ended_at = COALESCE(NEW.last_communication, now()),
          duration_seconds = GREATEST(
            0,
            EXTRACT(EPOCH FROM (COALESCE(NEW.last_communication, now()) - v_open_started))::int
          )
      WHERE id = v_open_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_equipments_track_runtime ON public.equipments;
CREATE TRIGGER trg_equipments_track_runtime
AFTER UPDATE OF last_outputs_state ON public.equipments
FOR EACH ROW
EXECUTE FUNCTION public.track_pump_runtime();

-- ─────────────────────────────────────────────────────────────────
-- Função de relatório diário por bomba (intervalo arbitrário)
-- Retorna: equipment_id, equipment_name, day, hours
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_horimetro_daily(
  _farm_id uuid,
  _from timestamptz,
  _to timestamptz
)
RETURNS TABLE (
  equipment_id uuid,
  equipment_name text,
  day date,
  hours numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_farm_access(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

  RETURN QUERY
  WITH expanded AS (
    -- Para cada sessão, calcula a interseção com cada dia do intervalo
    SELECT
      r.equipment_id,
      e.name AS equipment_name,
      gs::date AS day,
      EXTRACT(EPOCH FROM (
        LEAST(COALESCE(r.ended_at, now()), gs + interval '1 day', _to)
        - GREATEST(r.started_at, gs, _from)
      ))::numeric AS seconds_in_day
    FROM public.pump_runtime r
    JOIN public.equipments e ON e.id = r.equipment_id
    CROSS JOIN LATERAL generate_series(
      GREATEST(date_trunc('day', r.started_at), date_trunc('day', _from)),
      LEAST(date_trunc('day', COALESCE(r.ended_at, now())), date_trunc('day', _to)),
      interval '1 day'
    ) AS gs
    WHERE r.farm_id = _farm_id
      AND r.started_at < _to
      AND COALESCE(r.ended_at, now()) > _from
  )
  SELECT
    expanded.equipment_id,
    expanded.equipment_name,
    expanded.day,
    ROUND(SUM(GREATEST(0, expanded.seconds_in_day)) / 3600.0, 2) AS hours
  FROM expanded
  GROUP BY expanded.equipment_id, expanded.equipment_name, expanded.day
  ORDER BY expanded.day, expanded.equipment_name;
END;
$$;

-- ─────────────────────────────────────────────────────────────────
-- Função: total de horas no mês corrente por equipamento
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_horimetro_month_total(
  _farm_id uuid,
  _equipment_id uuid
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total numeric;
  v_month_start timestamptz := date_trunc('month', now());
BEGIN
  IF NOT public.has_farm_access(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

  SELECT COALESCE(
    SUM(
      EXTRACT(EPOCH FROM (
        LEAST(COALESCE(r.ended_at, now()), now())
        - GREATEST(r.started_at, v_month_start)
      ))
    ) / 3600.0,
    0
  )
  INTO v_total
  FROM public.pump_runtime r
  WHERE r.farm_id = _farm_id
    AND r.equipment_id = _equipment_id
    AND r.started_at < now()
    AND COALESCE(r.ended_at, now()) > v_month_start;

  RETURN ROUND(v_total, 2);
END;
$$;