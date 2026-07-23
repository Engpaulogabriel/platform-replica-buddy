-- Função: cancela comandos "ligar" pendentes/enviados quando a Bridge fica
-- offline por mais de 15 minutos. Evita religamento em massa quando o agent volta.
CREATE OR REPLACE FUNCTION public.purge_stale_on_commands_when_bridge_down()
RETURNS TABLE(farm_id uuid, cancelled_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_farm RECORD;
  v_count integer;
  v_total integer := 0;
BEGIN
  -- Itera farms com bridge inativa há > 15 min OU sem heartbeat algum
  FOR v_farm IN
    SELECT f.id AS fid
    FROM public.farms f
    LEFT JOIN public.site_health sh ON sh.farm_id = f.id
    WHERE sh.id IS NULL
       OR sh.last_heartbeat < now() - interval '15 minutes'
  LOOP
    -- Cancela comandos manuais "ligar" pendentes/enviados.
    -- Heurística: payload {1} ou {1xxxxx..} (qualquer dígito 1 dentro das chaves)
    -- Não toca em comandos de desligar (payload {0} ou {000000}).
    WITH cancelled AS (
      UPDATE public.commands c
      SET status = 'cancelled',
          responded_at = now(),
          error_message = 'Bridge offline > 15 min — comando de ligar cancelado por segurança'
      WHERE c.farm_id = v_farm.fid
        AND c.status IN ('pending', 'sent')
        AND c.type IN ('manual')
        AND c.frame ~ '\{[01]*1[01]*\}'
      RETURNING c.id, c.equipment_id
    )
    SELECT count(*) INTO v_count FROM cancelled;

    IF v_count > 0 THEN
      -- Limpa pending_command_id dos equipamentos afetados
      UPDATE public.equipments e
      SET pending_command_id = NULL,
          updated_at = now()
      WHERE e.farm_id = v_farm.fid
        AND e.pending_command_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.commands c2
          WHERE c2.id = e.pending_command_id
            AND c2.status IN ('pending', 'sent')
        );

      -- Log para visibilidade
      INSERT INTO public.agent_logs (farm_id, level, category, message)
      VALUES (
        v_farm.fid, 'warn', 'safety',
        format('Bridge offline > 15 min: %s comando(s) de ligar foram cancelados automaticamente para evitar religamento em massa.', v_count)
      );

      farm_id := v_farm.fid;
      cancelled_count := v_count;
      v_total := v_total + v_count;
      RETURN NEXT;
    END IF;
  END LOOP;

  RETURN;
END;
$$;

-- Grant execute para anon/authenticated (será chamada via edge function service-role,
-- mas mantemos restrito a service_role por segurança)
REVOKE ALL ON FUNCTION public.purge_stale_on_commands_when_bridge_down() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_stale_on_commands_when_bridge_down() TO service_role;