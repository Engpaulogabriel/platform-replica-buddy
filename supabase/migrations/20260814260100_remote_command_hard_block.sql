-- ============================================================================
-- BLOQUEIO DEFINITIVO do INSERT direto de comando remoto.
-- ----------------------------------------------------------------------------
-- APLICAR SOMENTE DEPOIS de:
--   1. 20260814260000 aplicada JUNTO com o commandQueue já chamando a RPC;
--   2. validação com comandos reais confirmando que command_id, actor_user_id
--      e a confirmação física estão chegando corretos:
--
--        SELECT * FROM public.command_authorship_health();
--        -- exige: sem_autor = 0, sem_trilha = 0, em TODAS as fazendas
--
--        SELECT count(*) FROM public.command_audit
--         WHERE details->>'legacy_direct_insert' = 'true'
--           AND command_created_at > now() - interval '24 hours';
--        -- exige: 0 — nenhum comando novo entrou pelo caminho legado
--
-- Depois disto, comando manual fora de enqueue_remote_command é RECUSADO.
-- ============================================================================

DO $$
DECLARE v_sem_autor bigint; v_legado bigint;
BEGIN
  SELECT count(*) INTO v_sem_autor
    FROM public.commands c
   WHERE c.type = 'manual'::public.command_type
     AND c.created_at > now() - interval '24 hours'
     AND (c.created_by IS NULL
          OR NOT EXISTS (SELECT 1 FROM public.command_audit ca WHERE ca.command_id = c.id));

  SELECT count(*) INTO v_legado
    FROM public.command_audit ca
   WHERE ca.details->>'legacy_direct_insert' = 'true'
     AND ca.command_created_at > now() - interval '24 hours';

  IF v_sem_autor > 0 THEN
    RAISE EXCEPTION 'TRAVA: % comando(s) das últimas 24h sem autor ou sem trilha. Corrija antes de bloquear.', v_sem_autor;
  END IF;
  IF v_legado > 0 THEN
    RAISE EXCEPTION 'TRAVA: % comando(s) das últimas 24h ainda entraram pelo caminho legado. O frontend não está usando a RPC.', v_legado;
  END IF;
END $$;

ALTER TABLE public.farms ALTER COLUMN command_rpc_enforced SET DEFAULT true;
UPDATE public.farms SET command_rpc_enforced = true;

-- ============================================================================
-- ROLLBACK que NÃO interrompe Ligar/Desligar:
--   UPDATE public.farms SET command_rpc_enforced = false;
--   -- volta à transição: o INSERT direto volta a ser aceito, mas o trigger
--   -- continua FORÇANDO created_by = auth.uid() e criando command_audit.
--   -- Nenhum comando fica sem autor, e o painel volta a funcionar na hora.
-- Reverter por fazenda:
--   UPDATE public.farms SET command_rpc_enforced = false WHERE id = '<farm>';
-- ============================================================================
