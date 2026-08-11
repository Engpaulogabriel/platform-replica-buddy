-- v3.25.60 — OTA do serial_bridge (--onedir): atualiza a PASTA inteira.
-- Novo kind 'update_bridge' em agent_commands: o platform_admin envia um zip
-- (pasta serial_bridge/) via signed URL; o agente para a bridge, substitui a
-- pasta resources/serial_bridge/ e reinicia. RLS existente (can_write_farm) cobre.
--
-- ALTER TYPE ... ADD VALUE fora de bloco transacional junto com uso; idempotente.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    WHERE t.typname = 'agent_cmd_kind' AND e.enumlabel = 'update_bridge'
  ) THEN
    ALTER TYPE public.agent_cmd_kind ADD VALUE 'update_bridge';
  END IF;
EXCEPTION WHEN undefined_object THEN
  NULL; -- enum inexistente (fluxo legado): ignora
END $$;
