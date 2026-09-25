-- ============================================================================
-- REALTIME: publicar public.equipments — o Dashboard depende disso
-- ----------------------------------------------------------------------------
-- PROBLEMA MEDIDO (Fazenda Sykue, 25/09/2026)
--
--   select string_agg(tablename,', ') from pg_publication_tables
--    where pubname='supabase_realtime';   →  (NENHUMA)
--
-- A publicação existe, com ops=INSERT/UPDATE/DELETE/TRUNCATE e
-- puballtables=false, mas SEM NENHUMA TABELA. Nenhum evento de
-- `postgres_changes` pode ser entregue, faça o frontend o que fizer.
--
-- Consequência observada em campo: o estado da bomba levava ~30 s para aparecer
-- no PumpCard. O Agent grava o RX na nuvem em menos de 1 s (queueTelemetry chama
-- apply_pump_telemetry imediatamente); os 30 s eram a rede de segurança
-- degradada de useCadastrosCloud (setInterval de 30_000 ms), que é o único
-- caminho restante quando o Realtime não entrega.
--
-- POR QUE SOMENTE `equipments`
--
-- Auditoria das subscriptions do frontend (25/09/2026): o kill switch
-- (realtimeKillSwitch.ts) substitui `supabase.channel` por um stub que responde
-- CLOSED, então TODA subscription que usa o cliente direto está morta. Só duas
-- passam pelo bypass `getRealtimeChannel`:
--
--   · useCadastrosCloud  → equipments, plc_groups, sectors
--   · useTechnicalTelemetry → technical_display_prefs
--
-- Dessas, apenas `equipments` carrega o estado da bomba (last_outputs_state,
-- last_communication, desired_running, last_actuation_origin) e é a fonte do
-- Dashboard/PumpCard via useDashboardEquipment → useCadastrosCloud.
--
-- `plc_groups` e `sectors` são cadastro: mudam por ação humana, o handler delas é
-- um refetch completo (scheduleReload) e não têm nada a ver com a latência
-- relatada. `technical_display_prefs` é preferência de exibição. `commands` não
-- é assinada por nenhum canal vivo (usePendingManualCommands usa o cliente
-- direto, que está stubbado). Publicar qualquer uma delas seria ampliar a
-- superfície de Realtime sem necessidade comprovada — fica fora.
--
-- REPLICA IDENTITY: NÃO ALTERADA.
-- `public.equipments` já está em FULL (verificado: relreplident='f') e tem PK.
-- Para os eventos usados bastaria DEFAULT — o handler lê apenas `payload.new`
-- (useCadastrosCloud.ts:236-238). Nada a fazer aqui.
--
-- RLS: não alterada. A entrega de postgres_changes respeita as policies de
-- SELECT do assinante, que já são as mesmas que a tela usa para ler a tabela.
--
-- ESCOPO: uma linha de DDL, idempotente. Não toca Agent, rádio, protocolo,
-- Bridge, frontend, nem nenhuma outra migration.
-- ============================================================================

DO $$
BEGIN
  -- A publicação é criada pelo Supabase; se não existir, não a inventamos aqui —
  -- criá-la com outras opções poderia divergir do padrão da plataforma.
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE NOTICE 'publicação supabase_realtime ausente — nada a fazer';
    RETURN;
  END IF;

  -- Idempotente de propósito: reexecutar a migration não pode falhar.
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'equipments'
  ) THEN
    RAISE NOTICE 'public.equipments já está em supabase_realtime — nada a fazer';
  ELSE
    ALTER PUBLICATION supabase_realtime ADD TABLE public.equipments;
    RAISE NOTICE 'public.equipments adicionada a supabase_realtime';
  END IF;
END $$;

-- ── VERIFICAÇÃO (somente leitura, para rodar depois de aplicar) ──────────────
--   select schemaname, tablename from pg_publication_tables
--    where pubname='supabase_realtime' order by 1,2;
--   → deve listar public.equipments, e SÓ ela.
--
-- A prova de ENTREGA de evento não é feita aqui: exigiria um write numa linha
-- operacional de `equipments`, o que dispara os gatilhos do ledger canônico
-- (log_equipment_state_change / trg_canonicalize_actuation_origin) e poderia
-- gravar linha em automation_log. A validação funcional é no frontend, onde
-- useCadastrosCloud.ts já imprime `[REALTIME] equipment update` com
-- `latency_ms` a cada evento recebido.
