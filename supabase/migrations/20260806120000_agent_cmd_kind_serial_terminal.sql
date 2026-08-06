-- v3.25.43 — Terminal Serial Remoto (substitui o Hércules)
-- Adiciona os dois novos valores ao enum agent_cmd_kind. Sem eles, o INSERT em
-- agent_commands com kind='serial_terminal'/'serial_sniff' é rejeitado pelo
-- Postgres. As políticas de RLS existentes (agent_commands_insert_writers /
-- can_write_farm) já cobrem o platform_admin — nenhuma policy nova é necessária.
--
-- ALTER TYPE ... ADD VALUE não roda dentro de bloco transacional junto com uso
-- do novo valor; aqui só adicionamos os labels (idempotente), como nas
-- migrations anteriores do mesmo enum.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    WHERE t.typname = 'agent_cmd_kind' AND e.enumlabel = 'serial_terminal'
  ) THEN
    ALTER TYPE public.agent_cmd_kind ADD VALUE 'serial_terminal';
  END IF;
EXCEPTION WHEN undefined_object THEN
  NULL; -- enum inexistente (fluxo legado): ignora
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    WHERE t.typname = 'agent_cmd_kind' AND e.enumlabel = 'serial_sniff'
  ) THEN
    ALTER TYPE public.agent_cmd_kind ADD VALUE 'serial_sniff';
  END IF;
EXCEPTION WHEN undefined_object THEN
  NULL;
END $$;
