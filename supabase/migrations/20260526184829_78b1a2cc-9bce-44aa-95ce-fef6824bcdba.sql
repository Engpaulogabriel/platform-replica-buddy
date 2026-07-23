
-- Policies restritivas para silenciar avisos do linter "RLS enabled, no policies".
-- Escrita real nessas tabelas é feita por edge functions / cron com service_role
-- (que bypassa RLS por design). Usuários autenticados NÃO devem escrever.
-- USING/WITH CHECK (false) garante deny-all explícito + serve como documentação.

-- automation_fired: chave de idempotência do motor de automação
CREATE POLICY "automation_fired_no_user_writes_insert"
  ON public.automation_fired FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY "automation_fired_no_user_writes_update"
  ON public.automation_fired FOR UPDATE TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY "automation_fired_no_user_writes_delete"
  ON public.automation_fired FOR DELETE TO authenticated USING (false);

-- energy_efficiency_daily: calculado pelo cron
CREATE POLICY "eed_no_user_writes_insert"
  ON public.energy_efficiency_daily FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY "eed_no_user_writes_update"
  ON public.energy_efficiency_daily FOR UPDATE TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY "eed_no_user_writes_delete"
  ON public.energy_efficiency_daily FOR DELETE TO authenticated USING (false);

-- water_balance_state: calculado pelo cron
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relname='water_balance_state') THEN
    EXECUTE 'CREATE POLICY "wbs_no_user_writes_insert" ON public.water_balance_state FOR INSERT TO authenticated WITH CHECK (false)';
    EXECUTE 'CREATE POLICY "wbs_no_user_writes_update" ON public.water_balance_state FOR UPDATE TO authenticated USING (false) WITH CHECK (false)';
    EXECUTE 'CREATE POLICY "wbs_no_user_writes_delete" ON public.water_balance_state FOR DELETE TO authenticated USING (false)';
  END IF;
END $$;

-- tampering_events: gravado pela edge function report-tampering (service_role)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relname='tampering_events') THEN
    EXECUTE 'CREATE POLICY "tampering_events_no_user_insert" ON public.tampering_events FOR INSERT TO authenticated WITH CHECK (false)';
  END IF;
END $$;

-- farm_maintenance_locks: gerenciado por RPC SECURITY DEFINER restrita a platform_admin
CREATE POLICY "fml_no_user_writes_insert"
  ON public.farm_maintenance_locks FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY "fml_no_user_writes_update"
  ON public.farm_maintenance_locks FOR UPDATE TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY "fml_no_user_writes_delete"
  ON public.farm_maintenance_locks FOR DELETE TO authenticated USING (false);

-- farm_backups: gerenciado por farm_backup_create / farm_backup_restore (SECURITY DEFINER)
CREATE POLICY "farm_backups_no_user_writes_insert"
  ON public.farm_backups FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY "farm_backups_no_user_writes_update"
  ON public.farm_backups FOR UPDATE TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY "farm_backups_no_user_writes_delete"
  ON public.farm_backups FOR DELETE TO authenticated USING (false);

COMMENT ON TABLE public.automation_fired IS 'Escrita exclusiva via run_automation_tick (SECURITY DEFINER) / service_role.';
COMMENT ON TABLE public.energy_efficiency_daily IS 'Escrita exclusiva via check_peak_efficiency_alerts (cron/service_role).';
COMMENT ON TABLE public.farm_maintenance_locks IS 'Escrita exclusiva via RPC SECURITY DEFINER restrita a platform_admin.';
COMMENT ON TABLE public.farm_backups IS 'Escrita exclusiva via farm_backup_create / farm_backup_restore (SECURITY DEFINER).';
