DO $$
DECLARE
  ddl text;
BEGIN
  ddl := pg_get_functiondef('public.apply_pump_telemetry(uuid,text,text,smallint,uuid,text,text)'::regprocedure);

  ddl := replace(ddl, E'  v_fail_pending boolean := false;\n', '');
  ddl := replace(ddl, E'    v_fail_pending := false;\n', '');
  ddl := replace(ddl, E'        v_fail_pending := false;\n', '');
  ddl := replace(ddl, E'        -- Correção definitiva: RX divergente durante comando manual é apenas telemetria intermediária.\n        -- O agente local mantém o reforço e decide timeout/erro após a janela operacional.\n', E'        -- Telemetria intermediária durante comando manual: o agente local decide timeout/erro.\n');
  ddl := replace(ddl, E'    IF v_fail_pending THEN\n      UPDATE public.commands\n      SET status = ''error'',\n          error_message = COALESCE(error_message, ''RX divergente do payload esperado''),\n          responded_at = COALESCE(responded_at, now())\n      WHERE id = v_eq.pending_command_id\n        AND status IN (''pending'', ''sent'');\n    ELSIF v_clear_pending AND v_eq.pending_command_id IS NOT NULL THEN\n', E'    IF v_clear_pending AND v_eq.pending_command_id IS NOT NULL THEN\n');

  IF ddl LIKE '%v_fail_pending%' OR ddl LIKE '%RX divergente do payload esperado%' THEN
    RAISE EXCEPTION 'apply_pump_telemetry cleanup incomplete';
  END IF;

  EXECUTE ddl;
END $$;