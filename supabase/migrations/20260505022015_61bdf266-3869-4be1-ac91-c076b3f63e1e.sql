-- =====================================================
-- HORÍMETRO: religar trigger + checkpoint + close orphans
-- =====================================================
-- Aproveita a tabela pump_runtime existente (já tem RLS,
-- índices únicos para "1 sessão aberta por equipamento" e
-- histórico de 418 sessões). Apenas religa o trigger que
-- estava desanexado e adiciona o mecanismo de checkpoint
-- + fechamento automático de órfãos.

-- 1. Checkpoint na tabela equipments
ALTER TABLE public.equipments
  ADD COLUMN IF NOT EXISTS runtime_checkpoint_at timestamptz;

-- 2. Atualiza track_pump_runtime para também gravar checkpoint
CREATE OR REPLACE FUNCTION public.track_pump_runtime()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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

  -- CHECKPOINT: se bomba está ligada, marca o último ponto onde sabemos
  -- que ainda estava ligada. Usado por close_orphan_runtime_events
  -- para estimar quando o evento órfão deve ser fechado.
  IF v_new_running THEN
    NEW.runtime_checkpoint_at := COALESCE(NEW.last_communication, now());
  END IF;

  -- Sem transição → nada a registrar
  IF v_old_running IS NOT DISTINCT FROM v_new_running THEN
    RETURN NEW;
  END IF;

  IF v_new_running THEN
    -- LIGOU: abre nova sessão (idempotente)
    IF NOT EXISTS (
      SELECT 1 FROM public.pump_runtime
      WHERE equipment_id = NEW.id AND ended_at IS NULL
    ) THEN
      INSERT INTO public.pump_runtime (farm_id, equipment_id, started_at)
      VALUES (NEW.farm_id, NEW.id, COALESCE(NEW.last_communication, now()));
    END IF;
  ELSE
    -- DESLIGOU: fecha sessão aberta
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
$function$;

-- 3. (Re)anexa o trigger BEFORE UPDATE em equipments
DROP TRIGGER IF EXISTS trg_equipments_track_runtime ON public.equipments;
CREATE TRIGGER trg_equipments_track_runtime
  BEFORE UPDATE ON public.equipments
  FOR EACH ROW
  WHEN (
    OLD.last_outputs_state IS DISTINCT FROM NEW.last_outputs_state
    OR (NEW.last_outputs_state ~ '^[01]+$' AND NEW.last_communication IS DISTINCT FROM OLD.last_communication)
  )
  EXECUTE FUNCTION public.track_pump_runtime();

-- 4. Função para fechar sessões órfãs (proteção contra crash/queda)
CREATE OR REPLACE FUNCTION public.close_orphan_pump_runtime(_max_idle_minutes int DEFAULT 5)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  closed_count int;
BEGIN
  WITH orphans AS (
    SELECT
      r.id,
      r.started_at,
      COALESCE(e.runtime_checkpoint_at, e.last_communication, r.started_at + interval '1 minute') AS close_at
    FROM public.pump_runtime r
    JOIN public.equipments e ON e.id = r.equipment_id
    WHERE r.ended_at IS NULL
      AND (
        -- Bomba já está desligada na realidade
        e.last_outputs_state ~ '^0+$'
        -- OU não recebe telemetria há muito tempo (provável crash)
        OR e.last_communication < now() - make_interval(mins => _max_idle_minutes)
      )
  )
  UPDATE public.pump_runtime r
  SET ended_at = orphans.close_at,
      duration_seconds = GREATEST(
        0,
        EXTRACT(EPOCH FROM (orphans.close_at - r.started_at))::int
      )
  FROM orphans
  WHERE r.id = orphans.id;

  GET DIAGNOSTICS closed_count = ROW_COUNT;
  RETURN closed_count;
END;
$$;

REVOKE ALL ON FUNCTION public.close_orphan_pump_runtime(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.close_orphan_pump_runtime(int) TO authenticated, service_role;

-- 5. Backfill: fecha sessões antigas que já estão órfãs (limpeza one-shot)
SELECT public.close_orphan_pump_runtime(60);

-- 6. Agenda execução diária (3:30 da manhã) via pg_cron
DO $$
BEGIN
  PERFORM cron.unschedule('close-orphan-pump-runtime-daily');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'close-orphan-pump-runtime-daily',
  '30 3 * * *',
  $$ SELECT public.close_orphan_pump_runtime(10); $$
);