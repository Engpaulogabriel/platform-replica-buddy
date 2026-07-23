
-- Tabela de histórico de nível (apenas mudanças significativas)
CREATE TABLE IF NOT EXISTS public.level_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL,
  equipment_id uuid NOT NULL REFERENCES public.equipments(id) ON DELETE CASCADE,
  raw integer,
  percent numeric(5,2),
  meters numeric(6,2),
  is_calibrated boolean NOT NULL DEFAULT false,
  read_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_level_history_eq_time ON public.level_history(equipment_id, read_at DESC);
CREATE INDEX IF NOT EXISTS idx_level_history_farm_time ON public.level_history(farm_id, read_at DESC);

ALTER TABLE public.level_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "level_history_select_members"
  ON public.level_history FOR SELECT TO authenticated
  USING (has_farm_access(auth.uid(), farm_id));

CREATE POLICY "level_history_select_platform_staff"
  ON public.level_history FOR SELECT TO authenticated
  USING (is_platform_staff(auth.uid()));

CREATE POLICY "level_history_insert_writers"
  ON public.level_history FOR INSERT TO authenticated
  WITH CHECK (can_write_farm(auth.uid(), farm_id));

-- Trigger: salva apenas em mudanças significativas (>=2%) ou após 30min
CREATE OR REPLACE FUNCTION public.save_level_history_if_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_calibrated boolean := false;
  v_meters numeric := NULL;
  v_percent numeric := NULL;
  v_max numeric := NULL;
  last_rec RECORD;
  should_save boolean := false;
  age_min numeric;
BEGIN
  -- Só processa equipamentos do tipo 'nivel'
  IF NEW.type IS DISTINCT FROM 'nivel' THEN
    RETURN NEW;
  END IF;

  -- Só dispara se a leitura realmente mudou
  IF NEW.level_last_raw IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.level_last_raw IS NOT DISTINCT FROM NEW.level_last_raw
     AND OLD.level_last_raw_at IS NOT DISTINCT FROM NEW.level_last_raw_at THEN
    RETURN NEW;
  END IF;

  -- Ignora se equipamento offline (sem leitura recente nos últimos 15 min)
  IF NEW.level_last_raw_at IS NULL OR NEW.level_last_raw_at < now() - interval '15 minutes' THEN
    RETURN NEW;
  END IF;

  -- Calibração: meters = raw * (cal_meters / cal_digital); percent vs max
  IF NEW.level_cal_digital IS NOT NULL AND NEW.level_cal_digital > 0
     AND NEW.level_cal_meters IS NOT NULL AND NEW.level_cal_meters > 0 THEN
    v_calibrated := true;
    v_meters := GREATEST(0, (NEW.level_last_raw::numeric / NEW.level_cal_digital) * NEW.level_cal_meters);
    v_max := COALESCE(NULLIF(NEW.level_max_meters, 0), NULLIF(NEW.max_height, 0));
    IF v_max IS NOT NULL AND v_max > 0 THEN
      v_percent := LEAST(100, GREATEST(0, (v_meters / v_max) * 100));
    END IF;
  END IF;

  -- Último registro salvo
  SELECT raw, percent, read_at INTO last_rec
  FROM public.level_history
  WHERE equipment_id = NEW.id
  ORDER BY read_at DESC
  LIMIT 1;

  -- NÃO salvar se raw atual = 0 e anterior = 0 (sensor desconectado)
  IF NEW.level_last_raw = 0 AND last_rec.raw IS NOT NULL AND last_rec.raw = 0 THEN
    RETURN NEW;
  END IF;

  IF last_rec IS NULL THEN
    should_save := true;
  ELSE
    age_min := EXTRACT(EPOCH FROM (now() - last_rec.read_at)) / 60.0;
    IF v_percent IS NOT NULL AND last_rec.percent IS NOT NULL THEN
      IF ABS(v_percent - last_rec.percent) >= 2 THEN
        should_save := true;
      END IF;
    ELSIF NEW.level_last_raw IS NOT NULL AND last_rec.raw IS NOT NULL THEN
      -- sem calibração: usa variação relativa de raw (≥2% do range observado)
      IF ABS(NEW.level_last_raw - last_rec.raw) >= GREATEST(20, ABS(last_rec.raw) * 0.02) THEN
        should_save := true;
      END IF;
    END IF;
    IF age_min >= 30 THEN
      should_save := true;
    END IF;
  END IF;

  IF should_save THEN
    INSERT INTO public.level_history (farm_id, equipment_id, raw, percent, meters, is_calibrated, read_at)
    VALUES (NEW.farm_id, NEW.id, NEW.level_last_raw, v_percent, v_meters, v_calibrated, COALESCE(NEW.level_last_raw_at, now()));
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_save_level_history ON public.equipments;
CREATE TRIGGER trg_save_level_history
  AFTER UPDATE ON public.equipments
  FOR EACH ROW
  EXECUTE FUNCTION public.save_level_history_if_changed();

-- Compactação: após 90 dias mantém só 1 registro/hora; após 365d mantém só 1/dia
CREATE OR REPLACE FUNCTION public.compact_old_level_history()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.level_history
  WHERE read_at < now() - interval '90 days'
    AND read_at >= now() - interval '365 days'
    AND id NOT IN (
      SELECT DISTINCT ON (equipment_id, date_trunc('hour', read_at)) id
      FROM public.level_history
      WHERE read_at < now() - interval '90 days'
        AND read_at >= now() - interval '365 days'
      ORDER BY equipment_id, date_trunc('hour', read_at), read_at
    );

  DELETE FROM public.level_history
  WHERE read_at < now() - interval '365 days'
    AND id NOT IN (
      SELECT DISTINCT ON (equipment_id, date_trunc('day', read_at)) id
      FROM public.level_history
      WHERE read_at < now() - interval '365 days'
      ORDER BY equipment_id, date_trunc('day', read_at), read_at
    );
END;
$$;
