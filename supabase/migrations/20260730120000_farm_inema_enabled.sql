-- ============================================================================
-- INEMA — toggle por fazenda. Coluna que controla se o módulo de Conformidade
-- INEMA aparece no Produtividade e se o agente Electron roda o inema_snapshot.
-- DEFAULT false: nenhuma fazenda liga o módulo até ser marcada explicitamente
-- no Suporte Técnico (aba Fazenda). Aplicar no SQL Editor.
-- ============================================================================

ALTER TABLE public.farms
  ADD COLUMN IF NOT EXISTS inema_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.farms.inema_enabled IS
  'Quando true, a aba Conformidade INEMA aparece no Produtividade e o agente '
  'Electron executa inema_snapshot() no heartbeat para esta fazenda.';
